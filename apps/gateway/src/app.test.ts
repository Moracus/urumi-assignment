import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Client, StreamableHTTPClientTransport, SdkHttpError, ProtocolError } from "@modelcontextprotocol/client";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { createGatewayApp, type GatewayAppOptions } from "./app.js";
import { hashPassword } from "./identity/passwords.js";
import type { AuditRecord } from "./audit/logger.js";

const origin = "http://localhost:3000";
const password = "a final MCP test password";

async function fixture(t: TestContext, options: Pick<GatewayAppOptions, "upstreams" | "auditLogger"> = {}) {
  assert.ok(process.env.MONGODB_TEST_URI, "Use the real MongoDB integration runner");
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  const db = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 2000 }).asPromise();
  const user = await db.collection("users").insertOne({
    email: "member@example.com", passwordHash: await hashPassword(password), role: "member", status: "active",
    requiredPasswordChange: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP };
  process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  const app = await createGatewayApp({ upstreams: [], ...options, mongodbUri: uri.toString() });
  t.after(async () => {
    await app.close();
    await db.dropDatabase(); await db.close();
    if (previous.origins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    else process.env.DASHBOARD_TRUSTED_ORIGINS = previous.origins;
    if (previous.http === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
    else process.env.DASHBOARD_ALLOW_HTTP = previous.http;
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": login.json().csrfToken };
  const issued = await app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
  assert.equal(issued.statusCode, 201);
  const { key, rawKey } = issued.json();
  return {
    app, db, address, userId: user.insertedId.toHexString(), headers, key, rawKey,
    async connect(credential = rawKey) {
      const client = new Client({ name: "gateway-test", version: "1.0.0" });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      }));
      return client;
    },
  };
}

const httpFailure = (status: number) => (error: unknown) => {
  assert.ok(error instanceof SdkHttpError);
  assert.equal(error.data.status, status);
  assert.equal(error.data.text, JSON.stringify({ error: status === 401 ? "Unauthorized" : "Authentication unavailable" }));
  return true;
};

async function controlledUpstream(t: TestContext, name: string, register: (server: McpServer) => void) {
  const app = createMcpFastifyApp({ host: "127.0.0.1" });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name, version: "1.0.0" });
    register(server);
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  app.all("/mcp", (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
  app.addHook("onClose", () => handler.close());
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, config: { name, url: `${address}/mcp`, enabled: true } };
}

function calculatorUpstream(t: TestContext) {
  return controlledUpstream(t, "calculator", (server) => {
    server.registerTool("calculate", { inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a * b) }],
    }));
  });
}

test("SDK discovery and calls use a controlled upstream and injected audit logger", async (t) => {

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
  const f = await fixture(t, {
    upstreams: [{ name: "calculator", url: `${upstreamAddress}/mcp`, enabled: true }],
    auditLogger: { async write(record) { records.push(record); } },
  });
  const { app } = f;
  const client = await f.connect();
  const { tools } = await client.listTools(undefined, { cacheMode: "bypass" });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "calculator.calculate");
  assert.equal(tools[0].description, "Controlled calculator");
  assert.deepEqual(tools[0].inputSchema.required, ["a", "b"]);
  assert.deepEqual(tools[0].inputSchema.properties, { a: { type: "number" }, b: { type: "number" } });
  const result = await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  assert.deepEqual(result.content, [{ type: "text", text: "42" }]);
  assert.deepEqual(result.structuredContent, { result: 42 });
  assert.equal(records.length, 1);
  assert.equal(records[0].userId, f.userId);
  assert.equal(records[0].keyId, f.key.id);
  assert.equal(records[0].toolName, "calculator.calculate");
  assert.equal(records[0].upstreamName, "calculator");
  assert.equal(records[0].outcome, "success");
  assert.ok(records[0].requestId);
  const toolError = await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 0 } });
  assert.equal(toolError.isError, true);
  assert.deepEqual(toolError.content, [{ type: "text", text: "Controlled tool error" }]);
  assert.equal(records[1].outcome, "tool_error");
  assert.equal((await client.listTools(undefined, { cacheMode: "bypass" })).tools.length, 1);
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
    const app = await createGatewayApp({ upstreams: [], mongodbUri: process.env.MONGODB_TEST_URI });
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
    assert.equal(unavailable.status, 401);
    assert.deepEqual(await unavailable.json(), { error: "Unauthorized" });
    process.env.GATEWAY_BOOTSTRAP_KEY = "test-only-gateway-key";
    await app.close();
    await assert.rejects(fetch(`${address}/health/live`));
  }
});

