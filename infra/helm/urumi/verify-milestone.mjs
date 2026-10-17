// Opt-in, mutating verification for a disposable release. See docs/planning/milestone-handoff.md.
// Credentials stay in memory; failures print only a fixed stage, never exceptions.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const require = createRequire(`${process.cwd()}/apps/dashboard/package.json`);
const { chromium, expect } = require('@playwright/test');
const { Client, StreamableHTTPClientTransport, ProtocolError } = require('@modelcontextprotocol/client');
let browser;
let dispatcher;
const clients = [];
let stage = 'configuration';
try {
  const origin = new URL(process.env.DASHBOARD_ORIGIN);
  const mcp = new URL(process.env.PUBLIC_MCP_URL);
  // Local ingress tunnels may use *.localhost names absent from host DNS.
  // Override only this MCP hostname; Undici retains Host, SNI and CA validation.
  if (process.env.VERIFICATION_MCP_ADDRESS) {
    const address = process.env.VERIFICATION_MCP_ADDRESS;
    assert.ok(isIP(address));
    const { Agent } = createRequire(`${process.cwd()}/apps/gateway/package.json`)('undici');
    dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
      if (hostname !== mcp.hostname) return callback(new Error('Unexpected MCP hostname'));
      const result = { address, family: isIP(address) };
      callback(null, options.all ? [result] : address, result.family);
    } } });
  }
  const namespace = process.env.VERIFICATION_NAMESPACE;
  const kubeContext = process.env.VERIFICATION_CONTEXT;
  assert.ok(namespace && kubeContext && process.env.VERIFICATION_DISPOSABLE === 'true');
  const calculator = process.env.VERIFICATION_CALCULATOR_URL;
  const time = process.env.VERIFICATION_TIME_URL;
  assert.ok(calculator && time);
  const password = (await readFile(process.env.DASHBOARD_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
  const kubectl = async args => (await promisify(execFile)('kubectl',
    ['--context', kubeContext, '-n', namespace, ...args], { timeout: 330000, maxBuffer: 1024 * 1024 })).stdout;
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.VERIFICATION_ALLOW_SELF_SIGNED === 'true' });
  const page = await context.newPage();
  const click = name => page.getByRole('button', { name, exact: true }).click();
  const navigate = async path => page.goto(new URL(path, origin).href);
  const login = async (email, secret) => {
    await navigate('/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(secret);
    await click('Log in');
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  };
  const api = async (path, method = 'GET', data) => {
    const me = await (await page.request.get(new URL('/api/auth/me', origin).href)).json();
    return page.request.fetch(new URL(path, origin).href, { method, data,
      headers: { Origin: origin.origin, 'X-CSRF-Token': me.csrfToken } });
  };
  const issue = async name => {
    stage = 'browser key issuance';
    await navigate('/keys');
    await page.getByLabel('Key name').fill(name);
    await click('Create key');
    const input = page.getByLabel('New API key', { exact: true });
    await expect(input).toBeVisible();
    const rawKey = await input.inputValue();
    const client = new Client({ name: 'deployed-milestone', version: '1' });
    clients.push(client);
    stage = 'public MCP connection';
    await client.connect(new StreamableHTTPClientTransport(mcp, {
      fetch: (input, init) => fetch(input, { ...init, ...(dispatcher ? { dispatcher } : {}) }),
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    return client;
  };
  const catalog = async client => (await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name);
  const calculate = async client => {
    const result = await client.callTool({ name: 'calculator.calculate',
      arguments: { operation: 'multiply', a: 6, b: 7 } });
    assert.ok(!result.isError && result.content?.[0]?.type === 'text');
    assert.deepEqual(JSON.parse(result.content[0].text), { operation: 'multiply', a: 6, b: 7, result: 42 });
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `milestone-${suffix}@example.com`;
  const assigned = randomUUID();
  const replacement = randomUUID();
  stage = 'administrator login and onboarding';
  await login(process.env.DASHBOARD_EMAIL, password);
  const cookie = (await context.cookies()).find(value => value.name === 'urumi_dashboard');
  assert.ok(cookie?.httpOnly && cookie.path === '/api' && cookie.sameSite === 'Lax');
  assert.equal(cookie.secure, origin.protocol === 'https:');
  await navigate('/admin/users');
  await page.getByLabel('Member email').fill(email);
  await page.getByLabel('Assigned password').fill(assigned);
  await click('Create member');
  await expect(page.getByRole('region', { name: 'User details' })).toContainText(email);
  await click('Log out');
  await login(email, assigned);
  await page.getByLabel('Current password').fill(assigned);
  await page.getByLabel('New password').fill(replacement);
  await click('Replace password');
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  assert.equal((await page.request.get(new URL('/api/auth/me', origin).href)).status(), 401);
  await login(email, replacement);
  stage = 'member MCP discovery, read-only calls and revocation';
  const member = await issue(`Milestone ${suffix}`);
  stage = 'member fresh discovery';
  assert.ok((await catalog(member)).includes('calculator.calculate'));
  assert.ok(!(await catalog(member)).includes('woocommerce.create_product'));
  stage = 'member calculator call';
  await calculate(member);
  stage = 'member time call';
  assert.ok(!(await member.callTool({ name: 'time.current', arguments: { timezone: 'UTC' } })).isError);
  stage = 'member direct write rejection';
  await assert.rejects(member.callTool({ name: 'woocommerce.create_product' }), ProtocolError);
  stage = 'member role and CSRF denial';
  assert.equal((await api('/api/admin/users')).status(), 403);
  assert.equal((await page.request.post(new URL('/api/keys', origin).href,
    { headers: { Origin: origin.origin }, data: {} })).status(), 403);
  await click('Log out');
  stage = 'MCP after dashboard logout';
  await calculate(member);
  await login(email, replacement);
  await navigate('/keys');
  await click(`Revoke Milestone ${suffix}`);
  await click('Confirm revoke');
  stage = 'continuing MCP client revocation';
  await expect(page.getByRole('row').filter({ hasText: `Milestone ${suffix}` })).toContainText('Revoked');
  await assert.rejects(member.listTools(undefined, { cacheMode: 'bypass' }), error => error.data?.status === 401);
  console.log('PASS deployed onboarding, Secure/HTTP-only session, CSRF, member authorization, MCP calls, logout/key separation and next-request revocation');
  await click('Log out');
  await login(process.env.DASHBOARD_EMAIL, password);
  const admin = await issue(`Milestone admin ${suffix}`);
  const details = page.getByRole('region', { name: 'Server details' });
  const serverId = `milestone-${suffix}`;
  stage = 'deployed application destination denials';
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://urumi-mongodb:27017/mcp', 'https://unapproved.invalid/mcp']) {
    assert.equal((await api('/api/admin/servers', 'POST', { serverId: `${serverId}-denied`,
      displayName: 'Rejected destination', url, transport: 'streamable-http',
      enabled: true, authentication: { type: 'none' } })).status(), 400);
    assert.equal((await api(`/api/admin/servers/${serverId}-denied`)).status(), 404);
  }
  console.log('PASS deployed destination policy rejects metadata, database and unapproved origins before persistence');
  stage = 'dashboard upstream lifecycle';
  await navigate('/admin/servers');
  await click('Register server');
  await page.getByLabel('Server identifier', { exact: true }).fill(serverId);
  await page.getByLabel('Display name', { exact: true }).fill('Milestone verification');
  await page.getByLabel('Endpoint', { exact: true }).fill(calculator);
  await click('Save server');
  await expect(details).toContainText('Runtime statusconnected');
  assert.ok((await catalog(admin)).includes(`${serverId}.calculate`));
  const definitions = (await admin.listTools(undefined, { cacheMode: 'bypass' })).tools;
  assert.deepEqual(definitions.find(tool => tool.name === `${serverId}.calculate`)?.inputSchema,
    definitions.find(tool => tool.name === 'calculator.calculate')?.inputSchema);
  await click('Disable server');
  await click('Confirm disable');
  await expect(details).toContainText('Runtime statusdisabled');
  assert.ok(!(await catalog(admin)).includes(`${serverId}.calculate`));
  await assert.rejects(admin.callTool({ name: `${serverId}.calculate`, arguments: { operation: 'multiply', a: 1, b: 2 } }), ProtocolError);
  await click('Enable server');
  await expect(details).toContainText('Runtime statusconnected');
  await click('Edit server');
  await page.getByLabel('Endpoint', { exact: true }).fill(new URL('/offline', calculator).href);
  await click('Save server');
  await expect(details).toContainText('Runtime statusunreachable');
  assert.ok(!(await catalog(admin)).includes(`${serverId}.calculate`));
  await calculate(admin);
  await click('Edit server');
  await page.getByLabel('Endpoint', { exact: true }).fill(time);
  await click('Save server');
  await expect(details).toContainText('Runtime statusconnected');
  assert.ok((await catalog(admin)).includes(`${serverId}.current`));
  assert.ok(!(await catalog(admin)).includes(`${serverId}.calculate`));
  await assert.rejects(admin.callTool({ name: `${serverId}.calculate` }), ProtocolError);
  assert.ok(!(await admin.callTool({ name: `${serverId}.current`, arguments: { timezone: 'UTC' } })).isError);
  await click('Refresh discovery');
  await expect(details).toContainText('Runtime statusconnected');
  await click('Remove server');
  await click('Confirm remove');
  await expect(details).toHaveCount(0);
  assert.ok(!(await catalog(admin)).includes(`${serverId}.current`));
  await assert.rejects(admin.callTool({ name: `${serverId}.current` }), ProtocolError);
  // Leave a second registration disabled to distinguish desired state from runtime observations.
  const retainedId = `${serverId}-retained`;
  assert.equal((await api('/api/admin/servers', 'POST', { serverId: retainedId,
    displayName: 'Retained verification', url: calculator, transport: 'streamable-http',
    enabled: false, authentication: { type: 'none' } })).status(), 201);
  // Optional default deletion proves the completed migration never reseeds it.
  const removedDefault = process.env.VERIFICATION_REMOVE_SERVER;
  if (removedDefault) assert.ok([204, 404].includes((await api(`/api/admin/servers/${removedDefault}`, 'DELETE')).status()));
  console.log('PASS deployed add, edit, disable, enable, discovery failure, healthy isolation, recovery and removal');
  const verifyPersistence = async () => {
    stage = 'restored administrator browser session';
    // Deployment readiness precedes ingress endpoint convergence after Recreate.
    // Retry only this read with the original cookie; never log in or replay a mutation.
    await expect.poll(async () => {
      try { return (await page.request.get(new URL('/api/auth/me', origin).href)).status(); }
      catch { return 0; }
    }, { timeout: 30000, intervals: [250, 500, 1000] }).toBe(200);
    await page.reload();
    await expect(page.getByRole('navigation')).toContainText(process.env.DASHBOARD_EMAIL);
    stage = 'restored registration deletions';
    assert.equal((await api(`/api/admin/servers/${serverId}`)).status(), 404);
    if (removedDefault) assert.equal((await api(`/api/admin/servers/${removedDefault}`)).status(), 404);
    stage = 'restored disabled registration';
    const retained = await (await api(`/api/admin/servers/${retainedId}`)).json();
    assert.equal(retained.server.enabled, false);
    assert.equal(retained.server.status, 'disabled');
    stage = 'restored active MCP key';
    await calculate(admin);
    stage = 'restored revoked MCP key';
    await assert.rejects(member.listTools(undefined, { cacheMode: 'bypass' }), error => error.data?.status === 401);
    stage = 'restored member metadata';
    const users = await (await api('/api/admin/users?limit=100')).json();
    assert.ok(users.users.some(user => user.email === email && !user.requiredPasswordChange));
  };
  stage = 'gateway restart persistence';
  await kubectl(['rollout', 'restart', 'deployment/urumi-gateway']);
  await kubectl(['rollout', 'status', 'deployment/urumi-gateway', '--timeout=300s']);
  await verifyPersistence();
  console.log('PASS gateway restart retains users, sessions, active/revoked keys, registrations, disabled intent and deletions');
  stage = 'MongoDB restart persistence';
  const pvcBefore = await kubectl(['get', 'pvc', 'data-urumi-mongodb-0', '-o', 'jsonpath={.metadata.uid}']);
  const persistenceScript = await readFile('infra/mongodb/verify-persistence.js', 'utf8');
  const mongoProbe = async phase => {
    const child = execFile('kubectl', ['--context', kubeContext, '-n', namespace, 'exec', '-i',
      'urumi-mongodb-0', '--', 'env', `URUMI_VERIFY_PHASE=${phase}`, 'mongosh', '--quiet', '--file', '/dev/stdin'],
    { timeout: 30000 }, () => {});
    const completion = new Promise((resolve, reject) => { child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('MongoDB probe failed'))); });
    child.stdin.end(persistenceScript);
    await completion;
  };
  await mongoProbe('seed');
  await kubectl(['rollout', 'restart', 'statefulset/urumi-mongodb']);
  await kubectl(['rollout', 'status', 'statefulset/urumi-mongodb', '--timeout=300s']);
  await mongoProbe('restore');
  assert.equal(await kubectl(['get', 'pvc', 'data-urumi-mongodb-0', '-o', 'jsonpath={.metadata.uid}']), pvcBefore);
  await verifyPersistence();
  assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
  console.log('PASS MongoDB restart retains PVC, transactional data and application state');
  stage = 'verification cleanup';
  assert.equal((await api(`/api/admin/servers/${retainedId}`, 'DELETE')).status(), 204);
  const userList = await (await api('/api/admin/users?limit=100')).json();
  const memberUser = userList.users.find(user => user.email === email);
  assert.ok(memberUser);
  assert.equal((await api(`/api/admin/users/${memberUser.id}`, 'PATCH', { status: 'disabled' })).status(), 200);
  const keys = await (await api('/api/keys?limit=100')).json();
  const adminKey = keys.keys.find(key => key.name === `Milestone admin ${suffix}`);
  assert.ok(adminKey);
  assert.equal((await api(`/api/keys/${adminKey.id}`, 'DELETE')).status(), 204);
  await click('Log out');
  console.log('PASS verification keys revoked, member disabled and temporary registration removed');
} catch {
  console.error(`Milestone verification FAILED at ${stage}; inspect the disposable release before retrying`);
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await browser?.close();
  await dispatcher?.close();
}
