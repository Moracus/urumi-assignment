import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import { DashboardAuthError } from "../identity/dashboard-sessions.js";
import type { AuthenticatedIdentity } from "../security/identity.js";
import { runChat, type ChatDependencies } from "./run.js";

export interface ChatConfig { apiKey: string; endpoint?: string }

export function chatConfig(): ChatConfig | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  return apiKey && /^[\x21-\x7e]{8,8192}$/.test(apiKey) ? { apiKey } : undefined;
}

export function registerChatRoutes(routes: FastifyInstance,
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedIdentity>, config: ChatConfig | undefined,
  dependencies: ChatDependencies,
) {
  routes.get("/api/chat", async request => {
    await authenticate(request);
    return { available: Boolean(config) };
  });
  routes.post("/api/chat", { bodyLimit: 16_384 }, async (request, reply) => {
    await authenticate(request);
    const parsed = z.strictObject({ prompt: z.string().trim().min(1).max(8000) }).safeParse(request.body);
    if (!parsed.success) {
      throw new DashboardAuthError(400, "Invalid request");
    }
    if (!config) throw new DashboardAuthError(503, "Chat unavailable");
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    reply.raw.on("close", abort);
    try { return await runChat(parsed.data.prompt, config, dependencies, () => authenticate(request), disconnected.signal); }
    finally { reply.raw.off("close", abort); }
  });
}
