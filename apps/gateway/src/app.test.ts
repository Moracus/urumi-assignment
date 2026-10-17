import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Fastify from "fastify";
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

test("chat requires an eligible dashboard session and reports missing provider configuration", async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; });
  const f = await fixture(t);
  const status = await fetch(`${f.address}/api/chat`, { headers: f.headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { available: false });
  const send = (headers: Record<string, string>, payload = { prompt: "Calculate 2 times 3" }) =>
    fetch(`${f.address}/api/chat`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal((await send({ authorization: `Bearer ${f.rawKey}`, origin })).status, 401);
  assert.equal((await send({ ...f.headers, origin: "https://untrusted.example" })).status, 403);
  assert.equal((await send({ ...f.headers, "x-csrf-token": "" })).status, 403);
  assert.equal((await send(f.headers)).status, 503);
  assert.equal((await fetch(`${f.address}/health/ready`)).status, 200);
});

test("invalid or disabled runtime chat configuration preserves management, readiness and MCP", async t => {
  const names = ["OPENAI_API_KEY", "CHAT_ENABLED", "CHAT_PROVIDER", "CHAT_MODEL"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  for (const settings of [
    { CHAT_ENABLED: "false" }, { CHAT_ENABLED: "invalid" },
    { CHAT_PROVIDER: "unsupported" }, { CHAT_MODEL: "bad model" },
    { CHAT_MODEL: "" }, { OPENAI_API_KEY: "blank key" },
  ]) {
    await t.test(JSON.stringify(settings), async t => {
      for (const name of names) delete process.env[name];
      process.env.OPENAI_API_KEY = "synthetic-provider-secret";
      Object.assign(process.env, settings);
      const f = await fixture(t);
      const status = await f.app.inject({ url: "/api/chat", headers: f.headers });
      assert.deepEqual(status.json(), { available: false });
      assert.equal((await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Calculate" } })).statusCode, 503);
      assert.equal((await f.app.inject({ url: "/health/ready" })).statusCode, 200);
      assert.equal((await f.app.inject({ url: "/api/keys", headers: f.headers })).statusCode, 200);
      assert.deepEqual((await (await f.connect()).listTools()).tools, []);
    });
  }
});

async function fixture(t: TestContext, options: Pick<GatewayAppOptions, "upstreams" | "auditLogger" | "destinations" | "upstreamNetwork" | "secretReader" | "approvedSecrets" | "chat"> = {}) {
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
  const app = await createGatewayApp({ upstreams: [],
    destinations: { allowLoopback: true, rules: (options.upstreams ?? []).map(config => ({
      origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"],
    })) }, ...options, mongodbUri: uri.toString() });
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
    app, db, mongodbUri: uri.toString(), address, userId: user.insertedId.toHexString(), headers, key, rawKey,
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

async function controlledUpstream(t: TestContext, name: string, register: (server: McpServer) => void, configure?: (app: ReturnType<typeof createMcpFastifyApp>) => void) {
  const app = createMcpFastifyApp({ host: "127.0.0.1", allowedHosts: ["127.0.0.1", "urumi-time-mcp", "urumi-woocommerce-mcp", "urumi-calculator-mcp", "tools.example.test"] });
  configure?.(app);
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
    server.registerTool("calculate", { description: "Controlled calculator", inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a * b) }],
    }));
  });
}

test("chat encodes real provider calls, validates schemas, pairs results and audits current session roles", async t => {
  const calculator = await calculatorUpstream(t);
  const clock = await controlledUpstream(t, "time", server => {
    server.registerTool("current", { description: "Clock", inputSchema: z.object({ timezone: z.string() }) },
      async () => ({ content: [{ type: "text", text: "Clock tool error" }], isError: true, structuredContent: { reason: "test" } }));
  });
  const commerce = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", { description: "Create product" }, async () => ({ content: [] }));
  });
  const aliases = await controlledUpstream(t, "aliases", server => {
    for (const name of ["a-b", "a_b", "very_long_".repeat(12)]) {
      server.registerTool(name, { description: `Untrusted description ${name}` }, async () => ({ content: [] }));
    }
  });
  const provider = Fastify();
  t.after(() => provider.close());
  let expectedCatalogSize = 2;
  let rounds = 0;
  provider.post("/v1/chat/completions", async request => {
    assert.equal(request.headers.authorization, "Bearer synthetic-provider-secret");
    const body = z.object({ model: z.literal("gpt-4.1-2025-04-14"), store: z.literal(false),
      messages: z.array(z.record(z.string(), z.unknown())),
      tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()) }) })) }).parse(request.body);
    assert.equal(body.tools.length, expectedCatalogSize);
    assert.equal(new Set(body.tools.map(tool => tool.function.name)).size, expectedCatalogSize);
    const results = body.messages.filter(message => message.role === "tool");
    rounds++;
    if (results.length === 0) {
      const calc = body.tools.find(tool => tool.function.description === "Controlled calculator")!.function;
      assert.deepEqual(calc.parameters.required, ["a", "b"]);
      const time = body.tools.find(tool => tool.function.description === "Clock")!.function;
      return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
        { id: "call-product", type: "function", function: { name: calc.name, arguments: '{"a":6,"b":7}' } },
        { id: "call-invalid", type: "function", function: { name: calc.name, arguments: '{"a":"six","b":7}' } },
        { id: "call-clock", type: "function", function: { name: time.name, arguments: '{"timezone":"UTC"}' } },
        { id: "call-forged", type: "function", function: { name: "invented_tool", arguments: '{}' } },
      ] } }] };
    }
    assert.deepEqual(results.map(result => result.tool_call_id), ["call-product", "call-invalid", "call-clock", "call-forged"]);
    assert.equal(JSON.parse(String(results[0].content)).content[0].text, "42");
    assert.equal(JSON.parse(String(results[1].content)).isError, true);
    assert.deepEqual(JSON.parse(String(results[2].content)), { content: [{ type: "text", text: "Clock tool error" }], isError: true, structuredContent: { reason: "test" } });
    assert.equal(JSON.parse(String(results[3].content)).isError, true);
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The answer is 42. <script>untrusted</script>" } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/v1/chat/completions`;
  const f = await fixture(t, { upstreams: [calculator.config, clock.config, commerce.config, aliases.config], chat: { apiKey: "synthetic-provider-secret", endpoint, model: "gpt-4.1-2025-04-14" } });
  const send = () => fetch(`${f.address}/api/chat`, { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: JSON.stringify({ prompt: "Multiply 6 by 7 and get the time in UTC" }) });
  const response = await send();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answer, "The answer is 42. <script>untrusted</script>");
  assert.deepEqual(result.calls.map((call: { id: string; toolName: string | null; outcome: string }) => [call.id, call.toolName, call.outcome]), [
    ["call-product", "calculator.calculate", "success"], ["call-invalid", "calculator.calculate", "rejected"],
    ["call-clock", "time.current", "tool_error"], ["call-forged", null, "rejected"],
  ]);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const rows = (await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.authenticationOrigin, "dashboard_session"); assert.equal(row.keyId, null);
    assert.equal(row.userId, f.userId); assert.equal(row.userEmail, "member@example.com");
  }
  assert.ok(!JSON.stringify(rows).includes("synthetic-provider-secret"));
  expectedCatalogSize = 6;
  assert.equal((await send()).status, 200);
  assert.equal(rounds, 4);
});

