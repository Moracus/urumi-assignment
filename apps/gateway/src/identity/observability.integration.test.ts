import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createGatewayApp } from "../app.js";
import { hashPassword } from "./passwords.js";

test("observability aggregates complete windows with lifecycle attribution and strict administrator access", async t => {
  const uri = new URL(process.env.MONGODB_TEST_URI!);
  uri.pathname = `/urumi_observability_${randomUUID().replaceAll("-", "")}`;
  process.env.DASHBOARD_ALLOW_HTTP = "true";
  process.env.DASHBOARD_TRUSTED_ORIGINS = "http://localhost:3000";
  const db = await mongoose.createConnection(uri.toString()).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  const app = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [] });
  t.after(() => app.close());
  async function login(role: string, restricted = false) {
    const email = `${role}-${restricted}@example.com`;
    await db.collection("users").insertOne({ email, role, status: "active", requiredPasswordChange: restricted,
      passwordHash: await hashPassword("observability password"), createdAt: new Date(), updatedAt: new Date() });
    const result = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://localhost:3000" },
      payload: { email, password: "observability password" } });
    assert.equal(result.statusCode, 200);
    return String(result.headers["set-cookie"]).split(";")[0];
  }
  const cookie = await login("admin");
  const url = "/api/admin/observability?from=2026-10-20T05:30:00%2B05:30&to=2026-10-21T00:00:00Z";
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { authorization: "Bearer fake" } })).statusCode, 401);
  for (const denied of [await login("member"), await login("admin", true)]) {
    assert.equal((await app.inject({ url, headers: { cookie: denied } })).statusCode, 403);
  }
  const upstreamId = new mongoose.Types.ObjectId().toHexString();
  const outcomes = [...Array(101).fill("success"), "tool_error", "upstream_error", "upstream_unavailable", "upstream_timeout", "rejected", "unauthorized", "not_found"];
  const rows = outcomes.map((outcome, i) => ({ attemptId: randomUUID(), requestId: randomUUID(), upstreamId,
    upstreamName: "same_name", upstreamDisplayName: "Historical name", outcome, timestamp: "2026-10-20T00:00:00.000Z",
    authenticationOrigin: i % 2 ? "dashboard_session" : "gateway_api_key", toolName: "same_name_tool", durationMs: 1 }));
  await db.collection("tool_audit").insertMany([...rows,
    { ...rows[0], attemptId: randomUUID(), upstreamId: null, upstreamName: "same_name", outcome: "success" },
    { ...rows[0], attemptId: randomUUID(), upstreamId: null, upstreamName: null, upstreamDisplayName: null, outcome: "unauthenticated" },
    { ...rows[0], attemptId: randomUUID(), timestamp: "2026-10-21T00:00:00.000Z" }]);
  const now = new Date();
  const replacement = await db.collection("upstream_registrations").insertOne({ serverId: "same_name", displayName: "Replacement",
    url: "http://unused.invalid/mcp", enabled: false, configurationRevision: 1, createdAt: now, updatedAt: now });
  const response = await app.inject({ url, headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const data = response.json();
  assert.equal(data.from, "2026-10-20T00:00:00.000Z");
  const old = data.rows.find((row: { upstreamId: string }) => row.upstreamId === upstreamId);
  assert.equal(old.attempts, 105); assert.equal(old.failures, 4); assert.equal(old.errorRate, 4 / 105);
  assert.equal(old.current, null); assert.equal(old.outcomes.rejected, 1);
  assert.deepEqual(old.historicalNames, [{ name: "same_name", displayName: "Historical name" }]);
  const current = data.rows.find((row: { upstreamId: string }) => row.upstreamId === replacement.insertedId.toHexString());
  assert.equal(current.attempts, 0); assert.equal(current.errorRate, null); assert.equal(current.current.status, "disabled");
  assert.equal(data.rows.find((row: { kind: string }) => row.kind === "legacy").attempts, 0);
  assert.equal(data.rows.find((row: { kind: string }) => row.kind === "unattributed").outcomes.unauthenticated, 1);
  for (const query of ["preset=no", "preset=hour&preset=day", "limit=2", "upstreamId=null", "from=2026-10-01T00:00:00Z", "from=2026-10-21T00:00:00Z&to=2026-10-20T00:00:00Z"]) {
    assert.equal((await app.inject({ url: `/api/admin/observability?${query}`, headers: { cookie } })).statusCode, 400, query);
  }
  const filtered = (await app.inject({ url: `${url}&upstreamId=${upstreamId}`, headers: { cookie } })).json();
  assert.equal(filtered.rows.length, 1); assert.equal(filtered.rows[0].attempts, 105);
  const empty = (await app.inject({ url: "/api/admin/observability?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z", headers: { cookie } })).json();
  assert.equal(empty.rows.length, 1); assert.equal(empty.rows[0].attempts, 0);
});

test("current health requires the same durable instance and revision; query caps fail safely", async t => {
  const { createServer } = await import("node:http");
  const upstream = createServer((_request, response) => { response.writeHead(503); response.end(); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const uri = new URL(process.env.MONGODB_TEST_URI!);
  uri.pathname = `/urumi_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const db = await mongoose.createConnection(uri.toString()).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  const app = await createGatewayApp({ mongodbUri: uri.toString(),
    destinations: { allowLoopback: true, rules: [{ origin, cidrs: ["127.0.0.1/32"] }] },
    upstreams: [{ name: "calculator", url: `${origin}/mcp`, enabled: true }],
  });
  t.after(() => app.close());
  await db.collection("users").insertOne({ email: "lifecycle@example.com", role: "admin", status: "active", requiredPasswordChange: false,
    passwordHash: await hashPassword("lifecycle administrator password"), createdAt: new Date(), updatedAt: new Date() });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://localhost:3000" },
    payload: { email: "lifecycle@example.com", password: "lifecycle administrator password" } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0] };
  const read = () => app.inject({ url: "/api/admin/observability", headers });
  const first = (await read()).json().rows[0];
  assert.equal(first.current.status, "unreachable");
  const registration = await db.collection("upstream_registrations").findOne({ serverId: "calculator" });
  assert.ok(registration);
  await db.collection("upstream_registrations").updateOne({ _id: registration._id }, { $inc: { configurationRevision: 1 } });
  assert.equal((await read()).json().rows[0].current.status, "disconnected");
  await db.collection("upstream_registrations").deleteOne({ _id: registration._id });
  const { _id, ...replacement } = registration;
  await db.collection("upstream_registrations").insertOne(replacement);
  const recreated = (await read()).json().rows[0];
  assert.notEqual(recreated.upstreamId, first.upstreamId);
  assert.equal(recreated.current.status, "disconnected");
  await db.collection("upstream_registrations").insertMany(Array.from({ length: 500 }, (_, i) => ({ ...replacement,
    _id: new mongoose.Types.ObjectId(), serverId: `extra_${i}`, url: `${origin}/extra/${i}` })));
  const capped = await read();
  assert.equal(capped.statusCode, 503);
  assert.equal(capped.headers["cache-control"], "no-store");
  assert.ok(!capped.body.includes(origin));
  const indexes = await db.collection("tool_audit").indexes();
  assert.ok(indexes.some(index => index.key.upstreamId === 1 && index.key.timestamp === -1));
});
