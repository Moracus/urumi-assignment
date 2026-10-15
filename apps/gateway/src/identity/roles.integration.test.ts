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
const password = "a final role test password";

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

test("explicit promotion refreshes existing dashboard sessions and permits self-demotion with another active administrator", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const patch = (userId: string, role: string, headers = admin) => f.app.inject({ method: "PATCH",
    url: `/api/admin/users/${userId}`, headers, payload: { role } });
  const promoted = await patch(f.memberId, "admin");
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.headers["cache-control"], "no-store");
  assert.equal(promoted.json().user.role, "admin");
  assert.deepEqual(Object.keys(promoted.json().user).sort(), ["createdAt", "email", "id", "requiredPasswordChange", "role", "status", "updatedAt"]);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: member })).json().user.role, "admin");
  assert.equal((await f.app.inject({ url: "/api/admin/users", headers: member })).statusCode, 200);
  const demoted = await patch(f.memberId, "member", member);
  assert.equal(demoted.statusCode, 200, demoted.body);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: member })).json().user.role, "member");
  assert.equal((await f.app.inject({ url: "/api/admin/users", headers: member })).statusCode, 403);
});

test("last-active-administrator demotion conflicts and concurrent self-demotions across replicas preserve one administrator", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const patch = (app: typeof f.app, id: string, headers: typeof admin, role = "member") => app.inject({
    method: "PATCH", url: `/api/admin/users/${id}`, headers, payload: { role },
  });
  const last = await patch(f.app, f.adminId, admin);
  assert.equal(last.statusCode, 409, last.body);
  assert.deepEqual(last.json(), { error: "At least one active administrator must remain" });
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: admin })).json().user.role, "admin");
  assert.equal((await patch(f.app, f.memberId, admin, "admin")).statusCode, 200);
  const second = await f.login("member@example.com");
  const replica = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => replica.close());
  const results = await Promise.all([
    patch(f.app, f.adminId, admin), patch(replica, f.memberId, second),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  const roles = await Promise.all([admin, second].map(async (headers) => {
    const me = await f.app.inject({ url: "/api/auth/me", headers });
    assert.equal(me.statusCode, 200);
    return me.json().user.role;
  }));
  assert.deepEqual(roles.sort(), ["admin", "member"]);
});

