import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import type { IdentityStorage } from "./storage.js";
import { DashboardAuthError } from "./dashboard-sessions.js";
import { issueApiKey, revokeApiKey, safeApiKey } from "./api-keys.js";
import { paginationInput } from "./pagination.js";

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  storage: IdentityStorage,
  resolveOwnerId: (request: FastifyRequest) => Promise<string>,
  path = "/api/keys",
) {
  app.post(path, { bodyLimit: 4096 }, async (request, reply) => {
    const userId = await resolveOwnerId(request);
    if (!z.strictObject({}).safeParse(request.query).success) throw new DashboardAuthError(400, "Invalid request");
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardAuthError(415, "Invalid request");
    const parsed = z.strictObject({ name: z.string().max(100).optional() }).safeParse(request.body);
    if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
    return reply.code(201).send(await issueApiKey(storage, userId, parsed.data.name));
  });
  app.get(path, async (request) => {
    const userId = await resolveOwnerId(request);
    const parsed = paginationInput.safeParse(request.query);
    if (!parsed.success) throw new DashboardAuthError(400, "Invalid request");
    const { page, limit } = parsed.data;
    const keys = await storage.apiKeys.find({ userId }).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit);
    return { keys: keys.map(safeApiKey), page, limit };
  });
  app.delete(`${path}/:keyId`, { bodyLimit: 4096 }, async (request, reply) => {
    const userId = await resolveOwnerId(request);
    if (!z.strictObject({}).safeParse(request.query).success
      || (request.body !== undefined && !z.strictObject({}).safeParse(request.body).success)) {
      throw new DashboardAuthError(400, "Invalid request");
    }
    const parsed = z.object({ keyId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).safeParse(request.params);
    if (!parsed.success) throw new DashboardAuthError(404, "Key not found");
    await revokeApiKey(storage, userId, parsed.data.keyId);
    return reply.code(204).send();
  });
}
