export type AuditOutcome =
  | "success"
  | "tool_error"
  | "unauthorized"
  | "not_found"
  | "upstream_error";

export interface AuditRecord {
  requestId: string;

  userId: string;

  keyId: string;

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