test("chat reauthenticates between calls and never replays writes after provider failure", async t => {
  let writes = 0;
  const commerce = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", { description: "Create product", inputSchema: z.object({ status: z.literal("publish") }) },
      async () => { writes++; return { content: [{ type: "text", text: "Created synthetic-provider-secret" }] }; });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  let revoke: (() => Promise<void>) | undefined;
  let providerRequests = 0;
  provider.post("/v1/chat/completions", async (request, reply) => {
    providerRequests++;
    const body = z.object({ messages: z.array(z.record(z.string(), z.unknown())), tools: z.array(z.object({ function: z.object({ name: z.string() }) })) }).parse(request.body);
    if (body.messages.some(message => message.role === "tool")) {
      assert.ok(!JSON.stringify(body).includes("synthetic-provider-secret"));
      return reply.code(500).send({ error: "private provider diagnostic synthetic-provider-secret" });
    }
    if (revoke) await revoke();
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      { id: "write-once", type: "function", function: { name: body.tools[0].function.name, arguments: '{"status":"publish"}' } },
    ] } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/v1/chat/completions`;
  const f = await fixture(t, { upstreams: [commerce.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const send = (extra = {}) => f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Create a published product", ...extra } });
  assert.equal((await send({ userId: "forged", role: "admin", messages: [] })).statusCode, 400);
  const result = await send();
  assert.equal(result.statusCode, 200);
  assert.match(result.json().error, /Chat stopped or provider unavailable/);
  assert.equal(result.json().calls[0].outcome, "success");
  assert.equal(writes, 1); assert.equal(providerRequests, 2);
  assert.ok(!result.body.includes("synthetic-provider-secret"));
  revoke = async () => { assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: f.headers })).statusCode, 204); };
  const revoked = await send();
  assert.equal(revoked.json().calls.length, 0);
  assert.equal(writes, 1); assert.equal(providerRequests, 3);
});

test("chat stops at its provider turn budget and rejects duplicate IDs before execution", async t => {
  let executions = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", { inputSchema: z.object({ a: z.number() }) },
      async () => { executions++; return { content: [{ type: "text", text: "1" }] }; });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  let turn = 0;
  let duplicate = false;
  provider.post("/completion", async request => {
    turn++;
    const body = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })) }).parse(request.body);
    const call = { id: `call-${turn}`, type: "function", function: { name: body.tools[0].function.name, arguments: '{"a":1}' } };
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: duplicate ? [call, call] : [call] } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [calculator.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  const send = () => f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Keep calculating" } });
  const exhausted = await send();
  assert.equal(exhausted.statusCode, 200);
  assert.equal(exhausted.json().calls.length, 5); assert.ok(exhausted.json().error);
  assert.equal(turn, 5); assert.equal(executions, 5);
  duplicate = true;
  const rejected = await send();
  assert.equal(rejected.json().calls.length, 0); assert.ok(rejected.json().error);
  assert.equal(turn, 6); assert.equal(executions, 5);
});

test("chat suppresses equivalent writes even when the provider reorders argument properties", async t => {
  let executions = 0;
  let uncertain = false;
  const commerce = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", { inputSchema: z.object({ name: z.string(), status: z.literal("publish") }) },
      async () => { executions++; return { content: [{ type: "text", text: "Write outcome" }], isError: uncertain }; });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  provider.post("/completion", async request => {
    const body = z.object({ messages: z.array(z.record(z.string(), z.unknown())), tools: z.array(z.object({ function: z.object({ name: z.string() }) })) }).parse(request.body);
    if (body.messages.some(message => message.role === "tool")) return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Created once" } }] };
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      { id: "first", type: "function", function: { name: body.tools[0].function.name, arguments: '{"name":"Mug","status":"publish"}' } },
      { id: "reordered", type: "function", function: { name: body.tools[0].function.name, arguments: uncertain ? '{"status":"publish","name":"Another Mug"}' : '{"status":"publish","name":"Mug"}' } },
    ] } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [commerce.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Create a published Mug" } });
  assert.equal(response.json().answer, "Created once");
  assert.deepEqual(response.json().calls.map((call: { outcome: string }) => call.outcome), ["success", "rejected"]);
  assert.equal(executions, 1);
  uncertain = true;
  const failed = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Create a published Mug" } });
  assert.deepEqual(failed.json().calls.map((call: { outcome: string }) => call.outcome), ["tool_error", "rejected"]);
  assert.equal(executions, 2);
});

test("chat never sends resolved upstream credentials in provider schema property names", async t => {
  const secret = "synthetic-upstream-secret";
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", { description: secret, inputSchema: z.object({ [secret]: z.string().optional() }) }, async () => ({ content: [] }));
  });
  const provider = Fastify();
  t.after(() => provider.close());
  let leaked = false;
  provider.post("/completion", async request => {
    leaked = JSON.stringify(request.body).includes(secret);
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Safe answer" } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const secretRef = { namespace: "urumi", name: "chat-test-secret", key: "token" };
  const f = await fixture(t, { upstreams: [{ ...calculator.config, authentication: { type: "header", headerName: "X-Tool-Token", secretRef } }],
    approvedSecrets: [secretRef], secretReader: { async read() { return secret; } }, chat: { apiKey: "synthetic-provider-secret", endpoint } });
  const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Answer safely" } });
  assert.equal(response.json().answer, "Safe answer");
  assert.equal(leaked, false);
});

test("manual refresh replaces the catalog for a continuing MCP client without changing desired state", async t => {
  let changed = false;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("new", {}, async () => ({ content: [], structuredContent: { refreshed: true }, isError: true }));
    server.server.setRequestHandler("tools/list", async () => ({ tools: [{
      name: changed ? "new" : "old", description: changed ? "New description" : "Old description",
      inputSchema: { type: "object", properties: { value: { type: changed ? "number" : "string" } } },
    }] }));
  });
  const f = await fixture(t, { upstreams: [extra.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  assert.equal((await client.listTools()).tools[0].name, "extra.old");
  const before = (await f.app.inject({ url: "/api/admin/servers/extra", headers: f.headers })).json().server;
  changed = true;
  const response = await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/refresh", headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const after = response.json().server;
  assert.equal(after.status, "connected");
  assert.equal(after.configurationRevision, before.configurationRevision);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.lastConnectedAt, before.lastConnectedAt);
  assert.ok(Date.parse(after.lastDiscoveredAt) > Date.parse(before.lastDiscoveredAt));
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools, [{
    name: "extra.new", description: "New description", inputSchema: { type: "object", properties: { value: { type: "number" } } },
  }]);
  await assert.rejects(client.callTool({ name: "extra.old" }), ProtocolError);
  const result = await client.callTool({ name: "extra.new", arguments: { value: 42 } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { refreshed: true });
});

test("manual refresh enforces session eligibility, Origin and CSRF and never enables disabled servers", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  const refresh = (headers: Record<string, string>, id = "calculator") => f.app.inject({
    method: "POST", url: `/api/admin/servers/${id}/refresh`, headers,
  });
  assert.equal((await refresh({})).statusCode, 401);
  assert.equal((await refresh({ authorization: `Bearer ${f.rawKey}`, origin })).statusCode, 401);
  assert.equal((await refresh(f.headers)).statusCode, 403);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  for (const headers of [{ ...f.headers, origin: "" }, { ...f.headers, origin: "https://evil.test" },
    { ...f.headers, "x-csrf-token": "" }, { ...f.headers, "x-csrf-token": "a".repeat(64) }]) {
    assert.equal((await refresh(headers)).statusCode, 403);
  }
  assert.equal((await refresh(f.headers, "missing")).statusCode, 404);
  await f.app.inject({ method: "POST", url: "/api/admin/servers/calculator/disable", headers: f.headers });
  const before = (await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  const disabled = await refresh(f.headers);
  assert.equal(disabled.statusCode, 409, disabled.body);
  assert.deepEqual(disabled.json(), { error: "Server is disabled" });
  assert.deepEqual((await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server, before);
  const client = await f.connect();
  assert.deepEqual((await client.listTools()).tools, []);
  for (const status of [{ requiredPasswordChange: true }, { requiredPasswordChange: false, status: "disabled" }]) {
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: status });
    assert.equal((await refresh(f.headers)).statusCode, status.requiredPasswordChange ? 403 : 401);
  }
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { status: "active" } });
  await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: f.headers });
  assert.equal((await refresh(f.headers)).statusCode, 401);
});

test("manual refresh rejects invalid discovery, bounds discovery and connection delays and recovers without stale publication", async t => {
  const discovery = barrier();
  const initialization = barrier();
  let mode: "valid" | "duplicate" | "discovery delay" | "connection delay" = "valid";
  let calls = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => { calls++; return { content: [] }; });
    server.server.setRequestHandler("initialize", async request => {
      if (mode === "connection delay") { initialization.enter(); await initialization.blocked; }
      return { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "extra", version: "1" } };
    });
    server.server.setRequestHandler("tools/list", async () => {
      if (mode === "discovery delay") {
        discovery.enter(); await discovery.blocked;
        return { tools: [{ name: "obsolete", inputSchema: { type: "object" } }] };
      }
      const tool = { name: "echo", inputSchema: { type: "object" as const } };
      return { tools: mode === "duplicate" ? [tool, tool] : [tool] };
    });
  });
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [extra.config, calculator.config] });
  t.after(discovery.release); t.after(initialization.release);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const refresh = () => f.app.inject({ method: "POST", url: "/api/admin/servers/extra/refresh", headers: f.headers }).then(value => value);
  const healthy = async () => {
    assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).content, [{ type: "text", text: "42" }]);
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url: "/api/keys", headers: f.headers })).statusCode, 200);
  };
  mode = "duplicate";
  const failed = await refresh();
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal(failed.json().server.status, "unreachable");
  assert.equal(failed.json().server.lastError, "Upstream unavailable");
  assert.equal(failed.json().server.toolCount, 0);
  await assert.rejects(client.callTool({ name: "extra.echo" }), ProtocolError);
  assert.equal(calls, 0);
  mode = "valid";
  assert.equal((await refresh()).json().server.status, "connected");
  mode = "discovery delay";
  const started = Date.now();
  const delayedDiscovery = refresh();
  await discovery.entered;
  await healthy();
  // An unrelated registration is independent of this server's blocked discovery.
  assert.equal((await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "other", displayName: "Other", url: `${calculator.config.url}?other=1`, transport: "streamable-http", enabled: false, authentication: { type: "none" },
  } })).statusCode, 201);
  const timedOut = await delayedDiscovery;
  assert.equal(timedOut.statusCode, 200);
  assert.equal(timedOut.json().server.status, "unreachable");
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 10000);
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  mode = "connection delay";
  const connecting = refresh();
  await initialization.entered;
  await healthy();
  assert.equal((await connecting).json().server.status, "unreachable");
  mode = "valid";
  const recovered = await refresh();
  assert.equal(recovered.json().server.status, "connected");
  assert.equal(recovered.json().server.lastError, null);
  assert.ok(recovered.json().server.lastConnectedAt && recovered.json().server.lastDiscoveredAt);
  initialization.release(); discovery.release();
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate", "extra.echo"]);
  await client.callTool({ name: "extra.echo" });
  assert.equal(calls, 1);
});

test("manual and periodic refresh serialize discovery and replacement and ignore failures from retired connections", async t => {
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const discovery = barrier();
  let delay = false;
  let active = 0;
  let maximum = 0;
  let discoveries = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => ({ content: [] }));
    server.server.setRequestHandler("tools/list", async () => {
      discoveries++; active++; maximum = Math.max(maximum, active);
      try {
        if (delay) { discovery.enter(); await discovery.blocked; }
        return { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
      } finally { active--; }
    });
  });
  const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
    rules: [{ origin: new URL(extra.config.url).origin, cidrs: ["127.0.0.1/32"] }] }));
  t.after(() => registry.close()); t.after(discovery.release);
  registry.register(extra.config);
  await registry.connect("extra");
  const previous = registry.getClient("extra")!;
  delay = true;
  const manual = registry.refresh("extra");
  await discovery.entered;
  const periodic = registry.refreshAll();
  const replacement = registry.connect("extra");
  const failure = registry.markUnreachable("extra", "Obsolete failure", previous);
  assert.equal(discoveries, 2);
  discovery.release();
  await Promise.all([manual, periodic, replacement, failure]);
  assert.equal(maximum, 1);
  assert.equal(discoveries, 4);
  assert.notEqual(registry.getClient("extra"), previous);
  assert.equal(registry.getState("extra")?.status, "connected");
  assert.deepEqual(registry.getState("extra")?.tools.map(tool => tool.name), ["echo"]);
  await registry.close();
  await registry.refresh("extra");
  assert.equal(registry.getClient("extra"), null);
});

test("server inspection requires an eligible administrator session and preserves discovered tool contracts", async (t) => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  for (const url of ["/api/admin/servers", "/api/admin/servers/calculator", "/api/admin/servers/calculator/tools"]) {
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.equal((await f.app.inject({ url, headers: { authorization: `Bearer ${f.rawKey}` } })).statusCode, 401);
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 403);
  }
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const listed = await f.app.inject({ url: "/api/admin/servers", headers: f.headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.headers["cache-control"], "no-store");
  const summary = listed.json().servers[0];
  assert.equal(summary.serverId, "calculator");
  assert.equal(summary.displayName, "calculator");
  assert.equal(summary.status, "connected");
  assert.equal(summary.toolCount, 1);
  assert.equal(summary.configurationRevision, 1);
  assert.ok(summary.createdAt && summary.updatedAt && summary.lastConnectedAt && summary.lastDiscoveredAt);
  assert.equal(summary.url, undefined);
  const detail = (await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  assert.equal(detail.url, calculator.config.url);
  assert.equal(detail.transport, "streamable-http");
  assert.deepEqual(detail.authentication, { type: "none", referenceConfigured: false });
  const tools = await f.app.inject({ url: "/api/admin/servers/calculator/tools", headers: f.headers });
  const client = await f.connect();
  assert.deepEqual(tools.json().tools, (await client.listTools()).tools);
  for (const suffix of ["", "/tools"]) {
    assert.equal((await f.app.inject({ url: `/api/admin/servers/missing${suffix}`, headers: f.headers })).statusCode, 404);
  }
  for (const status of [{ requiredPasswordChange: true }, { requiredPasswordChange: false, status: "disabled" }]) {
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: status });
    assert.equal((await f.app.inject({ url: "/api/admin/servers", headers: f.headers })).statusCode, status.requiredPasswordChange ? 403 : 401);
  }
});

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
    assert.equal((await fetch(`${address}/health/ready`)).status, 200);
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
  assert.deepEqual(records.map(record => record.outcome), ["unauthorized", "unauthorized", "not_found"]);
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
    assert.deepEqual(Object.keys(record).sort(), ["attemptId", "authenticationOrigin", "durationMs", "keyId", "outcome", "requestId", "timestamp", "toolName", "upstreamName", "userId", "userEmail", "upstreamId", "upstreamDisplayName"].sort());
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


test("invalid destination policy fails startup before storage or network access", async () => {
  const previous = process.env.UPSTREAM_DESTINATION_RULES;
  process.env.UPSTREAM_DESTINATION_RULES = "not-json";
  try {
    await assert.rejects(createGatewayApp({ upstreams: [] }), /Invalid upstream destination configuration/);
  } finally {
    if (previous === undefined) delete process.env.UPSTREAM_DESTINATION_RULES;
    else process.env.UPSTREAM_DESTINATION_RULES = previous;
  }
});

test("first migration rejects unapproved endpoints and sensitive targets even with explicit rules", async (t) => {
  const f = await fixture(t);
  await f.app.close();
  await f.db.collection("upstream_migrations").deleteMany({});
  for (const url of [
    "ftp://urumi-time-mcp:3003/mcp", "http://user:secret@urumi-time-mcp:3003/mcp",
    "http://urumi-time-mcp:3002/mcp", "http://urumi-time-mcp.other.svc:3003/mcp",
    "http://169.254.169.254/mcp", "http://127.0.0.1:3003/mcp", "https://kubernetes.default.svc/mcp",
    "http://database:27017/mcp", "http://[::ffff:127.0.0.1]:3003/mcp",
  ]) {
    const parsed = new URL(url);
    await assert.rejects(createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [{ name: "time", url, enabled: true }],
      destinations: { rules: ["urumi-time-mcp:3002", "other.svc"].some(value => url.includes(value)) ? [] : [{ origin: parsed.origin, cidrs: ["0.0.0.0/0", "::/0"] }] },
    }), /destination/);
  }
});

test("DNS validates every answer before dialing approved services and denies redirects without harming healthy tools", async (t) => {
  const calculator = await calculatorUpstream(t);
  let redirectCalls = 0;
  let targetCalls = 0;
  const redirect = createMcpFastifyApp({ host: "127.0.0.1" });
  redirect.all("/mcp", (_request, reply) => {
    redirectCalls++;
    return reply.redirect("/trap");
  });
  redirect.all("/trap", async () => { targetCalls++; return {}; });
  t.after(() => redirect.close());
  const redirectAddress = await redirect.listen({ host: "127.0.0.1", port: 0 });
  const { buildConnector } = await import("undici");
  const dial = buildConnector({ timeout: 1000 });
  const dialed: string[] = [];
  const f = await fixture(t, {
    upstreams: [calculator.config,
      { name: "time", url: "http://urumi-time-mcp:3003/mcp", enabled: true },
      { name: "woocommerce", url: "http://urumi-woocommerce-mcp:3001/mcp", enabled: true },
      { name: "redirect", url: `${redirectAddress}/mcp`, enabled: true }],
    destinations: { allowLoopback: true, rules: [calculator.config.url, `${redirectAddress}/mcp`].map(url => ({
      origin: new URL(url).origin, cidrs: ["127.0.0.1/32"],
    })) },
    upstreamNetwork: {
      async lookup(host, _options) {
        // A single forbidden answer invalidates the complete set, even when the first is safe.
        return host === "urumi-time-mcp" ? [{ address: "10.42.1.5", family: 4 }, { address: "169.254.169.254", family: 4 }] :
          [{ address: "10.42.1.6", family: 4 }];
      },
      dial(options, callback) {
        dialed.push(options.hostname);
        const endpoint = options.hostname === "10.42.1.6" ? new URL(calculator.config.url) : undefined;
        dial({ ...options, hostname: endpoint?.hostname ?? options.hostname, port: endpoint?.port ?? options.port }, callback);
      },
    },
  });
  const client = await f.connect();
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  assert.equal((await f.app.inject({ url: "/health/ready" })).json().connectedUpstreams, 2);
  assert.ok(dialed.includes("10.42.1.6"), "approved service address is passed literally to the socket boundary");
  assert.ok(!dialed.includes("10.42.1.5"));
  assert.ok(!dialed.includes("169.254.169.254"));
  assert.ok(redirectCalls > 0);
  assert.equal(targetCalls, 0);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).content, [{ type: "text", text: "42" }]);
});

test("automatic recovery rechecks changed DNS and never dials a newly forbidden address", async (t) => {
  const calculator = await calculatorUpstream(t);
  let address = "169.254.169.254";
  let lookups = 0;
  let approvedDials = 0;
  const { buildConnector } = await import("undici");
  const dial = buildConnector({ timeout: 1000 });
  const sockets: import("node:net").Socket[] = [];
  const f = await fixture(t, {
    upstreams: [calculator.config, { name: "time", url: "http://urumi-time-mcp:3003/mcp", enabled: true }],
    upstreamNetwork: {
      async lookup() { lookups++; return [{ address, family: 4 }]; },
      dial(options, callback) {
        if (options.hostname !== "10.42.1.5") { dial(options, callback); return; }
        approvedDials++;
        const endpoint = new URL(calculator.config.url);
        dial({ ...options, hostname: endpoint.hostname, port: endpoint.port }, (error, socket) => {
          if (error) callback(error, null);
          else { sockets.push(socket); callback(null, socket); }
        });
      },
    },
  });
  const client = await f.connect();
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const names = async () => (await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name);
  assert.deepEqual(await names(), ["calculator.calculate"]);
  assert.equal(approvedDials, 0);
  address = "10.42.1.5";
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail("Periodic maintenance did not reach expected state");
  }
  await waitFor(async () => (await names()).includes("time.calculate"));
  assert.ok(approvedDials > 0);
  const before = approvedDials;
  const previousLookups = lookups;
  address = "169.254.169.254";
  for (const socket of sockets) socket.destroy();
  await waitFor(async () => lookups > previousLookups && !(await names()).includes("time.calculate"));
  assert.equal(approvedDials, before);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 3, b: 7 } })).content, [{ type: "text", text: "21" }]);
});


test("all default service origins and explicitly approved external destinations connect through the application", async (t) => {
  const calculator = await calculatorUpstream(t);
  const { buildConnector } = await import("undici");
  const dial = buildConnector({ timeout: 1000 });
  const endpoint = new URL(calculator.config.url);
  const seen: string[] = [];
  const f = await fixture(t, {
    upstreams: [
      { name: "calculator", url: "http://urumi-calculator-mcp:3002/mcp", enabled: true },
      { name: "woocommerce", url: "http://urumi-woocommerce-mcp:3001/mcp", enabled: true },
      { name: "time", url: "http://urumi-time-mcp:3003/mcp", enabled: true },
      { name: "external", url: "http://tools.example.test/mcp", enabled: true },
    ],
    destinations: { rules: [{ origin: "http://tools.example.test", cidrs: ["203.0.113.10/32"] }] },
    upstreamNetwork: {
      async lookup(host) {
        seen.push(host);
        return [{ address: host === "tools.example.test" ? "203.0.113.10" : "10.42.1.5", family: 4 }];
      },
      dial(options, callback) { dial({ ...options, hostname: endpoint.hostname, port: endpoint.port }, callback); },
    },
  });
  assert.equal((await f.app.inject({ url: "/health/ready" })).json().connectedUpstreams, 4);
  assert.deepEqual([...new Set(seen)].sort(), ["tools.example.test", "urumi-calculator-mcp", "urumi-time-mcp", "urumi-woocommerce-mcp"]);
  const client = await f.connect();
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 2, b: 9 } })).content, [{ type: "text", text: "18" }]);
});

test("Kubernetes API service IP is denied through approved DNS aliases even on HTTPS 443", async (t) => {
  const previous = process.env.KUBERNETES_SERVICE_HOST;
  process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
  t.after(() => {
    if (previous === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
    else process.env.KUBERNETES_SERVICE_HOST = previous;
  });
  let dials = 0;
  const f = await fixture(t, {
    upstreams: [{ name: "time", url: "https://tools.example.test/mcp", enabled: true }],
    destinations: { rules: [{ origin: "https://tools.example.test", cidrs: ["10.96.0.1/32"] }] },
    upstreamNetwork: {
      async lookup() { return [{ address: "10.96.0.1", family: 4 }]; },
      dial(_options, callback) { dials++; callback(new Error("unexpected dial"), null); },
    },
  });
  assert.deepEqual((await (await f.connect()).listTools(undefined, { cacheMode: "bypass" })).tools, []);
  assert.equal(dials, 0);
});

test("operator denials override approvals and production cannot enable development loopback", async () => {
  await assert.rejects(createGatewayApp({ upstreams: [], destinations: {
    allowLoopback: true, rules: [{ origin: "http://127.0.0.1:3003", cidrs: ["127.0.0.1/32"] }],
    deniedCidrs: ["127.0.0.0/8"],
  } }), /Invalid upstream destination configuration/);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(createGatewayApp({ upstreams: [], destinations: { allowLoopback: true } }), /Invalid upstream destination configuration/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});


test("restart restores desired registrations, preserves edits and deletions, and discovers enabled servers afresh", async (t) => {
  let description = "First discovery";
  let disabledConnections = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", { description, inputSchema: z.object({ a: z.number() }) }, async ({ a }) => ({
      content: [{ type: "text", text: String(a) }], structuredContent: { value: a },
    }));
  });
  const disabled = await controlledUpstream(t, "time", server => {
    disabledConnections++;
    server.registerTool("current", {}, async () => ({ content: [] }));
  });
  const dead = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("list_products", {}, async () => ({ content: [] }));
  });
  await dead.app.close();
  const configs = [calculator.config, { ...disabled.config, enabled: false }, dead.config];
  const f = await fixture(t, { upstreams: configs });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  assert.equal(disabledConnections, 0);
  const before = (await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  const changedAt = new Date();
  await f.db.collection("upstream_registrations").updateOne({ serverId: "calculator" }, {
    $set: { displayName: "Arithmetic", configurationRevision: 2, updatedAt: changedAt },
  });
  await f.db.collection("upstream_registrations").deleteOne({ serverId: "time" });
  // Restore a disabled registration requiring a Secret, without ever connecting to it.
  await f.db.collection("upstream_registrations").insertOne({
    serverId: "suspended", displayName: "Suspended", url: disabled.config.url, transport: "streamable-http", enabled: false,
    authentication: { type: "bearer", secretRef: { namespace: "urumi", name: "private-token", key: "token" } },
    configurationRevision: 7, createdAt: changedAt, updatedAt: changedAt,
  });
  await f.app.close();
  description = "Fresh discovery";
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: configs.map(config => ({ ...config, enabled: true })),
    destinations: { allowLoopback: true, rules: configs.map(config => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) },
  });
  t.after(() => restarted.close());
  const servers = (await restarted.inject({ url: "/api/admin/servers", headers: f.headers })).json().servers;
  assert.deepEqual(servers.map((server: { serverId: string }) => server.serverId), ["calculator", "suspended", "woocommerce"]);
  const calculatorState = servers[0];
  assert.equal(calculatorState.displayName, "Arithmetic");
  assert.equal(calculatorState.configurationRevision, 2);
  assert.equal(calculatorState.updatedAt, changedAt.toISOString());
  assert.equal(calculatorState.createdAt, before.createdAt);
  assert.ok(Date.parse(calculatorState.lastDiscoveredAt) > Date.parse(before.lastDiscoveredAt));
  assert.equal(servers[1].status, "disabled");
  assert.equal(servers[1].lastConnectedAt, null);
  assert.equal(disabledConnections, 0);
  assert.equal(servers[2].status, "unreachable");
  assert.equal(servers[2].toolCount, 0);
  assert.equal(servers[2].lastError, "Upstream unavailable");
  const response = await restarted.inject({ url: "/api/admin/servers/suspended", headers: f.headers });
  assert.deepEqual(response.json().server.authentication, { type: "bearer", referenceConfigured: true });
  assert.ok(!response.body.includes("private-token"));
  assert.deepEqual((await restarted.inject({ url: "/api/admin/servers/woocommerce/tools", headers: f.headers })).json(), { tools: [] });
  assert.deepEqual((await restarted.inject({ url: "/api/admin/servers/suspended/tools", headers: f.headers })).json(), { tools: [] });
  const address = await restarted.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "restored-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${f.rawKey}` } },
  }));
  const tools = (await client.listTools(undefined, { cacheMode: "bypass" })).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["calculator.calculate"]);
  assert.equal(tools[0].description, "Fresh discovery");
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 42 } })).structuredContent, { value: 42 });
  assert.equal((await restarted.inject({ url: "/health/ready" })).statusCode, 200);
});

