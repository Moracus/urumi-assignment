import { test, expect, type Page } from '@playwright/test';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const origin = 'http://localhost:5174';
async function login(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('two users chat and connect MCP with distinct audit attribution, onboarding and immediate key revocation', async ({ page, playwright }) => {
  await page.goto('/login');
  await login(page, 'admin@example.com', 'browser administrator password');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  // User A acts through a dashboard session, before user B exists.
  const administrator = await (await page.request.get('/api/auth/me')).json();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('Acceptance: multiply 6 by 7 and get UTC time');
  const chatStarted = new Date().toISOString();
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByLabel('Final answer')).toHaveText('Acceptance: 42; 2026-10-16T00:00:00Z');
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  const sessionRows = await (await page.request.get(`/api/admin/audit?userId=${administrator.user.id}&from=${encodeURIComponent(chatStarted)}&limit=100`)).json();
  expect(sessionRows.records).toHaveLength(2);
  expect(sessionRows.records).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: administrator.user.id, toolName: 'calculator_calculate', authenticationOrigin: 'dashboard_session', keyId: null, outcome: 'success' }),
    expect.objectContaining({ userId: administrator.user.id, toolName: 'time_current', authenticationOrigin: 'dashboard_session', keyId: null, outcome: 'success' }),
  ]));
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  const email = `workflow-${Date.now()}@example.com`;
  await page.getByLabel('Member email').fill(email);
  await page.getByLabel('Assigned password').fill('assigned workflow password');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  await expect(page.getByRole('region', { name: 'User details' })).toContainText(email);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await login(page, email, 'assigned workflow password');
  await page.getByLabel('Current password').fill('assigned workflow password');
  await page.getByLabel('New password').fill('replacement workflow password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await login(page, email, 'replacement workflow password');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation')).toContainText(email);
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await page.getByLabel('Key name').fill('Workflow MCP client');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const input = page.getByLabel('New API key', { exact: true });
  await expect(input).toBeVisible();
  const rawKey = await input.inputValue();
  const { keys } = await (await page.request.get('/api/keys')).json();
  const keyId = keys.find((key: { name: string }) => key.name === 'Workflow MCP client').id;
  const client = new Client({ name: 'browser-workflow', version: '1' });
  const bearer = await playwright.request.newContext({ baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${rawKey}` } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'calculator_calculate', 'time_current', 'woocommerce_get_order', 'woocommerce_list_orders', 'woocommerce_list_products',
    ]);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content)
      .toEqual([{ type: 'text', text: '42' }]);
    expect((await client.callTool({ name: 'time_current', arguments: { timezone: 'UTC' } })).content)
      .toEqual([{ type: 'text', text: '2026-10-16T00:00:00Z' }]);
    for (const [name, args, expected] of [
      ['woocommerce_list_products', {}, { products: expect.any(Array), page: 1 }],
      ['woocommerce_list_orders', {}, { count: 4, page: 1, orders: expect.arrayContaining([expect.objectContaining({ number: 'at-midnight' })]) }],
      ['woocommerce_get_order', { order_id: 42 }, { id: 42, number: '42', payment_method: 'cod' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content;
      if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected commerce text result');
      expect(JSON.parse(content[0].text)).toMatchObject(expected);
    }
    for (const name of ['woocommerce_create_product', 'woocommerce_update_order_status']) {
      await expect(client.callTool({ name })).rejects.toBeInstanceOf(ProtocolError);
    }
    // Verify the operator command against controlled upstreams too. This is
    // harness evidence only; a live store requires operator-provided settings.
    const smoke = await promisify(execFile)(process.execPath, ['scripts/smoke-readonly.mjs'], {
      env: { ...process.env, URUMI_MCP_URL: `${origin}/mcp`, URUMI_API_KEY: rawKey, URUMI_ORDER_ID: '42' },
    });
    expect(smoke.stdout.trim().split('\n')).toEqual([
      'PASS calculator_calculate', 'PASS time_current', 'PASS woocommerce_list_products',
      'PASS woocommerce_list_orders', 'PASS woocommerce_get_order',
    ]);
    expect(smoke.stderr).not.toContain(rawKey);
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);
    expect((await page.request.get('/api/admin/servers')).status()).toBe(403);
    expect((await page.request.get('/api/admin/audit')).status()).toBe(403);
    const me = await (await page.request.get('/api/auth/me')).json();
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: origin },
      { Origin: origin, 'X-CSRF-Token': 'invalid' },
      { Origin: 'https://untrusted.example', 'X-CSRF-Token': me.csrfToken },
      { 'X-CSRF-Token': me.csrfToken },
    ];
    for (const headers of rejectedHeaders) {
      expect((await page.request.post('/api/keys', { headers, data: { name: 'Forbidden creation' } })).status()).toBe(403);
    }
    expect((await bearer.get('/api/keys')).status()).toBe(401);
    expect((await bearer.post('/api/keys', { headers: { Origin: origin }, data: {} })).status()).toBe(401);
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(rawKey);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 7, b: 8 } })).content)
      .toEqual([{ type: 'text', text: '56' }]);
    await login(page, email, 'replacement workflow password');
    await page.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(input).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke Workflow MCP client', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Workflow MCP client' })).toContainText('Revoked');
    await expect(client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).rejects.toMatchObject({
      data: expect.objectContaining({ status: 401 }),
    });
    await expect(client.listTools(undefined, { cacheMode: 'bypass' })).rejects.toMatchObject({
      data: expect.objectContaining({ status: 401 }),
    });
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    const member = await (await page.request.get('/api/auth/me')).json();
    expect(member.user.id).not.toBe(administrator.user.id);
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await login(page, 'admin@example.com', 'browser administrator password');
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    const history = await (await page.request.get(`/api/admin/audit?userId=${member.user.id}&limit=100`)).json();
    for (const name of ['calculator_calculate', 'time_current']) {
      expect(history.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: member.user.id, userEmail: email, toolName: name,
          authenticationOrigin: 'gateway_api_key', keyId, outcome: 'success' }),
      ]));
    }
    const rejected = await page.request.get('/api/admin/audit?outcome=unauthenticated&limit=100');
    expect((await rejected.json()).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'calculator_calculate', userId: null, keyId: null, authenticationOrigin: null }),
    ]));
    const serialized = JSON.stringify(history);
    for (const credential of [rawKey, 'synthetic-provider-secret', 'fixture-consumer', 'fixture-secret']) {
      expect(serialized).not.toContain(credential);
      expect(await page.content()).not.toContain(credential);
    }
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  } finally { await client.close(); await bearer.dispose(); }
});
