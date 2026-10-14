import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
import { createGatewayApp } from "../app.js";
import { hashPassword } from "./passwords.js";

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
  process.env.DASHBOARD_TRUSTED_PROXIES = "127.0.0.1";
  await f.restart();
  const login = (remoteAddress: string, proto?: string) => f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress,
    headers: { origin: "https://localhost:3000", ...(proto ? { "x-forwarded-proto": proto } : {}) }, payload: { email: "admin@example.com", password } });
  assert.equal((await login("127.0.0.1")).statusCode, 403);
  assert.equal((await login("192.0.2.10", "https")).statusCode, 403);
  assert.equal((await login("127.0.0.1", "https,http")).statusCode, 403);
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
    const response = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "127.0.0.1",
      headers: { origin, "x-forwarded-for": `203.0.113.${index},198.51.100.1,192.0.2.1` },
      payload: { email: `proxy${index}@example.com`, password } });
    assert.equal(response.statusCode, 401);
  }
  const blocked = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "127.0.0.1",
    headers: { origin, "x-forwarded-for": "203.0.113.99,198.51.100.1,192.0.2.1" }, payload: { email: "admin@example.com", password } });
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
