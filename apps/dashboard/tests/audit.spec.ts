import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@example.com', password = 'browser administrator password') {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('audit has loading, safe retry, empty and invalid response states', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/audit?**', async route => {
    await gate; await route.fulfill({ status: 503, json: { error: 'mongodb://private:secret@internal' } });
  });
  await login(page);
  await page.getByRole('link', { name: 'Tool history', exact: true }).click();
  await expect(page.getByText('Loading tool history…')).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/admin/audit?**');
  await page.route('**/api/admin/audit?**', route => route.fulfill({ json: { records: [], page: 1, limit: 10, hasMore: false } }));
  await page.getByRole('button', { name: 'Retry history' }).click();
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await page.unroute('**/api/admin/audit?**');
  await page.route('**/api/admin/audit?**', route => route.fulfill({ json: { records: [{ toolName: 'unsafe partial row' }], page: 1, limit: 10, hasMore: false } }));
  await page.getByRole('button', { name: 'Refresh history' }).click();
  await expect(page.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
});

test('administrator browses real MCP history pages and member access is denied', async ({ page }) => {
  await login(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const issued = await page.request.post('/api/keys', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken }, data: {} });
  const { rawKey } = await issued.json();
  // Real SDK clients reach the gateway while Playwright observes the public table.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'audit-browser', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    for (let index = 0; index < 11; index++) await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } });
  } finally { await client.close(); }
  await page.getByRole('link', { name: 'Tool history', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('admin@example.com');
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
  await expect(page.getByRole('columnheader')).toHaveText(['User', 'Server', 'Tool', 'Time', 'Duration', 'Outcome']);
  await expect(page.getByRole('row')).toHaveCount(11);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading tool history…')).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'calculator_calculate', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain(rawKey);
  const email = `audit-member-${Date.now()}@example.com`;
  const created = await page.request.post('/api/admin/users', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken },
    data: { email, password: 'audit assigned member password' },
  });
  expect(created.status()).toBe(201);
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('audit assigned member password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
  await page.getByLabel('Current password').fill('audit assigned member password');
  await page.getByLabel('New password').fill('audit replacement member password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await login(page, email, 'audit replacement member password');
  await expect(page.getByRole('link', { name: 'Tool history', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/admin/audit')).status()).toBe(403);
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('administrator sees unauthenticated MCP attempts with honest attribution', async ({ page }) => {
  const denied = await page.request.post('/mcp', { data: {
    jsonrpc: '2.0', id: 'browser-unverified', method: 'tools/call',
    params: { name: 'calculator_calculate', arguments: { a: 'private-browser-argument' } },
  } });
  expect(denied.status()).toBe(401);
  await login(page);
  await page.getByRole('link', { name: 'Tool history', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'unauthenticated', exact: true }) }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Unauthenticated');
  await expect(row).toContainText('Unresolved');
  expect(await page.locator('body').textContent()).not.toContain('private-browser-argument');
});
