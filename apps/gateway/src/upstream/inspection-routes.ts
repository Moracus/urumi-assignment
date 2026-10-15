import type { FastifyInstance } from "fastify";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";
import type { RegistrationStorage, UpstreamRegistration } from "./registrations.js";
import type { UpstreamRegistry } from "./registry.js";
import type { UpstreamManagement } from "./management.js";
import type { DestinationPolicy } from "./destination-policy.js";

export function registerServerInspectionRoutes(
  app: FastifyInstance, storage: RegistrationStorage, registry: UpstreamRegistry,
  policy: DestinationPolicy, management: UpstreamManagement,
) {
  function observed(server: UpstreamRegistration) {
    const state = registry.getState(server.serverId);
    return state?.config.configurationRevision === server.configurationRevision ? state : undefined;
  }
  function summary(server: UpstreamRegistration) {
    const state = observed(server);
    return {
      serverId: server.serverId, displayName: server.displayName, enabled: server.enabled,
      configurationRevision: server.configurationRevision, createdAt: server.createdAt, updatedAt: server.updatedAt,
      status: !server.enabled ? "disabled" : state?.status ?? "disconnected",
      toolCount: server.enabled && state?.status === "connected" ? state.tools.length : 0,
      lastConnectedAt: state?.lastConnectedAt ?? null,
      lastDiscoveredAt: state?.lastDiscoveredAt ?? null,
      // Do not serialize raw diagnostics, even if the registry's error convention changes.
      lastError: state?.lastError ? "Upstream unavailable" : null,
    };
  }
  function detail(server: UpstreamRegistration) {
    return {
      ...summary(server), url: server.url, transport: server.transport,
      authentication: { type: server.authentication.type, referenceConfigured: server.authentication.type !== "none" },
    };
  }
  app.post("/api/admin/servers", { bodyLimit: 8192 }, async (request, reply) => {
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) {
      throw new DashboardAuthError(415, "Invalid request");
    }
    const server = await management.create(request.body);
    return reply.code(201).send({ server: detail(server) });
  });
  for (const action of ["enable", "disable"] as const) {
    app.post<{ Params: { serverId: string } }>(`/api/admin/servers/:serverId/${action}`, { bodyLimit: 4096 }, async request => {
      const server = await management.setEnabled(request.params.serverId, action === "enable");
      return { server: detail(server) };
    });
  }
  app.delete<{ Params: { serverId: string } }>("/api/admin/servers/:serverId", async (request, reply) => {
    await management.remove(request.params.serverId);
    return reply.code(204).send();
  });
  async function find(serverId: string) {
    const server = (await storage.list(policy)).find(server => server.serverId === serverId);
    if (!server) throw new DashboardAuthError(404, "Server not found");
    return server;
  }
  app.get("/api/admin/servers", async () => ({ servers: (await storage.list(policy)).map(summary) }));
  app.get<{ Params: { serverId: string } }>("/api/admin/servers/:serverId", async request => {
    const server = await find(request.params.serverId);
    return { server: detail(server) };
  });
  app.get<{ Params: { serverId: string } }>("/api/admin/servers/:serverId/tools", async request => {
    const server = await find(request.params.serverId);
    const state = observed(server);
    return { tools: server.enabled && state?.status === "connected" ? state.tools.map(tool => ({
      name: `${server.serverId}.${tool.name}`, description: tool.description, inputSchema: tool.inputSchema,
    })) : [] };
  });
}
