import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
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
    { role: "admin", status: "disabled" }, { role: "admin", userId: f.adminId },
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
  // Arrange an inactive administrator; disabling itself belongs to the next slice.
  await f.db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(f.memberId) }, { $set: { role: "admin", status: "disabled" } });
  const denied = await f.app.inject({ method: "PATCH", url, headers: admin, payload: { role: "member" } });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal((await f.app.inject({ url, headers: admin })).json().user.role, "admin");
});
