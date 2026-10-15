import { DestinationPolicy, type DestinationNetwork } from "./destination-policy.js";
import type { Client } from "@modelcontextprotocol/client";

import {
  connectToUpstream,
  disconnectFromUpstream,
  type UpstreamConnection,
} from "./connection.js";

import type { DiscoveredTool, UpstreamConfig, UpstreamState } from "./types.js";

export class UpstreamRegistry {
  constructor(private readonly policy = new DestinationPolicy(), private readonly network?: DestinationNetwork) {}

  private closed = false;
  private nextGeneration = 0;

  private upstreams = new Map<string, UpstreamState>();

  private connections = new Map<string, UpstreamConnection>();

  private activeCalls = new Map<Client, Set<Promise<unknown>>>();

  private retiredConnections = new Map<string, Set<UpstreamConnection>>();

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private maintenance = new Map<string, Promise<void>>();
  private refreshRunning = false;

  register(config: UpstreamConfig): void {
    if (this.closed) throw new Error("Registry closed");
    if (this.upstreams.has(config.name)) {
      throw new Error(`Upstream already registered: ${config.name}`);
    }

    // Restrict names to a predictable namespace format.
    if (!/^[a-z][a-z0-9_-]*$/.test(config.name)) {
      throw new Error("Invalid upstream name");
    }

    this.policy.validate(config.url);

    this.upstreams.set(config.name, {
      config: { ...config },
      generation: ++this.nextGeneration,

      status: config.enabled ? "disconnected" : "disabled",

      client: null,
      tools: [],
      lastConnectedAt: null,
      lastDiscoveredAt: null,
      lastError: null,
    });
  }

  private async runMaintenance(
    name: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.closed) return;
    const previous = this.maintenance.get(name) ?? Promise.resolve();

    const current = previous.catch(() => {}).then(() => this.closed ? undefined : operation());

    this.maintenance.set(name, current);

