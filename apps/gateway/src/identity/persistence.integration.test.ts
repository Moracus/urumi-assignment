import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport, SdkHttpError } from "@modelcontextprotocol/client";
import { createGatewayApp } from "../app.js";
import { hashPassword } from "./passwords.js";

const baseUri = process.env.MONGODB_TEST_URI;
assert.ok(baseUri, "Use the real-database integration runner");
function databaseUri(base = baseUri!) {
  const uri = new URL(base);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  return uri.toString();
}

test("gateway startup rejects missing persistence before serving", async () => {
  const previousUri = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    await assert.rejects(createGatewayApp({ upstreams: [] }), {
      message: "Identity storage unavailable or invalid",
    });
  } finally {
    if (previousUri !== undefined) process.env.MONGODB_URI = previousUri;
  }
});

test("startup rejects unreachable storage with a bounded, safe process error", async () => {
  const start = Date.now();
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      env: { ...process.env, MONGODB_URI: "mongodb://sensitive-user:sensitive-password@127.0.0.1:1/identity" },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /Gateway startup failed/);
  assert.match(result.output, /\(connection\)/);
  assert.ok(!result.output.includes("sensitive"));
  assert.ok(!result.output.includes("mongodb://"));
  assert.ok(Date.now() - start < 10000);
});

test("startup initializes indexes and rejects an incompatible email index", async (t) => {
  const uri = databaseUri();
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  const app = await createGatewayApp({ mongodbUri: uri, upstreams: [] });
  await app.close();
  assert.ok((await db.collection("users").indexes()).some((index) => index.unique && index.key.email === 1));
  await db.collection("users").dropIndex("unique_normalized_email");
  await db.collection("users").createIndex({ email: 1 }, { name: "unique_normalized_email", unique: false });
  await assert.rejects(createGatewayApp({ mongodbUri: uri, upstreams: [] }), {
    message: "Identity storage unavailable or invalid",
  });
});

test("standalone MongoDB is rejected by actual transaction validation", async (t) => {
  assert.ok(process.env.MONGODB_STANDALONE_TEST_URI);
  const uri = databaseUri(process.env.MONGODB_STANDALONE_TEST_URI);
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  await assert.rejects(createGatewayApp({ mongodbUri: uri, upstreams: [] }), {
    message: "Identity storage unavailable or invalid",
  });
  assert.equal(await db.collection("users").countDocuments(), 0);
  assert.equal((await db.collection("initial_setup").findOne())?.consumedAt, null);
});

