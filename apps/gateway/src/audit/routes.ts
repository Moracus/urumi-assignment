import type { FastifyInstance } from "fastify";
import type { createAuditStorage } from "./storage.js";
import { paginationInput } from "../identity/pagination.js";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";

export function registerAuditRoutes(admin: FastifyInstance, storage: Awaited<ReturnType<typeof createAuditStorage>>) {
  admin.get("/api/admin/audit", async request => {
    const parsed = paginationInput.safeParse(request.query);
    if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
    return storage.page(parsed.data.page, parsed.data.limit);
  });
}
