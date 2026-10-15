import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import { timingSafeEqual } from "node:crypto";
import type { IdentityStorage } from "./storage.js";
import type { DashboardConfig } from "./dashboard-config.js";
import { createDashboardSessions, DashboardAuthError, dashboardSessionLifetimeSeconds } from "./dashboard-sessions.js";
import { isDashboardHttps, loginSourceIp } from "./source-ip.js";
import { validatePassword } from "./passwords.js";
import { createMember } from "./member-accounts.js";
import { safeUser } from "./safe-user.js";
import { registerApiKeyRoutes } from "./api-key-routes.js";
import { paginationInput } from "./pagination.js";
import { changeUserAccess } from "./user-roles.js";
import { resetUserPassword } from "./password-reset.js";

const cookieName = "urumi_dashboard";
const passwordInput = z.string().refine((value) => {
  try { validatePassword(value); return true; }
  catch { return false; }
});

function requireTrustedOrigin(request: FastifyRequest, config: DashboardConfig) {
  if (!config.trustedOrigins.includes(request.headers.origin ?? "")) throw new DashboardAuthError(403, "Forbidden");
}

function requireCsrf(request: FastifyRequest, token: string) {
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
    throw new DashboardAuthError(403, "Forbidden");
  }
}
function credential(request: FastifyRequest) {
  const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined;
}
function cookie(value: string, expires: Date, secure: boolean, maxAge = dashboardSessionLifetimeSeconds) {
  return `${cookieName}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`;
}

