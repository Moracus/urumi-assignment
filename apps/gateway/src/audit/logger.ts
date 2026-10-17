export type AuditOutcome =
  | "unauthenticated"
  | "rejected"
  | "success"
  | "tool_error"
  | "unauthorized"
  | "not_found"
  | "upstream_error"
  | "upstream_unavailable"
  | "upstream_timeout";
export interface AuditRecord {
  requestId: string;
  attemptId: string;
  authenticationOrigin: "gateway_api_key" | "dashboard_session" | null;
  userEmail: string | null;
  upstreamId: string | null;
  upstreamDisplayName: string | null;

  userId: string | null;

  keyId: string | null;

  upstreamName: string | null;

  toolName: string;

  timestamp: string;

  durationMs: number;

  outcome: AuditOutcome;
}

export interface AuditLogger {
  write(record: AuditRecord): Promise<void>;
}

export class ConsoleAuditLogger implements AuditLogger {
  async write(record: AuditRecord): Promise<void> {
    console.info(
      JSON.stringify({
        event: "tool_execution",
        ...record,
      }),
    );
  }
}