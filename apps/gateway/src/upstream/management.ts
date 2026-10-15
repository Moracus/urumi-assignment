import { DashboardAuthError } from "../identity/dashboard-sessions.js";
import { createRegistrationInput, editRegistrationInput, type RegistrationStorage, type UpstreamRegistration } from "./registrations.js";
import type { DestinationPolicy } from "./destination-policy.js";
import type { UpstreamRegistry } from "./registry.js";

/** Coordinates durable desired configuration with this process's live registry. */
export class UpstreamManagement {
  constructor(
    private readonly storage: RegistrationStorage,
    private readonly registry: UpstreamRegistry,
    private readonly policy: DestinationPolicy,
  ) {}

  private readonly operations = new Map<string, Promise<unknown>>();

  private async serialize<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(serverId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(serverId, current);
    try { return await current; }
    finally {
      if (this.operations.get(serverId) === current) this.operations.delete(serverId);
    }
  }

  async edit(serverId: string, input: unknown): Promise<UpstreamRegistration> {
    let parsed;
    try {
      parsed = editRegistrationInput.parse(input);
      if (parsed.url !== undefined) parsed.url = this.policy.validate(parsed.url).href;
    } catch {
      throw new DashboardAuthError(400, "Invalid server configuration");
    }
    return this.serialize(serverId, async () => {
      let server: UpstreamRegistration | null;
      try {
        server = await this.storage.edit(serverId, parsed);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 11000) {
          throw new DashboardAuthError(409, "Server already registered");
        }
        throw error;
      }
      if (!server) throw new DashboardAuthError(404, "Server not found");
      await this.registry.reconfigure({ name: server.serverId, url: server.url, enabled: server.enabled,
        authentication: server.authentication, configurationRevision: server.configurationRevision });
      return server;
    });
  }

  async setEnabled(serverId: string, enabled: boolean): Promise<UpstreamRegistration> {
    return this.serialize(serverId, async () => {
      // Desired state precedes connection or the disable acknowledgement.
      const server = await this.storage.setEnabled(serverId, enabled);
      if (!server) throw new DashboardAuthError(404, "Server not found");
      await this.registry.disable(serverId, server.configurationRevision);
      if (enabled) await this.registry.enable(serverId, server.configurationRevision);
      return server;
    });
  }

  async refresh(serverId: string): Promise<UpstreamRegistration> {
    return this.serialize(serverId, async () => {
      const server = (await this.storage.list(this.policy)).find(server => server.serverId === serverId);
      if (!server) throw new DashboardAuthError(404, "Server not found");
      if (!server.enabled) throw new DashboardAuthError(409, "Server is disabled");
      // Out-of-band storage edits require restart, as with inspection. Never
      // refresh an obsolete runtime configuration under a newer desired revision.
      if (this.registry.getState(serverId)?.config.configurationRevision !== server.configurationRevision) {
        throw new Error("Upstream configuration is not reconciled");
      }
      await this.registry.refresh(serverId);
      return server;
    });
  }

  async remove(serverId: string): Promise<void> {
    return this.serialize(serverId, async () => {
      // A cleanup/delete failure leaves a durable disabled registration to retry.
      const server = await this.storage.setEnabled(serverId, false);
      if (!server) throw new DashboardAuthError(404, "Server not found");
      await this.registry.disable(serverId, server.configurationRevision);
      await this.storage.remove(serverId);
      this.registry.remove(serverId);
    });
  }

  async create(input: unknown): Promise<UpstreamRegistration> {
    let parsed;
    try {
      parsed = createRegistrationInput.parse(input);
      parsed.url = this.policy.validate(parsed.url).href;
    } catch {
      throw new DashboardAuthError(400, "Invalid server configuration");
    }
    return this.serialize(parsed.serverId, async () => {
      let server: UpstreamRegistration;
      try {
        // Unique indexes arbitrate concurrent identifiers and canonical endpoints.
        server = await this.storage.create(parsed);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 11000) {
          throw new DashboardAuthError(409, "Server already registered");
        }
        throw error;
      }
      this.registry.register({ name: server.serverId, url: server.url, enabled: server.enabled,
        authentication: server.authentication, configurationRevision: server.configurationRevision });
      // Connection failure is an observed outcome, not a rollback of desired state.
      await this.registry.connect(server.serverId);
      return server;
    });
  }
}
