import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
import Fastify from "fastify";
import { createGatewayApp } from "../app.js";
import { hashPassword } from "./passwords.js";
import { connectIdentityStorage } from "./storage.js";
import { createDashboardSessions, DashboardAuthError } from "./dashboard-sessions.js";

const baseUri = process.env.MONGODB_TEST_URI;
assert.ok(baseUri, "Use the real MongoDB integration runner");
const origin = "http://localhost:3000";
const password = "a final test password";

async function fixture(t: TestContext) {
  const uri = new URL(baseUri!);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  const db = await mongoose.createConnection(uri.toString()).asPromise();
  const user = await db.collection("users").insertOne({
    email: "admin@example.com", passwordHash: await hashPassword(password),
    role: "admin", status: "active", requiredPasswordChange: false,
    createdAt: new Date(), updatedAt: new Date(),
  });
  const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP, key: process.env.GATEWAY_BOOTSTRAP_KEY };
  process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  process.env.GATEWAY_BOOTSTRAP_KEY = "test-only-gateway-key";
  let app = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [] });
  t.after(async () => {
    await app.close();
    await db.dropDatabase(); await db.close();
    if (previous.origins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    else process.env.DASHBOARD_TRUSTED_ORIGINS = previous.origins;
    if (previous.http === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
    else process.env.DASHBOARD_ALLOW_HTTP = previous.http;
    if (previous.key === undefined) delete process.env.GATEWAY_BOOTSTRAP_KEY;
    else process.env.GATEWAY_BOOTSTRAP_KEY = previous.key;
  });
  return {
    db, uri: uri.toString(), userId: user.insertedId,
    get app() { return app; },
    async restart() {
      await app.close();
      app = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [] });
    },
    login(email = " Admin@Example.COM ", secret = password, ip = "127.0.0.1") {
      return app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: ip,
        headers: { origin }, payload: { email, password: secret } });
    },
  };
}

function sessionCookie(response: { headers: { [key: string]: unknown } }) {
  const header = response.headers["set-cookie"];
  assert.equal(typeof header, "string");
  return String(header).split(";")[0];
}

test("administrator creates a member who replaces the assigned password before fresh login", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const headers = { cookie: sessionCookie(admin), origin, "x-csrf-token": admin.json().csrfToken };
  const assigned = "temporary member password";
  const created = await f.app.inject({ method: "POST", url: "/api/admin/users", headers,
    payload: { email: " Member@Example.COM ", password: assigned } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.headers["cache-control"], "no-store");
  const user = created.json().user;
  assert.deepEqual(Object.keys(user).sort(), ["createdAt", "email", "id", "requiredPasswordChange", "role", "status", "updatedAt"]);
  assert.equal(user.email, "member@example.com");
  assert.equal(user.role, "member");
  assert.equal(user.status, "active");
  assert.equal(user.requiredPasswordChange, true);
  const stored = await f.db.collection("users").findOne({ email: user.email });
  assert.ok(stored);
  assert.match(stored.passwordHash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!JSON.stringify(stored).includes(assigned));
  const inspected = await f.app.inject({ url: `/api/admin/users/${user.id}`, headers });
  assert.equal(inspected.statusCode, 200, inspected.body);
  assert.deepEqual(inspected.json(), { user });
  const member = await f.login(user.email, assigned);
  assert.equal(member.statusCode, 200, member.body);
  const memberHeaders = { cookie: sessionCookie(member), origin, "x-csrf-token": member.json().csrfToken };
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: memberHeaders })).json().user.requiredPasswordChange, true);
  assert.equal((await f.app.inject({ url: `/api/admin/users/${f.userId}`, headers: memberHeaders })).statusCode, 403);
  const replacement = "a final member password";
  const changed = await f.app.inject({ method: "POST", url: "/api/auth/change-password", headers: memberHeaders,
    payload: { currentPassword: assigned, newPassword: replacement } });
  assert.equal(changed.statusCode, 204, changed.body);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: memberHeaders })).statusCode, 401);
  assert.equal((await f.login(user.email, assigned)).statusCode, 401);
  const fresh = await f.login(user.email, replacement);
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().user.requiredPasswordChange, false);
  assert.equal((await f.app.inject({ url: `/api/admin/users/${f.userId}`, headers: { cookie: sessionCookie(fresh) } })).statusCode, 403);
});

