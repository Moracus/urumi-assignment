import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";

import { toNodeHandler } from "@modelcontextprotocol/node";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { createWooCommerceMcpServer } from "./mcp-server.js";

const port = Number(process.env.PORT ?? 3001);

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

// Create the MCP protocol handler.
const mcpHandler = createMcpHandler(
  createWooCommerceMcpServer
);

// Adapt the MCP handler to Node.js.
const nodeHandler = toNodeHandler(mcpHandler);

// Keep the Kubernetes health endpoints.
app.get("/health/live", async () => ({
  status: "ok",
  service: "woocommerce-mcp",
}));

app.get("/health/ready", async () => ({
  status: "ok",
  service: "woocommerce-mcp",
}));

// MCP Streamable HTTP endpoint.
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
    `WooCommerce MCP server listening on ${host}:${port}`
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}