test("concurrent migration fills only missing defaults and completed migration never reseeds a removed server", async (t) => {
  const calculator = await calculatorUpstream(t);
  const time = await controlledUpstream(t, "time", server => {
    server.registerTool("current", {}, async () => ({ content: [] }));
  });
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.app.close();
  await f.db.collection("upstream_migrations").deleteMany({});
  const now = new Date();
  await f.db.collection("upstream_registrations").updateOne({ serverId: "calculator" }, { $set: {
    displayName: "Preserved", enabled: false, configurationRevision: 3, updatedAt: now,
    authentication: { type: "header", headerName: "x-api-key", secretRef: { namespace: "urumi", name: "calculator-auth", key: "token" } },
  } });
  const options = { mongodbUri: f.mongodbUri, upstreams: [{ ...calculator.config, url: time.config.url }, time.config],
    destinations: { allowLoopback: true, rules: [calculator.config, time.config].map(config => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) },
  };
  const started = await Promise.allSettled([createGatewayApp(options), createGatewayApp(options)]);
  for (const result of started) if (result.status === "fulfilled") t.after(() => result.value.close());
  assert.ok(started.every(result => result.status === "fulfilled"), JSON.stringify(started));
  const documents = await f.db.collection("upstream_registrations").find().sort({ serverId: 1 }).toArray();
  assert.equal(documents.length, 2);
  assert.equal(documents[0].url, calculator.config.url);
  assert.equal(documents[0].displayName, "Preserved");
  assert.equal(documents[0].enabled, false);
  assert.equal(documents[0].configurationRevision, 3);
  assert.equal(documents[0].authentication.secretRef.name, "calculator-auth");
  assert.ok((await f.db.collection("upstream_migrations").findOne())?.completedAt);
  for (const result of started) if (result.status === "fulfilled") await result.value.close();
  await f.db.collection("upstream_registrations").deleteOne({ serverId: "time" });
  const restarted = await createGatewayApp(options);
  t.after(() => restarted.close());
  assert.equal(await f.db.collection("upstream_registrations").countDocuments(), 1);
  assert.equal((await restarted.inject({ url: "/health/ready" })).statusCode, 200);
});

test("failed migration rolls back all inserts and completion before a later startup retries", async (t) => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t);
  await f.app.close();
  await f.db.collection("upstream_migrations").deleteMany({});
  const options = { mongodbUri: f.mongodbUri, destinations: { allowLoopback: true,
    rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] }] } };
  await assert.rejects(createGatewayApp({ ...options, upstreams: [calculator.config, { ...calculator.config, name: "time", url: `${new URL(calculator.config.url).origin}/extra/../mcp` }] }));
  assert.equal(await f.db.collection("upstream_registrations").countDocuments(), 0);
  assert.equal((await f.db.collection("upstream_migrations").findOne())?.completedAt, null);
  const restarted = await createGatewayApp({ ...options, upstreams: [calculator.config] });
  t.after(() => restarted.close());
  assert.equal(await f.db.collection("upstream_registrations").countDocuments(), 1);
  assert.ok((await f.db.collection("upstream_migrations").findOne())?.completedAt);
});


test("startup rejects malformed persisted desired configuration and never downgrades Secret authentication", async (t) => {
  let connections = 0;
  const time = await controlledUpstream(t, "time", server => {
    connections++;
    server.registerTool("current", {}, async () => ({ content: [] }));
  });
  const f = await fixture(t);
  await f.app.close();
  const desired = { serverId: "time", displayName: "Private time", url: time.config.url,
    transport: "streamable-http", enabled: true, configurationRevision: 1, createdAt: new Date(), updatedAt: new Date(),
    authentication: { type: "bearer", secretRef: { namespace: "urumi", name: "time-token", key: "token" } },
  };
  const options = { mongodbUri: f.mongodbUri, upstreams: [], destinations: { allowLoopback: true,
    rules: [{ origin: new URL(time.config.url).origin, cidrs: ["127.0.0.1/32"] }] } };
  for (const invalid of [
    { serverId: "time.invalid" }, { configurationRevision: 0 }, { enabled: "false" }, { transport: "sse" },
    { authentication: { type: "bearer", rawKey: "synthetic-secret" } },
    { authentication: { type: "header", headerName: "Host", secretRef: desired.authentication.secretRef } },
    { url: time.config.url.replace("http://", "http://user:synthetic-secret@") },
    { url: `${time.config.url}#fragment` }, { rawKey: "synthetic-secret" },
  ]) {
    await f.db.collection("upstream_registrations").deleteMany({});
    await f.db.collection("upstream_registrations").insertOne({ ...desired, ...invalid });
    await assert.rejects(createGatewayApp(options));
  }
  assert.equal(connections, 0);
  await f.db.collection("upstream_registrations").deleteMany({});
  await f.db.collection("upstream_registrations").insertOne(desired);
  const app = await createGatewayApp(options);
  t.after(() => app.close());
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const server = (await app.inject({ url: "/api/admin/servers/time", headers: f.headers })).json().server;
  assert.equal(server.enabled, true);
  assert.equal(server.status, "unreachable");
  assert.deepEqual(server.authentication, { type: "bearer", referenceConfigured: true });
  assert.equal(connections, 0);
  assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 200);
});


test("completed migration ignores obsolete unapproved defaults on restart", async (t) => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri,
    upstreams: [{ name: "calculator", url: "http://169.254.169.254/mcp", enabled: false }],
    destinations: { allowLoopback: true, rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] }] },
  });
  t.after(() => restarted.close());
  assert.equal((await restarted.inject({ url: "/health/ready" })).statusCode, 200);
});

test("administrator registers a durable upstream visible to an already connected MCP client", async (t) => {
  const calculator = await calculatorUpstream(t);
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", { description: "Echo a value", inputSchema: z.object({ value: z.number().int() }) }, async ({ value }) => ({
      content: [{ type: "text", text: String(value) }], structuredContent: { value }, isError: value < 0,
    }));
  });
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [calculator.config], auditLogger: { async write(record) { records.push(record); } },
    destinations: { allowLoopback: true, rules: [calculator.config, extra.config].map(config => ({
      origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"],
    })) } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  const response = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "extra", displayName: "Extra tools", url: extra.config.url, transport: "streamable-http", enabled: true, authentication: { type: "none" },
  } });
  assert.equal(response.statusCode, 201, response.body);
  const created = response.json().server;
  assert.equal(created.status, "connected");
  assert.equal(created.toolCount, 1);
  assert.equal(created.configurationRevision, 1);
  assert.equal(created.url, extra.config.url);
  assert.equal((await f.app.inject({ url: "/api/admin/servers", headers: f.headers })).json().servers.length, 2);
  assert.deepEqual((await f.app.inject({ url: "/api/admin/servers/extra", headers: f.headers })).json().server, created);
  const tools = (await client.listTools(undefined, { cacheMode: "bypass" })).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["calculator.calculate", "extra.echo"]);
  const schema = tools[1].inputSchema;
  assert.equal(tools[1].description, "Echo a value");
  assert.deepEqual(schema.required, ["value"]);
  assert.deepEqual((await f.app.inject({ url: "/api/admin/servers/extra/tools", headers: f.headers })).json().tools, [tools[1]]);
  assert.deepEqual((await client.callTool({ name: "extra.echo", arguments: { value: 42 } })).structuredContent, { value: 42 });
  assert.equal((await client.callTool({ name: "extra.echo", arguments: { value: -1 } })).isError, true);
  assert.equal(records.at(-1)?.outcome, "tool_error");
  assert.equal(records.at(-1)?.userId, f.userId);
  assert.equal(records.at(-1)?.keyId, f.key.id);
  assert.equal(records.at(-1)?.upstreamName, "extra");
  await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [], destinations: { allowLoopback: true,
    rules: [calculator.config, extra.config].map(config => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  t.after(() => restarted.close());
  const restored = (await restarted.inject({ url: "/api/admin/servers/extra", headers: f.headers })).json().server;
  assert.equal(restored.status, "connected");
  assert.equal(restored.createdAt, created.createdAt);
  assert.deepEqual((await restarted.inject({ url: "/api/admin/servers/extra/tools", headers: f.headers })).json().tools, [tools[1]]);
});

test("registration validates strict input and concurrent canonical duplicates before outbound access", async (t) => {
  const calculator = await calculatorUpstream(t);
  const extra = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config], destinations: { allowLoopback: true,
    rules: [calculator.config, extra.config].map(config => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const payload = { serverId: "extra", displayName: " Extra ", url: extra.config.url, transport: "streamable-http", enabled: true, authentication: { type: "none" } };
  for (const invalid of [
    { serverId: "bad.name" }, { serverId: "UPPER" }, { displayName: " " }, { enabled: "true" },
    { transport: "sse" }, { configurationRevision: 5 }, { createdAt: new Date().toISOString() },
    { url: "http://169.254.169.254/mcp" }, { url: "file:///mcp" }, { url: `${extra.config.url}#secret` },
    { url: extra.config.url.replace("http://", "http://user:synthetic-secret@") },
    { authentication: { type: "bearer", secretRef: { namespace: "urumi", name: "token", key: "token" } } },
    { authentication: { type: "none", token: "synthetic-secret" } }, { headers: { authorization: "synthetic-secret" } },
  ]) {
    const response = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: { ...payload, ...invalid } });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(!response.body.includes("synthetic-secret"));
  }
  assert.equal((await f.app.inject({ url: "/api/admin/servers", headers: f.headers })).json().servers.length, 1);
  const create = (value: object) => f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: value });
  const byId = await Promise.all([create(payload), create({ ...payload, url: `${extra.config.url}?different=1` })]);
  assert.deepEqual(byId.map(response => response.statusCode).sort(), [201, 409]);
  const winner = byId.find(response => response.statusCode === 201)!.json().server;
  const byUrl = await Promise.all([create({ ...payload, serverId: "alias", url: winner.url.replace("/mcp", "/unused/../mcp") }),
    create({ ...payload, serverId: "alias2", url: winner.url })]);
  assert.deepEqual(byUrl.map(response => response.statusCode), [409, 409]);
  // URL's standard canonical form folds host case, default ports, and path dot segments.
  const canonical = await create({ ...payload, serverId: "canonical", enabled: false, url: "http://URUMI-TIME-MCP:3003/path/../mcp" });
  assert.equal(canonical.statusCode, 201, canonical.body);
  assert.equal(canonical.json().server.url, "http://urumi-time-mcp:3003/mcp");
  assert.equal((await create({ ...payload, serverId: "canonical2", url: "http://urumi-time-mcp:3003/mcp" })).statusCode, 409);
});

test("registration enforces dashboard session eligibility, role, trusted Origin and CSRF independently of MCP keys", async (t) => {
  const f = await fixture(t);
  const payload = { serverId: "time", displayName: "Time", url: "http://urumi-time-mcp:3003/mcp", transport: "streamable-http", enabled: false, authentication: { type: "none" } };
  const create = (headers: Record<string, string>) => f.app.inject({ method: "POST", url: "/api/admin/servers", headers, payload });
  assert.equal((await create({})).statusCode, 401);
  assert.equal((await create({ authorization: `Bearer ${f.rawKey}`, origin })).statusCode, 401);
  assert.equal((await create(f.headers)).statusCode, 403);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  for (const headers of [
    { ...f.headers, origin: "" }, { ...f.headers, origin: "http://evil.test" },
    { ...f.headers, "x-csrf-token": "" }, { ...f.headers, "x-csrf-token": "a".repeat(64) },
  ]) assert.equal((await create(headers)).statusCode, 403);
  for (const status of [{ requiredPasswordChange: true }, { requiredPasswordChange: false, status: "disabled" }]) {
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: status });
    assert.equal((await create(f.headers)).statusCode, status.requiredPasswordChange ? 403 : 401);
  }
  assert.equal(await f.db.collection("upstream_registrations").countDocuments(), 0);
});

