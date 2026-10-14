import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { createGatewayApp } from "./app.js";
import type { AuditRecord } from "./audit/logger.js";

test("SDK discovery and calls use a controlled upstream and injected audit logger", async (t) => {
  const previousKey = process.env.GATEWAY_BOOTSTRAP_KEY;
  process.env.GATEWAY_BOOTSTRAP_KEY = "test-only-gateway-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.GATEWAY_BOOTSTRAP_KEY;
    else process.env.GATEWAY_BOOTSTRAP_KEY = previousKey;
  });

  const upstream = createMcpFastifyApp({ host: "127.0.0.1" });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "controlled-calculator", version: "1.0.0" });
    server.registerTool("calculate", {
      description: "Controlled calculator",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
    }, async ({ a, b }) => b === 0 ? ({
      isError: true,
      content: [{ type: "text", text: "Controlled tool error" }],
    }) : ({
      content: [{ type: "text", text: String(a * b) }],
      structuredContent: { result: a * b },
    }));
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  upstream.all("/mcp", (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
  upstream.addHook("onClose", () => handler.close());
  t.after(() => upstream.close());
  const upstreamAddress = await upstream.listen({ host: "127.0.0.1", port: 0 });

  const records: AuditRecord[] = [];
  const app = await createGatewayApp({
    upstreams: [{ name: "calculator", url: `${upstreamAddress}/mcp`, enabled: true }],
    auditLogger: { async write(record) { records.push(record); } },
  });
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "gateway-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer test-only-gateway-key" } },
  }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "calculator.calculate");
  assert.equal(tools[0].description, "Controlled calculator");
  assert.deepEqual(tools[0].inputSchema.required, ["a", "b"]);
  assert.deepEqual(tools[0].inputSchema.properties, { a: { type: "number" }, b: { type: "number" } });
  const result = await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  assert.deepEqual(result.content, [{ type: "text", text: "42" }]);
  assert.deepEqual(result.structuredContent, { result: 42 });
  assert.equal(records.length, 1);
  assert.equal(records[0].userId, "bootstrap-admin");
  assert.equal(records[0].keyId, "bootstrap-key");
  assert.equal(records[0].toolName, "calculator.calculate");
  assert.equal(records[0].upstreamName, "calculator");
  assert.equal(records[0].outcome, "success");
  assert.ok(records[0].requestId);
  const toolError = await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 0 } });
  assert.equal(toolError.isError, true);
  assert.deepEqual(toolError.content, [{ type: "text", text: "Controlled tool error" }]);
  assert.equal(records[1].outcome, "tool_error");
  assert.equal((await client.listTools()).tools.length, 1);
  assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 200);
});

test("HTTP authentication and health remain intact across application start/close cycles", async (t) => {
  const previousKey = process.env.GATEWAY_BOOTSTRAP_KEY;
  process.env.GATEWAY_BOOTSTRAP_KEY = "test-only-gateway-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.GATEWAY_BOOTSTRAP_KEY;
    else process.env.GATEWAY_BOOTSTRAP_KEY = previousKey;
  });

  for (let cycle = 0; cycle < 2; cycle++) {
    const app = await createGatewayApp({ upstreams: [] });
    t.after(() => app.close());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    assert.deepEqual(await (await fetch(`${address}/health/live`)).json(), { status: "ok", service: "gateway" });
    assert.equal((await fetch(`${address}/health/ready`)).status, 503);
    for (const headers of [new Headers(), new Headers({ Authorization: "Bearer incorrect" })]) {
      const response = await fetch(`${address}/mcp?test=auth`, { headers });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="urumi-gateway"');
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    }
    delete process.env.GATEWAY_BOOTSTRAP_KEY;
    const unavailable = await fetch(`${address}/mcp`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "Authentication unavailable" });
    process.env.GATEWAY_BOOTSTRAP_KEY = "test-only-gateway-key";
    await app.close();
    await assert.rejects(fetch(`${address}/health/live`));
  }
});
