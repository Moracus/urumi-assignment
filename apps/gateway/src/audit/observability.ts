import { z } from "zod/v4";
import type { FastifyInstance } from "fastify";
import type { createAuditStorage } from "./storage.js";
import type { RegistrationStorage } from "../upstream/registrations.js";
import type { UpstreamRegistry } from "../upstream/registry.js";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";

const time = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const input = z.strictObject({ preset: z.enum(["hour", "day", "week"]).optional(),
  bucket: z.enum(["5minute", "hour", "day"]).optional(), from: time.optional(), to: time.optional(), upstreamId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
}).refine(v => (!v.from && !v.to) || (!!v.from && !!v.to && !v.preset));
import { observabilitySchema, outcomeSchema, type Observability } from "./observability-contract.js";
type Row = Observability["rows"][number];
function empty(kind: Row["kind"], upstreamId: string | null): Row {
  return { kind, upstreamId, historicalNames: [], current: null, attempts: 0, failures: 0, errorRate: null, durationSampleCount: 0, averageDurationMs: null, p95DurationMs: null, timeoutCount: 0, trend: [],
    outcomes: { success: 0, tool_error: 0, upstream_error: 0, upstream_unavailable: 0, upstream_timeout: 0,
      rejected: 0, unauthorized: 0, not_found: 0, unauthenticated: 0 } };
}
export function registerObservabilityRoutes(admin: FastifyInstance, audit: Awaited<ReturnType<typeof createAuditStorage>>,
  registrations: RegistrationStorage, registry: UpstreamRegistry) {
  admin.get("/api/admin/observability", async request => {
    const parsed = input.safeParse(request.query);
    if (!parsed.success) throw new DashboardAuthError(400, "Invalid observability window");
    const generatedAt = new Date().toISOString();
    const { preset = "day", upstreamId } = parsed.data;
    const to = parsed.data.to ?? generatedAt;
    const from = parsed.data.from ?? new Date(Date.parse(to) - { hour: 3600000, day: 86400000, week: 604800000 }[preset]).toISOString();
    if (from >= to || Date.parse(to) - Date.parse(from) > 604800000) throw new DashboardAuthError(400, "Invalid observability window");
    const bucket = parsed.data.bucket ?? (Date.parse(to) - Date.parse(from) <= 3600000 ? "5minute"
      : Date.parse(to) - Date.parse(from) <= 86400000 ? "hour" : "day");
    const bucketMs = { "5minute": 300000, hour: 3600000, day: 86400000 }[bucket];
    const firstBucket = Math.floor(Date.parse(from) / bucketMs) * bucketMs;
    const bucketCount = Math.ceil((Date.parse(to) - firstBucket) / bucketMs);
    if (bucketCount > 169) throw new DashboardAuthError(400, "Observability window exceeds bucket limits");
    const [metrics, current] = await Promise.all([
      audit.aggregateWindow(from, to, bucketMs, upstreamId), registrations.observabilityRegistrations(),
    ]);
    const { groups } = metrics;
    if (groups.length > 4500 || current.length > 500) throw new DashboardAuthError(503, "Observability window exceeds query limits");
    const rows = new Map<string, Row>();
    for (const group of groups) {
      const { upstreamId: id, name, displayName, outcome } = group._id;
      const kind = id ? "registration" : name || displayName ? "legacy" : "unattributed";
      const key = id ?? JSON.stringify([kind, name, displayName]);
      const row = rows.get(key) ?? empty(kind, id);
      if (!row.historicalNames.some(n => n.name === name && n.displayName === displayName)) row.historicalNames.push({ name, displayName });
      const outcomeKey = z.keyof(outcomeSchema).parse(outcome);
      row.outcomes[outcomeKey] += group.count;
      rows.set(key, row);
    }
    for (const server of current) {
      const id = server._id.toHexString();
      if (upstreamId && upstreamId !== id) continue;
      const row = rows.get(id) ?? empty("registration", id);
      const state = registry.getState(server.serverId);
      const matches = state?.config.registrationId === id && state.config.configurationRevision === server.configurationRevision;
      row.current = { name: server.serverId, displayName: server.displayName,
        status: !server.enabled ? "disabled" : matches ? state.status : "disconnected" };
      rows.set(id, row);
    }
    if (rows.size > 500 || rows.size * bucketCount > 12000 || metrics.durations.length > 500 || metrics.trends.length > 12000) throw new DashboardAuthError(503, "Observability window exceeds query limits");
    const trendGroups = new Map(metrics.trends.map(group => [JSON.stringify([group._id.upstreamId ??
      JSON.stringify([group._id.name || group._id.displayName ? "legacy" : "unattributed", group._id.name, group._id.displayName]), group._id.bucket]), group.outcomes]));
    for (const [key, row] of rows) {
      row.timeoutCount = row.outcomes.upstream_timeout;
      row.trend = Array.from({ length: bucketCount }, (_, i) => {
        const start = firstBucket + i * bucketMs;
        const outcomes = trendGroups.get(JSON.stringify([key, start])) ?? empty(row.kind, row.upstreamId).outcomes;
        const failures = row.kind === "registration" ? outcomes.tool_error + outcomes.upstream_error + outcomes.upstream_unavailable + outcomes.upstream_timeout : 0;
        return { from: new Date(Math.max(start, Date.parse(from))).toISOString(), to: new Date(Math.min(start + bucketMs, Date.parse(to))).toISOString(),
          outcomes, failures, attempts: row.kind === "registration" ? outcomes.success + failures : 0, timeoutCount: outcomes.upstream_timeout };
      });
      const duration = metrics.durations.find(d => d._id === row.upstreamId);
      if (duration) {
        row.durationSampleCount = duration.durationSampleCount;
        row.averageDurationMs = duration.averageDurationMs;
        row.p95DurationMs = duration.p95[0] ?? null;
      }
      // Name-only/unresolved rows never enter a registration's denominator.
      if (row.kind !== "registration") continue;
      row.failures = row.outcomes.tool_error + row.outcomes.upstream_error + row.outcomes.upstream_unavailable + row.outcomes.upstream_timeout;
      row.attempts = row.outcomes.success + row.failures;
      row.errorRate = row.attempts ? row.failures / row.attempts : null;
    }
    return observabilitySchema.parse({ from, to, generatedAt, bucket, percentileMethod: "approximate", rows: [...rows.values()].sort((a, b) =>
      (a.upstreamId ?? JSON.stringify(a.historicalNames)).localeCompare(b.upstreamId ?? JSON.stringify(b.historicalNames))) });
  });
}
