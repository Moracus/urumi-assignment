import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
import { connectIdentityStorage } from "./storage.js";
import { createGatewayApp } from "../app.js";
import { hashPassword } from "./passwords.js";
import { Client, StreamableHTTPClientTransport, SdkHttpError } from "@modelcontextprotocol/client";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const temporary = "operator assigned temporary password";

async function fixture(t: TestContext) {
  assert.ok(process.env.MONGODB_TEST_URI, "Use the real MongoDB integration runner");
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  const storage = await connectIdentityStorage(uri.toString());
  t.after(async () => { await storage.connection.dropDatabase(); await storage.close(); });
  return { storage, uri: uri.toString() };
}

async function runCli(uri: string, args: string[] = [], password = temporary) {
  const directory = await mkdtemp(join(tmpdir(), "urumi-recovery-"));
  try {
    const file = join(directory, "password");
    await writeFile(file, password, { mode: 0o600 });
    return await new Promise<{ code: number | null; output: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/identity/recovery-cli.js", "--password-file", file, ...args], {
        env: { ...process.env, MONGODB_URI: uri, GATEWAY_BOOTSTRAP_KEY: "" },
      });
      let output = "";
      let stdout = "";
      child.stdout.on("data", (data) => { output += data; stdout += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output, stdout }));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("recovery CLI requires an explicit existing user and never reopens setup or creates accounts", async (t) => {
  const { storage, uri } = await fixture(t);
  const consumedAt = new Date();
  await storage.setup.updateOne({ _id: "initial-administrator" }, { $set: { consumedAt } });
  for (const args of [[], ["--user-id", "invalid"], ["--user-id", new mongoose.Types.ObjectId().toHexString()]]) {
    const result = await runCli(uri, args);
    assert.equal(result.code, 1);
    assert.match(result.output, /Administrator recovery failed/);
    assert.ok(!result.output.includes(temporary));
    assert.equal(await storage.users.countDocuments(), 0);
    assert.deepEqual((await storage.setup.findById("initial-administrator"))?.consumedAt, consumedAt);
  }
});