test("offline creation is durable, leaves unrelated requests responsive and recovers on the same MCP client", async (t) => {
  const calculator = await calculatorUpstream(t);
  let calls = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("calculate", { description: "Recovered tool", inputSchema: z.object({ a: z.number(), b: z.number() }) }, async () => {
      calls++;
      return { content: [{ type: "text", text: "recovered" }] };
    });
  });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let online = false;
  const { buildConnector } = await import("undici");
  const dial = buildConnector({ timeout: 1000 });
  const endpoint = new URL(extra.config.url);
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [calculator.config], auditLogger: { async write(record) { records.push(record); } },
    destinations: { allowLoopback: true, rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] },
      { origin: "http://tools.example.test", cidrs: ["203.0.113.10/32"] }] },
    upstreamNetwork: {
      async lookup() {
        entered();
        if (!online) { await blocked; throw new Error("synthetic-secret offline diagnostic"); }
        return [{ address: "203.0.113.10", family: 4 }];
      },
      dial(options, callback) {
        dial(options.hostname === "203.0.113.10" ? { ...options, hostname: endpoint.hostname, port: endpoint.port } : options, callback);
      },
    },
  });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const create = f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "extra", displayName: "Offline tools", url: "http://tools.example.test/mcp", transport: "streamable-http", enabled: true, authentication: { type: "none" },
  } });
  // Start the injection before waiting for its controlled external I/O barrier.
  const pending = create.then(response => response);
  await started;
  const observed = (await f.app.inject({ url: "/api/admin/servers/extra", headers: f.headers })).json().server;
  assert.equal(observed.status, "connecting");
  assert.equal(observed.toolCount, 0);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: f.headers })).statusCode, 200);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).content, [{ type: "text", text: "42" }]);
  release();
  const response = await pending;
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().server.status, "unreachable");
  assert.equal(response.json().server.lastError, "Upstream unavailable");
  assert.ok(!response.body.includes("synthetic-secret"));
  assert.deepEqual((await f.app.inject({ url: "/api/admin/servers/extra/tools", headers: f.headers })).json().tools, []);
  online = true;
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if ((await client.listTools(undefined, { cacheMode: "bypass" })).tools.some(tool => tool.name === "extra.calculate")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok((await client.listTools(undefined, { cacheMode: "bypass" })).tools.some(tool => tool.name === "extra.calculate"));
  assert.equal((await client.callTool({ name: "extra.calculate", arguments: { a: 1, b: 2 } })).isError, undefined);
  assert.equal(calls, 1);
  assert.equal(records.at(-1)?.outcome, "success");
  assert.equal(records.at(-1)?.keyId, f.key.id);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "member" } });
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  await assert.rejects(client.callTool({ name: "extra.calculate", arguments: { a: 1, b: 2 } }), ProtocolError);
  assert.equal(calls, 1);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/keys/${f.key.id}`, headers: f.headers })).statusCode, 204);
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), httpFailure(401));
});

test("failed registration persistence never publishes or connects the requested upstream", async (t) => {
  let connections = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    connections++;
    server.registerTool("echo", {}, async () => ({ content: [] }));
  });
  const f = await fixture(t, { destinations: { allowLoopback: true, rules: [{ origin: new URL(extra.config.url).origin, cidrs: ["127.0.0.1/32"] }] } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  // Inject a failure at the real persistence boundary, after session authentication remains usable.
  await f.db.db!.command({ collMod: "upstream_registrations", validator: { serverId: { $ne: "extra" } }, validationLevel: "strict" });
  const response = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "extra", displayName: "Extra", url: extra.config.url, transport: "streamable-http", enabled: true, authentication: { type: "none" },
  } });
  assert.equal(response.statusCode, 503);
  assert.equal(connections, 0);
  assert.deepEqual((await f.app.inject({ url: "/api/admin/servers", headers: f.headers })).json(), { servers: [] });
  assert.deepEqual((await (await f.connect()).listTools(undefined, { cacheMode: "bypass" })).tools, []);
});

test("executeTool rejects a mapping from an older generation and ignores its late failure after reconnection", async (t) => {
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const { ToolAggregator } = await import("./tools/aggregator.js");
  const { AggregatedToolResolver } = await import("./tools/resolver.js");
  const { McpUpstreamInvoker } = await import("./tools/invoker.js");
  const { executeTool } = await import("./execution/execute-tool.js");
  let calls = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => { calls++; return { content: [] }; });
  });
  const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
    rules: [{ origin: new URL(extra.config.url).origin, cidrs: ["127.0.0.1/32"] }] }));
  t.after(() => registry.close());
  registry.register(extra.config);
  await registry.connect("extra");
  const resolver = new AggregatedToolResolver(new ToolAggregator(registry), registry);
  const old = await resolver.resolve("extra.echo");
  assert.ok(old);
  const previousClient = registry.getClient("extra")!;
  await registry.connect("extra");
  await registry.markUnreachable("extra", "Late failure", previousClient);
  assert.equal(registry.getState("extra")?.status, "connected");
  const records: AuditRecord[] = [];
  const dependencies = { resolver: { async resolve() { return old; } }, invoker: new McpUpstreamInvoker(registry),
    auditLogger: { async write(record: AuditRecord) { records.push(record); } } };
  const request = { identity: { userId: "admin", role: "admin" as const, keyId: "key" }, toolName: "extra.echo", arguments: {}, requestId: "stale" };
  await assert.rejects(executeTool(request, dependencies), { name: "UpstreamUnavailableError" });
  assert.equal(calls, 0);
  assert.equal(records[0].outcome, "upstream_unavailable");
  await executeTool({ ...request, requestId: "fresh" }, { ...dependencies, resolver });
  assert.equal(calls, 1);
  assert.equal(records[1].outcome, "success");
  await assert.rejects(executeTool({ ...request, identity: { ...request.identity, role: "member" } }, { ...dependencies, resolver }), { name: "AuthorizationError" });
  assert.equal(calls, 1);
  assert.equal(records[2].outcome, "unauthorized");
});

test("duplicate discovered names cannot publish a partial catalog or disrupt healthy tools", async (t) => {
  const calculator = await calculatorUpstream(t);
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => ({ content: [] }));
    server.server.setRequestHandler("tools/list", async () => ({ tools: [
      { name: "echo", description: "First", inputSchema: { type: "object", properties: {} } },
      { name: "echo", description: "Collision", inputSchema: { type: "object", properties: {} } },
    ] }));
  });
  const f = await fixture(t, { upstreams: [calculator.config], destinations: { allowLoopback: true,
    rules: [calculator.config, extra.config].map(config => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const response = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "extra", displayName: "Colliding tools", url: extra.config.url, transport: "streamable-http", enabled: true, authentication: { type: "none" },
  } });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().server.status, "unreachable");
  assert.equal(response.json().server.toolCount, 0);
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).content, [{ type: "text", text: "42" }]);
});

test("a transport failure from the current client remains effective after a successful catalog refresh", async (t) => {
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const extra = await calculatorUpstream(t);
  const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
    rules: [{ origin: new URL(extra.config.url).origin, cidrs: ["127.0.0.1/32"] }] }));
  t.after(() => registry.close());
  registry.register(extra.config);
  await registry.connect(extra.config.name);
  const client = registry.getClient(extra.config.name)!;
  await registry.refreshAll();
  await registry.markUnreachable(extra.config.name, "MCP request failed", client);
  assert.equal(registry.getState(extra.config.name)?.status, "unreachable");
  assert.equal(registry.getClient(extra.config.name), null);
});

test("lifecycle APIs stop stale MCP calls, rediscover on enable and preserve disable/removal across restart", async t => {
  let calls = 0;
  let description = "Before disable";
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", { description, inputSchema: z.object({}) }, async () => {
      calls++;
      return { content: [{ type: "text", text: "calculated" }] };
    });
  });
  const time = await controlledUpstream(t, "time", server => {
    server.registerTool("current", {}, async () => ({ content: [] }));
  });
  const configs = [calculator.config, time.config];
  const f = await fixture(t, { upstreams: configs });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const mutate = (name: string, action: string) => f.app.inject({ method: action === "remove" ? "DELETE" : "POST",
    url: `/api/admin/servers/${name}${action === "remove" ? "" : `/${action}`}`, headers: f.headers });
  await client.callTool({ name: "calculator.calculate", arguments: {} });
  assert.equal(calls, 1);
  const disabled = await mutate("calculator", "disable");
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().server.status, "disabled");
  assert.equal(disabled.json().server.enabled, false);
  assert.equal(disabled.json().server.toolCount, 0);
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["time.current"]);
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: {} }), ProtocolError);
  assert.equal(calls, 1);
  await client.callTool({ name: "time.current", arguments: {} });
  description = "Fresh after enable";
  const enabled = await mutate("calculator", "enable");
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().server.status, "connected");
  assert.equal((await client.listTools(undefined, { cacheMode: "bypass" })).tools.find(tool => tool.name === "calculator.calculate")?.description, description);
  await client.callTool({ name: "calculator.calculate", arguments: {} });
  assert.equal(calls, 2);
  assert.equal((await mutate("calculator", "disable")).statusCode, 200);
  assert.equal((await mutate("time", "remove")).statusCode, 204);
  assert.equal((await mutate("time", "remove")).statusCode, 404);
  for (const action of ["enable", "disable", "remove"]) assert.equal((await mutate("missing", action)).statusCode, 404);
  await assert.rejects(client.callTool({ name: "time.current", arguments: {} }), ProtocolError);
  await client.close();
  await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: configs,
    destinations: { allowLoopback: true, rules: configs.map(config => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  t.after(() => restarted.close());
  const servers = (await restarted.inject({ url: "/api/admin/servers", headers: f.headers })).json().servers;
  assert.deepEqual(servers.map((server: { serverId: string; status: string }) => [server.serverId, server.status]), [["calculator", "disabled"]]);
});

test("lifecycle mutations require eligible administrator sessions, trusted Origin and CSRF", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  const client = await f.connect();
  for (const action of ["disable", "enable", "remove"]) {
    const mutate = (headers: Record<string, string>) => f.app.inject({ method: action === "remove" ? "DELETE" : "POST",
      url: `/api/admin/servers/calculator${action === "remove" ? "" : `/${action}`}`, headers });
    assert.equal((await mutate({})).statusCode, 401);
    assert.equal((await mutate({ authorization: `Bearer ${f.rawKey}` })).statusCode, 401);
    assert.equal((await mutate(f.headers)).statusCode, 403);
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
    for (const headers of [{ ...f.headers, origin: "https://untrusted.example" }, { ...f.headers, "x-csrf-token": "" },
      { cookie: f.headers.cookie, "x-csrf-token": f.headers["x-csrf-token"] }]) {
      assert.equal((await mutate(headers)).statusCode, 403);
    }
    for (const status of [{ requiredPasswordChange: true }, { requiredPasswordChange: false, status: "disabled" }]) {
      await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: status });
      assert.equal((await mutate(f.headers)).statusCode, status.requiredPasswordChange ? 403 : 401);
    }
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { requiredPasswordChange: false, status: "active", role: "member" } });
  }
  assert.equal((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).isError, undefined);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/keys/${f.key.id}`, headers: f.headers })).statusCode, 204);
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } }), httpFailure(401));
});

test("lifecycle persistence failures return non-success without changing callable state", async t => {
  let calls = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => { calls++; return { content: [] }; });
  });
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const mutate = (action: string) => f.app.inject({ method: action === "remove" ? "DELETE" : "POST",
    url: `/api/admin/servers/calculator${action === "remove" ? "" : `/${action}`}`, headers: f.headers });
  await f.db.db!.command({ collMod: "upstream_registrations", validator: { enabled: true }, validationLevel: "strict" });
  for (const action of ["disable", "remove"]) {
    const response = await mutate(action);
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { error: "Authentication unavailable" });
    await client.callTool({ name: "calculator.calculate", arguments: {} });
  }
  assert.equal(calls, 2);
  await f.db.db!.command({ collMod: "upstream_registrations", validator: {}, validationLevel: "strict" });
  assert.equal((await mutate("disable")).statusCode, 200);
  await f.db.db!.command({ collMod: "upstream_registrations", validator: { enabled: false }, validationLevel: "strict" });
  assert.equal((await mutate("enable")).statusCode, 503);
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: {} }), ProtocolError);
  assert.equal(calls, 2);
  await f.db.db!.command({ collMod: "upstream_registrations", validator: {}, validationLevel: "strict" });
  assert.equal((await mutate("enable")).statusCode, 200);
  await client.callTool({ name: "calculator.calculate", arguments: {} });
  assert.equal(calls, 3);
});

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  return { entered, enter, release, blocked };
}

test("concurrent enable and removal serialize while delayed discovery leaves healthy requests responsive", async t => {
  const discovery = barrier();
  let delay = false;
  let calls = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => { calls++; return { content: [] }; });
    server.server.setRequestHandler("tools/list", async () => {
      if (delay) { discovery.enter(); await discovery.blocked; }
      return { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
    });
  });
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [extra.config, calculator.config] });
  t.after(discovery.release);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const disable = () => f.app.inject({ method: "POST", url: "/api/admin/servers/extra/disable", headers: f.headers });
  assert.equal((await disable()).statusCode, 200);
  delay = true;
  const enabling = f.app.inject({ method: "POST", url: "/api/admin/servers/extra/enable", headers: f.headers }).then(value => value);
  await discovery.entered;
  let removed = false;
  const removing = f.app.inject({ method: "DELETE", url: "/api/admin/servers/extra", headers: f.headers }).then(value => { removed = true; return value; });
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: f.headers })).statusCode, 200);
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  assert.equal(removed, false);
  discovery.release();
  assert.equal((await enabling).statusCode, 200);
  assert.equal((await removing).statusCode, 204);
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  await assert.rejects(client.callTool({ name: "extra.echo", arguments: {} }), ProtocolError);
  assert.equal(calls, 0);
  assert.equal((await disable()).statusCode, 404);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/enable", headers: f.headers })).statusCode, 404);
});

test("disable barriers reject resolved mappings and delayed automatic discovery cannot resurrect removed servers", async t => {
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const { ToolAggregator } = await import("./tools/aggregator.js");
  const { AggregatedToolResolver } = await import("./tools/resolver.js");
  const { McpUpstreamInvoker } = await import("./tools/invoker.js");
  const { executeTool } = await import("./execution/execute-tool.js");
  for (const phase of ["connect", "automatic refresh", "manual refresh"] as const) {
    await t.test(phase, async t => {
      const discovery = barrier();
      let delay = false;
      let calls = 0;
      const extra = await controlledUpstream(t, "extra", server => {
        server.registerTool("echo", {}, async () => { calls++; return { content: [] }; });
        server.server.setRequestHandler("tools/list", async () => {
          if (delay) { discovery.enter(); await discovery.blocked; }
          return { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
        });
      });
      const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
        rules: [{ origin: new URL(extra.config.url).origin, cidrs: ["127.0.0.1/32"] }] }));
      t.after(() => registry.close());
      t.after(discovery.release);
      registry.register(extra.config);
      await registry.connect("extra");
      const resolver = new AggregatedToolResolver(new ToolAggregator(registry), registry);
      const mapping = await resolver.resolve("extra.echo");
      assert.ok(mapping);
      const previousClient = registry.getClient("extra")!;
      delay = true;
      const connecting = phase === "connect" ? registry.connect("extra")
        : phase === "manual refresh" ? registry.refresh("extra") : Promise.resolve();
      if (phase === "automatic refresh") registry.startRefresh(10);
      await discovery.entered;
      const disabling = registry.disable("extra");
      const records: AuditRecord[] = [];
      const request = { identity: { userId: "admin", role: "admin" as const, keyId: "key" }, toolName: "extra.echo", arguments: {}, requestId: "stale" };
      const dependencies = { resolver: { async resolve() { return mapping; } }, invoker: new McpUpstreamInvoker(registry),
        auditLogger: { async write(record: AuditRecord) { records.push(record); } } };
      await assert.rejects(executeTool(request, dependencies), { name: "UpstreamUnavailableError" });
      assert.equal(calls, 0);
      discovery.release();
      await connecting;
      await disabling;
      registry.remove("extra");
      await registry.refreshAll();
      assert.equal(await resolver.resolve("extra.echo"), null);
      await assert.rejects(executeTool(request, dependencies), { name: "UpstreamUnavailableError" });
      assert.equal(calls, 0);
      assert.deepEqual(records.map(record => record.outcome), ["upstream_unavailable", "upstream_unavailable"]);
      // An old failure and queued periodic maintenance cannot recreate the registration.
      await registry.markUnreachable("extra", "Late failure", previousClient);
      assert.equal(registry.getState("extra"), undefined);
      registry.register(extra.config);
      delay = false;
      await registry.connect("extra");
      await registry.markUnreachable("extra", "Late failure", previousClient);
      await executeTool(request, { ...dependencies, resolver });
      assert.equal(calls, 1);
    });
  }
});

