import { DestinationPolicy, type DestinationOptions, type DestinationNetwork } from "./upstream/destination-policy.js";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedIdentity } from "./security/identity.js";

import { toNodeHandler } from "@modelcontextprotocol/node";

import { createMcpHandler } from "@modelcontextprotocol/server";

import {
  authenticateRequest,
  AuthenticationError,
} from "./security/authentication.js";

import { UpstreamRegistry } from "./upstream/registry.js";

import {
  getDefaultUpstreams,
} from "./upstream/defaults.js";

import { ToolAggregator } from "./tools/aggregator.js";

import {
  AggregatedToolResolver,
} from "./tools/resolver.js";

import {
  McpUpstreamInvoker,
} from "./tools/invoker.js";

import {
  ConsoleAuditLogger,
} from "./audit/logger.js";

import {
  createGatewayMcpServer,
} from "./mcp-server.js";

import type { AuditLogger } from "./audit/logger.js";
import type { UpstreamConfig } from "./upstream/types.js";
import { connectIdentityStorage } from "./identity/storage.js";
import { dashboardConfig } from "./identity/dashboard-config.js";
import { registerDashboardRoutes } from "./identity/dashboard-routes.js";
import { UpstreamManagement } from "./upstream/management.js";
import { registerServerInspectionRoutes } from "./upstream/inspection-routes.js";

export interface GatewayAppOptions {
  host?: string;
  allowedHosts?: string[];
  upstreams?: UpstreamConfig[];
  auditLogger?: AuditLogger;
  mongodbUri?: string;
  destinations?: DestinationOptions;
  upstreamNetwork?: DestinationNetwork;
}

// Construction owns MCP and registry resources; the caller owns listening.
export async function createGatewayApp(options: GatewayAppOptions = {}) {
  const policy = new DestinationPolicy(options.destinations);
  const upstreams = options.upstreams ?? getDefaultUpstreams();
  const dashboard = dashboardConfig();
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const allowedHosts = options.allowedHosts ?? (
    process.env.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1"
  ).split(",").map((value) => value.trim()).filter(Boolean);

  // Persistence must be usable before any HTTP or upstream resources are started.
  const identityStorage = await connectIdentityStorage(options.mongodbUri);

  try {
    await identityStorage.upstreamRegistrations.migrate(upstreams, policy);
    const registrations = await identityStorage.upstreamRegistrations.list(policy);

    // ------------------------------------------
    // 1. Initialize upstream registry
    // ------------------------------------------

    const registry = new UpstreamRegistry(policy, options.upstreamNetwork);

    for (const server of registrations) {
      registry.register({ name: server.serverId, url: server.url, enabled: server.enabled,
        authentication: server.authentication, configurationRevision: server.configurationRevision });
    }

    // ------------------------------------------
    // 2. Initialize gateway components
    // ------------------------------------------

    const aggregator = new ToolAggregator(registry);

    const resolver = new AggregatedToolResolver(
      aggregator,
      registry,
    );

    const invoker = new McpUpstreamInvoker(registry);

    const auditLogger = options.auditLogger ?? new ConsoleAuditLogger();

    const execution = {
      resolver,
      invoker,
      auditLogger,
    };

    // ------------------------------------------
    // 3. Create MCP HTTP handler
    // ------------------------------------------

    // Adapt the Node HTTP handler to the SDK factory without a second lookup.
    // Each incoming request gets a separate scope, including legacy stateless serving.
    const verifiedIdentity = new AsyncLocalStorage<AuthenticatedIdentity>();
    const mcpHandler = createMcpHandler(
      () => {
        const identity = verifiedIdentity.getStore();
        if (!identity) throw new AuthenticationError();

        return createGatewayMcpServer(
          identity,
          {
            aggregator,
            execution,
          },
        );
      },
    );

    const nodeHandler = toNodeHandler(mcpHandler);

    // ------------------------------------------
    // 4. Create Fastify application
    // ------------------------------------------

    const app = createMcpFastifyApp({
      host,
      allowedHosts,
    });

    const management = new UpstreamManagement(identityStorage.upstreamRegistrations, registry, policy);
    await registerDashboardRoutes(app, identityStorage, dashboard, admin => {
      registerServerInspectionRoutes(admin, identityStorage.upstreamRegistrations, registry, policy, management);
    });

    // ------------------------------------------
    // 5. Health endpoints
    // ------------------------------------------

    app.get("/health/live", async () => ({
      status: "ok",
      service: "gateway",
    }));

    app.get("/health/ready", async (_request, reply) => {
      const connected = registry
        .list()
        .filter(
          (upstream) =>
            upstream.status === "connected",
        ).length;

      if (!(await identityStorage.isAvailable()) || connected === 0) {
        return reply.code(503).send({
          status: "not_ready",
          service: "gateway",
        });
      }

      return {
        status: "ok",
        service: "gateway",
        connectedUpstreams: connected,
      };
    });

    // ------------------------------------------
    // 6. Authentication boundary
    // ------------------------------------------

    app.all("/mcp", async (request, reply) => {
      try {
        if (!(await identityStorage.isAvailable())) {
          return reply.code(503).send({ error: "Authentication unavailable" });
        }
        const identity = await authenticateRequest(
          request.headers.authorization,
          identityStorage,
        );
        return await verifiedIdentity.run(identity, () => nodeHandler(request.raw, reply.raw, request.body));
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return reply
            .code(401)
            .header(
              "WWW-Authenticate",
              'Bearer realm="urumi-gateway"',
            )
            .send({
              error: "Unauthorized",
            });
        }

        request.log.error(
          "Gateway authentication unavailable",
        );

        return reply.code(503).send({
          error: "Authentication unavailable",
        });
      }
    });

    // ------------------------------------------
    // 8. Graceful shutdown
    // ------------------------------------------

    app.addHook("onClose", async () => {
      try {
        await mcpHandler.close();
      } finally {
        try { await registry.close(); }
        finally { await identityStorage.close(); }
      }
    });
    try {
      await registry.connectAll();
      registry.startRefresh(30_000);
    } catch (error) {
      await app.close();
      throw error;
    }

    return app;
  } catch (error) {
    await identityStorage.close();
    throw error;
  }
}