test("administrator lists safe accounts with bounded deterministic pagination", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const headers = { cookie: sessionCookie(admin), origin, "x-csrf-token": admin.json().csrfToken };
  for (const email of ["first@example.com", "second@example.com"]) {
    const result = await f.app.inject({ method: "POST", url: "/api/admin/users", headers, payload: { email, password } });
    assert.equal(result.statusCode, 201, result.body);
  }
  const list = (query = "") => f.app.inject({ url: `/api/admin/users${query}`, headers });
  const all = await list();
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.headers["cache-control"], "no-store");
  assert.equal(all.json().page, 1);
  assert.equal(all.json().limit, 20);
  assert.equal(all.json().users.length, 3);
  const pages = [];
  for (let page = 1; page <= 4; page++) {
    const response = await list(`?page=${page}&limit=1`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().page, page);
    assert.equal(response.json().limit, 1);
    pages.push(...response.json().users);
  }
  assert.deepEqual(pages, all.json().users);
  for (const user of pages) {
    assert.deepEqual(Object.keys(user).sort(), ["createdAt", "email", "id", "requiredPasswordChange", "role", "status", "updatedAt"]);
  }
  assert.equal((await list("?limit=100")).statusCode, 200);
  for (const query of ["?limit=101", "?limit=0", "?limit=-1", "?limit=1.5", "?limit=", "?limit=abc",
    "?page=0", "?page=1.5", "?page=9007199254740991", "?role=admin", "?limit=1&limit=2"]) {
    const response = await list(query);
    assert.equal(response.statusCode, 400, query);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
});

test("admin account routes enforce session roles, pending replacement, Origin, and CSRF", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const other = await f.login();
  const cookie = sessionCookie(admin);
  const headers = { cookie, origin, "x-csrf-token": admin.json().csrfToken };
  const create = (requestHeaders: Record<string, string>) => f.app.inject({
    method: "POST", url: "/api/admin/users", headers: requestHeaders,
    payload: { email: "blocked@example.com", password },
  });
  const deniedHeaders: Record<string, string>[] = [{ cookie, origin }, { cookie, "x-csrf-token": admin.json().csrfToken },
    { ...headers, origin: "http://evil.example" }, { ...headers, "x-csrf-token": other.json().csrfToken }];
  for (const denied of deniedHeaders) {
    assert.equal((await create(denied)).statusCode, 403);
  }
  const missingSessionHeaders: Record<string, string>[] = [{}, { authorization: "Bearer test-only-gateway-key" }];
  for (const authHeaders of missingSessionHeaders) {
    for (const url of ["/api/admin/users", `/api/admin/users/${f.userId}`]) {
      assert.equal((await f.app.inject({ url, headers: authHeaders })).statusCode, 401);
    }
    assert.equal((await create({ ...authHeaders, origin })).statusCode, 401);
  }
  for (const state of [{ role: "member", requiredPasswordChange: false }, { role: "admin", requiredPasswordChange: true }]) {
    await f.db.collection("users").updateOne({ _id: f.userId }, { $set: state });
    for (const url of ["/api/admin/users", `/api/admin/users/${f.userId}`]) {
      assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
    }
    assert.equal((await create(headers)).statusCode, 403);
  }
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { role: "admin", requiredPasswordChange: false } });
  assert.equal((await f.app.inject({ url: "/api/admin/users", headers })).json().users.length, 1);
  assert.equal((await f.app.inject({ url: "/api/admin/users/not-an-id", headers })).statusCode, 400);
  const missing = await f.app.inject({ url: "/api/admin/users/000000000000000000000000", headers });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "User not found" });
});