test("enable rediscovers with current destination checks and offline servers stay enabled without harming healthy tools", async t => {
  const calculator = await calculatorUpstream(t);
  let online = true;
  let calls = 0;
  let lookups = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => { calls++; return { content: [] }; });
  });
  const { buildConnector } = await import("undici");
  const dial = buildConnector({ timeout: 1000 });
  const endpoint = new URL(extra.config.url);
  const f = await fixture(t, { upstreams: [calculator.config, { ...extra.config, url: "http://tools.example.test/mcp" }],
    destinations: { allowLoopback: true, rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] },
      { origin: "http://tools.example.test", cidrs: ["203.0.113.10/32"] }] },
    upstreamNetwork: {
      async lookup() { lookups++; return [{ address: online ? "203.0.113.10" : "169.254.169.254", family: 4 }]; },
      dial(options, callback) {
        dial(options.hostname === "203.0.113.10" ? { ...options, hostname: endpoint.hostname, port: endpoint.port } : options, callback);
      },
    },
  });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  await client.callTool({ name: "extra.echo", arguments: {} });
  assert.equal(calls, 1);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/disable", headers: f.headers })).statusCode, 200);
  online = false;
  const before = lookups;
  const response = await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/enable", headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(lookups > before);
  assert.equal(response.json().server.enabled, true);
  assert.equal(response.json().server.status, "unreachable");
  assert.equal(response.json().server.lastError, "Upstream unavailable");
  assert.equal(response.json().server.toolCount, 0);
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["calculator.calculate"]);
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  await assert.rejects(client.callTool({ name: "extra.echo", arguments: {} }), ProtocolError);
  assert.equal(calls, 1);
  const deniedRefresh = await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/refresh", headers: f.headers });
  assert.equal(deniedRefresh.statusCode, 200);
  assert.equal(deniedRefresh.json().server.status, "unreachable");
  assert.equal(deniedRefresh.json().server.configurationRevision, response.json().server.configurationRevision);
  online = true;
  assert.equal((await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/refresh", headers: f.headers })).json().server.status, "connected");
  await client.callTool({ name: "extra.echo", arguments: {} });
  assert.equal(calls, 2);
});

test("disable drains an already-started call while blocking new invocations and retaining audit attribution", async t => {
  const call = barrier();
  let calls = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => {
      calls++;
      call.enter();
      await call.blocked;
      return { content: [{ type: "text", text: "finished" }] };
    });
  });
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [calculator.config], auditLogger: { async write(record) { records.push(record); } } });
  t.after(call.release);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const started = client.callTool({ name: "calculator.calculate", arguments: {} });
  await call.entered;
  let completed = false;
  const disabling = f.app.inject({ method: "POST", url: "/api/admin/servers/calculator/disable", headers: f.headers }).then(response => { completed = true; return response; });
  // Observe the persisted barrier through the HTTP contract before releasing the call.
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers });
    if (!response.json().server.enabled) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server.enabled, false);
  assert.equal(completed, false);
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: {} }), ProtocolError);
  assert.equal(calls, 1);
  call.release();
  assert.deepEqual((await started).content, [{ type: "text", text: "finished" }]);
  assert.equal((await disabling).statusCode, 200);
  assert.deepEqual(records.map(record => record.outcome), ["not_found", "success"]);
  assert.ok(records.every(record => record.userId === f.userId && record.keyId === f.key.id));
});

test("failed removal deletion leaves a durable disabled registration that can be retried", async t => {
  let calls = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => { calls++; return { content: [] }; });
  });
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  // Fail the actual MongoDB delete command, after the durable disable succeeds.
  await f.db.db!.admin().command({ configureFailPoint: "failCommand", mode: { times: 1 }, data: { failCommands: ["delete"], errorCode: 8 } });
  const removing = await f.app.inject({ method: "DELETE", url: "/api/admin/servers/calculator", headers: f.headers });
  assert.equal(removing.statusCode, 503, removing.body);
  const detail = (await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  assert.equal(detail.enabled, false);
  assert.equal(detail.status, "disabled");
  assert.equal(detail.toolCount, 0);
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: {} }), ProtocolError);
  assert.equal(calls, 0);
  await client.close();
  await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [calculator.config],
    destinations: { allowLoopback: true, rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] }] } });
  t.after(() => restarted.close());
  assert.equal((await restarted.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server.status, "disabled");
  assert.equal((await restarted.inject({ method: "DELETE", url: "/api/admin/servers/calculator", headers: f.headers })).statusCode, 204);
});

test("failed connection cleanup keeps the barrier and retained connection available for retry", async t => {
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const { ToolAggregator } = await import("./tools/aggregator.js");
  const { AggregatedToolResolver } = await import("./tools/resolver.js");
  const { McpUpstreamInvoker } = await import("./tools/invoker.js");
  let calls = 0;
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => { calls++; return { content: [] }; });
  });
  const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
    rules: [{ origin: new URL(extra.config.url).origin, cidrs: ["127.0.0.1/32"] }] }));
  t.after(() => registry.close());
  registry.register(extra.config);
  await registry.connect("extra");
  const resolver = new AggregatedToolResolver(new ToolAggregator(registry), registry);
  const mapping = await resolver.resolve("extra.echo");
  assert.ok(mapping);
  const client = registry.getClient("extra")!;
  const close = client.close.bind(client);
  // Inject a close rejection at the external MCP SDK client boundary; connection,
  // discovery, resolution and actual upstream calls otherwise remain real.
  client.close = async () => { throw new Error("synthetic cleanup failure"); };
  await assert.rejects(registry.disable("extra"), /synthetic cleanup failure/);
  assert.equal(registry.getState("extra")?.status, "disabled");
  await assert.rejects(new McpUpstreamInvoker(registry).invoke(mapping, {}), { name: "UpstreamUnavailableError" });
  assert.equal(calls, 0);
  assert.throws(() => registry.remove("extra"), /cleanup incomplete/);
  client.close = close;
  await registry.disable("extra");
  registry.remove("extra");
  assert.equal(await resolver.resolve("extra.echo"), null);
});

test("server edits preserve display-only connections and replace endpoints for a continuing MCP client", async t => {
  let oldCalls = 0;
  let discoveries = 0;
  const old = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => { oldCalls++; return { content: [{ type: "text", text: "old" }] }; });
    server.server.setRequestHandler("tools/list", async () => {
      discoveries++;
      return { tools: [{ name: "calculate", inputSchema: { type: "object", properties: {} } }] };
    });
  });
  const replacement = await controlledUpstream(t, "replacement", server => {
    server.registerTool("calculate", {}, async () => ({ content: [{ type: "text", text: "new" }] }));
  });
  const time = await controlledUpstream(t, "time", server => {
    server.registerTool("current", {}, async () => ({ content: [] }));
  });
  const f = await fixture(t, { upstreams: [old.config, time.config], destinations: { allowLoopback: true,
    rules: [old, replacement, time].map(upstream => ({ origin: new URL(upstream.config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const patch = (payload: object) => f.app.inject({ method: "PATCH", url: "/api/admin/servers/calculator", headers: f.headers, payload });
  const before = (await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  const display = await patch({ displayName: " Renamed calculator " });
  assert.equal(display.statusCode, 200, display.body);
  assert.equal(display.json().server.displayName, "Renamed calculator");
  assert.equal(display.json().server.lastConnectedAt, before.lastConnectedAt);
  assert.equal(discoveries, 1);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate" })).content, [{ type: "text", text: "old" }]);
  const swapped = await patch({ url: replacement.config.url });
  assert.equal(swapped.statusCode, 200, swapped.body);
  assert.equal(swapped.json().server.serverId, "calculator");
  assert.equal(swapped.json().server.configurationRevision, 3);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate" })).content, [{ type: "text", text: "new" }]);
  assert.equal(oldCalls, 1);
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [old.config],
    destinations: { allowLoopback: true, rules: [old, replacement, time].map(upstream => ({
      origin: new URL(upstream.config.url).origin, cidrs: ["127.0.0.1/32"],
    })) } });
  t.after(() => restarted.close());
  const restored = (await restarted.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  assert.equal(restored.url, replacement.config.url);
  assert.equal(restored.displayName, "Renamed calculator");
  assert.equal(restored.status, "connected");
  await restarted.close();
  await replacement.app.close();
  const failed = await patch({ url: `${replacement.config.url}?offline=1` });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().server.status, "unreachable");
  assert.equal(failed.json().server.toolCount, 0);
  assert.deepEqual((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(tool => tool.name), ["time.current"]);
  await client.callTool({ name: "time.current" });
  await assert.rejects(client.callTool({ name: "calculator.calculate" }), ProtocolError);
  assert.equal(oldCalls, 1);
});

test("server PATCH enforces administrator eligibility, CSRF, strict input and canonical uniqueness", async t => {
  const calculator = await calculatorUpstream(t);
  const time = await controlledUpstream(t, "time", server => { server.registerTool("current", {}, async () => ({ content: [] })); });
  const f = await fixture(t, { upstreams: [calculator.config, time.config] });
  const url = "/api/admin/servers/calculator";
  const patch = (payload: object, headers = f.headers, path = url) => f.app.inject({ method: "PATCH", url: path, headers, payload });
  assert.equal((await f.app.inject({ method: "PATCH", url, payload: { displayName: "New" } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: { authorization: `Bearer ${f.rawKey}` }, payload: { displayName: "New" } })).statusCode, 401);
  assert.equal((await patch({ displayName: "New" })).statusCode, 403);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  for (const headers of [{ ...f.headers, origin: "https://untrusted.test" }, { ...f.headers, "x-csrf-token": "" }]) {
    assert.equal((await patch({ displayName: "New" }, headers)).statusCode, 403);
  }
  for (const payload of [{}, { serverId: "renamed" }, { enabled: false }, { authentication: { type: "unsupported" } },
    { headers: { authorization: "secret" } }, { displayName: " " }, { displayName: "x", unexpected: true },
    { url: "http://unapproved.example/mcp" }, { url: "file:///tmp/mcp" }, { url: "http://user:secret@localhost/mcp" }]) {
    const response = await patch(payload);
    assert.equal(response.statusCode, 400, response.body);
  }
  const duplicate = await patch({ url: time.config.url.replace("/mcp", "/a/../mcp"), displayName: "Must not persist" });
  assert.equal(duplicate.statusCode, 409);
  assert.equal((await f.app.inject({ url, headers: f.headers })).json().server.displayName, "calculator");
  assert.equal((await patch({ displayName: "New" }, f.headers, "/api/admin/servers/missing")).statusCode, 404);
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: { ...f.headers, "content-type": "text/plain" }, payload: "new" })).statusCode, 415);
  for (const status of [{ requiredPasswordChange: true }, { requiredPasswordChange: false, status: "disabled" }]) {
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: status });
    assert.equal((await patch({ displayName: "New" })).statusCode, status.requiredPasswordChange ? 403 : 401);
  }
});

test("server edit persistence failure leaves desired configuration and the callable endpoint unchanged", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  await f.db.db!.command({ collMod: "upstream_registrations", validator: { configurationRevision: 1 }, validationLevel: "strict" });
  const response = await f.app.inject({ method: "PATCH", url: "/api/admin/servers/calculator", headers: f.headers,
    payload: { displayName: "Rejected", url: `${calculator.config.url}?replacement=1` } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "Authentication unavailable" });
  const unchanged = (await f.app.inject({ url: "/api/admin/servers/calculator", headers: f.headers })).json().server;
  assert.equal(unchanged.url, calculator.config.url);
  assert.equal(unchanged.displayName, "calculator");
  assert.equal(unchanged.configurationRevision, 1);
  assert.deepEqual((await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } })).content,
    [{ type: "text", text: "42" }]);
});

