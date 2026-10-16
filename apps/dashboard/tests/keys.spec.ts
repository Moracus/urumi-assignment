import { test, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport, SdkHttpError, ProtocolError } from '@modelcontextprotocol/client';

// Isolate test arrangements without disabling the real login throttle within a test.
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

async function openKeys(page: Page) {
  await page.goto('/keys');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal API keys' })).toBeVisible();
}

test('named creation is disclosed once; dismissal and reload retain only safe metadata', async ({ page }) => {
  await openKeys(page);
  await page.getByLabel('Key name').fill('Browser client');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const secret = page.getByLabel('New API key', { exact: true });
  await expect(secret).toHaveValue(/^ugw_[A-Za-z0-9_-]{43}$/);
  const rawKey = await secret.inputValue();
  await expect(page.getByText('Save this key now. It cannot be recovered after dismissal.')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss key' }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByRole('table')).toContainText('Browser client');
  await page.reload();
  await expect(page.getByRole('table')).toContainText('Browser client');
  expect(await page.content()).not.toContain(rawKey);
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
});

test('revocation cancellation, pending state and authoritative retained record', async ({ page }) => {
  await openKeys(page);
  await page.getByLabel('Key name').fill('Revoke client');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss key' }).click();
  await page.getByRole('button', { name: 'Revoke Revoke client', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke Revoke client', exact: true })).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/keys/*', async route => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Revoke Revoke client', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByRole('button', { name: 'Revoking…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  release();
  await expect(page.getByText('Key revoked.', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Revoke client' })).toContainText('Revoked');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});

test('metadata loading, safe error/retry, empty pages and pagination', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/keys?**', async route => {
    await gate;
    await route.fulfill({ status: 503, json: { error: 'private internal URL' } });
  });
  await openKeys(page);
  await expect(page.getByText('Loading keys…')).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/keys?**');
  const key = { id: '000000000000000000000001', name: 'Page one', prefix: 'ugw_prefix', createdAt: '2026-10-16T00:00:00Z', lastUsedAt: null, revokedAt: null };
  await page.route('**/api/keys?**', route => route.fulfill({ json: {
    keys: new URL(route.request().url()).searchParams.get('page') === '1'
      ? Array.from({ length: 10 }, (_, index) => ({ ...key, id: String(index + 1).padStart(24, '0') })) : [], page: 1, limit: 10,
  } }));
  await page.getByRole('button', { name: 'Retry keys' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(page.getByText('No keys on this page.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByRole('table')).toBeVisible();
});

test('clipboard feedback and raw-key cleanup on navigation, reload, expiry and account change', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openKeys(page);
  async function issue(name: string) {
    await page.getByLabel('Key name').fill(name);
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(page.getByLabel('New API key', { exact: true })).toBeVisible();
    return page.getByLabel('New API key', { exact: true }).inputValue();
  }
  const rawKey = await issue('Clipboard client');
  await page.getByRole('button', { name: 'Copy key' }).click();
  await expect(page.getByText('Key copied.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rawKey);
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
  await page.getByRole('button', { name: 'Copy key' }).click();
  await expect(page.getByText('Copy failed. Select and copy the key manually before dismissal.')).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Personal API keys' })).toBeVisible();
  expect(await page.content()).not.toContain(rawKey);
  const reloadKey = await issue('Reload client');
  await page.reload();
  await expect(page.getByLabel('Key name')).toBeVisible();
  expect(await page.content()).not.toContain(reloadKey);
  const expiredKey = await issue('Expired client');
  expect((await page.request.post('/api/__test/expire-session')).status()).toBe(204);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(expiredKey);
  // A different account in this tab cannot restore the previous account's creation view.
  const session = await (await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' }, data: { email: 'admin@example.com', password: 'browser administrator password' } })).json();
  const email = `cleanup-${Date.now()}@example.com`;
  await page.request.post('/api/admin/users', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': session.csrfToken }, data: { email, password: 'assigned member password' } });
  await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' }, data: { email, password: 'assigned member password' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
  expect(await page.content()).not.toContain(expiredKey);
});

test('member-issued key connects SDK, filters discovery, denies writes independently and revokes continuing access', async ({ page, playwright }) => {
  await page.goto('/');
  const admin = await (await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' }, data: { email: 'admin@example.com', password: 'browser administrator password' } })).json();
  const otherKey = await (await page.request.post('/api/keys', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': admin.csrfToken }, data: { name: 'Other owner' } })).json();
  const email = `mcp-${Date.now()}@example.com`;
  expect((await page.request.post('/api/admin/users', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': admin.csrfToken }, data: { email, password: 'assigned member password' } })).status()).toBe(201);
  const restricted = await (await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' }, data: { email, password: 'assigned member password' } })).json();
  expect((await page.request.post('/api/auth/change-password', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': restricted.csrfToken }, data: { currentPassword: 'assigned member password', newPassword: 'final member password' } })).status()).toBe(204);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('final member password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(page.getByText('No keys on this page.')).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  expect((await page.request.delete(`/api/keys/${otherKey.key.id}`, { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken } })).status()).toBe(404);
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  const management: { url: string; headers: Record<string, string>; body: string | null }[] = [];
  const logs: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) management.push({ url: request.url(), headers: request.headers(), body: request.postData() }); });
  page.on('console', entry => logs.push(entry.text()));
  await page.getByLabel('Key name').fill('Member MCP client');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const input = page.getByLabel('New API key', { exact: true });
  await expect(input).toBeVisible();
  const rawKey = await input.inputValue();
  await expect(page.getByText('Public MCP URL:')).toContainText('http://localhost:5174/mcp');
  await expect(page.locator('pre')).toContainText('<YOUR_GATEWAY_API_KEY>');
  const client = new Client({ name: 'urumi-client', version: '1.0.0' });
  // Same SDK and transport shown in the dashboard's connection example.
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual(['calculator.calculate', 'time.current', 'woocommerce.list_products']);
    expect((await client.callTool({ name: 'calculator.calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content).toEqual([{ type: 'text', text: '42' }]);
    expect((await client.callTool({ name: 'time.current', arguments: { timezone: 'UTC' } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'woocommerce.list_products' })).content).toEqual([{ type: 'text', text: 'Controlled product' }]);
    for (const name of ['woocommerce.create_product', 'woocommerce.update_order_status']) {
      await expect(client.callTool({ name })).rejects.toBeInstanceOf(ProtocolError);
    }
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Member MCP client' });
    await expect(row.locator('td').nth(4)).not.toHaveText('—');
    await page.getByRole('button', { name: 'Dismiss key' }).click();
    await page.getByRole('button', { name: 'Revoke Member MCP client' }).click();
    await page.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(row).toContainText('Revoked');
    try {
      await client.callTool({ name: 'calculator.calculate', arguments: { operation: 'multiply', a: 6, b: 7 } });
      throw new Error('Revoked request unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(SdkHttpError);
      if (error instanceof SdkHttpError) expect(error.data.status).toBe(401);
    }
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    expect(JSON.stringify(management)).not.toContain(rawKey);
    expect(management.every(request => request.headers.authorization === undefined)).toBe(true);
    expect(logs.join('\n')).not.toContain(rawKey);
    expect(page.url()).not.toContain(rawKey);
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
    // Bearer credentials alone never authenticate management routes.
    const bearer = await playwright.request.newContext({ baseURL: 'http://localhost:5174', extraHTTPHeaders: { Authorization: `Bearer ${otherKey.rawKey}` } });
    try { expect((await bearer.get('/api/keys')).status()).toBe(401); } finally { await bearer.dispose(); }
  } finally { await client.close(); }
});

test('pending creation cannot restore a raw key after logout', async ({ page }) => {
  await openKeys(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  let rawKey = '';
  await page.route('**/api/keys', async route => {
    const response = await route.fetch();
    rawKey = (await response.json()).rawKey;
    received(); await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel('Key name').fill('Delayed creation');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await started;
  await expect(page.getByRole('button', { name: 'Creating key…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/keys');
  release(); await completed;
  await expect(page.getByLabel('New API key', { exact: true })).toHaveCount(0);
  expect(await page.content()).not.toContain(rawKey);
});

test('account replacement while a key is displayed clears the creation view', async ({ page }) => {
  await openKeys(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const email = `switch-${Date.now()}@example.com`;
  expect((await page.request.post('/api/admin/users', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken }, data: { email, password: 'assigned member password' } })).status()).toBe(201);
  await page.getByLabel('Key name').fill('Switch account');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const secret = page.getByLabel('New API key', { exact: true });
  await expect(secret).toBeVisible();
  const rawKey = await secret.inputValue();
  expect((await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' }, data: { email, password: 'assigned member password' } })).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
  await expect(secret).toHaveCount(0);
  expect(await page.content()).not.toContain(rawKey);
});