test("recovery restores members and disabled administrators with irreversible credential invalidation", async (t) => {
  for (const state of [{ role: "member", status: "active" }, { role: "admin", status: "disabled" }]) {
    await t.test(`${state.status} ${state.role}`, async (t) => {
      const { storage, uri } = await fixture(t);
      const original = "original recovery test password";
      const user = await storage.users.create({ email: "target@example.com", role: "member", status: "active",
        passwordHash: await hashPassword(original), requiredPasswordChange: false });
      const consumedAt = new Date();
      await storage.setup.updateOne({ _id: "initial-administrator" }, { $set: { consumedAt } });
      const origin = "http://localhost:3000";
      const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP };
      process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
      process.env.DASHBOARD_ALLOW_HTTP = "true";
      t.after(() => {
        if (previous.origins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
        else process.env.DASHBOARD_TRUSTED_ORIGINS = previous.origins;
        if (previous.http === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
        else process.env.DASHBOARD_ALLOW_HTTP = previous.http;
      });
      const upstream = createMcpFastifyApp({ host: "127.0.0.1" });
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "controlled", version: "1.0.0" });
        server.registerTool("current", { description: "Controlled time" }, async () => ({ content: [{ type: "text", text: "controlled" }] }));
        return server;
      });
      const nodeHandler = toNodeHandler(handler);
      upstream.all("/mcp", (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
      upstream.addHook("onClose", () => handler.close());
      t.after(() => upstream.close());
      const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
      const app = await createGatewayApp({ mongodbUri: uri, destinations: { allowLoopback: true, rules: [{ origin: address, cidrs: ["127.0.0.1/32"] }] }, upstreams: [{ name: "time", url: `${address}/mcp`, enabled: true }] });
      t.after(() => app.close());
      const login = async (password: string) => app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
        payload: { email: user.email, password } });
      const sessionHeaders = (response: Awaited<ReturnType<typeof login>>) => ({
        cookie: String(response.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": response.json().csrfToken,
      });
      const devices = [await login(original), await login(original)];
      devices.forEach((response) => assert.equal(response.statusCode, 200, response.body));
      const headers = sessionHeaders(devices[0]);
      const keys = [];
      for (let i = 0; i < 2; i++) {
        const issued = await app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
        assert.equal(issued.statusCode, 201, issued.body);
        keys.push(issued.json());
      }
      assert.equal((await app.inject({ method: "DELETE", url: `/api/keys/${keys[1].key.id}`, headers })).statusCode, 204);
      const revokedAt = (await storage.apiKeys.findById(keys[1].key.id))?.revokedAt;
      const gatewayAddress = await app.listen({ host: "127.0.0.1", port: 0 });
      const client = new Client({ name: "recovery-test", version: "1.0.0" });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${keys[0].rawKey}` } },
      }));
      assert.equal((await client.listTools(undefined, { cacheMode: "bypass" })).tools[0].name, "time_current");
      // Operator fixture simulates loss of administrator access while retaining old credentials.
      await storage.users.updateOne({ _id: user._id }, { $set: state });
      const recovered = await runCli(uri, ["--user-id", user._id.toHexString()]);
      assert.equal(recovered.code, 0, recovered.output);
      const safe = JSON.parse(recovered.stdout);
      assert.equal(safe.id, user._id.toHexString());
      assert.equal(safe.role, "admin");
      assert.equal(safe.status, "active");
      assert.equal(safe.requiredPasswordChange, true);
      assert.ok(!/passwordHash|keyHash/.test(recovered.output));
      assert.ok(!recovered.output.includes(temporary));
      assert.deepEqual((await storage.setup.findById("initial-administrator"))?.consumedAt, consumedAt);
      const stored = await storage.users.findById(user._id).select("+passwordHash");
      assert.match(stored!.passwordHash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      assert.ok(!stored!.passwordHash.includes(temporary));
      for (const device of devices) assert.equal((await app.inject({ url: "/api/auth/me", headers: sessionHeaders(device) })).statusCode, 401);
      assert.equal((await login(original)).statusCode, 401);
      const pending = await login(temporary);
      assert.equal(pending.statusCode, 200, pending.body);
      const pendingHeaders = sessionHeaders(pending);
      for (const url of ["/api/keys", "/api/admin/users"]) {
        assert.equal((await app.inject({ url, headers: pendingHeaders })).statusCode, 403);
      }
      assert.equal((await app.inject({ method: "POST", url: "/api/keys", headers: pendingHeaders, payload: {} })).statusCode, 403);
      const unauthorized = (error: unknown) => {
        assert.ok(error instanceof SdkHttpError);
        assert.equal(error.data.status, 401);
        return true;
      };
      await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), unauthorized);
      const final = "fresh final recovery password";
      assert.equal((await app.inject({ method: "POST", url: "/api/auth/change-password", headers: pendingHeaders,
        payload: { currentPassword: temporary, newPassword: final } })).statusCode, 204);
      assert.equal((await app.inject({ url: "/api/auth/me", headers: pendingHeaders })).statusCode, 401);
      const fresh = await login(final);
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.equal((await app.inject({ url: "/api/admin/users", headers: sessionHeaders(fresh) })).statusCode, 200);
      await assert.rejects(client.callTool({ name: "time_current", arguments: {} }), unauthorized);
      for (const key of keys) {
        assert.equal((await app.inject({ url: "/mcp", headers: { authorization: `Bearer ${key.rawKey}` } })).statusCode, 401);
        assert.ok((await storage.apiKeys.findById(key.key.id))?.revokedAt);
      }
      assert.deepEqual((await storage.apiKeys.findById(keys[1].key.id))?.revokedAt, revokedAt);
      assert.equal((await app.inject({ url: "/mcp", headers: { authorization: "Bearer test-setup-secret" } })).statusCode, 401);
      const issued = await app.inject({ method: "POST", url: "/api/keys", headers: sessionHeaders(fresh), payload: {} });
      assert.equal(issued.statusCode, 201, issued.body);
      const freshClient = new Client({ name: "fresh-recovery", version: "1.0.0" });
      t.after(() => freshClient.close());
      await freshClient.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${issued.json().rawKey}` } },
      }));
      assert.deepEqual((await freshClient.callTool({ name: "time_current", arguments: {} })).content, [{ type: "text", text: "controlled" }]);
    });
  }
});

