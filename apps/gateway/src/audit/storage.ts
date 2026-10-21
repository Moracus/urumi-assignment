import { Schema, type Connection, type QueryFilter } from "mongoose";
import type { AuditLogger, AuditRecord } from "./logger.js";

export interface AuditFilters {
  userId?: string;
  upstreamId?: string;
  toolName?: string;
  outcome?: AuditRecord["outcome"];
  activity?: "attempts" | "failures" | "durations";
  from?: string;
  to?: string;
}

const auditOutcomes: AuditRecord["outcome"][] = ["unauthenticated", "rejected", "success", "tool_error", "unauthorized",
  "not_found", "upstream_error", "upstream_unavailable", "upstream_timeout"];
interface WindowAggregation {
  groups: { _id: { upstreamId: string | null; name: string | null; displayName: string | null; outcome: string }; count: number }[];
  durations: { _id: string; durationSampleCount: number; averageDurationMs: number | null; p95: (number | null)[] }[];
  trends: { _id: { upstreamId: string | null; name: string | null; displayName: string | null; bucket: number };
    outcomes: Record<AuditRecord["outcome"], number> }[];
}

const auditSchema = new Schema<AuditRecord>({
  attemptId: { type: String, required: true },
  requestId: { type: String, required: true },
  userId: { type: String, default: null },
  userEmail: { type: String, default: null },
  authenticationOrigin: { type: String, enum: ["gateway_api_key", "dashboard_session", null], default: null },
  keyId: { type: String, default: null },
  upstreamId: { type: String, default: null },
  upstreamName: { type: String, default: null },
  upstreamDisplayName: { type: String, default: null },
  toolName: { type: String, required: true },
  timestamp: { type: String, required: true },
  durationMs: { type: Number, required: true, min: 0 },
  outcome: { type: String, required: true, enum: ["unauthenticated", "rejected", "success", "tool_error", "unauthorized", "not_found",
    "upstream_error", "upstream_unavailable", "upstream_timeout"] },
}, { strict: "throw", bufferCommands: false, versionKey: false });
auditSchema.index({ timestamp: -1, _id: -1 });
auditSchema.index({ upstreamId: 1, timestamp: -1 });
auditSchema.index({ attemptId: 1 }, { unique: true });

export async function createAuditStorage(connection: Connection) {
  const records = connection.model("ToolAudit", auditSchema, "tool_audit");
  await records.createCollection();
  await records.createIndexes();
  return {
    async write(record: AuditRecord) {
      // Explicit projection keeps payloads out even if a runtime caller supplies extra fields.
      await records.create({ attemptId: record.attemptId, requestId: record.requestId,
        userId: record.userId, userEmail: record.userEmail, authenticationOrigin: record.authenticationOrigin,
        keyId: record.authenticationOrigin === "gateway_api_key" ? record.keyId : null,
        upstreamId: record.upstreamId, upstreamName: record.upstreamName, upstreamDisplayName: record.upstreamDisplayName,
        toolName: record.toolName, timestamp: record.timestamp, durationMs: record.durationMs, outcome: record.outcome });
    },
    async aggregateWindow(from: string, to: string, bucketMs: number, upstreamId?: string) {
      const match = { timestamp: { $gte: from, $lt: to }, ...(upstreamId ? { upstreamId } : {}) };
      // Registration identity, rather than name snapshots, is the duration population.
      const identity = { upstreamId: { $ifNull: ["$upstreamId", null] },
        name: { $cond: ["$upstreamId", null, { $ifNull: ["$upstreamName", null] }] },
        displayName: { $cond: ["$upstreamId", null, { $ifNull: ["$upstreamDisplayName", null] }] } };
      const sample = { $cond: [{ $and: [{ $in: ["$outcome", ["success", "tool_error"]] },
        { $isNumber: "$durationMs" }, { $gte: ["$durationMs", 0] }, { $lte: ["$durationMs", Number.MAX_VALUE] }] }, "$durationMs", null] };
      // All facets consume the same matched audit stream, so totals and buckets agree
      // even while new audit records are being inserted. Limits apply after grouping.
      const [result] = await records.aggregate<WindowAggregation>([
        { $match: match },
        { $facet: {
          groups: [
            { $group: { _id: { upstreamId: { $ifNull: ["$upstreamId", null] }, name: { $ifNull: ["$upstreamName", null] },
              displayName: { $ifNull: ["$upstreamDisplayName", null] }, outcome: "$outcome" }, count: { $sum: 1 } } },
            { $limit: 4501 },
          ],
          durations: [
            { $match: { upstreamId: { $type: "string" } } },
            { $set: { sample } },
            { $group: { _id: "$upstreamId", durationSampleCount: { $sum: { $cond: [{ $ne: ["$sample", null] }, 1, 0] } },
              averageDurationMs: { $avg: "$sample" }, p95: { $percentile: { input: "$sample", p: [0.95], method: "approximate" } } } },
            { $limit: 501 },
          ],
          trends: [
            { $group: { _id: { ...identity, bucket: { $multiply: [
              { $floor: { $divide: [{ $toLong: { $toDate: "$timestamp" } }, bucketMs] } }, bucketMs] } },
              ...Object.fromEntries(auditOutcomes.map(outcome =>
                [outcome, { $sum: { $cond: [{ $eq: ["$outcome", outcome] }, 1, 0] } }])) } },
            { $project: { _id: 1, outcomes: Object.fromEntries(auditOutcomes.map(outcome => [outcome, `$${outcome}`])) } },
            { $limit: 12001 },
          ],
        } },
      ]).option({ maxTimeMS: 5000, allowDiskUse: false });
      return result ?? { groups: [], durations: [], trends: [] };
    },
    async page(page: number, limit: number, filters: AuditFilters = {}) {
      const query: QueryFilter<AuditRecord> = {};
      if (filters.userId) query.userId = filters.userId;
      if (filters.upstreamId) query.upstreamId = filters.upstreamId;
      if (filters.toolName) query.toolName = filters.toolName;
      const populations: Record<NonNullable<AuditFilters["activity"]>, AuditRecord["outcome"][]> = {
        attempts: ["success", "tool_error", "upstream_error", "upstream_unavailable", "upstream_timeout"],
        failures: ["tool_error", "upstream_error", "upstream_unavailable", "upstream_timeout"],
        durations: ["success", "tool_error"],
      };
      if (filters.activity) {
        const population = populations[filters.activity];
        query.outcome = { $in: filters.outcome ? population.filter(outcome => outcome === filters.outcome) : population };
        // Metric populations require durable attribution, just as the aggregate does.
        if (!filters.upstreamId) query.upstreamId = { $type: "string" };
        if (filters.activity === "durations") query.durationMs = { $gte: 0, $lte: Number.MAX_VALUE };
      } else if (filters.outcome) query.outcome = filters.outcome;
      if (filters.from || filters.to) query.timestamp = {
        ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lt: filters.to } : {}),
      };
      const rows = await records.find(query).sort({ timestamp: -1, _id: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
      return { records: rows.slice(0, limit).map(row => ({
        id: row._id.toHexString(), attemptId: row.attemptId, requestId: row.requestId,
        userId: row.userId, userEmail: row.userEmail, authenticationOrigin: row.authenticationOrigin, keyId: row.keyId,
        upstreamId: row.upstreamId, upstreamName: row.upstreamName, upstreamDisplayName: row.upstreamDisplayName,
        toolName: row.toolName, timestamp: row.timestamp, durationMs: row.durationMs, outcome: row.outcome,
      })), page, limit, hasMore: rows.length > limit };
    },
  } satisfies AuditLogger & Record<string, unknown>;
}