test("connected MCP clients lose access on the very next request after key revocation", async (t) => {
  const upstream = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [upstream.config] });
  const client = await f.connect();
  await client.listTools(undefined, { cacheMode: "bypass" });
  const used = (await f.app.inject({ url: "/api/keys", headers: f.headers })).json().keys[0];
  assert.ok(Number.isFinite(Date.parse(used.lastUsedAt)));
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/keys/${f.key.id}`, headers: f.headers })).statusCode, 204);
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), httpFailure(401));
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: { a: 1, b: 2 } }), httpFailure(401));
  await assert.rejects(f.connect(), httpFailure(401));
  const after = (await f.app.inject({ url: "/api/keys", headers: f.headers })).json().keys[0];
  assert.equal(after.lastUsedAt, used.lastUsedAt);
});

test("MCP rejects bootstrap, missing, malformed, orphaned and ineligible credentials without cookie or session bypass", async (t) => {
  const upstream = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [upstream.config] });
  const previous = process.env.GATEWAY_BOOTSTRAP_KEY;
  const bootstrap = `ugw_${"A".repeat(43)}`;
  process.env.GATEWAY_BOOTSTRAP_KEY = bootstrap;
  t.after(() => {
    if (previous === undefined) delete process.env.GATEWAY_BOOTSTRAP_KEY;
    else process.env.GATEWAY_BOOTSTRAP_KEY = previous;
  });
  for (const credential of [bootstrap, "incorrect", `ugw_${"B".repeat(43)}`]) {
    await assert.rejects(f.connect(credential), httpFailure(401));
  }
  for (const authorization of [undefined, "Bearer", `Basic ${f.rawKey}`, `Bearer ${f.rawKey} extra`]) {
    const client = new Client({ name: "cookie-bypass", version: "1.0.0" });
    t.after(() => client.close());
    await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(`${f.address}/mcp`), {
      requestInit: { headers: { cookie: f.headers.cookie, "mcp-session-id": "invented-session", "x-user-id": f.userId,
        "x-role": "admin", ...(authorization ? { authorization } : {}) } },
    })), httpFailure(401));
  }
  const client = await f.connect();
  const userId = new mongoose.Types.ObjectId(f.userId);
  for (const state of [{ status: "disabled", requiredPasswordChange: false }, { status: "active", requiredPasswordChange: true }]) {
    await f.db.collection("users").updateOne({ _id: userId }, { $set: state });
    await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), httpFailure(401));
    await assert.rejects(f.connect(), httpFailure(401));
  }
  await f.db.collection("users").deleteOne({ _id: userId });
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), httpFailure(401));
  await assert.rejects(f.connect(), httpFailure(401));
});

test("fresh roles filter discovery and calls, last-use advances on denied tools, and concurrent identities stay isolated", async (t) => {
  let writes = 0;
  const woocommerce = await controlledUpstream(t, "woocommerce", (server) => {
    for (const name of ["list_products", "list_orders", "get_order", "create_product", "update_order_status"]) {
      server.registerTool(name, { description: `Controlled ${name}` }, async () => {
        if (name === "create_product" || name === "update_order_status") writes++;
        return { content: [{ type: "text", text: name }], structuredContent: { tool: name } };
      });
    }
  });
  const calculator = await calculatorUpstream(t);
  const time = await controlledUpstream(t, "time", (server) => {
    server.registerTool("current", {}, async () => ({ content: [{ type: "text", text: "UTC" }] }));
  });
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [woocommerce.config, calculator.config, time.config],
    auditLogger: { async write(record) { records.push(record); } } });
  const otherUser = await f.db.collection("users").insertOne({ email: "admin@example.com", role: "admin", status: "active",
    requiredPasswordChange: false, passwordHash: await hashPassword(password), createdAt: new Date(), updatedAt: new Date() });
  const login = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "admin@example.com", password } });
  assert.equal(login.statusCode, 200);
  const adminHeaders = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": login.json().csrfToken };
  async function changeRole(role: "admin" | "member") {
    const response = await f.app.inject({ method: "PATCH", url: `/api/admin/users/${f.userId}`, headers: adminHeaders, payload: { role } });
    assert.equal(response.statusCode, 200, response.body);
  }
  const client = await f.connect();
  const memberTools = ["calculator.calculate", "time.current", "woocommerce.get_order", "woocommerce.list_orders", "woocommerce.list_products"];
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map((tool) => tool.name).sort(), memberTools);
  async function denied(name: string) {
    // SDK eras may represent an unknown registered tool as a protocol error or an isError result.
    await client.callTool({ name }).then(
      (result) => assert.equal(result.isError, true),
      (error: unknown) => assert.ok(error instanceof ProtocolError),
    );
  }
  for (const name of ["woocommerce.create_product", "woocommerce.update_order_status", "woocommerce.invented"]) await denied(name);
  assert.equal(writes, 0);
  assert.equal(records.length, 0);
  const usedBefore = (await f.app.inject({ url: "/api/keys", headers: f.headers })).json().keys[0].lastUsedAt;
  await denied("woocommerce.create_product");
  const usedAfter = (await f.app.inject({ url: "/api/keys", headers: f.headers })).json().keys[0].lastUsedAt;
  assert.ok(Date.parse(usedAfter) > Date.parse(usedBefore));
  await changeRole("admin");
  const adminTools = [...memberTools, "woocommerce.create_product", "woocommerce.update_order_status"].sort();
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map((tool) => tool.name).sort(), adminTools);
  const result = await client.callTool({ name: "woocommerce.create_product" });
  assert.deepEqual(result.structuredContent, { tool: "create_product" });
  assert.equal(writes, 1);
  assert.equal(records[0].userId, f.userId);
  assert.equal(records[0].keyId, f.key.id);
  await changeRole("member");
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map((tool) => tool.name).sort(), memberTools);
  await denied("woocommerce.update_order_status");
  assert.equal(writes, 1);
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", payload: {},
    headers: adminHeaders });
  assert.equal(issued.statusCode, 201);
  const admin = await f.connect(issued.json().rawKey);
  const offset = records.length;
  await Promise.all([
    client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } }),
    admin.callTool({ name: "woocommerce.update_order_status" }),
  ]);
  assert.deepEqual(records.slice(offset).map((record) => [record.toolName, record.userId, record.keyId]).sort(), [
    ["calculator.calculate", f.userId, f.key.id],
    ["woocommerce.update_order_status", otherUser.insertedId.toHexString(), issued.json().key.id],
  ]);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "keyId", "outcome", "requestId", "timestamp", "toolName", "upstreamName", "userId"]);
    assert.ok(!JSON.stringify(record).includes(f.rawKey));
    assert.ok(!JSON.stringify(record).includes(issued.json().rawKey));
  }
});

test("authenticated MCP timeout isolates an upstream, never retries writes, and recovers through normal refresh", async (t) => {
  let stall = true;
  let calls = 0;
  const woocommerce = await controlledUpstream(t, "woocommerce", (server) => {
    server.registerTool("create_product", {}, async () => {
      calls++;
      if (stall) await new Promise((resolve) => setTimeout(resolve, 11000));
      return { content: [{ type: "text", text: "Controlled product" }] };
    });
  });
  const time = await controlledUpstream(t, "time", (server) => {
    server.registerTool("current", {}, async () => ({ content: [{ type: "text", text: "UTC" }] }));
  });
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [woocommerce.config, time.config],
    auditLogger: { async write(record) { records.push(record); } } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const lastUsedBefore = (await f.app.inject({ url: "/api/keys", headers: f.headers })).json().keys[0].lastUsedAt;
  const started = Date.now();
  const result = await client.callTool({ name: "woocommerce.create_product" }, { timeout: 15000 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "Upstream request timed out" }]);
  assert.ok(Date.now() - started >= 9500);
  assert.ok(Date.now() - started < 15000);
  assert.equal(calls, 1);
  assert.equal(records[0].outcome, "upstream_timeout");
  assert.equal(records[0].userId, f.userId);
  assert.equal(records[0].keyId, f.key.id);
  const lastUsedAfter = (await f.app.inject({ url: "/api/keys", headers: f.headers })).json().keys[0].lastUsedAt;
  assert.ok(Date.parse(lastUsedAfter) > Date.parse(lastUsedBefore));
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map((tool) => tool.name), ["time.current"]);
  assert.deepEqual((await client.callTool({ name: "time.current" })).content, [{ type: "text", text: "UTC" }]);
  assert.equal((await f.app.inject({ url: "/health/ready" })).statusCode, 200);
  stall = false;
  const deadline = Date.now() + 35000;
  let restored = false;
  while (Date.now() < deadline && !restored) {
    restored = (await client.listTools(undefined, { cacheMode: "bypass" })).tools.some((tool) => tool.name === "woocommerce.create_product");
    if (!restored) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(restored, true, "Periodic refresh must restore upstream discovery");
  const recovered = await client.callTool({ name: "woocommerce.create_product" });
  assert.deepEqual(recovered.content, [{ type: "text", text: "Controlled product" }]);
  assert.equal(calls, 2);
});

test("dashboard logout and ordinary password changes leave a connected MCP key usable", async (t) => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  const client = await f.connect();
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: f.headers })).statusCode, 204);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).content, [{ type: "text", text: "42" }]);
  const login = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "member@example.com", password } });
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": login.json().csrfToken };
  const replaced = await f.app.inject({ method: "POST", url: "/api/auth/change-password", headers,
    payload: { currentPassword: password, newPassword: "a different final MCP password" } });
  assert.equal(replaced.statusCode, 204);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 2, b: 3 } })).content, [{ type: "text", text: "6" }]);
  assert.deepEqual((await (await f.connect()).listTools(undefined, { cacheMode: "bypass" })).tools.map((tool) => tool.name), ["calculator.calculate"]);
});
