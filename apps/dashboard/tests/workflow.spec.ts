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

test('browser-created member replaces password, connects MCP, logs out independently and revokes the continuing client', async ({ page, playwright }) => {
  await page.goto('/login');
  await login(page, 'admin@example.com', 'browser administrator password');
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
  const client = new Client({ name: 'browser-workflow', version: '1' });
  const bearer = await playwright.request.newContext({ baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${rawKey}` } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'calculator.calculate', 'time.current', 'woocommerce.get_order', 'woocommerce.list_orders', 'woocommerce.list_products',
    ]);
    expect((await client.callTool({ name: 'calculator.calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content)
      .toEqual([{ type: 'text', text: '42' }]);
    expect((await client.callTool({ name: 'time.current', arguments: { timezone: 'UTC' } })).content)
      .toEqual([{ type: 'text', text: '2026-10-16T00:00:00Z' }]);
    for (const [name, args, expected] of [
      ['woocommerce.list_products', {}, { products: expect.any(Array), page: 1 }],
      ['woocommerce.list_orders', {}, { count: 4, page: 1, orders: expect.arrayContaining([expect.objectContaining({ number: 'at-midnight' })]) }],
      ['woocommerce.get_order', { order_id: 42 }, { id: 42, number: '42', payment_method: 'cod' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content;
      if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected commerce text result');
      expect(JSON.parse(content[0].text)).toMatchObject(expected);
    }
    for (const name of ['woocommerce.create_product', 'woocommerce.update_order_status']) {
      await expect(client.callTool({ name })).rejects.toBeInstanceOf(ProtocolError);
    }
    // Verify the operator command against controlled upstreams too. This is
    // harness evidence only; a live store requires operator-provided settings.
    const smoke = await promisify(execFile)(process.execPath, ['scripts/smoke-readonly.mjs'], {
      env: { ...process.env, URUMI_MCP_URL: `${origin}/mcp`, URUMI_API_KEY: rawKey, URUMI_ORDER_ID: '42' },
    });
    expect(smoke.stdout.trim().split('\n')).toEqual([
      'PASS calculator.calculate', 'PASS time.current', 'PASS woocommerce.list_products',
      'PASS woocommerce.list_orders', 'PASS woocommerce.get_order',
    ]);
    expect(smoke.stderr).not.toContain(rawKey);
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);
    expect((await page.request.get('/api/admin/servers')).status()).toBe(403);
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
    expect((await client.callTool({ name: 'calculator.calculate', arguments: { operation: 'multiply', a: 7, b: 8 } })).content)
      .toEqual([{ type: 'text', text: '56' }]);
    await login(page, email, 'replacement workflow password');
    await page.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(input).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke Workflow MCP client', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Workflow MCP client' })).toContainText('Revoked');
    await expect(client.listTools(undefined, { cacheMode: 'bypass' })).rejects.toMatchObject({
      data: expect.objectContaining({ status: 401 }),
    });
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  } finally { await client.close(); await bearer.dispose(); }
});
