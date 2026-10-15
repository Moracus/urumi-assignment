import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport, SdkHttpError } from "@modelcontextprotocol/client";
import { createGatewayApp, type GatewayAppOptions } from "../app.js";
import { hashPassword } from "./passwords.js";

const origin = "http://localhost:3000";
const password = "a final reset test password";

async function fixture(t: TestContext, options: Pick<GatewayAppOptions, "upstreams" | "auditLogger"> = {}) {
  assert.ok(process.env.MONGODB_TEST_URI, "Use the real MongoDB integration runner");
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  const db = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 2000 }).asPromise();
  const passwordHash = await hashPassword(password);
  const users = [];
  for (const [email, role] of [["admin@example.com", "admin"], ["member@example.com", "member"]]) {
    const inserted = await db.collection("users").insertOne({ email, role, passwordHash, status: "active",
      requiredPasswordChange: false, createdAt: new Date(), updatedAt: new Date() });
    users.push(inserted.insertedId.toHexString());
  }
  const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP };
  process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  const app = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [], ...options });
  t.after(async () => {
    await app.close(); await db.dropDatabase(); await db.close();
    if (previous.origins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    else process.env.DASHBOARD_TRUSTED_ORIGINS = previous.origins;
    if (previous.http === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
    else process.env.DASHBOARD_ALLOW_HTTP = previous.http;
  });
  async function login(email = "admin@example.com") {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email, password } });
    assert.equal(response.statusCode, 200, response.body);
    return { cookie: String(response.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": response.json().csrfToken };
  }
  return { app, db, uri: uri.toString(), adminId: users[0], memberId: users[1], login };
}