test("member creation rejects strict input violations and normalized duplicate races", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const headers = { cookie: sessionCookie(admin), origin, "x-csrf-token": admin.json().csrfToken };
  const valid = { email: "new@example.com", password };
  for (const payload of [{ ...valid, role: "admin" }, { ...valid, role: "member" }, { ...valid, userId: String(f.userId) },
    { ...valid, status: "disabled" }, { ...valid, requiredPasswordChange: false }, { ...valid, passwordHash: "hash" },
    { ...valid, unexpected: true }, { ...valid, email: "bad" }, { ...valid, password: "short" },
    { ...valid, password: "x".repeat(129) }, { email: valid.email }, { password }, null, []]) {
    const response = await f.app.inject({ method: "POST", url: "/api/admin/users", headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify(payload) });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  for (const [contentType, payload, status] of [
    ["application/json", "{invalid", 400], ["text/plain", password, 415], ["application/json", "x".repeat(5000), 413],
  ] as const) {
    const response = await f.app.inject({ method: "POST", url: "/api/admin/users", headers: { ...headers, "content-type": contentType }, payload });
    assert.equal(response.statusCode, status, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  assert.equal((await f.app.inject({ url: "/api/admin/users", headers })).json().users.length, 1);
  const other = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => other.close());
  const results = await Promise.all([
    f.app.inject({ method: "POST", url: "/api/admin/users", headers, payload: valid }),
    other.inject({ method: "POST", url: "/api/admin/users", headers, payload: { email: " NEW@Example.COM ", password } }),
  ]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 409]);
  assert.deepEqual(results.find((response) => response.statusCode === 409)?.json(), { error: "Email already exists" });
  const duplicate = await f.app.inject({ method: "POST", url: "/api/admin/users", headers, payload: valid });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  const list = await f.app.inject({ url: "/api/admin/users", headers });
  assert.equal(list.json().users.length, 2);
  for (const response of [...results, duplicate, list]) {
    assert.equal(response.headers["cache-control"], "no-store");
    assert.ok(!response.body.includes(password));
    assert.ok(!response.body.includes("passwordHash"));
  }
});

test("password replacement clears required change and ends every device session before fresh login", async (t) => {
  const f = await fixture(t);
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { requiredPasswordChange: true } });
  const first = await f.login();
  const second = await f.login();
  const nextPassword = "a different final password";
  const response = await f.app.inject({ method: "POST", url: "/api/auth/change-password",
    headers: { cookie: sessionCookie(first), origin, "x-csrf-token": first.json().csrfToken },
    payload: { currentPassword: password, newPassword: nextPassword } });
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["set-cookie"]), /Max-Age=0/);
  for (const login of [first, second]) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(login) } })).statusCode, 401);
  }
  await f.restart();
  assert.equal((await f.login()).statusCode, 401);
  const fresh = await f.login("admin@example.com", nextPassword);
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().user.requiredPasswordChange, false);
  const stored = await f.db.collection("users").findOne({ _id: f.userId });
  assert.ok(stored);
  assert.match(stored.passwordHash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!JSON.stringify(stored).includes(nextPassword));
});