export async function registerDashboardRoutes(app: FastifyInstance, storage: IdentityStorage, config: DashboardConfig,
  registerAdminRoutes?: (admin: FastifyInstance) => void,
) {
  const sessions = await createDashboardSessions(storage);
  await app.register(async (routes) => {
    routes.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof DashboardAuthError) return reply.code(error.status).send({ error: error.message });
      // Parsing and validation failures never echo input or internal exceptions.
      const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) {
        return reply.code(status).send({ error: "Invalid request" });
      }
      request.log.error("Dashboard authentication unavailable");
      return reply.code(503).send({ error: "Authentication unavailable" });
    });
    routes.addHook("preHandler", async (request) => {
      if (!(await storage.isAvailable())) throw new DashboardAuthError(503, "Authentication unavailable");
      if (!config.allowHttp && !isDashboardHttps(request, config.trustedProxies)) throw new DashboardAuthError(403, "Forbidden");
    });
    routes.post("/api/auth/login", { bodyLimit: 4096 }, async (request, reply) => {
      requireTrustedOrigin(request, config);
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardAuthError(415, "Invalid request");
      const parsed = z.strictObject({
        email: z.string().trim().toLowerCase().email().max(254),
        password: passwordInput,
      }).safeParse(request.body);
      if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
      const result = await sessions.login(parsed.data.email, parsed.data.password, loginSourceIp(request, config.trustedProxies));
      reply.header("Set-Cookie", cookie(result.credential, result.expiresAt, !config.allowHttp));
      return { user: result.user, csrfToken: result.csrfToken };
    });
    routes.get("/api/auth/me", async (request) => sessions.authenticate(credential(request), { allowRequiredPasswordChange: true }));
    routes.post("/api/auth/change-password", { bodyLimit: 4096 }, async (request, reply) => {
      requireTrustedOrigin(request, config);
      const token = credential(request);
      const authenticated = await sessions.authenticate(token, { allowRequiredPasswordChange: true });
      requireCsrf(request, authenticated.csrfToken);
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardAuthError(415, "Invalid request");
      const parsed = z.strictObject({ currentPassword: passwordInput, newPassword: passwordInput }).safeParse(request.body);
      if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
      if (!token) throw new DashboardAuthError(401, "Unauthorized");
      await sessions.changePassword(token, parsed.data.currentPassword, parsed.data.newPassword);
      reply.header("Set-Cookie", cookie("", new Date(0), !config.allowHttp, 0));
      return reply.code(204).send();
    });
    routes.post("/api/auth/logout", { bodyLimit: 4096 }, async (request, reply) => {
      requireTrustedOrigin(request, config);
      if (request.body !== undefined && !z.strictObject({}).safeParse(request.body).success) {
        throw new DashboardAuthError(400, "Invalid request");
      }
      const token = credential(request);
      const authenticated = await sessions.authenticate(token, { allowRequiredPasswordChange: true });
      requireCsrf(request, authenticated.csrfToken);
      // Authentication above guarantees an opaque credential.
      if (!token) throw new DashboardAuthError(401, "Unauthorized");
      await sessions.logout(token);
      reply.header("Set-Cookie", cookie("", new Date(0), !config.allowHttp, 0));
      return reply.code(204).send();
    });
    await registerApiKeyRoutes(routes, storage, async (request) => {
      const authenticated = await sessions.authenticate(credential(request));
      if (request.method !== "GET") {
        requireTrustedOrigin(request, config);
        requireCsrf(request, authenticated.csrfToken);
      }
      return authenticated.user.id;
    });
    await routes.register(async (admin) => {
      admin.addHook("preHandler", async (request) => {
        const authenticated = await sessions.authenticate(credential(request));
        if (authenticated.user.role !== "admin") throw new DashboardAuthError(403, "Forbidden");
        if (request.method !== "GET") {
          requireTrustedOrigin(request, config);
          requireCsrf(request, authenticated.csrfToken);
        }
      });
      registerAdminRoutes?.(admin);
      await registerApiKeyRoutes(admin, storage, async (request) => {
        const parsed = z.object({ userId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).safeParse(request.params);
        if (!parsed.success) throw new DashboardAuthError(404, "User not found");
        const user = await storage.users.findById(parsed.data.userId);
        if (!user) throw new DashboardAuthError(404, "User not found");
        return user._id.toHexString();
      }, "/api/admin/users/:userId/keys");
      admin.post("/api/admin/users", { bodyLimit: 4096 }, async (request, reply) => {
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardAuthError(415, "Invalid request");
        const parsed = z.strictObject({
          email: z.string().trim().toLowerCase().email().max(254), password: passwordInput,
        }).safeParse(request.body);
        if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
        const user = await createMember(storage, parsed.data.email, parsed.data.password);
        return reply.code(201).send({ user });
      });
      admin.post("/api/admin/users/:userId/reset-password", { bodyLimit: 4096 }, async (request, reply) => {
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardAuthError(415, "Invalid request");
        const params = z.strictObject({ userId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).safeParse(request.params);
        const body = z.strictObject({ password: passwordInput }).safeParse(request.body);
        if (!params.success || !body.success) throw new DashboardAuthError(400, "Invalid request");
        await resetUserPassword(storage, params.data.userId, body.data.password);
        return reply.code(204).send();
      });
      admin.get("/api/admin/users/:userId", async (request) => {
        const parsed = z.strictObject({ userId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).safeParse(request.params);
        if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
        const user = await storage.users.findById(parsed.data.userId);
        if (!user) throw new DashboardAuthError(404, "User not found");
        return { user: safeUser(user) };
      });
      admin.patch("/api/admin/users/:userId", { bodyLimit: 4096 }, async (request) => {
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardAuthError(415, "Invalid request");
        const params = z.strictObject({ userId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).safeParse(request.params);
        const body = z.strictObject({
          role: z.enum(["admin", "member"]).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        }).refine((value) => value.role !== undefined || value.status !== undefined).safeParse(request.body);
        if (!params.success || !body.success) throw new DashboardAuthError(400, "Invalid request");
        return { user: await changeUserAccess(storage, params.data.userId, body.data) };
      });
      admin.get("/api/admin/users", async (request) => {
        const parsed = paginationInput.safeParse(request.query);
        if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
        const { page, limit } = parsed.data;
        const users = await storage.users.find().sort({ _id: 1 }).skip((page - 1) * limit).limit(limit);
        return { users: users.map(safeUser), page, limit };
      });
    });
  });
}