test("role changes enforce session eligibility, administrator authority, Origin, CSRF and strict inputs without forbidden effects", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const otherSession = await f.login();
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", headers: admin, payload: {} });
  assert.equal(issued.statusCode, 201);
  const url = `/api/admin/users/${f.memberId}`;
  for (const [headers, status] of [
    [{ origin }, 401], [{ origin, authorization: `Bearer ${issued.json().rawKey}` }, 401],
    [member, 403], [{ cookie: admin.cookie, origin }, 403],
    [{ cookie: admin.cookie, "x-csrf-token": admin["x-csrf-token"] }, 403],
    [{ ...admin, origin: "http://localhost:3001" }, 403],
    [{ ...admin, "x-csrf-token": "invalid" }, 403],
    [{ ...admin, "x-csrf-token": otherSession["x-csrf-token"] }, 403],
  ] as const) {
    const response = await f.app.inject({ method: "PATCH", url, headers, payload: { role: "admin" } });
    assert.equal(response.statusCode, status, response.body);
  }
  for (const payload of [{}, { role: "owner" }, { role: null }, { role: ["admin"] },
    { role: "admin", status: "invalid" }, { role: "admin", userId: f.adminId },
    { role: "admin", requiredPasswordChange: false }, { role: "admin", email: "changed@example.com" }]) {
    const response = await f.app.inject({ method: "PATCH", url, headers: admin, payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  for (const [id, status] of [["invalid", 400], ["000000000000000000000000", 404]] as const) {
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/admin/users/${id}`, headers: admin, payload: { role: "admin" } })).statusCode, status);
  }
  const wrongType = await f.app.inject({ method: "PATCH", url, headers: { ...admin, "content-type": "text/plain" }, payload: '{"role":"admin"}' });
  assert.equal(wrongType.statusCode, 415);
  const oversized = await f.app.inject({ method: "PATCH", url, headers: admin, payload: { role: "admin", extra: "x".repeat(4096) } });
  assert.equal(oversized.statusCode, 413);
  const unchanged = await f.app.inject({ url, headers: admin });
  assert.equal(unchanged.json().user.role, "member");
  assert.equal(unchanged.json().user.status, "active");
  assert.equal((await f.app.inject({ url: "/api/keys", headers: admin })).json().keys[0].revokedAt, null);
  for (const [changes, status] of [
    [{ requiredPasswordChange: true }, 403],
    [{ requiredPasswordChange: false, status: "disabled" }, 401],
  ] as const) {
    await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.adminId) }, { $set: changes });
    const response = await f.app.inject({ method: "PATCH", url, headers: admin, payload: { role: "admin" } });
    assert.equal(response.statusCode, status, response.body);
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: member })).json().user.role, "member");
  }
});

test("disabled administrators cannot satisfy last-active-administrator protection and same-role patches are safe", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const url = `/api/admin/users/${f.adminId}`;
  const same = await f.app.inject({ method: "PATCH", url, headers: admin, payload: { role: "admin" } });
  assert.equal(same.statusCode, 200, same.body);
  // Arrange an inactive administrator to verify it does not satisfy the invariant.
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.memberId) }, { $set: { role: "admin", status: "disabled" } });
  const denied = await f.app.inject({ method: "PATCH", url, headers: admin, payload: { role: "member" } });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal((await f.app.inject({ url, headers: admin })).json().user.role, "admin");
});


test("disabling invalidates every session and both routes' keys permanently after re-enabling", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const second = await f.login("member@example.com");
  const keys = [];
  for (const [url, headers] of [["/api/keys", member], [`/api/admin/users/${f.memberId}/keys`, admin]] as const) {
    const issued = await f.app.inject({ method: "POST", url, headers, payload: {} });
    assert.equal(issued.statusCode, 201, issued.body);
    keys.push(issued.json());
  }
  const patch = (status: string) => f.app.inject({ method: "PATCH", url: `/api/admin/users/${f.memberId}`,
    headers: admin, payload: { status } });
  const disabled = await patch("disabled");
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().user.status, "disabled");
  assert.equal(disabled.headers["cache-control"], "no-store");
  for (const headers of [member, second]) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  }
  const deniedLogin = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password } });
  assert.equal(deniedLogin.statusCode, 401);
  assert.equal((await patch("active")).statusCode, 200);
  for (const headers of [member, second]) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  }
  const fresh = await f.login("member@example.com");
  const listed = await f.app.inject({ url: "/api/keys", headers: fresh });
  assert.equal(listed.json().keys.length, 2);
  assert.ok(listed.json().keys.every((key: { revokedAt: string | null }) => key.revokedAt !== null));
  for (const key of keys) {
    assert.equal((await f.app.inject({ url: "/mcp", headers: { authorization: `Bearer ${key.rawKey}` } })).statusCode, 401);
  }
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers: fresh, payload: {} })).statusCode, 201);
});

test("status patches enforce strict inputs and administrator session, eligibility, Origin and CSRF", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const url = `/api/admin/users/${f.memberId}`;
  for (const [headers, status] of [
    [{ origin }, 401], [member, 403], [{ cookie: admin.cookie, origin }, 403],
    [{ ...admin, origin: "http://untrusted.example" }, 403],
    [{ cookie: admin.cookie, "x-csrf-token": admin["x-csrf-token"] }, 403],
    [{ ...admin, "x-csrf-token": member["x-csrf-token"] }, 403],
  ] as const) {
    const response = await f.app.inject({ method: "PATCH", url, headers, payload: { status: "disabled" } });
    assert.equal(response.statusCode, status, response.body);
  }
  for (const payload of [{}, { status: null }, { status: "enabled" }, { status: ["disabled"] },
    { status: "disabled", requiredPasswordChange: false }, { status: "disabled", userId: f.adminId }]) {
    assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload })).statusCode, 400);
  }
  assert.equal((await f.app.inject({ url, headers: admin })).json().user.status, "active");
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.adminId) }, { $set: { requiredPasswordChange: true } });
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "disabled" } })).statusCode, 403);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.adminId) }, { $set: { status: "disabled" } });
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "disabled" } })).statusCode, 401);
});

test("last-administrator conflict rolls back status, role, session invalidation and key revocation", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", headers: admin, payload: {} });
  assert.equal(issued.statusCode, 201);
  for (const payload of [{ status: "disabled" }, { role: "member", status: "disabled" }]) {
    const response = await f.app.inject({ method: "PATCH", url: `/api/admin/users/${f.adminId}`, headers: admin, payload });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), { error: "At least one active administrator must remain" });
    const me = await f.app.inject({ url: "/api/auth/me", headers: admin });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.role, "admin");
    assert.equal(me.json().user.status, "active");
    assert.equal((await f.app.inject({ url: "/api/keys", headers: admin })).json().keys[0].revokedAt, null);
  }
});

test("mixed disable and demotion races and concurrent disabling preserve an active administrator across replicas", async (t) => {
  for (const otherChange of [{ role: "member" }, { status: "disabled" }]) {
    const f = await fixture(t);
    const admin = await f.login();
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/admin/users/${f.memberId}`, headers: admin, payload: { role: "admin" } })).statusCode, 200);
    const second = await f.login("member@example.com");
    const replica = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
    t.after(() => replica.close());
    const results = await Promise.all([
      f.app.inject({ method: "PATCH", url: `/api/admin/users/${f.adminId}`, headers: admin, payload: { status: "disabled" } }),
      replica.inject({ method: "PATCH", url: `/api/admin/users/${f.memberId}`, headers: second, payload: otherChange }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const remaining = await Promise.all([admin, second].map((headers) => f.app.inject({ url: "/api/admin/users", headers })));
    assert.ok(remaining.some((response) => response.statusCode === 200));
  }
});

test("disable races with login and both key issuance routes leave no credential that revives on enable", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const replica = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => replica.close());
  const url = `/api/admin/users/${f.memberId}`;
  for (let round = 0; round < 3; round++) {
    const member = await f.login("member@example.com");
    const [disabled, login, personal, assisted] = await Promise.all([
      f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "disabled" } }),
      replica.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "member@example.com", password } }),
      replica.inject({ method: "POST", url: "/api/keys", headers: member, payload: {} }),
      replica.inject({ method: "POST", url: `${url}/keys`, headers: admin, payload: {} }),
    ]);
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.ok([200, 401].includes(login.statusCode), login.body);
    assert.ok([201, 401, 403].includes(personal.statusCode), personal.body);
    assert.ok([201, 403].includes(assisted.statusCode), assisted.body);
    assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "active" } })).statusCode, 200);
    for (const cookie of [member.cookie, ...(login.statusCode === 200 ? [String(login.headers["set-cookie"]).split(";")[0]] : [])]) {
      assert.equal((await replica.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 401);
    }
    for (const issued of [personal, assisted].filter((r) => r.statusCode === 201)) {
      assert.equal((await replica.inject({ url: "/mcp", headers: { authorization: `Bearer ${issued.json().rawKey}` } })).statusCode, 401);
    }
    const listed = await replica.inject({ url: `${url}/keys`, headers: admin });
    assert.ok(listed.json().keys.every((key: { revokedAt: string | null }) => key.revokedAt !== null));
  }
});