    try {
      await current;
    } finally {
      if (this.maintenance.get(name) === current) {
        this.maintenance.delete(name);
      }
    }
  }

  private async closeConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);

    const state = this.upstreams.get(name);

    if (state) {
      state.client = null;
    }

    if (connection) {
      // Calls already sent retain their existing ten-second bound. The barrier
      // prevents new entries, so cleanup can drain this finite set safely.
      await Promise.allSettled([...(this.activeCalls.get(connection.client) ?? [])]);
      await disconnectFromUpstream(connection);
      if (this.connections.get(name) === connection) this.connections.delete(name);
    }
    const retired = this.retiredConnections.get(name);
    if (retired) {
      for (const obsolete of retired) {
        await disconnectFromUpstream(obsolete);
        retired.delete(obsolete);
      }
      if (retired.size === 0) this.retiredConnections.delete(name);
    }
  }

  async withInvocation<T>(client: Client, operation: () => Promise<T>): Promise<T> {
    const calls = this.activeCalls.get(client) ?? new Set<Promise<unknown>>();
    const call = operation();
    calls.add(call);
    this.activeCalls.set(client, calls);
    try { return await call; }
    finally {
      calls.delete(call);
      if (calls.size === 0) this.activeCalls.delete(client);
    }
  }

  private async retireConnection(name: string, connection: UpstreamConnection): Promise<void> {
    try { await disconnectFromUpstream(connection); }
    catch {
      const retired = this.retiredConnections.get(name) ?? new Set<UpstreamConnection>();
      retired.add(connection);
      this.retiredConnections.set(name, retired);
    }
  }

  async disable(name: string, configurationRevision?: number): Promise<void> {
    const state = this.upstreams.get(name);
    if (!state) throw new Error("Unknown upstream");
    // Synchronous barrier: discovery already awaiting I/O cannot publish afterwards.
    state.generation = ++this.nextGeneration;
    state.config = { ...state.config, enabled: false, configurationRevision };
    state.status = "disabled";
    state.tools = [];
    state.client = null;
    state.lastError = null;
    await this.runMaintenance(name, () => this.closeConnection(name));
  }

  async enable(name: string, configurationRevision?: number): Promise<void> {
    await this.runMaintenance(name, async () => {
      const state = this.upstreams.get(name);
      if (!state) throw new Error("Unknown upstream");
      state.config = { ...state.config, enabled: true, configurationRevision };
      await this.connectInternal(name);
    });
  }

  remove(name: string): void {
    const state = this.upstreams.get(name);
    if (state?.config.enabled || this.connections.has(name) || this.retiredConnections.has(name)) {
      throw new Error("Upstream cleanup incomplete");
    }
    this.upstreams.delete(name);
  }

  async connect(name: string): Promise<void> {
    return this.runMaintenance(name, () => this.connectInternal(name));
  }

  private async connectInternal(name: string): Promise<void> {
    const state = this.upstreams.get(name);

    if (!state) {
      throw new Error(`Unknown upstream: ${name}`);
    }

    if (!state.config.enabled) {
      state.status = "disabled";
      return;
    }

    const generation = state.generation = ++this.nextGeneration;
    const current = () => !this.closed && this.upstreams.get(name) === state && state.generation === generation;

    // Replace the previous connection when reconnecting.
    await this.closeConnection(name);

    if (!current()) return;
    state.status = "connecting";
    state.lastError = null;

    let connection: UpstreamConnection | null = null;

    try {
      // Secret resolution is a separate management capability. Never connect unauthenticated
      // when persisted configuration requires upstream credentials.
      if (state.config.authentication && state.config.authentication.type !== "none") {
        throw new Error("Upstream credentials unavailable");
      }
      connection = await connectToUpstream(name, state.config.url, this.policy, this.network);

      // Discover tools before marking the upstream healthy.
      const result = await connection.client.listTools(undefined, {
        timeout: 5_000,
      });

      const tools: DiscoveredTool[] = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      if (!current()) {
        await this.retireConnection(name, connection);
        return;
      }
      this.validateTools(tools);

      // Replace cached definitions atomically after success.
      state.tools = tools;

      state.client = connection.client;

      this.connections.set(name, connection);

      state.status = "connected";
      state.lastConnectedAt = new Date();
      state.lastDiscoveredAt = new Date();

      console.info(`[Registry] ${name}: discovered ${tools.length} tools`);
    } catch {
      if (!current()) {
        if (connection) await this.retireConnection(name, connection);
        return;
      }
      state.status = "unreachable";
      state.lastError = "Connection or tool discovery failed";

      if (connection) {
        await this.retireConnection(name, connection);
      }

      // Preserve the previous cached tool definitions.
      state.client = null;

      console.error(`[Registry] ${name}: unavailable`);
    }
  }

  private validateTools(tools: DiscoveredTool[]): void {
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
      throw new Error("Duplicate upstream tool names");
    }
  }

  private async refreshInternal(name: string): Promise<void> {
    const state = this.upstreams.get(name);

    if (!state || !state.config.enabled) {
      return;
    }

    if (state.status !== "connected" || !state.client) {
      await this.connectInternal(name);
      return;
    }

    const generation = state.generation;
    const client = state.client;
    const current = () => !this.closed && this.upstreams.get(name) === state && state.generation === generation && state.client === client;
    try {
      const result = await client.listTools(undefined, {
        timeout: 5_000,
      });

      const tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      if (!current()) return;
      this.validateTools(tools);
      state.tools = tools;
      state.generation = ++this.nextGeneration;
      state.lastDiscoveredAt = new Date();
      state.lastError = null;
    } catch {
      if (!current()) return;
      state.status = "unreachable";
      state.lastError = "Tool discovery failed";

      await this.closeConnection(name);

      console.error(`[Registry] ${name}: refresh failed`);
    }
  }

  async connectAll(): Promise<void> {
    // Parallel discovery prevents one failing server
    // from aborting initialization of healthy servers.
    await Promise.allSettled(
      [...this.upstreams.keys()].map((name) => this.connect(name)),
    );
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      [...this.upstreams.keys()].map((name) => this.runMaintenance(name, () => this.refreshInternal(name))),
    );
  }

  async markUnreachable(
    name: string,
    reason = "Upstream request failed",
    failedClient?: Client,
  ): Promise<void> {
    await this.runMaintenance(name, async () => {
      const state = this.upstreams.get(name);

      if (!state || !state.config.enabled) {
        return;
      }

      // Catalog refresh keeps the transport: its failures still matter. Only a
      // replacement client makes an in-flight transport failure obsolete.
      if (failedClient && state.client !== failedClient) {
        return;
      }

      state.status = "unreachable";
      state.lastError = reason;

      await this.closeConnection(name);

      console.warn(`[Registry] ${name}: ${reason}`);
    });
  }

  startRefresh(intervalMs = 30_000): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      if (this.refreshRunning) {
        return;
      }

      this.refreshRunning = true;

      void this.refreshAll()
        .catch(() => {
          console.error("[Registry] Periodic refresh failed");
        })
        .finally(() => {
          this.refreshRunning = false;
        });
    }, intervalMs);
  }

  getState(name: string): UpstreamState | undefined {
    const state = this.upstreams.get(name);

    if (!state) {
      return undefined;
    }

    return {
      ...state,
      config: { ...state.config },
      tools: state.tools.map((tool) => ({ ...tool })),
    };
  }

  list(): UpstreamState[] {
    return [...this.upstreams.keys()]
      .map((name) => this.getState(name))
      .filter((state): state is UpstreamState => state !== undefined);
  }

  getClient(name: string): Client | null {
    const state = this.upstreams.get(name);

    if (state?.status !== "connected") {
      return null;
    }

    return state.client;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Let bounded maintenance discard late results before releasing transports.
    await Promise.allSettled([...this.maintenance.values()]);
    await Promise.allSettled(
      [...new Set([...this.connections.keys(), ...this.retiredConnections.keys()])].map((name) => this.closeConnection(name)),
    );
  }
}
