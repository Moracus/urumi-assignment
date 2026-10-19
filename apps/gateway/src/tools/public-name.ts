import { createHash } from "node:crypto";

// Public names are shared by MCP and chat. Native names remain in the catalog;
// this deliberately non-reversible representation must never be used for routing.
export function makePublicToolName(upstreamName: string, upstreamToolName: string): string {
  const normalized = `${upstreamName}_${upstreamToolName}`
    .toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (normalized.length <= 64) return normalized;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${normalized.slice(0, 47)}_${suffix}`;
}