test("competing server edits serialize desired revisions while healthy MCP requests continue", async t => {
  const discovery = barrier();
  let delay = false;
  let oldCalls = 0;
  const old = await controlledUpstream(t, "extra", server => { server.registerTool("echo", {}, async () => { oldCalls++; return { content: [] }; }); });
  const replacement = await controlledUpstream(t, "replacement", server => {
    server.registerTool("echo", {}, async () => ({ content: [] }));
    server.server.setRequestHandler("tools/list", async () => {
      if (delay) { discovery.enter(); await discovery.blocked; }
      return { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
    });
  });
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [old.config, calculator.config], destinations: { allowLoopback: true,
    rules: [old, replacement, calculator].map(upstream => ({ origin: new URL(upstream.config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  t.after(discovery.release);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  delay = true;
  const patch = (payload: object) => f.app.inject({ method: "PATCH", url: "/api/admin/servers/extra", headers: f.headers, payload });
  const first = patch({ url: replacement.config.url }).then(response => response);
  await discovery.entered;
  let secondCompleted = false;
  const second = patch({ displayName: "Final display" }).then(response => { secondCompleted = true; return response; });
  assert.equal((await f.app.inject({ url: "/api/admin/servers/extra/tools", headers: f.headers })).json().tools.length, 0);
  await assert.rejects(client.callTool({ name: "extra.echo" }), ProtocolError);
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  assert.equal(secondCompleted, false);
  discovery.release();
  assert.equal((await first).statusCode, 200);
  const final = await second;
  assert.equal(final.statusCode, 200);
  assert.equal(final.json().server.url, replacement.config.url);
  assert.equal(final.json().server.displayName, "Final display");
  assert.equal(final.json().server.configurationRevision, 3);
  assert.equal(final.json().server.status, "connected");
  await client.callTool({ name: "extra.echo" });
  assert.equal(oldCalls, 0);
});

test("endpoint replacement rejects stale mappings, delayed old discovery and late old client failures", async t => {
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const { ToolAggregator } = await import("./tools/aggregator.js");
  const { AggregatedToolResolver } = await import("./tools/resolver.js");
  const { McpUpstreamInvoker } = await import("./tools/invoker.js");
  const { executeTool } = await import("./execution/execute-tool.js");
  for (const phase of ["connect", "refresh"] as const) {
    await t.test(phase, async t => {
      const discovery = barrier();
      let delay = false;
      let oldCalls = 0;
      let newCalls = 0;
      const old = await controlledUpstream(t, "extra", server => {
        server.registerTool("echo", {}, async () => { oldCalls++; return { content: [] }; });
        server.server.setRequestHandler("tools/list", async () => {
          if (delay) { discovery.enter(); await discovery.blocked; }
          return { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
        });
      });
      const replacement = await controlledUpstream(t, "replacement", server => {
        server.registerTool("echo", {}, async () => { newCalls++; return { content: [] }; });
      });
      const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
        rules: [old, replacement].map(upstream => ({ origin: new URL(upstream.config.url).origin, cidrs: ["127.0.0.1/32"] })) }));
      t.after(() => registry.close());
      t.after(discovery.release);
      registry.register(old.config);
      await registry.connect("extra");
      const resolver = new AggregatedToolResolver(new ToolAggregator(registry), registry);
      const mapping = await resolver.resolve("extra.echo");
      assert.ok(mapping);
      const previousClient = registry.getClient("extra")!;
      delay = true;
      const pending = phase === "connect" ? registry.connect("extra") : registry.refreshAll();
      await discovery.entered;
      const replacing = registry.reconfigure({ ...old.config, url: replacement.config.url, configurationRevision: 2 });
      const records: AuditRecord[] = [];
      const request = { identity: { userId: "admin", role: "admin" as const, keyId: "key" }, toolName: "extra.echo", arguments: {}, requestId: "replacement" };
      const dependencies = { resolver: { async resolve() { return mapping; } }, invoker: new McpUpstreamInvoker(registry),
        auditLogger: { async write(record: AuditRecord) { records.push(record); } } };
      await assert.rejects(executeTool(request, dependencies), { name: "UpstreamUnavailableError" });
      discovery.release();
      await pending;
      await replacing;
      await registry.markUnreachable("extra", "Late old failure", previousClient);
      await assert.rejects(executeTool(request, dependencies), { name: "UpstreamUnavailableError" });
      await executeTool(request, { ...dependencies, resolver });
      assert.equal(registry.getState("extra")?.config.configurationRevision, 2);
      assert.equal(registry.getState("extra")?.status, "connected");
      assert.equal(oldCalls, 0);
      assert.equal(newCalls, 1);
      assert.deepEqual(records.map(record => record.outcome), ["upstream_unavailable", "upstream_unavailable", "success"]);
    });
  }
});

test("HTTP endpoint replacement drains a delayed failing old call without poisoning the continuing MCP client", async t => {
  const failure = barrier();
  let oldCalls = 0;
  const old = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => ({ content: [] }));
    server.server.setRequestHandler("tools/call", async () => {
      oldCalls++;
      failure.enter();
      await failure.blocked;
      throw new Error("Controlled old upstream failure");
    });
  });
  const replacement = await controlledUpstream(t, "replacement", server => {
    server.registerTool("echo", {}, async () => ({ content: [{ type: "text", text: "replacement" }] }));
  });
  const calculator = await calculatorUpstream(t);
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [old.config, calculator.config], auditLogger: { async write(record) { records.push(record); } },
    destinations: { allowLoopback: true, rules: [old, replacement, calculator].map(upstream => ({
      origin: new URL(upstream.config.url).origin, cidrs: ["127.0.0.1/32"],
    })) } });
  t.after(failure.release);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const failing = client.callTool({ name: "extra.echo" });
  await failure.entered;
  const replacing = f.app.inject({ method: "PATCH", url: "/api/admin/servers/extra", headers: f.headers,
    payload: { url: replacement.config.url } }).then(response => response);
  let withdrawn = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = (await f.app.inject({ url: "/api/admin/servers/extra", headers: f.headers })).json().server;
    if (state.configurationRevision === 2 && state.status === "disconnected") {
      assert.equal(state.url, replacement.config.url);
      assert.equal(state.toolCount, 0);
      withdrawn = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(withdrawn, "Persisted replacement must withdraw the old catalog before draining calls");
  await assert.rejects(client.callTool({ name: "extra.echo" }), ProtocolError);
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  failure.release();
  const edited = await replacing;
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await failing).isError, true);
  assert.equal(edited.json().server.status, "connected");
  assert.equal((await f.app.inject({ url: "/api/admin/servers/extra", headers: f.headers })).json().server.status, "connected");
  assert.deepEqual((await client.callTool({ name: "extra.echo" })).content, [{ type: "text", text: "replacement" }]);
  assert.equal(oldCalls, 1);
  assert.equal(records.filter(record => record.toolName === "extra.echo" && record.outcome === "upstream_error").length, 1);
});


test("approved bearer Secret authenticates only its upstream through dashboard and MCP", async t => {
  const secret = "synthetic-upstream-bearer-22";
  const seen: string[] = [];
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => ({ content: [{ type: "text", text: "authenticated" }] }));
  }, app => app.addHook("onRequest", async (request, reply) => {
    seen.push(request.headers.authorization ?? "missing");
    if (request.headers.authorization !== `Bearer ${secret}`) return reply.code(401).send();
  }));
  const calculator = await calculatorUpstream(t);
  const ref = { namespace: "urumi", name: "extra-token", key: "token" };
  const records: AuditRecord[] = [];
  const f = await fixture(t, { upstreams: [calculator.config], approvedSecrets: [ref],
    secretReader: { async read(value) { assert.deepEqual(value, ref); return secret; } },
    auditLogger: { async write(record) { records.push(record); } },
    destinations: { allowLoopback: true, rules: [extra, calculator].map(({ config }) => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers,
    payload: { serverId: "extra", displayName: "Private", url: extra.config.url, transport: "streamable-http", enabled: true,
      authentication: { type: "bearer", secretRef: ref } } });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().server.status, "connected");
  const client = await f.connect();
  assert.equal((await client.callTool({ name: "extra.echo" })).isError, undefined);
  assert.ok(seen.length > 0);
  assert.ok(seen.every(value => value === `Bearer ${secret}` && !value.includes(f.rawKey)));
  assert.ok(!JSON.stringify([response.json(), records, await f.db.collection("upstream_registrations").find().toArray()]).includes(secret));
});

test("Secret reference policy rejects unsafe headers and raw or unapproved credentials before I/O", async t => {
  const ref = { namespace: "urumi", name: "approved", key: "token" };
  let reads = 0;
  const f = await fixture(t, { approvedSecrets: [ref], secretReader: { async read() { reads++; return "synthetic-private-22"; } } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const base = { serverId: "extra", displayName: "Extra", url: "http://urumi-time-mcp:3003/mcp", transport: "streamable-http", enabled: true };
  const invalid = [
    ...["Host", "Authorization", "Cookie", "Connection", "Content-Type", "Origin", "Mcp-Session-Id", "X-Forwarded-For", "Proxy-Test", "Sec-Fetch-Site", "X-HTTP-Method-Override", "invalid\r\nname"].map(headerName => ({ type: "header", secretRef: ref, headerName })),
    { type: "bearer", secretRef: { ...ref, namespace: "other" } },
    { type: "bearer", secretRef: { ...ref, name: "unapproved" } },
    { type: "bearer", secretRef: { ...ref, key: "password" } },
    { type: "bearer", secretRef: { ...ref, namespace: "../urumi" } },
    { type: "bearer", secretRef: { ...ref, name: "../approved" } },
    { type: "bearer", secretRef: { ...ref, key: "bad/key" } },
    { type: "bearer", secretRef: ref, headerName: "X-Token" },
    { type: "none", secretRef: ref }, { type: "none", token: "synthetic-private-22" },
    { type: "bearer", secretRef: ref, value: "synthetic-private-22" },
  ];
  for (const authentication of invalid) {
    const response = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: { ...base, authentication } });
    assert.equal(response.statusCode, 400, JSON.stringify(authentication));
    assert.ok(!response.body.includes("synthetic-private-22"));
  }
  const create = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: { ...base, enabled: false, authentication: { type: "none" } } });
  assert.equal(create.statusCode, 201);
  for (const authentication of invalid) {
    const response = await f.app.inject({ method: "PATCH", url: "/api/admin/servers/extra", headers: f.headers, payload: { authentication } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(reads, 0);
  const stored = await f.db.collection("upstream_registrations").findOne({ serverId: "extra" });
  assert.deepEqual(stored?.authentication, { type: "none" });
  assert.equal(stored?.configurationRevision, 1);
});

test("credential edits retire old authentication and reconnect rotation resolves current Secret values", async t => {
  const first = { namespace: "urumi", name: "first", key: "token" };
  const second = { ...first, name: "second" };
  let value = "synthetic-first-22";
  let readFailure = false;
  let reads = 0;
  const seen: { bearer?: string; custom?: string }[] = [];
  const output: string[] = [];
  for (const method of ["info", "warn", "error"] as const) t.mock.method(console, method, (...args: unknown[]) => output.push(JSON.stringify(args)));
  let expected = { header: "authorization", value: `Bearer ${value}` };
  const extra = await controlledUpstream(t, "extra", server => {
    server.registerTool("echo", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  }, app => app.addHook("onRequest", async (request, reply) => {
    seen.push({ bearer: request.headers.authorization, custom: String(request.headers["x-upstream-token"] ?? "") });
    if (request.headers[expected.header] !== expected.value) return reply.code(401).send();
  }));
  const healthyHeaders: unknown[] = [];
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => ({ content: [] }));
  }, app => app.addHook("onRequest", async request => { healthyHeaders.push(request.headers.authorization, request.headers["x-upstream-token"]); }));
  const records: AuditRecord[] = [];
  const destinations = { allowLoopback: true, rules: [extra, calculator].map(({ config }) => ({ origin: new URL(config.url).origin, cidrs: ["127.0.0.1/32"] })) };
  const secretReader = { async read() { reads++; if (readFailure) throw new Error(`Forbidden or missing key: ${value}`); return value; } };
  const f = await fixture(t, { upstreams: [calculator.config], approvedSecrets: [first, second], secretReader,
    destinations, auditLogger: { async write(record) { records.push(record); } } });
  const request = (method: "POST" | "PATCH", path: string, payload?: object) => f.app.inject({ method, url: `/api/admin/servers/extra${path}`, headers: f.headers, payload });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const created = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "extra", displayName: "Extra", url: extra.config.url, transport: "streamable-http", enabled: true,
    authentication: { type: "bearer", secretRef: first },
  } });
  assert.equal(created.statusCode, 201, created.body);
  await client.callTool({ name: "extra.echo" });
  // Failure replacing the reference must withdraw the old credential/catalog.
  readFailure = true;
  const failed = await request("PATCH", "", { authentication: { type: "bearer", secretRef: second } });
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal(failed.json().server.status, "unreachable");
  assert.equal(failed.json().server.toolCount, 0);
  const afterFailure = seen.length;
  await assert.rejects(client.callTool({ name: "extra.echo" }), ProtocolError);
  assert.equal(seen.length, afterFailure);
  await client.callTool({ name: "calculator.calculate" });
  // Recovery resolves again and sends only the custom header, never stale bearer.
  readFailure = false;
  value = "synthetic-second-22";
  expected = { header: "x-upstream-token", value };
  const custom = await request("PATCH", "", { authentication: { type: "header", secretRef: second, headerName: "X-Upstream-Token" } });
  assert.equal(custom.json().server.status, "connected", custom.body);
  const afterCustom = seen.length;
  await client.callTool({ name: "extra.echo" });
  assert.ok(seen.slice(afterCustom).every(headers => headers.custom === value && headers.bearer === undefined));
  await request("POST", "/disable");
  value = "synthetic-rotated-22";
  expected.value = value;
  const beforeRotation = reads;
  const enabled = await request("POST", "/enable");
  assert.equal(enabled.json().server.status, "connected");
  assert.equal(reads, beforeRotation + 1);
  await client.callTool({ name: "extra.echo" });
  assert.equal(seen.at(-1)?.custom, value);
  // Invalid Secret contents fail closed before HTTP and leave the healthy server usable.
  await request("POST", "/disable");
  const beforeInvalid = seen.length;
  value = "invalid\r\nheader";
  const invalid = await request("POST", "/enable");
  assert.equal(invalid.json().server.status, "unreachable");
  assert.equal(seen.length, beforeInvalid);
  value = "synthetic-recovered-22";
  expected.value = value;
  const recovered = await request("POST", "/refresh");
  assert.equal(recovered.json().server.status, "connected", recovered.body);
  await client.callTool({ name: "extra.echo" });
  assert.equal(seen.at(-1)?.custom, value);
  // Restart resolves persisted references with the current value, rather than storing headers.
  await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [], destinations, approvedSecrets: [first, second], secretReader });
  t.after(() => restarted.close());
  const restored = await restarted.inject({ url: "/api/admin/servers/extra", headers: f.headers });
  assert.equal(restored.json().server.status, "connected");
  const persisted = await f.db.collection("upstream_registrations").find().toArray();
  assert.deepEqual(persisted.find(row => row.serverId === "extra")?.authentication, { type: "header", secretRef: second, headerName: "X-Upstream-Token" });
  assert.ok(healthyHeaders.every(header => header === undefined));
  const captured = JSON.stringify([output, records, persisted, failed.json(), custom.json(), invalid.json(), recovered.json(), restored.json()]);
  assert.ok(!captured.includes("synthetic-"));
});

test("authenticated upstream redirects cannot disclose credentials and failed Secret reads isolate servers", async t => {
  const ref = { namespace: "urumi", name: "private", key: "token" };
  const secret = "synthetic-redirect-secret-22";
  let destinationCalls = 0;
  const destination = await controlledUpstream(t, "destination", server => {
    destinationCalls++;
    server.registerTool("echo", {}, async () => ({ content: [] }));
  });
  let redirectRequests = 0;
  const redirect = createMcpFastifyApp({ host: "127.0.0.1" });
  redirect.all("/mcp", async (request, reply) => {
    redirectRequests++;
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    return reply.redirect(destination.config.url, 307);
  });
  t.after(() => redirect.close());
  const address = await redirect.listen({ host: "127.0.0.1", port: 0 });
  const calculator = await calculatorUpstream(t);
  let failure: string | undefined;
  const f = await fixture(t, { upstreams: [calculator.config], approvedSecrets: [ref],
    secretReader: { async read() { if (failure) throw new Error(`${failure}: ${secret}`); return secret; } },
    destinations: { allowLoopback: true, rules: [calculator.config.url, destination.config.url, address].map(url => ({ origin: new URL(url).origin, cidrs: ["127.0.0.1/32"] })) } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const created = await f.app.inject({ method: "POST", url: "/api/admin/servers", headers: f.headers, payload: {
    serverId: "extra", displayName: "Redirecting", url: `${address}/mcp`, transport: "streamable-http", enabled: true,
    authentication: { type: "bearer", secretRef: ref },
  } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().server.status, "unreachable");
  assert.ok(redirectRequests > 0);
  assert.equal(destinationCalls, 0);
  const client = await f.connect();
  for (failure of ["missing Secret", "missing key", "forbidden access"]) {
    const before = redirectRequests;
    const refreshed = await f.app.inject({ method: "POST", url: "/api/admin/servers/extra/refresh", headers: f.headers });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json().server.status, "unreachable");
    assert.ok(!refreshed.body.includes(secret));
    assert.ok(!refreshed.body.includes(failure));
    assert.equal(redirectRequests, before);
    assert.equal(destinationCalls, 0);
    await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  }
});

test("malformed Secret approval fails startup before database access", async () => {
  const previous = process.env.UPSTREAM_SECRET_REFERENCES;
  try {
    for (const invalid of ["not-json", "{}", '[{"namespace":"urumi","name":"token","key":"token","value":"synthetic-private"}]', '[{"namespace":"../urumi","name":"token","key":"token"}]']) {
      process.env.UPSTREAM_SECRET_REFERENCES = invalid;
      await assert.rejects(createGatewayApp({ mongodbUri: "invalid" }), /Invalid upstream Secret configuration/);
    }
  } finally {
    if (previous === undefined) delete process.env.UPSTREAM_SECRET_REFERENCES;
    else process.env.UPSTREAM_SECRET_REFERENCES = previous;
  }
});


test("administrator reads durable safe tool history across gateway restart", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  assert.equal((await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).statusCode, 403);
  assert.equal((await f.app.inject({ url: "/api/admin/audit" })).statusCode, 401);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const result = await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  assert.deepEqual(result.content, [{ type: "text", text: "42" }]);
  const response = await f.app.inject({ url: "/api/admin/audit?page=1&limit=1", headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const { records, page, limit, hasMore } = response.json();
  assert.equal(page, 1); assert.equal(limit, 1); assert.equal(hasMore, false);
  assert.equal(records.length, 1);
  const row = records[0];
  assert.equal(row.userId, f.userId); assert.equal(row.userEmail, "member@example.com");
  assert.equal(row.keyId, f.key.id); assert.equal(row.authenticationOrigin, "gateway_api_key");
  assert.equal(row.upstreamName, "calculator"); assert.equal(row.upstreamDisplayName, "calculator");
  assert.match(row.upstreamId, /^[a-f0-9]{24}$/);
  assert.equal(row.toolName, "calculator.calculate"); assert.equal(row.outcome, "success");
  assert.match(row.attemptId, /^[a-f0-9-]{36}$/); assert.ok(row.requestId);
  assert.ok(Number.isFinite(Date.parse(row.timestamp))); assert.ok(row.durationMs >= 0);
  assert.deepEqual(Object.keys(row).sort(), ["id", "attemptId", "requestId", "userId", "userEmail", "keyId", "authenticationOrigin",
    "upstreamId", "upstreamName", "upstreamDisplayName", "toolName", "timestamp", "durationMs", "outcome"].sort());
  for (const query of ["page=0", "limit=101", "limit=-1", "page=1.5", "unknown=1", "limit=1&limit=2"]) {
    assert.equal((await f.app.inject({ url: `/api/admin/audit?${query}`, headers: f.headers })).statusCode, 400);
  }
  await client.close(); await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [],
    destinations: { allowLoopback: true, rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] }] } });
  t.after(() => restarted.close());
  assert.deepEqual((await restarted.inject({ url: "/api/admin/audit?page=1&limit=1", headers: f.headers })).json(), response.json());
});

