import { randomUUID } from "node:crypto";
import type { AuditLogger, AuditOutcome } from "./logger.js";
import type { AuthenticatedIdentity } from "../security/identity.js";
import { authorizeTool } from "../security/authorization.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recognize one bounded call, never a batch, notification, or arbitrary bad JSON.
// Arguments and client metadata are deliberately neither copied nor retained.
export function identifyMcpAttempt(method: string, body: unknown): McpAttempt | undefined {
  if (method !== "POST" || !object(body) || body.jsonrpc !== "2.0" || body.method !== "tools/call"
    || !(typeof body.id === "string" || (typeof body.id === "number" && Number.isFinite(body.id)))
    || !object(body.params) || typeof body.params.name !== "string"
    || !/^[A-Za-z0-9_.-]{1,512}$/.test(body.params.name)) return;
  return new McpAttempt(body.params.name);
}

export class McpAttempt {
  readonly id = randomUUID();
  private readonly startedAt = Date.now();
  private readonly timestamp = new Date().toISOString();
  private owned = false;
  private identity: AuthenticatedIdentity | undefined;
  private outcome: AuditOutcome = "unauthenticated";

  constructor(readonly toolName: string) {}

  authenticate(identity: AuthenticatedIdentity, knownTool: boolean) {
    this.identity = identity;
    this.outcome = "not_found";
    if (!knownTool) return;
    try {
      authorizeTool(identity, this.toolName);
      // The SDK owns validation and protocol responses. A call that never
      // reaches execution is a rejection, not an upstream/application failure.
      this.outcome = "rejected";
    } catch {
      this.outcome = "unauthorized";
    }
  }

  startExecution(): string {
    // Claim before invocation, including when the HTTP peer disconnects.
    this.owned = true;
    return this.id;
  }

  async finish(logger: AuditLogger) {
    if (this.owned) return;
    this.owned = true;
    try {
      await logger.write({
        attemptId: this.id, requestId: this.id,
        authenticationOrigin: this.identity ? "gateway_api_key" : null,
        userId: this.identity?.userId ?? null, userEmail: this.identity?.userEmail ?? null,
        keyId: this.identity?.keyId ?? null,
        upstreamId: null, upstreamName: null, upstreamDisplayName: null,
        toolName: this.toolName, timestamp: this.timestamp,
        durationMs: Date.now() - this.startedAt, outcome: this.outcome,
      });
    } catch {
      console.error(JSON.stringify({ event: "audit_write_failed", attemptId: this.id }));
    }
  }
}
