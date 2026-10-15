import type {
  AuthenticatedIdentity,
} from "../security/identity.js";

export interface ToolExecutionRequest {
  identity: AuthenticatedIdentity;

  toolName: string;

  arguments: Record<string, unknown>;

  requestId: string;
}

export interface ResolvedTool {
  generation?: number;
  publicName: string;

  upstreamName: string;

  upstreamToolName: string;
}

export interface ToolExecutionResult {
  content: Array<Record<string, unknown>>;

  isError?: boolean;

  [key: string]: unknown;
}

export interface ToolResolver {
  resolve(
    publicToolName: string,
  ): Promise<ResolvedTool | null>;
}

export interface UpstreamInvoker {
  invoke(
    tool: ResolvedTool,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult>;
}

export interface ToolExecutionResponse {
  requestId: string;

  result: ToolExecutionResult;
}