test("audit preserves historical attribution and MCP tool errors with bounded deterministic pages", async t => {
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", { inputSchema: z.object({ secret: z.string() }) }, async () => ({
      isError: true, content: [{ type: "text", text: "secret-result http://private-upstream:9999" }],
      structuredContent: { privateValue: "secret-result" },
    }));
  });
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  for (let index = 0; index < 3; index++) {
    const result = await client.callTool({ name: "calculator.calculate", arguments: { secret: "secret-argument" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { privateValue: "secret-result" });
  }
  const before = (await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records;
  assert.equal(before.length, 3); assert.ok(before.every((row: AuditRecord) => row.outcome === "tool_error"));
  const renamed = await f.app.inject({ method: "PATCH", url: "/api/admin/servers/calculator", headers: f.headers,
    payload: { displayName: "Renamed calculator" } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await f.app.inject({ method: "DELETE", url: "/api/admin/servers/calculator", headers: f.headers })).statusCode, 204);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { email: "changed@example.com" } });
  assert.deepEqual((await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records, before);
  // Arrange equal timestamps to exercise the API's tie-breaker independently of wall-clock speed.
  await f.db.collection("tool_audit").updateMany({}, { $set: { timestamp: "2026-10-17T00:00:00.000Z" } });
  const seen: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await f.app.inject({ url: `/api/admin/audit?page=${page}&limit=1`, headers: f.headers });
    const body = response.json();
    assert.equal(body.records.length, 1); assert.equal(body.hasMore, page < 3);
    assert.equal(body.records[0].userEmail, "member@example.com");
    assert.equal(body.records[0].upstreamDisplayName, "calculator");
    seen.push(body.records[0].id);
    for (const secret of ["secret-result", "secret-argument", "private-upstream", f.rawKey, "passwordHash", "stack", "arguments", "content"]) {
      assert.ok(!response.body.includes(secret), secret);
    }
  }
  assert.deepEqual(seen, before.map((row: { id: string }) => row.id).sort().reverse());
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual((await f.app.inject({ url: "/api/admin/audit?page=4&limit=1", headers: f.headers })).json(),
    { records: [], page: 4, limit: 1, hasMore: false });
});

test("MongoDB audit-write rejection signals safely without replacing a tool result or replaying a write", async t => {
  let writes = 0;
  const upstream = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", {}, async () => {
      writes++; return { content: [{ type: "text", text: "Product created" }], structuredContent: { id: 42 } };
    });
  });
  const f = await fixture(t, { upstreams: [upstream.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  // Inject failure at the actual database boundary; authentication remains available.
  await f.db.db!.command({ collMod: "tool_audit", validator: { $expr: { $eq: [1, 0] } }, validationLevel: "strict" });
  const signals: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { signals.push(args); });
  const result = await client.callTool({ name: "woocommerce.create_product" });
  assert.deepEqual(result.structuredContent, { id: 42 }); assert.equal(result.isError, undefined); assert.equal(writes, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].length, 1);
  const signal = JSON.parse(String(signals[0][0]));
  assert.deepEqual(Object.keys(signal).sort(), ["attemptId", "event"]);
  assert.equal(signal.event, "audit_write_failed"); assert.match(signal.attemptId, /^[a-f0-9-]{36}$/);
  assert.deepEqual((await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records, []);
  await f.db.db!.command({ collMod: "tool_audit", validator: {} });
  await client.callTool({ name: "woocommerce.create_product" });
  assert.equal(writes, 2);
  assert.equal((await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records.length, 1);
});

test("shared execution records real dashboard-session origin, rejections and unavailable catalog entries", async t => {
  // These outcomes cannot currently reach an MCP callback: SDK filtering rejects them first.
  // Exercise the shared execution contract directly, reading durable rows through the admin API.
  const { connectIdentityStorage } = await import("./identity/storage.js");
  const { createDashboardSessions } = await import("./identity/dashboard-sessions.js");
  const { UpstreamRegistry } = await import("./upstream/registry.js");
  const { DestinationPolicy } = await import("./upstream/destination-policy.js");
  const { ToolAggregator } = await import("./tools/aggregator.js");
  const { AggregatedToolResolver } = await import("./tools/resolver.js");
  const { McpUpstreamInvoker } = await import("./tools/invoker.js");
  const { executeTool } = await import("./execution/execute-tool.js");
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const storage = await connectIdentityStorage(f.mongodbUri);
  t.after(() => storage.close());
  const sessions = await createDashboardSessions(storage);
  const session = await sessions.authenticate(f.headers.cookie.split("=")[1]);
  const identity = { userId: session.user.id, userEmail: session.user.email, role: session.user.role,
    authenticationOrigin: "dashboard_session" as const, keyId: null };
  const registry = new UpstreamRegistry(new DestinationPolicy({ allowLoopback: true,
    rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] }] }));
  t.after(() => registry.close());
  registry.register(calculator.config); await registry.connectAll();
  const dependencies = { resolver: new AggregatedToolResolver(new ToolAggregator(registry), registry),
    invoker: new McpUpstreamInvoker(registry), auditLogger: storage.audit,
    upstreamAttribution: storage.upstreamRegistrations.auditAttribution };
  const request = { identity, toolName: "calculator.calculate", arguments: { a: 6, b: 7 }, requestId: "session-request" };
  assert.deepEqual((await executeTool(request, dependencies)).result.content, [{ type: "text", text: "42" }]);
  await assert.rejects(executeTool({ ...request, toolName: "calculator.unknown" }, dependencies), { name: "ToolNotFoundError" });
  await assert.rejects(executeTool({ ...request, identity: { ...identity, role: "member" }, toolName: "woocommerce.create_product" }, dependencies), { name: "AuthorizationError" });
  await registry.markUnreachable("calculator", "Test outage");
  await assert.rejects(executeTool(request, dependencies), { name: "UpstreamUnavailableError" });
  const response = await f.app.inject({ url: "/api/admin/audit", headers: f.headers });
  assert.equal(response.statusCode, 200);
  const rows: AuditRecord[] = response.json().records;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.outcome).sort(), ["not_found", "success", "unauthorized", "upstream_unavailable"]);
  const filtered = await f.app.inject({ url: `/api/admin/audit?userId=${f.userId}&toolName=calculator.calculate&outcome=success&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`, headers: f.headers });
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.deepEqual(filtered.json().records, rows.filter(row => row.outcome === "success"));
  for (const query of ["userId=000000000000000000000000", "toolName=unknown", "outcome=tool_error", "from=2100-01-01T00:00:00Z", "to=2000-01-01T00:00:00Z"]) {
    assert.deepEqual((await f.app.inject({ url: `/api/admin/audit?${query}`, headers: f.headers })).json().records, []);
  }
  for (const query of ["userId=invalid", "toolName=", "outcome=invalid", "from=yesterday", "to=invalid", "from=2100-01-01T00:00:00Z&to=2000-01-01T00:00:00Z"]) {
    assert.equal((await f.app.inject({ url: `/api/admin/audit?${query}`, headers: f.headers })).statusCode, 400);
  }
  assert.equal(new Set(rows.map(row => row.attemptId)).size, 4);
  for (const row of rows) {
    assert.equal(row.authenticationOrigin, "dashboard_session"); assert.equal(row.keyId, null);
    assert.equal(row.userId, f.userId); assert.equal(row.userEmail, "member@example.com");
    assert.equal(row.requestId, "session-request");
    if (["not_found", "unauthorized"].includes(row.outcome)) {
      assert.equal(row.upstreamName, null); assert.equal(row.upstreamId, null); assert.equal(row.upstreamDisplayName, null);
    } else { assert.equal(row.upstreamName, "calculator"); assert.match(row.upstreamId!, /^[a-f0-9]{24}$/); }
  }
});

test("durable audit classifies upstream protocol failure and timeout while healthy calls continue", async t => {
  let mode: "timeout" | "invalid" = "timeout";
  let writes = 0;
  const upstream = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", {}, async () => {
      writes++;
      await new Promise(resolve => setTimeout(resolve, 11000));
      return { content: [{ type: "text", text: "Late side effect" }] };
    });
    if (mode === "invalid") server.server.setRequestHandler("tools/call", async () => { throw new Error("malformed-private-result"); });
  });
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [upstream.config, calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  const timedOut = await client.callTool({ name: "woocommerce.create_product" }, { timeout: 15000 });
  assert.equal(timedOut.isError, true);
  assert.deepEqual(timedOut.content, [{ type: "text", text: "Upstream request timed out" }]);
  assert.equal(writes, 1);
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  mode = "invalid";
  const refresh = await f.app.inject({ method: "POST", url: "/api/admin/servers/woocommerce/refresh", headers: f.headers });
  assert.equal(refresh.statusCode, 200);
  const invalid = await client.callTool({ name: "woocommerce.create_product" });
  assert.equal(invalid.isError, true);
  assert.deepEqual(invalid.content, [{ type: "text", text: "Tool execution failed" }]);
  assert.equal(writes, 1);
  const response = await f.app.inject({ url: "/api/admin/audit", headers: f.headers });
  const rows: AuditRecord[] = response.json().records;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.outcome).sort(), ["success", "upstream_error", "upstream_timeout"]);
  assert.ok(rows.every(row => row.userId === f.userId && row.keyId === f.key.id));
  assert.ok(!response.body.includes("malformed-private-result"));
});


test("SDK rejected tool attempts and normal execution each have one durable row", async t => {
  const calculator = await calculatorUpstream(t);
  const woocommerce = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", {}, async () => { assert.fail("Forbidden write executed"); });
  });
  const f = await fixture(t, { upstreams: [calculator.config, woocommerce.config] });
  const client = await f.connect();
  async function rejected(name: string, args?: Record<string, unknown>) {
    await client.callTool({ name, arguments: args }).then(
      result => assert.equal(result.isError, true),
      error => assert.ok(error instanceof ProtocolError),
    );
  }
  await rejected("calculator.missing");
  await rejected("woocommerce.create_product");
  await rejected("calculator.calculate", { a: "private-invalid-argument", b: 7 });
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ url: "/api/admin/audit", headers: f.headers });
  assert.equal(response.statusCode, 200);
  const rows: AuditRecord[] = response.json().records;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.outcome).sort(), ["not_found", "rejected", "success", "unauthorized"]);
  assert.equal(new Set(rows.map(row => row.attemptId)).size, 4);
  for (const row of rows) {
    assert.equal(row.userId, f.userId); assert.equal(row.keyId, f.key.id);
    assert.equal(row.authenticationOrigin, "gateway_api_key");
    assert.match(row.attemptId, /^[a-f0-9-]{36}$/);
    if (row.outcome !== "success") {
      assert.equal(row.upstreamId, null); assert.equal(row.upstreamName, null);
      assert.equal(row.upstreamDisplayName, null);
    }
  }
  assert.ok(!response.body.includes("private-invalid-argument"));
  assert.ok(!response.body.includes(f.rawKey));
});

test("identifiable unauthenticated calls have null attribution and malformed traffic fabricates no executions", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  const client = await f.connect();
  await f.app.inject({ method: "DELETE", url: `/api/keys/${f.key.id}`, headers: f.headers });
  await assert.rejects(client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } }), httpFailure(401));
  const body = { jsonrpc: "2.0", id: "same-client-id", method: "tools/call", params: {
    name: "calculator.calculate", arguments: { a: "private-argument", userId: f.userId, role: "admin", keyId: f.key.id },
    _meta: { attemptId: "forged-attempt", userId: f.userId },
  } };
  // A repeated client ID still describes independent server-owned attempts.
  await Promise.all([undefined, "Bearer invalid-credential", `Bearer ${f.rawKey}`].map(async authorization => {
    const response = await fetch(`${f.address}/mcp`, { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="urumi-gateway"');
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  }));
  for (const payload of [
    {}, { ...body, jsonrpc: "1.0" }, { ...body, id: null }, { ...body, id: undefined },
    { ...body, method: "tools/list" }, [body], { ...body, params: {} },
    { ...body, params: { name: "x".repeat(513) } }, { ...body, params: { name: "unsafe\nname" } },
  ]) {
    const response = await fetch(`${f.address}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(response.status, 401); await response.text();
  }
  const badJson = await fetch(`${f.address}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(badJson.status, 400); await badJson.text();
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ url: "/api/admin/audit?outcome=unauthenticated", headers: f.headers });
  assert.equal(response.statusCode, 200);
  const rows: AuditRecord[] = response.json().records;
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.attemptId)).size, 4);
  for (const row of rows) {
    assert.equal(row.userId, null); assert.equal(row.userEmail, null); assert.equal(row.keyId, null);
    assert.equal(row.authenticationOrigin, null); assert.equal(row.upstreamId, null);
    assert.equal(row.upstreamName, null); assert.equal(row.upstreamDisplayName, null);
    assert.equal(row.toolName, "calculator.calculate"); assert.equal(row.outcome, "unauthenticated");
    assert.match(row.attemptId, /^[a-f0-9-]{36}$/);
  }
  assert.equal((await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records.length, 4);
  for (const secret of [f.userId, f.key.id, f.rawKey, "forged-attempt", "private-argument", "invalid-credential", "same-client-id"]) {
    assert.ok(!response.body.includes(secret));
  }
});