test("pending replacement permits account details, logout and change only, with ordinary eligibility refreshed per request", async (t) => {
  const f = await fixture(t);
  const storage = await connectIdentityStorage(f.uri);
  const sessions = await createDashboardSessions(storage);
  const protectedApi = Fastify();
  t.after(async () => { await protectedApi.close(); await storage.close(); });
  protectedApi.setErrorHandler((error, _request, reply) => {
    if (error instanceof DashboardAuthError) return reply.code(error.status).send({ error: error.message });
    return reply.code(503).send({ error: "Authentication unavailable" });
  });
  // Representative later management/key routes use ordinary session authentication.
  for (const url of ["/api/keys", "/api/admin/users"]) {
    protectedApi.get(url, async (request) => sessions.authenticate(request.headers.cookie?.split("=")[1]));
  }
  for (const role of ["admin", "member"]) {
    await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { role, requiredPasswordChange: false } });
    const login = await f.login();
    const cookie = sessionCookie(login);
    assert.equal((await protectedApi.inject({ url: "/api/keys", headers: { cookie } })).statusCode, 200);
    await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { requiredPasswordChange: true } });
    for (const url of ["/api/keys", "/api/admin/users"]) {
      const denied = await protectedApi.inject({ url, headers: { cookie } });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.deepEqual(denied.json(), { error: "Password change required" });
    }
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 200);
    const logout = await f.app.inject({ method: "POST", url: "/api/auth/logout",
      headers: { cookie, origin, "x-csrf-token": login.json().csrfToken } });
    assert.equal(logout.statusCode, 204, logout.body);
  }
});

test("password change rejects incorrect, unchanged and invalid passwords without altering credentials", async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const cookie = sessionCookie(login);
  const before = await f.db.collection("users").findOne({ _id: f.userId });
  const attempts = [
    { currentPassword: "incorrect test password", newPassword: "a different final password" },
    { currentPassword: password, newPassword: password },
    { currentPassword: password, newPassword: "x".repeat(11) },
    { currentPassword: password, newPassword: "x".repeat(129) },
    { currentPassword: "short", newPassword: "a different final password" },
    { currentPassword: password, newPassword: 123 },
    { currentPassword: password },
    { currentPassword: password, newPassword: "a different final password", userId: String(f.userId) },
  ];
  for (const payload of attempts) {
    const result = await f.app.inject({ method: "POST", url: "/api/auth/change-password",
      headers: { cookie, origin, "x-csrf-token": login.json().csrfToken }, payload });
    assert.equal(result.statusCode, 400, result.body);
    assert.ok(!result.body.includes(password));
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 200);
  }
  assert.deepEqual(await f.db.collection("users").findOne({ _id: f.userId }), before);
  assert.equal((await f.login()).statusCode, 200);
});

test("password change requires a dashboard session, trusted Origin and this session's CSRF token", async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login();
  const cookie = sessionCookie(first);
  const before = await f.db.collection("users").findOne({ _id: f.userId });
  const cases: { headers: Record<string, string>; status: number }[] = [
    { headers: { cookie, "x-csrf-token": first.json().csrfToken }, status: 403 },
    { headers: { cookie, origin: "http://localhost:3001", "x-csrf-token": first.json().csrfToken }, status: 403 },
    { headers: { cookie, origin }, status: 403 },
    { headers: { cookie, origin, "x-csrf-token": "invalid" }, status: 403 },
    { headers: { cookie, origin, "x-csrf-token": second.json().csrfToken }, status: 403 },
    { headers: { origin, "x-csrf-token": first.json().csrfToken }, status: 401 },
    { headers: { origin, authorization: "Bearer test-only-gateway-key", "x-csrf-token": first.json().csrfToken }, status: 401 },
  ];
  for (const { headers, status } of cases) {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/change-password", headers,
      payload: { currentPassword: password, newPassword: "a different final password" } });
    assert.equal(response.statusCode, status, response.body);
  }
  const headers = { cookie, origin, "x-csrf-token": first.json().csrfToken };
  for (const [contentType, payload, status] of [
    ["text/plain", password, 415], ["application/json", "{invalid", 400],
    ["application/json", "x".repeat(5000), 413],
  ] as const) {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/change-password",
      headers: { ...headers, "content-type": contentType }, payload });
    assert.equal(response.statusCode, status, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  assert.deepEqual(await f.db.collection("users").findOne({ _id: f.userId }), before);
  assert.equal(await f.db.collection("dashboard_sessions").countDocuments(), 2);
});

