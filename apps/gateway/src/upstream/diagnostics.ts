import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";

export type FailureStage = "credentials" | "connection" | "discovery" | "invocation";
export type DiagnosticCode = "credentials_unavailable" | "connection_failed" | "discovery_failed" | "invocation_failed"
  | "dns_failed" | "tls_failed" | "connection_refused" | "http_authentication" | "timeout" | "invalid_mcp_response";
export interface UpstreamDiagnostic { stage: FailureStage; code: DiagnosticCode; observedAt: Date }

/** Carries only locally classified evidence; never attach an original error as cause. */
export class SafeUpstreamFailure extends Error {
  constructor(readonly code: DiagnosticCode) { super("Upstream request failed"); }
}

/** Use only at the DNS/socket adapter, never on an upstream JSON-RPC error. */
export function networkFailure(error: unknown): SafeUpstreamFailure {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new SafeUpstreamFailure("dns_failed");
  if (code === "ECONNREFUSED") return new SafeUpstreamFailure("connection_refused");
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(String(code))) return new SafeUpstreamFailure("tls_failed");
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return new SafeUpstreamFailure("timeout");
  return new SafeUpstreamFailure("connection_failed");
}

export function diagnose(stage: FailureStage, error: unknown): UpstreamDiagnostic {
  const fallback = { credentials: "credentials_unavailable", connection: "connection_failed", discovery: "discovery_failed", invocation: "invocation_failed" } as const;
  const code = stage === "credentials" ? fallback.credentials
    : error instanceof SafeUpstreamFailure ? error.code
    : error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout ? "timeout"
    : error instanceof SdkError && error.code === SdkErrorCode.InvalidResult ? "invalid_mcp_response"
    : fallback[stage];
  return { stage, code, observedAt: new Date() };
}