test("legacy HTTP SDK validation and concurrent repeated RPC IDs retain one row per attempt", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  const post = async (args: unknown) => {
    const response = await fetch(`${f.address}/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${f.rawKey}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: {
      name: "calculator.calculate", arguments: args,
    } }) });
    assert.equal(response.status, 200);
    return response.text();
  };
  const responses = await Promise.all([post({ a: 6, b: 7 }), post({ a: "bad", b: 7 }), post([])]);
  assert.ok(responses[0].includes('"text":"42"'));
  assert.ok(responses[1].includes('"isError":true'));
  assert.ok(responses[2].includes('"error"'));
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ url: "/api/admin/audit", headers: f.headers });
  const rows: AuditRecord[] = response.json().records;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.outcome).sort(), ["rejected", "rejected", "success"]);
  assert.equal(new Set(rows.map(row => row.attemptId)).size, 3);
  assert.ok(rows.every(row => row.requestId !== "42" && row.userId === f.userId && row.keyId === f.key.id));
});

test("rejected-attempt audit-write failure preserves authentication and SDK rejection responses", async t => {
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  const client = await f.connect();
  await f.db.db!.command({ collMod: "tool_audit", validator: { $expr: { $eq: [1, 0] } }, validationLevel: "strict" });
  const signals: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { signals.push(args); });
  await assert.rejects(client.callTool({ name: "calculator.missing" }), ProtocolError);
  const response = await fetch(`${f.address}/mcp`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calculator.calculate" } }) });
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "Unauthorized" });
  // The HTTP denial can arrive while its bounded audit insert is completing.
  for (let retry = 0; signals.length < 2 && retry < 100; retry++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.equal(signal.length, 1);
    const parsed = JSON.parse(String(signal[0]));
    assert.deepEqual(Object.keys(parsed).sort(), ["attemptId", "event"]);
    assert.equal(parsed.event, "audit_write_failed"); assert.match(parsed.attemptId, /^[a-f0-9-]{36}$/);
  }
  await f.db.db!.command({ collMod: "tool_audit", validator: {} });
  await client.callTool({ name: "calculator.calculate", arguments: { a: 6, b: 7 } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const rows = (await f.app.inject({ url: "/api/admin/audit", headers: f.headers })).json().records;
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, "success");
});

test("gateway shutdown drains rejected-attempt audit inserts before closing MongoDB", async t => {
  const signals: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { signals.push(args); });
  const calculator = await calculatorUpstream(t);
  const f = await fixture(t, { upstreams: [calculator.config] });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const client = await f.connect();
  await assert.rejects(client.callTool({ name: "calculator.missing" }), ProtocolError);
  await client.close();
  await f.app.close();
  const restarted = await createGatewayApp({ mongodbUri: f.mongodbUri, upstreams: [],
    destinations: { allowLoopback: true, rules: [{ origin: new URL(calculator.config.url).origin, cidrs: ["127.0.0.1/32"] }] } });
  t.after(() => restarted.close());
  const response = await restarted.inject({ url: "/api/admin/audit", headers: f.headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().records.length, 1);
  assert.equal(response.json().records[0].outcome, "not_found");
  assert.deepEqual(signals, []);
});

test("chat stops after an oversized UTF-8 tool result and preserves the completed side effect", async t => {
  let executions = 0;
  let requests = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => {
      executions++;
      return { content: [{ type: "text", text: "界".repeat(6000) }] };
    });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  provider.post("/completion", async () => {
    requests++;
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
      { id: `large-${requests}`, type: "function", function: { name: "tool_0", arguments: '{}' } },
      { id: `later-${requests}`, type: "function", function: { name: "tool_0", arguments: '{}' } },
    ] } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [calculator.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Get a large result" } });
  assert.equal(response.json().calls.length, 1);
  assert.equal(response.json().calls[0].outcome, "success");
  assert.match(response.json().error, /tool result size limit/i);
  assert.equal(executions, 1);
  assert.equal(requests, 1);
});

test("running chat observes account, session and server changes before subsequent executions", async t => {
  for (const change of ["role", "disabled", "password", "expiry", "logout", "server-disable", "server-remove"] as const) {
    for (const timing of ["same response", "next turn"] as const) {
      if (change.startsWith("server-") && timing === "same response") continue;
      await t.test(`${change} during ${timing}`, async t => {
        let executions = 0;
        let withdraw: () => Promise<void>;
        const commerce = await controlledUpstream(t, "woocommerce", server => {
          server.registerTool("create_product", { inputSchema: z.object({ name: z.string() }) }, async () => {
            executions++;
            if (timing === "same response") await withdraw();
            return { content: [{ type: "text", text: "Created" }] };
          });
        });
        const provider = Fastify();
        t.after(() => provider.close());
        let turn = 0;
        provider.post("/completion", async request => {
          turn++;
          if (turn === (timing === "same response" ? 2 : 3)) {
            const body = z.object({ messages: z.array(z.record(z.string(), z.unknown())) }).parse(request.body);
            const results = body.messages.filter(message => message.role === "tool");
            assert.deepEqual(results.map(result => result.tool_call_id), timing === "same response" ? ["first", "second"] : ["turn-1", "turn-2"]);
            assert.equal(JSON.parse(String(results[1].content)).isError, true);
            return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Access changed" } }] };
          }
          if (timing === "next turn" && turn === 2) await withdraw();
          const call = (id: string) => ({ id, type: "function", function: { name: "tool_0", arguments: JSON.stringify({ name: id }) } });
          return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls:
            timing === "same response" ? [call("first"), call("second")] : [call(`turn-${turn}`)] } }] };
        });
        const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
        const f = await fixture(t, { upstreams: [commerce.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
        const userFilter = { _id: new mongoose.Types.ObjectId(f.userId) };
        await f.db.collection("users").updateOne(userFilter, { $set: { role: "admin" } });
        withdraw = async () => {
          if (change === "role") await f.db.collection("users").updateOne(userFilter, { $set: { role: "member" } });
          else if (change === "disabled") await f.db.collection("users").updateOne(userFilter, { $set: { status: "disabled" } });
          else if (change === "password") await f.db.collection("users").updateOne(userFilter, { $set: { requiredPasswordChange: true } });
          else if (change === "expiry") await f.db.collection("dashboard_sessions").updateMany({}, { $set: { expiresAt: new Date(0) } });
          else if (change === "logout") assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: f.headers })).statusCode, 204);
          else {
            const servers = (await f.app.inject({ url: "/api/admin/servers", headers: f.headers })).json().servers;
            const id = servers.find((server: { serverId: string }) => server.serverId === "woocommerce").serverId;
            const response = await f.app.inject({ method: change === "server-disable" ? "POST" : "DELETE",
              url: `/api/admin/servers/${id}${change === "server-disable" ? "/disable" : ""}`, headers: f.headers });
            assert.equal(response.statusCode, change === "server-disable" ? 200 : 204);
          }
        };
        const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Create two distinct products" } });
        if (change === "role" || change.startsWith("server-")) {
          assert.equal(response.json().answer, "Access changed");
          assert.equal(response.json().calls[1].outcome, change === "role" ? "unauthorized" : "rejected");
        } else assert.match(response.json().error, /session or access changed/);
        assert.equal(response.json().calls[0].outcome, "success");
        assert.equal(executions, 1, "withdrawn access cannot be retained by an old provider catalog");
      });
    }
  }
});

test("chat enforces request, provider, context and call byte/count budgets at HTTP boundaries", async t => {
  let executions = 0;
  let mode = "large-provider";
  let requests = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => { executions++; return { content: [] }; });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  provider.post("/completion", async (_request, reply) => {
    requests++;
    if (mode === "large-provider") return reply.type("application/json").send('{"padding":"' + "界".repeat(90_000) + '"}');
    if (mode === "malformed") return { choices: [] };
    if (mode === "authentication") return reply.code(401).send({ error: "synthetic-provider-secret" });
    if (mode === "context") return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "界".repeat(32_000), tool_calls: [
      { id: `context-${requests}`, type: "function", function: { name: "tool_0", arguments: '{}' } },
    ] } }] };
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls:
      Array.from({ length: mode === "too-many" ? 9 : 8 }, (_, i) => ({ id: `call-${requests}-${i}`, type: "function", function: { name: "tool_0", arguments: '{}' } })) } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [calculator.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  const send = (prompt = "Calculate") => f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt } });
  assert.equal((await send("界".repeat(6000))).statusCode, 413, "body budget measures UTF-8 bytes");
  assert.equal((await send("a".repeat(8001))).statusCode, 400);
  assert.equal(requests, 0);
  for (const failure of ["large-provider", "malformed", "authentication", "too-many"]) {
    mode = failure;
    const response = await send();
    assert.ok(response.json().error);
    if (failure === "large-provider") assert.match(response.json().error, /provider response size limit/i);
    if (failure === "too-many") assert.match(response.json().error, /tool call limit/i);
    assert.equal(response.json().calls.length, 0);
    assert.ok(!response.body.includes("synthetic-provider-secret"));
  }
  assert.equal(executions, 0);
  mode = "context";
  const context = await send();
  assert.match(context.json().error, /context size limit/i);
  assert.equal(context.json().calls.length, 2);
  assert.equal(executions, 2);
  mode = "calls";
  const calls = await send();
  assert.match(calls.json().error, /tool call limit/i);
  assert.equal(calls.json().calls.length, 8);
  assert.equal(executions, 10);
});

test("provider timeout and client disconnect never replay a completed write", async t => {
  let executions = 0;
  const commerce = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", {}, async () => { executions++; return { content: [] }; });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  let followup: () => void = () => {};
  let requests = 0;
  provider.post("/completion", async (request, reply) => {
    requests++;
    const body = z.object({ messages: z.array(z.record(z.string(), z.unknown())) }).parse(request.body);
    if (body.messages.some(message => message.role === "tool")) {
      followup();
      // Leave both headers and body pending until the gateway cancels its request.
      reply.hijack();
      request.raw.socket.on("close", () => reply.raw.destroy());
      return;
    }
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
      { id: "write", type: "function", function: { name: "tool_0", arguments: '{}' } },
    ] } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [commerce.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const send = (signal?: AbortSignal) => fetch(`${f.address}/api/chat`, { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: JSON.stringify({ prompt: "Create once" }), signal });
  const timedOut = await send();
  const result = await timedOut.json();
  assert.match(result.error, /provider request timed out/i);
  assert.deepEqual(result.calls.map((call: { id: string; outcome: string }) => [call.id, call.outcome]), [["write", "success"]]);
  assert.equal(executions, 1);
  assert.equal(requests, 2);
  const controller = new AbortController();
  followup = () => controller.abort();
  await assert.rejects(send(controller.signal), { name: "AbortError" });
  // A subsequent healthy gateway request proves the server remains usable, without resubmission.
  assert.equal((await fetch(`${f.address}/health/ready`)).status, 200);
  assert.equal(executions, 2);
  assert.equal(requests, 4);
});

test("overall chat duration prevents dispatch from a delayed provider response", async t => {
  let executions = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    server.registerTool("calculate", {}, async () => { executions++; return { content: [] }; });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  provider.post("/completion", async () => {
    t.mock.timers.tick(90_000);
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
      { id: "too-late", type: "function", function: { name: "tool_0", arguments: '{}' } },
    ] } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [calculator.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Calculate" } });
  assert.match(response.json().error, /overall request duration limit/i);
  assert.equal(executions, 0);
  t.mock.timers.reset();
});

test("uncertain upstream write timeout is paired by ID and blocks a different write", async t => {
  let executions = 0;
  const commerce = await controlledUpstream(t, "woocommerce", server => {
    server.registerTool("create_product", { inputSchema: z.object({ name: z.string() }) }, async () => {
      executions++;
      await new Promise(resolve => setTimeout(resolve, 10_100));
      return { content: [] };
    });
  });
  const provider = Fastify();
  t.after(() => provider.close());
  provider.post("/completion", async request => {
    const body = z.object({ messages: z.array(z.record(z.string(), z.unknown())) }).parse(request.body);
    const results = body.messages.filter(message => message.role === "tool");
    if (results.length) {
      assert.deepEqual(results.map(result => result.tool_call_id), ["uncertain", "different-write"]);
      assert.ok(results.every(result => JSON.parse(String(result.content)).isError === true));
      return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Inspect the store before trying again" } }] };
    }
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls:
      ["uncertain", "different-write"].map(id => ({ id, type: "function", function: { name: "tool_0", arguments: JSON.stringify({ name: id }) } })) } }] };
  });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [commerce.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Create two products" } });
  assert.deepEqual(response.json().calls.map((call: { outcome: string }) => call.outcome), ["upstream_timeout", "rejected"]);
  assert.equal(response.json().answer, "Inspect the store before trying again");
  assert.equal(executions, 1);
});

test("chat stops before provider I/O when the authorized catalog exceeds its budget", async t => {
  let requests = 0;
  const calculator = await controlledUpstream(t, "calculator", server => {
    for (let i = 0; i < 129; i++) server.registerTool(`tool_${i}`, {}, async () => ({ content: [] }));
  });
  const provider = Fastify();
  t.after(() => provider.close());
  provider.post("/completion", async () => { requests++; return {}; });
  const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
  const f = await fixture(t, { upstreams: [calculator.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
  const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "List tools" } });
  assert.match(response.json().error, /tool catalog limit/i);
  assert.equal(requests, 0);
});

test("queued calls cannot reach a server withdrawn during the same provider response", async t => {
  for (const action of ["disable", "remove"] as const) await t.test(action, async t => {
    let withdraw: () => Promise<void>;
    let writes = 0;
    const calculator = await controlledUpstream(t, "calculator", server => {
      server.registerTool("calculate", {}, async () => { await withdraw(); return { content: [] }; });
    });
    const commerce = await controlledUpstream(t, "woocommerce", server => {
      server.registerTool("create_product", {}, async () => { writes++; return { content: [] }; });
    });
    const provider = Fastify();
    t.after(() => provider.close());
    provider.post("/completion", async request => {
      const body = z.object({ messages: z.array(z.record(z.string(), z.unknown())) }).parse(request.body);
      const results = body.messages.filter(message => message.role === "tool");
      if (results.length) {
        assert.deepEqual(results.map(result => result.tool_call_id), ["withdraw", "queued-write"]);
        assert.equal(JSON.parse(String(results[1].content)).isError, true);
        return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Server withdrawn" } }] };
      }
      return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
        { id: "withdraw", type: "function", function: { name: "tool_0", arguments: '{}' } },
        { id: "queued-write", type: "function", function: { name: "tool_1", arguments: '{}' } },
      ] } }] };
    });
    const endpoint = `${await provider.listen({ host: "127.0.0.1", port: 0 })}/completion`;
    const f = await fixture(t, { upstreams: [calculator.config, commerce.config], chat: { apiKey: "synthetic-provider-secret", endpoint } });
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.userId) }, { $set: { role: "admin" } });
    withdraw = async () => {
      const response = await f.app.inject({ method: action === "disable" ? "POST" : "DELETE",
        url: `/api/admin/servers/woocommerce${action === "disable" ? "/disable" : ""}`, headers: f.headers });
      assert.equal(response.statusCode, action === "disable" ? 200 : 204);
    };
    const response = await f.app.inject({ method: "POST", url: "/api/chat", headers: f.headers, payload: { prompt: "Calculate then create a product" } });
    assert.equal(response.json().answer, "Server withdrawn");
    assert.deepEqual(response.json().calls.map((call: { outcome: string }) => call.outcome), ["success", "rejected"]);
    assert.equal(writes, 0);
  });
});
