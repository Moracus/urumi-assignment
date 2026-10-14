import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
import { createGatewayApp } from "../app.js";
import { hashPassword } from "./passwords.js";

const baseUri = process.env.MONGODB_TEST_URI;
assert.ok(baseUri, "Use the real MongoDB integration runner");
const origin = "http://localhost:3000";
const password = "a final key test password";

async function fixture(t: TestContext) {
  const uri = new URL(baseUri!);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  const db = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 2000 }).asPromise();
  const passwordHash = await hashPassword(password);
  const user = await db.collection("users").insertOne({
    email: "member@example.com", passwordHash, role: "member", status: "active",
    requiredPasswordChange: false, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.collection("users").insertOne({
    email: "other@example.com", passwordHash, role: "admin", status: "active",
    requiredPasswordChange: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP };
  process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  let app = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [] });
  t.after(async () => {
    await app.close();
    await db.dropDatabase(); await db.close();
    if (previous.origins === undefined) delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    else process.env.DASHBOARD_TRUSTED_ORIGINS = previous.origins;
    if (previous.http === undefined) delete process.env.DASHBOARD_ALLOW_HTTP;
    else process.env.DASHBOARD_ALLOW_HTTP = previous.http;
  });
  async function login(email = "member@example.com") {
    const result = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email, password } });
    assert.equal(result.statusCode, 200, result.body);
    return { cookie: String(result.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": result.json().csrfToken };
  }
  return {
    db, uri: uri.toString(), userId: user.insertedId, login,
    get app() { return app; },
    async restart() {
      await app.close();
      app = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [] });
    },
  };
}

const metadataFields = ["createdAt", "id", "lastUsedAt", "name", "prefix", "revokedAt"];