test("administrator reset hashes a temporary password, ends every target session and preserves keys", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const devices = [await f.login("member@example.com"), await f.login("member@example.com")];
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", headers: devices[0], payload: {} });
  assert.equal(issued.statusCode, 201);
  const revoked = await f.app.inject({ method: "POST", url: "/api/keys", headers: devices[0], payload: {} });
  assert.equal(revoked.statusCode, 201);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/keys/${revoked.json().key.id}`, headers: devices[0] })).statusCode, 204);
  const keysBefore = await f.db.collection("api_keys").find().toArray();
  const temporary = "assigned temporary reset password";
  const reset = await f.app.inject({ method: "POST", url: `/api/admin/users/${f.memberId}/reset-password`,
    headers: admin, payload: { password: temporary } });
  assert.equal(reset.statusCode, 204, reset.body);
  assert.equal(reset.body, "");
  assert.equal(reset.headers["cache-control"], "no-store");
  for (const headers of devices) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  }
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: admin })).statusCode, 200);
  const stored = await f.db.collection("users").findOne({ _id: new mongoose.Types.ObjectId(f.memberId) });
  assert.ok(stored);
  assert.match(stored.passwordHash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!JSON.stringify(stored).includes(temporary));
  assert.equal(stored.requiredPasswordChange, true);
  assert.equal(stored.role, "member");
  assert.equal(stored.status, "active");
  assert.deepEqual(await f.db.collection("api_keys").find().toArray(), keysBefore);
  const login = (secret: string) => f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password: secret } });
  assert.equal((await login(password)).statusCode, 401);
  const pending = await login(temporary);
  assert.equal(pending.statusCode, 200, pending.body);
  const headers = { cookie: String(pending.headers["set-cookie"]).split(";")[0], origin,
    "x-csrf-token": pending.json().csrfToken };
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).json().user.requiredPasswordChange, true);
  for (const url of ["/api/keys", "/api/admin/users"]) {
    assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
  }
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: {} })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: `/api/admin/users/${f.memberId}/keys`, headers: admin, payload: {} })).statusCode, 403);
  assert.equal((await f.app.inject({ url: "/mcp", headers: { authorization: `Bearer ${issued.json().rawKey}` } })).statusCode, 401);
  const secondPending = await login(temporary);
  assert.equal(secondPending.statusCode, 200);
  const secondCookie = String(secondPending.headers["set-cookie"]).split(";")[0];
  const replacement = "a different final reset password";
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/change-password", headers,
    payload: { currentPassword: temporary, newPassword: replacement } })).statusCode, 204);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: secondCookie } })).statusCode, 401);
  assert.equal((await login(temporary)).statusCode, 401);
  const fresh = await login(replacement);
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().user.requiredPasswordChange, false);
  assert.equal((await f.app.inject({ url: "/mcp", headers: { authorization: `Bearer ${revoked.json().rawKey}` } })).statusCode, 401);
  assert.deepEqual(await f.db.collection("api_keys").find().toArray(), keysBefore);
});

test("password reset enforces administrator eligibility, session, Origin, CSRF and strict target/input validation", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const other = await f.login();
  const member = await f.login("member@example.com");
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", headers: admin, payload: {} });
  assert.equal(issued.statusCode, 201);
  const before = await f.db.collection("users").findOne({ _id: new mongoose.Types.ObjectId(f.memberId) });
  const url = `/api/admin/users/${f.memberId}/reset-password`;
  const payload = { password: "assigned temporary reset password" };
  for (const [headers, status] of [
    [{ origin }, 401], [{ origin, authorization: `Bearer ${issued.json().rawKey}` }, 401],
    [member, 403], [{ cookie: admin.cookie, origin }, 403],
    [{ cookie: admin.cookie, "x-csrf-token": admin["x-csrf-token"] }, 403],
    [{ ...admin, origin: "http://untrusted.example" }, 403],
    [{ ...admin, "x-csrf-token": "invalid" }, 403],
    [{ ...admin, "x-csrf-token": other["x-csrf-token"] }, 403],
  ] as const) {
    const response = await f.app.inject({ method: "POST", url, headers, payload });
    assert.equal(response.statusCode, status, response.body);
  }
  for (const invalid of [{}, { password: "short" }, { password: "x".repeat(129) },
    { password: null }, { password: 123 }, { password: [payload.password] },
    { ...payload, currentPassword: password }, { ...payload, userId: f.adminId },
    { ...payload, role: "admin" }, { ...payload, requiredPasswordChange: false }]) {
    const response = await f.app.inject({ method: "POST", url, headers: admin, payload: invalid });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  for (const [id, status] of [["invalid", 400], ["000000000000000000000000", 404]] as const) {
    assert.equal((await f.app.inject({ method: "POST", url: `/api/admin/users/${id}/reset-password`, headers: admin, payload })).statusCode, status);
  }
  assert.equal((await f.app.inject({ method: "POST", url, headers: { ...admin, "content-type": "text/plain" }, payload: JSON.stringify(payload) })).statusCode, 415);
  assert.equal((await f.app.inject({ method: "POST", url, headers: { ...admin, "content-type": "application/json" }, payload: "{invalid" })).statusCode, 400);
  assert.equal((await f.app.inject({ method: "POST", url, headers: admin, payload: { password: "x".repeat(5000) } })).statusCode, 413);
  for (const [changes, status] of [
    [{ requiredPasswordChange: true }, 403],
    [{ requiredPasswordChange: false, status: "disabled" }, 401],
  ] as const) {
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.adminId) }, { $set: changes });
    assert.equal((await f.app.inject({ method: "POST", url, headers: admin, payload })).statusCode, status);
  }
  assert.deepEqual(await f.db.collection("users").findOne({ _id: new mongoose.Types.ObjectId(f.memberId) }), before);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: member })).statusCode, 200);
});

test("connected SDK client resumes with the same unrevoked key only after required password replacement", async (t) => {
  const upstream = createMcpFastifyApp({ host: "127.0.0.1" });
  let invocations = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "controlled", version: "1.0.0" });
    server.registerTool("current", { description: "Controlled time" }, async () => {
      invocations++;
      return { content: [{ type: "text", text: "controlled" }] };
    });
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  upstream.all("/mcp", (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
  upstream.addHook("onClose", () => handler.close());
  t.after(() => upstream.close());
  const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const f = await fixture(t, { upstreams: [{ name: "time", url: `${address}/mcp`, enabled: true }] });
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", headers: member, payload: {} });
  assert.equal(issued.statusCode, 201);
  const gatewayAddress = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "reset-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${issued.json().rawKey}` } },
  }));
  assert.equal((await client.listTools(undefined, { cacheMode: "bypass" })).tools[0].name, "time.current");
  await client.callTool({ name: "time.current", arguments: {} });
  assert.equal(invocations, 1);
  const temporary = "assigned temporary reset password";
  assert.equal((await f.app.inject({ method: "POST", url: `/api/admin/users/${f.memberId}/reset-password`,
    headers: admin, payload: { password: temporary } })).statusCode, 204);
  const unauthorized = (error: unknown) => {
    assert.ok(error instanceof SdkHttpError);
    assert.equal(error.data.status, 401);
    return true;
  };
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), unauthorized);
  await assert.rejects(client.callTool({ name: "time.current", arguments: {} }), unauthorized);
  assert.equal(invocations, 1);
  const login = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password: temporary } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": login.json().csrfToken };
  const second = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password: temporary } });
  assert.equal(second.statusCode, 200);
  // Pending-password users can still log out independently.
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: {
    cookie: String(second.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": second.json().csrfToken,
  } })).statusCode, 204);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/change-password", headers,
    payload: { currentPassword: temporary, newPassword: "a different final reset password" } })).statusCode, 204);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  assert.equal((await client.listTools(undefined, { cacheMode: "bypass" })).tools[0].name, "time.current");
  const result = await client.callTool({ name: "time.current", arguments: {} });
  assert.deepEqual(result.content, [{ type: "text", text: "controlled" }]);
  assert.equal(invocations, 2);
  const keys = await f.app.inject({ url: `/api/admin/users/${f.memberId}/keys`, headers: admin });
  assert.equal(keys.json().keys[0].id, issued.json().key.id);
  assert.equal(keys.json().keys[0].revokedAt, null);
});

