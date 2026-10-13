import type {
  AuditLogger,
  AuditOutcome,
} from "../audit/logger.js";

import {
  authorizeTool,
} from "../security/authorization.js";

import type {
  ToolExecutionRequest,
  ToolExecutionResponse,
  ToolResolver,
  UpstreamInvoker,
} from "./types.js";

export class ToolNotFoundError extends Error {
  constructor() {
    super("Tool not found");
    this.name = "ToolNotFoundError";
  }
}

export interface ExecutionDependencies {
  resolver: ToolResolver;
  invoker: UpstreamInvoker;
  auditLogger: AuditLogger;
}

export async function executeTool(
  request: ToolExecutionRequest,
  dependencies: ExecutionDependencies,
): Promise<ToolExecutionResponse> {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  let upstreamName: string | null = null;
  let outcome: AuditOutcome = "upstream_error";

  try {
    // 1. Authorization
    authorizeTool(
      request.identity,
      request.toolName,
    );

    // 2. Tool resolution
    const tool = await dependencies.resolver.resolve(
      request.toolName,
    );

    if (!tool) {
      throw new ToolNotFoundError();
    }

    upstreamName = tool.upstreamName;

    // 3. Upstream execution
    const result = await dependencies.invoker.invoke(
      tool,
      request.arguments,
    );

    // MCP tools can return errors as successful
    // protocol responses with isError: true.
    outcome = result.isError
      ? "tool_error"
      : "success";

    return {
      requestId: request.requestId,
      result,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AuthorizationError"
    ) {
      outcome = "unauthorized";
    } else if (error instanceof ToolNotFoundError) {
      outcome = "not_found";
    } else {
      outcome = "upstream_error";
    }

    throw error;
  } finally {
    // 4. Audit logging
    const durationMs = Date.now() - startedAt;

    try {
      await dependencies.auditLogger.write({
        requestId: request.requestId,
        userId: request.identity.userId,
        keyId: request.identity.keyId,
        upstreamName,
        toolName: request.toolName,
        timestamp,
        durationMs,
        outcome,
      });
    } catch (auditError) {
      // For now, surface audit infrastructure failures
      // in server logs without replacing the tool result.
      // A durable audit queue/persistence policy comes later.
      console.error(
        "Audit logging failed",
        auditError instanceof Error
          ? auditError.name
          : "Unknown error",
      );
    }
  }
}