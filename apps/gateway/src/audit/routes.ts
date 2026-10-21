import { z } from "zod/v4";
import type { FastifyInstance } from "fastify";
import type { createAuditStorage } from "./storage.js";
import { paginationInput } from "../identity/pagination.js";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";

// Normalize offsets before lexicographic comparison of persisted UTC timestamps.
const time = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const queryInput = paginationInput.extend({
  userId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  upstreamId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  toolName: z.string().min(1).max(512).optional(),
  outcome: z.enum(["unauthenticated", "rejected", "success", "tool_error", "unauthorized", "not_found", "upstream_error", "upstream_unavailable", "upstream_timeout"]).optional(),
  activity: z.enum(["attempts", "failures", "durations"]).optional(),
  from: time.optional(), to: time.optional(),
}).refine(value => !value.from || !value.to || value.from < value.to);

export function registerAuditRoutes(admin: FastifyInstance, storage: Awaited<ReturnType<typeof createAuditStorage>>) {
  admin.get("/api/admin/audit", async request => {
    const parsed = queryInput.safeParse(request.query);
    if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
    const { page, limit, ...filters } = parsed.data;
    return storage.page(page, limit, filters);
  });
}