test("ordinary password changes preserve key metadata, other accounts and exact Unicode passwords at both bounds", async (t) => {
  const f = await fixture(t);
  const otherPassword = "another user's password";
  await f.db.collection("users").insertOne({ email: "member@example.com", passwordHash: await hashPassword(otherPassword),
    role: "member", status: "active", requiredPasswordChange: false, createdAt: new Date(), updatedAt: new Date() });
  const other = await f.login("member@example.com", otherPassword);
  // Prove password replacement leaves existing API-key records intact.
  await f.db.collection("api_keys").insertOne({ userId: f.userId, keyHash: createHash("sha256").update("test-only-key").digest("hex"), revokedAt: null });
  const keysBefore = await f.db.collection("api_keys").find().toArray();
  let currentPassword = password;
  for (const newPassword of ["🙂".repeat(12), " " + "🙂".repeat(126) + " "]) {
    const login = await f.login("admin@example.com", currentPassword);
    assert.equal(login.statusCode, 200, login.body);
    const response = await f.app.inject({ method: "POST", url: "/api/auth/change-password",
      headers: { cookie: sessionCookie(login), origin, "x-csrf-token": login.json().csrfToken },
      payload: { currentPassword, newPassword } });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal((await f.login("admin@example.com", currentPassword)).statusCode, 401);
    currentPassword = newPassword;
  }
  assert.equal((await f.login("admin@example.com", currentPassword)).statusCode, 200);
  assert.equal((await f.login("admin@example.com", currentPassword.trim())).statusCode, 401);
  assert.deepEqual(await f.db.collection("api_keys").find().toArray(), keysBefore);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(other) } })).statusCode, 200);
});

test("concurrent password changes admit one replacement and old-password login cannot escape invalidation", async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login();
  const newPasswords = ["the first replacement password", "the second replacement password"];
  const changes = [first, second].map((login, index) => f.app.inject({ method: "POST", url: "/api/auth/change-password",
    headers: { cookie: sessionCookie(login), origin, "x-csrf-token": login.json().csrfToken },
    payload: { currentPassword: password, newPassword: newPasswords[index] } }));
  const results = await Promise.all(changes);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [204, 401]);
  const winner = results.findIndex((result) => result.statusCode === 204);
  assert.equal((await f.login("admin@example.com", newPasswords[winner])).statusCode, 200);
  assert.equal((await f.login()).statusCode, 401);
  for (const login of [first, second]) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(login) } })).statusCode, 401);
  }
  // Race a login against another replacement. It is either denied or committed before invalidation.
  const fresh = await f.login("admin@example.com", newPasswords[winner]);
  const [changed, racingLogin] = await Promise.all([
    f.app.inject({ method: "POST", url: "/api/auth/change-password",
      headers: { cookie: sessionCookie(fresh), origin, "x-csrf-token": fresh.json().csrfToken },
      payload: { currentPassword: newPasswords[winner], newPassword: "the last replacement password" } }),
    f.login("admin@example.com", newPasswords[winner]),
  ]);
  assert.equal(changed.statusCode, 204, changed.body);
  assert.ok([200, 401].includes(racingLogin.statusCode), racingLogin.body);
  if (racingLogin.statusCode === 200) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(racingLogin) } })).statusCode, 401);
  }
  assert.equal((await f.login("admin@example.com", "the last replacement password")).statusCode, 200);
});