test("member receives a gateway key once and only safe metadata survives storage and restart", async (t) => {
  const f = await fixture(t);
  const headers = await f.login();
  const logs: string[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    t.mock.method(console, method, (...values: unknown[]) => { logs.push(JSON.stringify(values)); });
    t.mock.method(f.app.log, method === "log" ? "trace" : method, (...values: unknown[]) => { logs.push(JSON.stringify(values)); });
  }
  const created = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: { name: "Local client" } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.headers["cache-control"], "no-store");
  const { key, rawKey } = created.json();
  assert.deepEqual(Object.keys(created.json()).sort(), ["key", "rawKey"]);
  assert.deepEqual(Object.keys(key).sort(), metadataFields);
  assert.match(rawKey, /^ugw_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(rawKey.slice(4), "base64url").length, 32);
  assert.equal(key.prefix, rawKey.slice(0, 12));
  assert.equal(key.name, "Local client");
  assert.equal(key.lastUsedAt, null);
  assert.equal(key.revokedAt, null);
  const stored = await f.db.collection("api_keys").findOne({ _id: new mongoose.Types.ObjectId(key.id) });
  assert.ok(stored);
  assert.equal(stored.userId.toString(), f.userId.toString());
  assert.equal(stored.keyHash, createHash("sha256").update(rawKey).digest("hex"));
  assert.deepEqual(Object.keys(stored).sort(), ["__v", "_id", "createdAt", "keyHash", "lastUsedAt", "name", "prefix", "revokedAt", "userId"]);
  assert.ok(!JSON.stringify(stored).includes(rawKey));
  const indexes = await f.db.collection("api_keys").indexes();
  assert.ok(indexes.some((index) => index.unique && index.key.keyHash === 1));
  assert.ok(indexes.some((index) => index.key.userId === 1));
  assert.ok(indexes.every((index) => index.expireAfterSeconds === undefined));
  await f.restart();
  const listed = await f.app.inject({ url: "/api/keys", headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.deepEqual(listed.json(), { keys: [key], page: 1, limit: 20 });
  assert.ok(!listed.body.includes(rawKey));
  assert.ok(!listed.body.includes(stored.keyHash));
  assert.ok(!logs.join("\n").includes(rawKey));
  assert.ok(!logs.join("\n").includes(stored.keyHash));
});

test("revocation is owner-scoped, retains metadata, and is idempotent", async (t) => {
  const f = await fixture(t);
  const headers = await f.login();
  const otherHeaders = await f.login("other@example.com");
  const created = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
  assert.equal(created.statusCode, 201, created.body);
  const { key, rawKey } = created.json();
  const otherList = await f.app.inject({ url: "/api/keys", headers: otherHeaders });
  assert.deepEqual(otherList.json().keys, []);
  for (const id of [key.id, "000000000000000000000000", "not-an-id"]) {
    const inaccessible = await f.app.inject({ method: "DELETE", url: `/api/keys/${id}`, headers: otherHeaders });
    assert.equal(inaccessible.statusCode, 404, inaccessible.body);
    assert.deepEqual(inaccessible.json(), { error: "Key not found" });
  }
  assert.equal((await f.app.inject({ url: "/api/keys", headers })).json().keys[0].revokedAt, null);
  const revoke = () => f.app.inject({ method: "DELETE", url: `/api/keys/${key.id}`, headers });
  const first = await revoke();
  assert.equal(first.statusCode, 204, first.body);
  assert.equal(first.headers["cache-control"], "no-store");
  const listed = await f.app.inject({ url: "/api/keys", headers });
  assert.equal(listed.json().keys.length, 1);
  const revoked = listed.json().keys[0];
  assert.ok(Number.isFinite(Date.parse(revoked.revokedAt)));
  assert.deepEqual(revoked, { ...key, revokedAt: revoked.revokedAt });
  assert.equal((await revoke()).statusCode, 204);
  assert.deepEqual((await f.app.inject({ url: "/api/keys", headers })).json().keys, [revoked]);
  assert.equal(await f.db.collection("api_keys").countDocuments(), 1);
  assert.ok(!listed.body.includes(rawKey));
});

test("key lists paginate safe metadata with strict bounded query inputs", async (t) => {
  const f = await fixture(t);
  const headers = await f.login();
  const keys = [];
  for (const name of ["First", "Second", "Third"]) {
    const response = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: { name } });
    assert.equal(response.statusCode, 201, response.body);
    keys.push(response.json().key);
  }
  const pages = [];
  for (let page = 1; page <= 4; page++) {
    const response = await f.app.inject({ url: `/api/keys?page=${page}&limit=1`, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().page, page);
    assert.equal(response.json().limit, 1);
    pages.push(...response.json().keys);
  }
  assert.deepEqual(pages, keys);
  assert.equal((await f.app.inject({ url: "/api/keys?limit=100", headers })).statusCode, 200);
  for (const query of ["limit=101", "limit=0", "limit=-1", "limit=1.5", "limit=", "limit=abc",
    "page=0", "page=1.5", "page=9007199254740991", "userId=someone", "limit=1&limit=2"]) {
    const response = await f.app.inject({ url: `/api/keys?${query}`, headers });
    assert.equal(response.statusCode, 400, query);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
});

test("concurrent issuance across gateways cannot exceed twenty active keys and revocation frees a slot", async (t) => {
  const f = await fixture(t);
  const headers = await f.login();
  for (let index = 0; index < 19; index++) {
    const response = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
    assert.equal(response.statusCode, 201, response.body);
  }
  const other = await createGatewayApp({ mongodbUri: f.uri, upstreams: [] });
  t.after(() => other.close());
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? other : f.app).inject({ method: "POST", url: "/api/keys", headers, payload: {} })));
  assert.equal(results.filter((response) => response.statusCode === 201).length, 1);
  for (const response of results.filter((response) => response.statusCode !== 201)) {
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), { error: "Active key limit reached" });
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const all = await f.app.inject({ url: "/api/keys?limit=100", headers });
  assert.equal(all.json().keys.length, 20);
  assert.equal(new Set((await f.db.collection("api_keys").find().toArray()).map((key) => key.keyHash)).size, 20);
  const keyId = all.json().keys[0].id;
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/keys/${keyId}`, headers })).statusCode, 204);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: {} })).statusCode, 201);
  const after = await f.app.inject({ url: "/api/keys?limit=100", headers });
  assert.equal(after.json().keys.length, 21);
  assert.equal(after.json().keys.filter((key: { revokedAt: string | null }) => key.revokedAt === null).length, 20);
});

test("key mutations reject unknown inputs and invalid names without issuing or revoking", async (t) => {
  const f = await fixture(t);
  const headers = await f.login();
  for (const payload of [{ name: "x".repeat(101) }, { name: 123 }, { name: null },
    { userId: String(f.userId) }, { role: "admin" }, { keyHash: "hash" }, { revokedAt: null },
    { prefix: "ugw_custom" }, { unexpected: true }, null, []]) {
    const response = await f.app.inject({ method: "POST", url: "/api/keys",
      headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  for (const [contentType, payload, status] of [
    ["application/json", "{invalid", 400], ["text/plain", "invalid", 415], ["application/json", "x".repeat(5000), 413],
  ] as const) {
    const response = await f.app.inject({ method: "POST", url: "/api/keys",
      headers: { ...headers, "content-type": contentType }, payload });
    assert.equal(response.statusCode, status, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  const query = await f.app.inject({ method: "POST", url: "/api/keys?userId=other", headers, payload: {} });
  assert.equal(query.statusCode, 400, query.body);
  assert.deepEqual((await f.app.inject({ url: "/api/keys", headers })).json().keys, []);
  const created = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: { name: "x".repeat(100) } });
  assert.equal(created.statusCode, 201, created.body);
  const keyId = created.json().key.id;
  for (const request of [
    { url: `/api/keys/${keyId}`, payload: { userId: "other" } },
    { url: `/api/keys/${keyId}?userId=other` },
  ]) {
    const response = await f.app.inject({ method: "DELETE", headers, ...request });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "Invalid request" });
  }
  assert.equal((await f.app.inject({ url: "/api/keys", headers })).json().keys[0].revokedAt, null);
});

test("key routes require eligible sessions and mutations require trusted Origin and session CSRF", async (t) => {
  const f = await fixture(t);
  const headers = await f.login();
  const second = await f.login();
  const created = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
  assert.equal(created.statusCode, 201);
  const { key, rawKey } = created.json();
  const requests = [
    { method: "GET" as const, url: "/api/keys" },
    { method: "POST" as const, url: "/api/keys", payload: {} },
    { method: "DELETE" as const, url: `/api/keys/${key.id}` },
  ];
  for (const authHeaders of [{ origin }, { origin, authorization: `Bearer ${rawKey}` }]) {
    for (const request of requests) {
      const response = await f.app.inject({ ...request, headers: authHeaders });
      assert.equal(response.statusCode, 401, response.body);
      assert.deepEqual(response.json(), { error: "Unauthorized" });
    }
  }
  for (const denied of [
    { cookie: headers.cookie, origin },
    { cookie: headers.cookie, "x-csrf-token": headers["x-csrf-token"] },
    { ...headers, origin: "http://localhost:3001" },
    { ...headers, "x-csrf-token": second["x-csrf-token"] },
    { ...headers, "x-csrf-token": "invalid" },
  ]) {
    for (const request of requests.filter((request) => request.method !== "GET")) {
      const response = await f.app.inject({ ...request, headers: denied });
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(response.json(), { error: "Forbidden" });
    }
  }
  assert.deepEqual((await f.app.inject({ url: "/api/keys", headers })).json().keys, [key]);
  for (const role of ["member", "admin"]) {
    await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { role, requiredPasswordChange: true } });
    for (const request of requests) {
      const response = await f.app.inject({ ...request, headers });
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(response.json(), { error: "Password change required" });
    }
  }
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { status: "disabled", requiredPasswordChange: false } });
  for (const request of requests) {
    assert.equal((await f.app.inject({ ...request, headers })).statusCode, 401);
  }
  await f.db.collection("users").deleteOne({ _id: f.userId });
  for (const request of requests) {
    assert.equal((await f.app.inject({ ...request, headers })).statusCode, 401);
  }
  assert.equal(await f.db.collection("api_keys").countDocuments(), 1);
  assert.equal((await f.db.collection("api_keys").findOne())?.revokedAt, null);
});

test("password replacement permits fresh key issuance and logout leaves keys intact", async (t) => {
  const f = await fixture(t);
  await f.db.collection("users").updateOne({ _id: f.userId }, { $set: { requiredPasswordChange: true } });
  const pending = await f.login();
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers: pending, payload: {} })).statusCode, 403);
  const newPassword = "a replaced key test password";
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/change-password", headers: pending,
    payload: { currentPassword: password, newPassword } })).statusCode, 204);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/keys", headers: pending, payload: {} })).statusCode, 401);
  const login = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password: newPassword } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": login.json().csrfToken };
  const created = await f.app.inject({ method: "POST", url: "/api/keys", headers, payload: {} });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().key.name, null);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, 204);
  assert.equal((await f.app.inject({ url: "/api/keys", headers })).statusCode, 401);
  const fresh = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin },
    payload: { email: "member@example.com", password: newPassword } });
  const listed = await f.app.inject({ url: "/api/keys", headers: { cookie: String(fresh.headers["set-cookie"]).split(";")[0] } });
  assert.deepEqual(listed.json().keys, [created.json().key]);
});