test("re-enabling preserves required password replacement and repeated disabling preserves revocation timestamps", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers: member, payload: {} })).statusCode, 201);
  const url = `/api/admin/users/${f.memberId}`;
  const patch = (status: string) => f.app.inject({ method: "PATCH", url, headers: admin, payload: { status } });
  assert.equal((await patch("disabled")).statusCode, 200);
  const first = (await f.app.inject({ url: `${url}/keys`, headers: admin })).json().keys;
  assert.equal((await patch("disabled")).statusCode, 200);
  assert.deepEqual((await f.app.inject({ url: `${url}/keys`, headers: admin })).json().keys, first);
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.memberId) }, { $set: { requiredPasswordChange: true } });
  const enabled = await patch("active");
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().user.requiredPasswordChange, true);
  const fresh = await f.login("member@example.com");
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: fresh })).statusCode, 200);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers: fresh, payload: {} })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: `${url}/keys`, headers: admin, payload: {} })).statusCode, 403);
});

test("database rejection during revocation rolls back account changes and session deletion", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login("member@example.com");
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers: member, payload: {} })).statusCode, 201);
  // Real database validation forces failure after the transaction has changed the
  // user and deleted sessions, without mocking a security-sensitive collaborator.
  await f.db.db!.command({ collMod: "api_keys", validator: { revokedAt: { $type: "null" } } });
  const url = `/api/admin/users/${f.memberId}`;
  const rejected = await f.app.inject({ method: "PATCH", url, headers: admin, payload: { role: "admin", status: "disabled" } });
  assert.equal(rejected.statusCode, 503, rejected.body);
  assert.deepEqual(rejected.json(), { error: "Authentication unavailable" });
  const me = await f.app.inject({ url: "/api/auth/me", headers: member });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.role, "member");
  assert.equal(me.json().user.status, "active");
  assert.equal((await f.app.inject({ url: "/api/keys", headers: member })).json().keys[0].revokedAt, null);
  await f.db.db!.command({ collMod: "api_keys", validator: {} });
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "disabled" } })).statusCode, 200);
});

test("connected MCP client is denied on the next request and old credentials stay revoked in a fresh gateway", async (t) => {
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
  const f = await fixture(t, { upstreams: [{ name: "time", url: `${address}/mcp`, enabled: true }] });
  const admin = await f.login();
  const member = await f.login("member@example.com");
  const issued = await f.app.inject({ method: "POST", url: "/api/keys", headers: member, payload: {} });
  assert.equal(issued.statusCode, 201);
  const gatewayAddress = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "disable-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${issued.json().rawKey}` } },
  }));
  assert.equal((await client.listTools(undefined, { cacheMode: "bypass" })).tools[0].name, "time.current");
  const url = `/api/admin/users/${f.memberId}`;
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "disabled" } })).statusCode, 200);
  const unauthorized = (error: unknown) => {
    assert.ok(error instanceof SdkHttpError);
    assert.equal(error.data.status, 401);
    return true;
  };
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), unauthorized);
  await assert.rejects(client.callTool({ name: "time.current", arguments: {} }), unauthorized);
  assert.equal((await f.app.inject({ method: "PATCH", url, headers: admin, payload: { status: "active" } })).statusCode, 200);
  await assert.rejects(client.listTools(undefined, { cacheMode: "bypass" }), unauthorized);
  const freshGateway = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => freshGateway.close());
  assert.equal((await freshGateway.inject({ url: "/api/auth/me", headers: member })).statusCode, 401);
  assert.equal((await freshGateway.inject({ url: "/mcp", headers: { authorization: `Bearer ${issued.json().rawKey}` } })).statusCode, 401);
  const keys = await freshGateway.inject({ url: `${url}/keys`, headers: admin });
  assert.ok(keys.json().keys[0].revokedAt);
});
