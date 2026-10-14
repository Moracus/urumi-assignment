import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, argon2, timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import mongoose from "mongoose";

const baseUri = process.env.MONGODB_TEST_URI;
assert.ok(baseUri, "Run pnpm --filter @urumi/gateway test:integration with MONGODB_TEST_URI");

function databaseUri() {
  const uri = new URL(baseUri!);
  uri.pathname = `/urumi_test_${randomUUID().replaceAll("-", "")}`;
  return uri.toString();
}

async function runCli(uri: string, password: string, secret = "test-setup-secret", email = " Admin@Example.COM ") {
  const directory = await mkdtemp(join(tmpdir(), "urumi-setup-"));
  try {
    const passwordFile = join(directory, "password");
    const secretFile = join(directory, "secret");
    await writeFile(passwordFile, password, { mode: 0o600 });
    await writeFile(secretFile, secret, { mode: 0o600 });
    return await new Promise<{ code: number | null; output: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/identity/setup-cli.js", "--email", email,
        "--password-file", passwordFile, "--bootstrap-secret-file", secretFile], {
        env: { ...process.env, MONGODB_URI: uri, GATEWAY_BOOTSTRAP_KEY: "test-setup-secret" },
      });
      let output = "";
      let stdout = "";
      child.stdout.on("data", (data) => { output += data; stdout += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output, stdout }));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("CLI creates a real administrator with a final Argon2id password and initialized indexes", async (t) => {
  const uri = databaseUri();
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  const password = "a final password 🔐";
  const result = await runCli(uri, password);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes(password));
  assert.ok(!result.output.includes("test-setup-secret"));
  assert.ok(!result.output.includes("passwordHash"));
  const response = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(response).sort(), ["createdAt", "email", "id", "requiredPasswordChange", "role", "status", "updatedAt"]);
  const user = await db.collection("users").findOne({ email: "admin@example.com" });
  assert.ok(user);
  assert.equal(user.role, "admin");
  assert.equal(user.status, "active");
  assert.equal(user.requiredPasswordChange, false);
  assert.ok(user.createdAt instanceof Date);
  assert.ok(user.updatedAt instanceof Date);
  assert.match(String(user._id), /^[a-f0-9]{24}$/);
  assert.equal(response.id, String(user._id));
  const match = String(user.passwordHash).match(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$([^$]+)\$([^$]+)$/);
  assert.ok(match);
  const derived = await new Promise<Buffer>((resolve, reject) => argon2("argon2id", {
    message: password, nonce: Buffer.from(match[1], "base64"), memory: 65536, passes: 3, parallelism: 1, tagLength: 32,
  }, (error, value) => error ? reject(error) : resolve(value)));
  assert.ok(timingSafeEqual(derived, Buffer.from(match[2], "base64")));
  const indexes = await db.collection("users").indexes();
  assert.ok(indexes.some((index) => index.unique && index.key.email === 1));
  await assert.rejects(db.collection("users").insertOne({ ...user, _id: new mongoose.Types.ObjectId() }));
});

test("setup is consumed once across concurrent CLI processes, restart, and administrator deletion", async (t) => {
  const uri = databaseUri();
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  const results = await Promise.all([
    runCli(uri, "a final password", "test-setup-secret", "first@example.com"),
    runCli(uri, "a final password", "test-setup-secret", "second@example.com"),
  ]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(await db.collection("users").countDocuments(), 1);
  const state = await db.collection("initial_setup").findOne();
  assert.ok(state?.consumedAt instanceof Date);
  assert.equal((await runCli(uri, "another final password")).code, 1);
  await db.collection("users").deleteMany({});
  const afterDeletion = await runCli(uri, "another final password");
  assert.equal(afterDeletion.code, 1);
  assert.match(afterDeletion.output, /already consumed/);
  assert.equal(await db.collection("users").countDocuments(), 0);
  assert.deepEqual((await db.collection("initial_setup").findOne())?.consumedAt, state.consumedAt);
});

test("invalid setup credentials and password lengths leave enrollment available", async (t) => {
  const uri = databaseUri();
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  for (const [password, secret] of [["short", "test-setup-secret"], ["x".repeat(129), "test-setup-secret"],
    ["correct final password", "wrong-secret"]]) {
    const result = await runCli(uri, password, secret);
    assert.equal(result.code, 1);
    assert.ok(!result.output.includes(password));
    assert.ok(!result.output.includes(secret));
    assert.equal(await db.collection("users").countDocuments(), 0);
    assert.equal((await db.collection("initial_setup").findOne())?.consumedAt, null);
  }
  // All spaces and Unicode are valid; no composition rules, normalization, or truncation.
  assert.equal((await runCli(uri, " ".repeat(12))).code, 0);
});

test("a failed administrator transaction rolls back consumption and permits a corrected setup", async (t) => {
  const uri = databaseUri();
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000 }).asPromise();
  t.after(async () => { await db.dropDatabase(); await db.close(); });
  await db.collection("users").insertOne({ email: "admin@example.com", role: "member" });
  const failed = await runCli(uri, "a final password");
  assert.equal(failed.code, 1);
  assert.equal((await db.collection("initial_setup").findOne())?.consumedAt, null);
  assert.equal(await db.collection("users").countDocuments(), 1);
  await db.collection("users").deleteMany({});
  assert.equal((await runCli(uri, "🔐".repeat(128))).code, 0);
  const user = await db.collection("users").findOne();
  assert.ok(user);
  const match = String(user.passwordHash).split("$");
  const derive = (password: string) => new Promise<Buffer>((resolve, reject) => argon2("argon2id", {
    message: password, nonce: Buffer.from(match[4], "base64"), memory: 65536, passes: 3, parallelism: 1, tagLength: 32,
  }, (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(await derive("🔐".repeat(128)), Buffer.from(match[5], "base64"));
  assert.notDeepEqual(await derive("🔐".repeat(127) + "a"), Buffer.from(match[5], "base64"));
});