test("login returns safe current user and a hashed persistent independent session", async (t) => {
  const f = await fixture(t);
  const start = Date.now();
  const first = await f.login();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(Object.keys(first.json()).sort(), ["csrfToken", "user"]);
  assert.deepEqual(Object.keys(first.json().user).sort(),
    ["createdAt", "email", "id", "requiredPasswordChange", "role", "status", "updatedAt"]);
  assert.equal(first.json().user.email, "admin@example.com");
  assert.equal(first.json().user.id, String(f.userId));
  assert.match(String(first.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(first.headers["set-cookie"]), /Path=\/api/);
  assert.match(String(first.headers["set-cookie"]), /SameSite=Lax/);
  assert.match(String(first.headers["set-cookie"]), /Max-Age=28800/);
  assert.match(String(first.headers["set-cookie"]), /Expires=/);
  assert.ok(!String(first.headers["set-cookie"]).includes("Secure"));
  assert.equal(first.headers["cache-control"], "no-store");
  const cookie = sessionCookie(first);
  const credential = cookie.split("=")[1];
  const stored = await f.db.collection("dashboard_sessions").findOne();
  assert.ok(stored);
  assert.equal(stored.credentialHash, createHash("sha256").update(credential).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(credential));
  assert.ok(stored.expiresAt.getTime() >= start + 8 * 60 * 60 * 1000);
  assert.ok(stored.expiresAt.getTime() < Date.now() + 8 * 60 * 60 * 1000 + 1000);
  const second = await f.login();
  assert.equal(second.statusCode, 200);
  assert.notEqual(sessionCookie(second), cookie);
  await f.restart();
  const me = await f.app.inject({ url: "/api/auth/me", headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  assert.deepEqual(me.json(), first.json());
  assert.deepEqual((await f.db.collection("dashboard_sessions").findOne({ _id: stored._id }))?.expiresAt, stored.expiresAt);
});

test("logout requires exact Origin and session-bound CSRF and ends only this device", async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login();
  const cookie = sessionCookie(first);
  const logout = (headers: Record<string, string>) => f.app.inject({
    method: "POST", url: "/api/auth/logout", headers: { cookie, ...headers },
  });
  const rejectedHeaders: Record<string, string>[] = [
    { "x-csrf-token": first.json().csrfToken },
    { origin: "http://localhost:3001", "x-csrf-token": first.json().csrfToken },
    { origin, "x-csrf-token": "wrong" },
    { origin, "x-csrf-token": second.json().csrfToken },
    { origin },
  ];
  for (const headers of rejectedHeaders) {
    assert.equal((await logout(headers)).statusCode, 403);
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 200);
  }
  const result = await logout({ origin, "x-csrf-token": first.json().csrfToken });
  assert.equal(result.statusCode, 204, result.body);
  assert.match(String(result.headers["set-cookie"]), /Max-Age=0/);
  assert.match(String(result.headers["set-cookie"]), /Expires=Thu, 01 Jan 1970/);
  assert.match(String(result.headers["set-cookie"]), /Path=\/api/);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(second) } })).statusCode, 200);
  assert.equal(await f.db.collection("dashboard_sessions").countDocuments(), 1);
  const mcp = await f.app.inject({ method: "POST", url: "/mcp", headers: {
    authorization: "Bearer test-only-gateway-key", accept: "application/json, text/event-stream",
  }, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "logout-test", version: "1" },
  } } });
  assert.equal(mcp.statusCode, 200, mcp.body);
});

test("five failed normalized account attempts survive restart and are shared across replicas", async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await f.login(" ADMIN@example.com ", "incorrect test password");
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Invalid credentials" });
  }
  await f.restart();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await f.login("admin@example.com", "incorrect test password")).statusCode, 401);
  }
  const other = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => other.close());
  const limited = await other.inject({ method: "POST", url: "/api/auth/login",
    headers: { origin }, payload: { email: "admin@example.com", password } });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.deepEqual(limited.json(), { error: "Too many attempts" });
  assert.equal(await f.db.collection("dashboard_sessions").countDocuments(), 0);
});

