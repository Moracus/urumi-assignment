import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";

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

const port = Number(process.env.PORT ?? 3000);

const host = process.env.HOST ?? "127.0.0.1";

const allowedHosts = (
  process.env.MCP_ALLOWED_HOSTS ??
  "localhost,127.0.0.1"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// ------------------------------------------
// 1. Initialize upstream registry
// ------------------------------------------

const registry = new UpstreamRegistry();

for (const config of getDefaultUpstreams()) {
  registry.register(config);
}

await registry.connectAll();

registry.startRefresh(30_000);

// ------------------------------------------
// 2. Initialize gateway components
// ------------------------------------------

const aggregator = new ToolAggregator(registry);

const resolver = new AggregatedToolResolver(
  aggregator,
  registry,
);

const invoker = new McpUpstreamInvoker(registry);

const auditLogger = new ConsoleAuditLogger();

const execution = {
  resolver,
  invoker,
  auditLogger,
};

// ------------------------------------------
// 3. Create MCP HTTP handler
// ------------------------------------------

const mcpHandler = createMcpHandler(
  (context) => {
    // Identity is established independently
    // for each incoming MCP request.
    const authorization =
      context.requestInfo?.headers.get(
        "authorization",
      );

    const identity = authenticateRequest(
      authorization ?? undefined,
    );

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

  if (connected === 0) {
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

app.addHook("preHandler", async (request, reply) => {
  if (request.url.split("?")[0] !== "/mcp") {
    return;
  }

  try {
    authenticateRequest(
      request.headers.authorization,
    );
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
      "Gateway authentication configuration error",
    );

    return reply.code(503).send({
      error: "Authentication unavailable",
    });
  }
});

// ------------------------------------------
// 7. MCP endpoint
// ------------------------------------------

app.all("/mcp", (request, reply) => {
  return nodeHandler(
    request.raw,
    reply.raw,
    request.body,
  );
});

// ------------------------------------------
// 8. Graceful shutdown
// ------------------------------------------

app.addHook("onClose", async () => {
  await mcpHandler.close();
  await registry.close();
});

// ------------------------------------------
// 9. Start application
// ------------------------------------------

try {
  await app.listen({
    port,
    host,
  });

  app.log.info(
    `MCP Gateway listening on ${host}:${port}`,
  );
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}