import type { Client } from "@modelcontextprotocol/client";

export type UpstreamStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "unreachable"
  | "disabled";

export interface UpstreamConfig {
  name: string;

  url: string;

  enabled: boolean;
}

export interface DiscoveredTool {
  name: string;

  description?: string;

  inputSchema: Record<string, unknown>;
}

export interface UpstreamState {
  config: UpstreamConfig;

  status: UpstreamStatus;

  client: Client | null;

  tools: DiscoveredTool[];

  lastConnectedAt: Date | null;

  lastDiscoveredAt: Date | null;

  lastError: string | null;
}