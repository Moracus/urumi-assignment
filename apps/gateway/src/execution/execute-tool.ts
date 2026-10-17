import { randomUUID } from "node:crypto";
import type { AuditLogger, AuditOutcome } from "../audit/logger.js";

import { authorizeTool } from "../security/authorization.js";

import type {
  ToolExecutionRequest,
  ToolExecutionResponse,
  ToolResolver,
  UpstreamInvoker,
} from "./types.js";

import {
  UpstreamUnavailableError,
  UpstreamTimeoutError,
} from "../tools/errors.js";

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
  upstreamAttribution?: (name: string) => Promise<{ id: string; displayName: string } | null>;
}

export async function executeTool(
  request: ToolExecutionRequest,
  dependencies: ExecutionDependencies,
): Promise<ToolExecutionResponse> {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  let upstreamName: string | null = null;
  let upstream: { id: string; displayName: string } | null = null;
  const attemptId = randomUUID();
  let outcome: AuditOutcome = "upstream_error";
  async function captureUpstream(name: string) {
    try { return await dependencies.upstreamAttribution?.(name) ?? null; }
    catch { console.error("Audit attribution unavailable"); return null; }
  }

  try {
    // 1. Authorization
    authorizeTool(request.identity, request.toolName);

    // 2. Tool resolution
    const tool = await dependencies.resolver.resolve(request.toolName);

    if (!tool) {
      throw new ToolNotFoundError();
    }

    upstreamName = tool.upstreamName;
    // Capture before invocation, including removal while a call is in flight.
    upstream = await captureUpstream(upstreamName);

    // 3. Upstream execution
    const result = await dependencies.invoker.invoke(tool, request.arguments);

    // MCP tools can return errors as successful
    // protocol responses with isError: true.
    outcome = result.isError ? "tool_error" : "success";

    return {
      requestId: request.requestId,
      result,
    };
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      upstreamName = error.upstreamName;
      if (!upstream) upstream = await captureUpstream(upstreamName);
    }
    if (error instanceof Error && error.name === "AuthorizationError") {
      outcome = "unauthorized";
    } else if (error instanceof ToolNotFoundError) {
      outcome = "not_found";
    } else if (error instanceof UpstreamUnavailableError) {
      outcome = "upstream_unavailable";
    } else if (error instanceof UpstreamTimeoutError) {
      outcome = "upstream_timeout";
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
        attemptId,
        authenticationOrigin: request.identity.authenticationOrigin ?? "gateway_api_key",
        userEmail: request.identity.userEmail ?? null,
        upstreamId: upstream?.id ?? null,
        upstreamDisplayName: upstream?.displayName ?? null,
        userId: request.identity.userId,
        keyId: request.identity.keyId,
        upstreamName,
        toolName: request.toolName,
        timestamp,
        durationMs,
        outcome,
      });
    } catch {
      // Never replace a determined result or replay a possibly applied side effect.
      console.error(JSON.stringify({ event: "audit_write_failed", attemptId }));
    }
  }
}