test("expiry is enforced before cleanup, current eligibility and role are refreshed, and credentials stay separate", async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const cookie = sessionCookie(first);
  const stored = await f.db.collection("dashboard_sessions").findOne();
  assert.ok(stored);
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { role: "member", requiredPasswordChange: true } });
  const current = await f.app.inject({ url: "/api/auth/me", headers: { cookie } });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().user.role, "member");
  assert.equal(current.json().user.requiredPasswordChange, true);
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { status: "disabled" } });
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 401);
  const disabled = await f.login();
  const unknown = await f.login("unknown@example.com");
  const incorrect = await f.login("admin@example.com", "incorrect test password");
  assert.equal(disabled.statusCode, 401);
  assert.deepEqual(unknown.json(), disabled.json());
  assert.deepEqual(incorrect.json(), disabled.json());
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { status: "active" } });
  await f.db.collection("dashboard_sessions").updateOne({ _id: stored._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { authorization: "Bearer test-only-gateway-key" } })).statusCode, 401);
  const fresh = await f.login();
  assert.equal(fresh.statusCode, 200);
  assert.equal((await f.app.inject({ url: "/mcp", headers: { cookie: sessionCookie(fresh) } })).statusCode, 401);
  const before = await f.db.collection("dashboard_sessions").countDocuments();
  for (const invalid of ["", "ugw_test", `${sessionCookie(fresh)}; ${sessionCookie(fresh)}`]) {
    assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: invalid } })).statusCode, 401);
  }
  assert.equal(await f.db.collection("dashboard_sessions").countDocuments(), before);
});

test("login rejects missing/untrusted Origin and invalid JSON inputs before creating sessions", async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, "null", "http://localhost:3001", "http://localhost:3000/", "http://localhost:3000.evil.example"]) {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/login",
      headers: value === undefined ? {} : { origin: value }, payload: { email: "admin@example.com", password } });
    assert.equal(response.statusCode, 403);
  }
  const invalidInputs = [
    { email: "admin@example.com", password, role: "admin" },
    { email: "admin@example.com", password, userId: String(f.userId) },
    { email: "invalid", password }, { email: "admin@example.com", password: "short" },
    { email: "admin@example.com", password: "x".repeat(129) }, { email: "admin@example.com" },
    { email: "admin@example.com", password: 123 }, null, [],
  ];
  for (const payload of invalidInputs) {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  const malformed = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, "content-type": "application/json" }, payload: "{invalid" });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { error: "Invalid request" });
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, "content-type": "text/plain" }, payload: password })).statusCode, 415);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, "content-type": "application/json" }, payload: "x".repeat(5000) })).statusCode, 413);
  assert.equal(await f.db.collection("dashboard_sessions").countDocuments(), 0);
  assert.equal(await f.db.collection("login_throttles").countDocuments(), 0);
});

test("IP limit counts 30 attempts, ignores spoofed forwarding, and ages out persisted windows", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 30; index++) {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "192.0.2.10",
      headers: { origin, "x-forwarded-for": `198.51.100.${index}` }, payload: { email: `unknown${index}@example.com`, password } });
    assert.equal(response.statusCode, 401, response.body);
    if (index === 15) await f.restart();
  }
  const blocked = await f.login("admin@example.com", password, "192.0.2.10");
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.json(), { error: "Too many attempts" });
  assert.equal((await f.login("admin@example.com", password, "192.0.2.11")).statusCode, 200);
  const old = new Date(Date.now() - 15 * 60 * 1000 - 1);
  await f.db.collection("login_throttles").updateMany({}, { $set: { "attempts.$[].at": old } });
  assert.equal((await f.login("admin@example.com", password, "192.0.2.10")).statusCode, 200);
});

