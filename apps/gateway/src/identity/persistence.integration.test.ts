import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createGatewayApp } from "../app.js";

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
  const previousKey = process.env.GATEWAY_BOOTSTRAP_KEY;
  process.env.GATEWAY_BOOTSTRAP_KEY = "test-setup-secret";
  t.after(() => {
    if (previousKey === undefined) delete process.env.GATEWAY_BOOTSTRAP_KEY;
    else process.env.GATEWAY_BOOTSTRAP_KEY = previousKey;
  });
  const uri = databaseUri();
  const container = process.env.MONGODB_TEST_CONTAINER;
  assert.ok(container, "Use the isolated integration runner for outage tests");
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
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
  assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 200);
  const docker = promisify(execFile);
  await docker("docker", ["stop", "--time", "1", container]);
  // Register restoration immediately; recovery runs even if an assertion fails.
  t.after(async () => { await docker("docker", ["start", container]); });
  assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
  const start = Date.now();
  const unavailable = await app.inject({ url: "/health/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { status: "not_ready", service: "gateway" });
  const mcp = await app.inject({ url: "/mcp", headers: { authorization: "Bearer test-setup-secret" } });
  assert.equal(mcp.statusCode, 503);
  assert.deepEqual(mcp.json(), { error: "Authentication unavailable" });
  assert.ok(Date.now() - start < 10000);
  await docker("docker", ["start", container]);
  const deadline = Date.now() + 20000;
  let ready = 503;
  while (Date.now() < deadline && ready !== 200) {
    ready = (await app.inject({ url: "/health/ready" })).statusCode;
    if (ready !== 200) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready, 200);
  assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/mcp" })).statusCode, 401);
});
