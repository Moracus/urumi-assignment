import { z } from "zod/v4";
import type { FastifyInstance } from "fastify";
import type { createAuditStorage } from "./storage.js";
import type { RegistrationStorage } from "../upstream/registrations.js";
import type { UpstreamRegistry } from "../upstream/registry.js";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";

const time = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const input = z.strictObject({ preset: z.enum(["hour", "day", "week"]).optional(),
  from: time.optional(), to: time.optional(), upstreamId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
}).refine(v => (!v.from && !v.to) || (!!v.from && !!v.to && !v.preset));
import { observabilitySchema, outcomeSchema, type Observability } from "./observability-contract.js";
type Row = Observability["rows"][number];
function empty(kind: Row["kind"], upstreamId: string | null): Row {
  return { kind, upstreamId, historicalNames: [], current: null, attempts: 0, failures: 0, errorRate: null,
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
    const [groups, current] = await Promise.all([
      audit.aggregateWindow(from, to, upstreamId), registrations.observabilityRegistrations(),
    ]);
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
    if (rows.size > 500) throw new DashboardAuthError(503, "Observability window exceeds query limits");
    for (const row of rows.values()) {
      // Name-only/unresolved rows never enter a registration's denominator.
      if (row.kind !== "registration") continue;
      row.failures = row.outcomes.tool_error + row.outcomes.upstream_error + row.outcomes.upstream_unavailable + row.outcomes.upstream_timeout;
      row.attempts = row.outcomes.success + row.failures;
      row.errorRate = row.attempts ? row.failures / row.attempts : null;
    }
    return observabilitySchema.parse({ from, to, generatedAt, rows: [...rows.values()].sort((a, b) =>
      (a.upstreamId ?? JSON.stringify(a.historicalNames)).localeCompare(b.upstreamId ?? JSON.stringify(b.historicalNames))) });
  });
}