test("recovery rolls back role, password, sessions and keys when revocation fails", async (t) => {
  const { storage, uri } = await fixture(t);
  const user = await storage.users.create({ email: "target@example.com", role: "member", status: "disabled",
    passwordHash: await hashPassword("original recovery test password"), requiredPasswordChange: false });
  await storage.sessions.create({ userId: user._id, credentialHash: "test-session-hash",
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
  await storage.apiKeys.create({ userId: user._id, keyHash: "test-key-hash", prefix: "ugw_test", createdAt: new Date() });
  const db = storage.connection.db!;
  const before = await Promise.all(["users", "dashboard_sessions", "api_keys"].map((name) => db.collection(name).find().toArray()));
  await db.command({ collMod: "api_keys", validator: { revokedAt: { $type: "null" } } });
  const failed = await runCli(uri, ["--user-id", user._id.toHexString()]);
  assert.equal(failed.code, 1);
  assert.match(failed.output, /Administrator recovery failed/);
  assert.ok(!failed.output.includes(temporary));
  assert.ok(!/test-key-hash|test-session-hash|passwordHash|MongoServerError/.test(failed.output));
  const after = await Promise.all(["users", "dashboard_sessions", "api_keys"].map((name) => db.collection(name).find().toArray()));
  assert.deepEqual(after, before);
  assert.equal((await storage.setup.findById("initial-administrator"))?.consumedAt, null);
  await db.command({ collMod: "api_keys", validator: {} });
  assert.equal((await runCli(uri, ["--user-id", user._id.toHexString()])).code, 0);
  assert.equal((await storage.setup.findById("initial-administrator"))?.consumedAt, null);
});

test("concurrent recovery CLIs select one temporary password and invalidate all old credentials atomically", async (t) => {
  const { storage, uri } = await fixture(t);
  const original = "original recovery test password";
  const user = await storage.users.create({ email: "target@example.com", role: "member", status: "active",
    passwordHash: await hashPassword(original), requiredPasswordChange: false });
  const consumedAt = new Date();
  await storage.setup.updateOne({ _id: "initial-administrator" }, { $set: { consumedAt } });
  const origin = "http://localhost:3000";
  const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP };
  process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  t.after(() => {
    if (previous.origins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    else process.env.DASHBOARD_TRUSTED_ORIGINS = previous.origins;
    if (previous.http === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
    else process.env.DASHBOARD_ALLOW_HTTP = previous.http;
  });
  const app = await createGatewayApp({ mongodbUri: uri, upstreams: [] });
  t.after(() => app.close());
  const login = (password: string) => app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: user.email, password } });
  const device = await login(original);
  assert.equal(device.statusCode, 200, device.body);
  const headers = { cookie: String(device.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": device.json().csrfToken };
  const key = await app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
  assert.equal(key.statusCode, 201, key.body);
  const passwords = [temporary, "another recovery temporary password"];
  const results = await Promise.all(passwords.map((password) => runCli(uri, ["--user-id", user._id.toHexString()], password)));
  for (const result of results) {
    assert.equal(result.code, 0, result.output);
    assert.ok(passwords.every((password) => !result.output.includes(password)));
  }
  const attempts = [];
  for (const password of passwords) attempts.push(await login(password));
  assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [200, 401]);
  const current = attempts.find((response) => response.statusCode === 200)!;
  assert.equal(current.json().user.role, "admin");
  assert.equal(current.json().user.status, "active");
  assert.equal(current.json().user.requiredPasswordChange, true);
  assert.equal((await login(original)).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  assert.ok((await storage.apiKeys.findById(key.json().key.id))?.revokedAt);
  assert.equal((await app.inject({ url: "/mcp", headers: { authorization: `Bearer ${key.json().rawKey}` } })).statusCode, 401);
  assert.deepEqual((await storage.setup.findById("initial-administrator"))?.consumedAt, consumedAt);
  assert.equal(await storage.users.countDocuments(), 1);
});

test("recovery rejects unsafe arguments, invalid passwords and secret-bearing errors without leaking inputs", async (t) => {
  const { storage, uri } = await fixture(t);
  const user = await storage.users.create({ email: "target@example.com", role: "member", status: "disabled",
    passwordHash: await hashPassword("original recovery test password"), requiredPasswordChange: false });
  const before = await storage.users.findById(user._id).select("+passwordHash").lean();
  const target = ["--user-id", user._id.toHexString()];
  for (const args of [[...target, "--password", temporary], [...target, temporary],
    [...target, "--bootstrap-secret", temporary], [...target, "--password-file", `/missing/${temporary}`]]) {
    const failed = await runCli(uri, args);
    assert.equal(failed.code, 1);
    assert.ok(!failed.output.includes(temporary));
    assert.match(failed.output, /Administrator recovery failed/);
  }
  for (const password of ["short", "x".repeat(129)]) {
    const failed = await runCli(uri, target, password);
    assert.equal(failed.code, 1);
    assert.ok(!failed.output.includes(password));
  }
  const invalidUri = `mongodb://operator:${temporary}@invalid.example/db`;
  const failed = await runCli(invalidUri, target);
  assert.equal(failed.code, 1);
  assert.ok(!failed.output.includes(temporary));
  assert.ok(!failed.output.includes(invalidUri));
  assert.deepEqual(await storage.users.findById(user._id).select("+passwordHash").lean(), before);
});