test("database outage fails readiness and MCP safely while liveness stays healthy, then recovers", async (t) => {
  const previousOrigins = process.env.DASHBOARD_TRUSTED_ORIGINS;
  const previousHttp = process.env.DASHBOARD_ALLOW_HTTP;
  process.env.DASHBOARD_TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  t.after(() => {
    if (previousOrigins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    else process.env.DASHBOARD_TRUSTED_ORIGINS = previousOrigins;
    if (previousHttp === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
    else process.env.DASHBOARD_ALLOW_HTTP = previousHttp;
  });
  const previousKey = process.env.GATEWAY_BOOTSTRAP_KEY;
  process.env.GATEWAY_BOOTSTRAP_KEY = "test-setup-secret";
  t.after(() => {
    if (previousKey === undefined) delete process.env.GATEWAY_BOOTSTRAP_KEY;
    else process.env.GATEWAY_BOOTSTRAP_KEY = previousKey;
  });
  const uri = databaseUri();
  const container = process.env.MONGODB_TEST_CONTAINER;
  assert.ok(container, "Use the isolated integration runner for outage tests");
  const docker = promisify(execFile);
  let paused = false;
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => {
    if (paused) { await docker("docker", ["unpause", container]); paused = false; }
    await db.dropDatabase(); await db.close();
  });
  const upstream = createMcpFastifyApp({ host: "127.0.0.1" });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "controlled", version: "1.0.0" });
    server.registerTool("current", { description: "Controlled time" }, async () => ({
      content: [{ type: "text", text: "controlled" }],
    }));
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  upstream.all("/mcp", (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
  upstream.addHook("onClose", () => handler.close());
  t.after(() => upstream.close());
  const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const app = await createGatewayApp({ mongodbUri: uri,
    upstreams: [{ name: "time", url: `${address}/mcp`, enabled: true }],
  });
  t.after(() => app.close());
  await db.collection("users").insertOne({ email: "outage@example.com", role: "member", status: "active",
    requiredPasswordChange: false, passwordHash: await hashPassword("outage test password"), createdAt: new Date(), updatedAt: new Date() });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://localhost:3000" },
    payload: { email: "outage@example.com", password: "outage test password" } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const keyHeaders = { cookie, origin: "http://localhost:3000", "x-csrf-token": login.json().csrfToken };
  const createdKey = await app.inject({ method: "POST", url: "/api/keys", headers: keyHeaders, payload: {} });
  assert.equal(createdKey.statusCode, 201);
  const keyId = createdKey.json().key.id;
  const gatewayAddress = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "outage-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${createdKey.json().rawKey}` } },
  }));
  const keysBefore = (await app.inject({ url: "/api/keys", headers: keyHeaders })).json().keys;
  assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 200);
  // Pause preserves tmpfs data; stopping this disposable container discards its sessions.
  await docker("docker", ["pause", container]);
  paused = true;
  assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
  const start = Date.now();
  const unavailable = await app.inject({ url: "/health/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { status: "not_ready", service: "gateway" });
  const mcp = await app.inject({ url: "/mcp", headers: { authorization: "Bearer test-setup-secret" } });
  assert.equal(mcp.statusCode, 503);
  assert.deepEqual(mcp.json(), { error: "Authentication unavailable" });
  assert.ok(Date.now() - start < 10000);
  const sdkStart = Date.now();
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass", timeout: 7000 }), (error: unknown) => {
    assert.ok(error instanceof SdkHttpError);
    assert.equal(error.data.status, 503);
    assert.equal(error.data.text, JSON.stringify({ error: "Authentication unavailable" }));
    return true;
  });
  assert.ok(Date.now() - sdkStart < 7000);
  for (const request of [
    { url: "/api/auth/me", headers: { cookie } },
    { method: "POST" as const, url: "/api/auth/logout", headers: { cookie, origin: "http://localhost:3000", "x-csrf-token": login.json().csrfToken } },
    { method: "POST" as const, url: "/api/auth/login", headers: { origin: "http://localhost:3000" }, payload: { email: "outage@example.com", password: "outage test password" } },
    { url: "/api/keys", headers: keyHeaders },
    { method: "POST" as const, url: "/api/keys", headers: keyHeaders, payload: {} },
    { method: "DELETE" as const, url: `/api/keys/${keyId}`, headers: keyHeaders },
  ]) {
    const requestStart = Date.now();
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: "Authentication unavailable" });
    assert.ok(Date.now() - requestStart < 7000);
    assert.equal(response.headers["set-cookie"], undefined);
  }
  await docker("docker", ["unpause", container]);
  paused = false;
  const deadline = Date.now() + 20000;
  let ready = 503;
  while (Date.now() < deadline && ready !== 200) {
    ready = (await app.inject({ url: "/health/ready" })).statusCode;
    if (ready !== 200) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready, 200);
  assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/mcp" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 200);
  const keysAfter = await app.inject({ url: "/api/keys", headers: keyHeaders });
  // An already-admitted initialize notification may complete after the snapshot.
  const lastUsedAfterOutage = keysAfter.json().keys[0].lastUsedAt;
  assert.deepEqual(keysAfter.json().keys, [{ ...keysBefore[0], lastUsedAt: lastUsedAfterOutage }]);
  assert.ok(Date.parse(lastUsedAfterOutage) >= Date.parse(keysBefore[0].lastUsedAt));
  assert.deepEqual((await client.callTool({ name: "time.current" })).content, [{ type: "text", text: "controlled" }]);
  const usedAfter = (await app.inject({ url: "/api/keys", headers: keyHeaders })).json().keys[0].lastUsedAt;
  assert.ok(Date.parse(usedAfter) > Date.parse(keysBefore[0].lastUsedAt));
});
