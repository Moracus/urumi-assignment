import { DashboardAuthError } from "../identity/dashboard-sessions.js";
import { createRegistrationInput, type RegistrationStorage, type UpstreamRegistration } from "./registrations.js";
import type { DestinationPolicy } from "./destination-policy.js";
import type { UpstreamRegistry } from "./registry.js";

/** Coordinates durable desired configuration with this process's live registry. */
export class UpstreamManagement {
  constructor(
    private readonly storage: RegistrationStorage,
    private readonly registry: UpstreamRegistry,
    private readonly policy: DestinationPolicy,
  ) {}

  async create(input: unknown): Promise<UpstreamRegistration> {
    let parsed;
    try {
      parsed = createRegistrationInput.parse(input);
      parsed.url = this.policy.validate(parsed.url).href;
    } catch {
      throw new DashboardAuthError(400, "Invalid server configuration");
    }
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
  }
}