test("secure mode refuses HTTP and permits HTTPS only through explicitly trusted proxies", async (t) => {
  const f = await fixture(t);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProxies = process.env.DASHBOARD_TRUSTED_PROXIES;
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousProxies === undefined) delete process.env.DASHBOARD_TRUSTED_PROXIES; else process.env.DASHBOARD_TRUSTED_PROXIES = previousProxies;
  });
  process.env.NODE_ENV = "production";
  await assert.rejects(createGatewayApp({ mongodbUri: f.uri, upstreams: [] }), /HTTP configuration/);
  process.env.DASHBOARD_ALLOW_HTTP = "false";
  process.env.DASHBOARD_TRUSTED_ORIGINS = "http://localhost:3000";
  await assert.rejects(createGatewayApp({ mongodbUri: f.uri, upstreams: [] }), /Origin configuration/);
  process.env.DASHBOARD_TRUSTED_ORIGINS = "https://localhost:3000";
  process.env.DASHBOARD_TRUSTED_PROXIES = "127.0.0.1,::1";
  await f.restart();
  const login = (remoteAddress: string, proto?: string) => f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress,
    headers: { origin: "https://localhost:3000", ...(proto ? { "x-forwarded-proto": proto } : {}) }, payload: { email: "admin@example.com", password } });
  assert.equal((await login("127.0.0.1")).statusCode, 403);
  assert.equal((await login("192.0.2.10", "https")).statusCode, 403);
  assert.equal((await login("127.0.0.1", "https,http")).statusCode, 403);
  assert.equal((await login("0:0:0:0:0:0:0:1", "https")).statusCode, 200);
  const response = await login("127.0.0.1", "https");
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers["set-cookie"]), /; Secure/);
  const cookie = sessionCookie(response);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 403);
  const logout = await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: {
    cookie, origin: "https://localhost:3000", "x-forwarded-proto": "https", "x-csrf-token": response.json().csrfToken,
  } });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /; Secure/);
});

test("trusted proxy uses the nearest untrusted hop and cannot evade limits with an invented leftmost address", async (t) => {
  const f = await fixture(t);
  const previousProxies = process.env.DASHBOARD_TRUSTED_PROXIES;
  t.after(() => {
    if (previousProxies === undefined) delete process.env.DASHBOARD_TRUSTED_PROXIES;
    else process.env.DASHBOARD_TRUSTED_PROXIES = previousProxies;
  });
  process.env.DASHBOARD_TRUSTED_PROXIES = "127.0.0.1,192.0.2.1";
  await f.restart();
  for (let index = 0; index < 30; index++) {
    const clientIp = index % 2 === 0 ? "2001:db8::1" : "2001:DB8:0:0:0:0:0:1";
    const response = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "127.0.0.1",
      headers: { origin, "x-forwarded-for": `203.0.113.${index},${clientIp},192.0.2.1` },
      payload: { email: `proxy${index}@example.com`, password } });
    assert.equal(response.statusCode, 401);
  }
  const blocked = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "127.0.0.1",
    headers: { origin, "x-forwarded-for": "203.0.113.99,2001:db8::1,192.0.2.1" }, payload: { email: "admin@example.com", password } });
  assert.equal(blocked.statusCode, 429);
  const allowed = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "127.0.0.1",
    headers: { origin, "x-forwarded-for": "198.51.100.2,192.0.2.1" }, payload: { email: "admin@example.com", password } });
  assert.equal(allowed.statusCode, 200);
});

test("success does not consume account failures and concurrent replicas cannot overrun the fifth failure", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) assert.equal((await f.login("admin@example.com", "incorrect test password")).statusCode, 401);
  for (let index = 0; index < 2; index++) assert.equal((await f.login()).statusCode, 200);
  const other = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => other.close());
  const results = await Promise.all([
    f.login("admin@example.com", "incorrect test password"),
    other.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: " ADMIN@example.com ", password: "incorrect test password" } }),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [401, 429]);
  assert.equal((await f.login()).statusCode, 429);
  const old = new Date(Date.now() - 15 * 60 * 1000 - 1);
  await f.db.collection("login_throttles").updateMany({}, { $set: { "attempts.$[].at": old } });
  assert.equal((await f.login()).statusCode, 200);
});

test("logout rejects client identity fields without invalidating a valid session", async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const cookie = sessionCookie(login);
  const headers = { cookie, origin, "x-csrf-token": login.json().csrfToken };
  const response = await f.app.inject({ method: "POST", url: "/api/auth/logout", headers,
    payload: { userId: String(f.userId), role: "admin" } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Invalid request" });
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 200);
});