test("reset serializes with login and key issuance across gateway instances", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const replica = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => replica.close());
  const [reset, login, personal, assisted] = await Promise.all([
    f.app.inject({ method: "POST", url: `/api/admin/users/${f.memberId}/reset-password`, headers: admin,
      payload: { password: "assigned temporary reset password" } }),
    replica.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "member@example.com", password } }),
    replica.inject({ method: "POST", url: "/api/keys", headers: member, payload: {} }),
    replica.inject({ method: "POST", url: `/api/admin/users/${f.memberId}/keys`, headers: admin, payload: {} }),
  ]);
  assert.equal(reset.statusCode, 204, reset.body);
  assert.ok([200, 401].includes(login.statusCode), login.body);
  assert.ok([201, 401, 403].includes(personal.statusCode), personal.body);
  assert.ok([201, 403].includes(assisted.statusCode), assisted.body);
  for (const cookie of [member.cookie, ...(login.statusCode === 200 ? [String(login.headers["set-cookie"]).split(";")[0]] : [])]) {
    assert.equal((await replica.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 401);
  }
  for (const response of [personal, assisted].filter((response) => response.statusCode === 201)) {
    const keys = await replica.inject({ url: `/api/admin/users/${f.memberId}/keys`, headers: admin });
    assert.ok(keys.json().keys.some((key: { id: string; revokedAt: string | null }) => key.id === response.json().key.id && key.revokedAt === null));
    assert.equal((await replica.inject({ url: "/mcp", headers: { authorization: `Bearer ${response.json().rawKey}` } })).statusCode, 401);
  }
});


test("reset of another administrator preserves role and disabled status", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const target = `/api/admin/users/${f.memberId}`;
  const promoted = await f.app.inject({ method: "PATCH", url: target, headers: admin,
    payload: { role: "admin", status: "disabled" } });
  assert.equal(promoted.statusCode, 200, promoted.body);
  const reset = await f.app.inject({ method: "POST", url: `${target}/reset-password`, headers: admin,
    payload: { password: "temporary administrator password" } });
  assert.equal(reset.statusCode, 204, reset.body);
  const inspected = await f.app.inject({ url: target, headers: admin });
  assert.equal(inspected.json().user.role, "admin");
  assert.equal(inspected.json().user.status, "disabled");
  assert.equal(inspected.json().user.requiredPasswordChange, true);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password: "temporary administrator password" } })).statusCode, 401);
});
