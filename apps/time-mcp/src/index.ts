import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";

import { toNodeHandler } from "@modelcontextprotocol/node";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { createTimeMcpServer } from "./mcp-server.js";

const port = Number(process.env.PORT ?? 3003);

const host = process.env.HOST ?? "127.0.0.1";

const allowedHosts = (
  process.env.MCP_ALLOWED_HOSTS ??
  "localhost,127.0.0.1"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const app = createMcpFastifyApp({
  host,
  allowedHosts,
});

const mcpHandler = createMcpHandler(
  createTimeMcpServer
);

const nodeHandler = toNodeHandler(mcpHandler);

app.get("/health/live", async () => ({
  status: "ok",
  service: "time-mcp",
}));

app.get("/health/ready", async () => ({
  status: "ok",
  service: "time-mcp",
}));

app.all("/mcp", (request, reply) => {
  return nodeHandler(
    request.raw,
    reply.raw,
    request.body
  );
});

try {
  await app.listen({
    port,
    host,
  });

  app.log.info(
    `Time MCP server listening on ${host}:${port}`
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}