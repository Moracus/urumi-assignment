import type { FastifyInstance } from "fastify";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";
import type { RegistrationStorage, UpstreamRegistration } from "./registrations.js";
import type { UpstreamRegistry } from "./registry.js";
import type { DestinationPolicy } from "./destination-policy.js";

export function registerServerInspectionRoutes(
  app: FastifyInstance, storage: RegistrationStorage, registry: UpstreamRegistry,
  policy: DestinationPolicy, restored: UpstreamRegistration[],
) {
  const revisions = new Map(restored.map(server => [server.serverId, server.configurationRevision]));
  function observed(server: UpstreamRegistration) {
    return revisions.get(server.serverId) === server.configurationRevision ? registry.getState(server.serverId) : undefined;
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
  async function find(serverId: string) {
    const server = (await storage.list(policy)).find(server => server.serverId === serverId);
    if (!server) throw new DashboardAuthError(404, "Server not found");
    return server;
  }
  app.get("/api/admin/servers", async () => ({ servers: (await storage.list(policy)).map(summary) }));
  app.get<{ Params: { serverId: string } }>("/api/admin/servers/:serverId", async request => {
    const server = await find(request.params.serverId);
    return { server: {
      ...summary(server), url: server.url, transport: server.transport,
      authentication: { type: server.authentication.type, referenceConfigured: server.authentication.type !== "none" },
    } };
  });
  app.get<{ Params: { serverId: string } }>("/api/admin/servers/:serverId/tools", async request => {
    const server = await find(request.params.serverId);
    const state = observed(server);
    return { tools: server.enabled && state?.status === "connected" ? state.tools.map(tool => ({
      name: `${server.serverId}.${tool.name}`, description: tool.description, inputSchema: tool.inputSchema,
    })) : [] };
  });
}
