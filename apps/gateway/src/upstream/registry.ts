import type { Client } from "@modelcontextprotocol/client";

import {
  connectToUpstream,
  disconnectFromUpstream,
  type UpstreamConnection,
} from "./connection.js";

import type { DiscoveredTool, UpstreamConfig, UpstreamState } from "./types.js";

export class UpstreamRegistry {
  private upstreams = new Map<string, UpstreamState>();

  private connections = new Map<string, UpstreamConnection>();

  private inFlight = new Map<string, Promise<void>>();

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  register(config: UpstreamConfig): void {
    if (this.upstreams.has(config.name)) {
      throw new Error(`Upstream already registered: ${config.name}`);
    }

    // Restrict names to a predictable namespace format.
    if (!/^[a-z][a-z0-9_-]*$/.test(config.name)) {
      throw new Error("Invalid upstream name");
    }

    const url = new URL(config.url);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Upstream must use HTTP or HTTPS");
    }

    this.upstreams.set(config.name, {
      config: { ...config },

      status: config.enabled ? "disconnected" : "disabled",

      client: null,
      tools: [],
      lastConnectedAt: null,
      lastDiscoveredAt: null,
      lastError: null,
    });
  }

  private async closeConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);

    this.connections.delete(name);

    const state = this.upstreams.get(name);

    if (state) {
      state.client = null;
    }

    if (connection) {
      await disconnectFromUpstream(connection).catch(() => {});
    }
  }

  async connect(name: string): Promise<void> {
    const existing = this.inFlight.get(name);

    if (existing) {
      return existing;
    }

    const task = this.connectInternal(name);

    this.inFlight.set(name, task);

    try {
      await task;
    } finally {
      this.inFlight.delete(name);
    }
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

    // Replace the previous connection when reconnecting.
    await this.closeConnection(name);

    state.status = "connecting";
    state.lastError = null;

    let connection: UpstreamConnection | null = null;

    try {
      connection = await connectToUpstream(name, state.config.url);

      // Discover tools before marking the upstream healthy.
      const result = await connection.client.listTools(undefined, {
        timeout: 5_000,
      });

      const tools: DiscoveredTool[] = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      // Replace cached definitions atomically after success.
      state.tools = tools;

      state.client = connection.client;

      this.connections.set(name, connection);

      state.status = "connected";
      state.lastConnectedAt = new Date();
      state.lastDiscoveredAt = new Date();

      console.info(`[Registry] ${name}: discovered ${tools.length} tools`);
    } catch {
      state.status = "unreachable";
      state.lastError = "Connection or tool discovery failed";

      if (connection) {
        await disconnectFromUpstream(connection).catch(() => {});
      }

      // Preserve the previous cached tool definitions.
      state.client = null;

      console.error(`[Registry] ${name}: unavailable`);
    }
  }

  async refresh(name: string): Promise<void> {
    const state = this.upstreams.get(name);

    if (!state || !state.config.enabled) {
      return;
    }

    if (state.status !== "connected" || !state.client) {
      await this.connect(name);
      return;
    }

    try {
      const result = await state.client.listTools();

      state.tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      state.lastDiscoveredAt = new Date();
      state.lastError = null;
    } catch {
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
      [...this.upstreams.keys()].map((name) => this.refresh(name)),
    );
  }

  startRefresh(intervalMs = 30_000): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
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
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    await Promise.allSettled(
      [...this.connections.keys()].map((name) => this.closeConnection(name)),
    );
  }
}
