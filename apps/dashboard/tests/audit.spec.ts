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
  const history = await (await page.request.get('/api/admin/audit?toolName=calculator_calculate')).json();
  const attempt = history.records[0];
  await page.getByLabel('Registration ID', { exact: true }).fill(attempt.upstreamId);
  await page.getByLabel('User ID', { exact: true }).fill(attempt.userId);
  await page.getByLabel('Exact public tool', { exact: true }).fill('calculator_calculate');
  await page.getByLabel('Outcome', { exact: true }).selectOption('success');
  await page.getByLabel('From (inclusive)', { exact: true }).fill('2000-01-01T05:30:00+05:30');
  await page.getByLabel('To (exclusive)', { exact: true }).fill('2100-01-01T00:00:00Z');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(/from=2000-01-01T00%3A00%3A00.000Z/);
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(11);
  const link = page.url();
  await page.goto(link);
  await expect(page.getByLabel('Registration ID', { exact: true })).toHaveValue(attempt.upstreamId);
  const details = page.getByText('Attempt details', { exact: true }).first();
  await details.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('table')).toContainText(attempt.attemptId);
  await expect(page.getByRole('table')).toContainText(attempt.requestId);
  await expect(page.getByRole('table')).toContainText(attempt.keyId);
  await expect(page.getByRole('table')).toContainText('gateway_api_key');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByLabel('Exact public tool', { exact: true }).fill('unknown_tool');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
  await page.goBack();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
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

test('history rejects invalid deep links without issuing protected reads', async ({ page }) => {
  await login(page);
  let reads = 0;
  await page.route('**/api/admin/audit?**', route => { reads++; return route.continue(); });
  for (const query of ['unknown=x', 'outcome=success&outcome=success', 'upstreamId=null', 'page=01',
    'from=2026-02-30T00:00:00Z', 'from=2026-10-17T00:00:00',
    'from=2026-10-18T00:00:00Z&to=2026-10-17T00:00:00Z', 'toolName=%ZZ']) {
    await page.goto(`/admin/audit?${query}`);
    await expect(page.getByRole('alert')).toContainText('Invalid history filters');
    await expect(page.getByRole('table')).toHaveCount(0);
  }
  expect(reads).toBe(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => reads).toBe(1);
});

test('stale history is retained only while authorized and delayed reads cannot restore it', async ({ page, playwright }) => {
  await page.request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calculator_calculate' } } });
  await login(page);
  await page.goto('/admin/audit?outcome=unauthenticated');
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
  await page.route('**/api/admin/audit?**', route => route.fulfill({ status: 503, json: { error: 'private diagnostic' } }));
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
  await page.unroute('**/api/admin/audit?**');
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  const email = `history-admin-${Date.now()}@example.com`;
  const created = await page.request.post('/api/admin/users', { headers, data: { email, password: 'assigned history password' } });
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  expect((await page.request.patch(`/api/admin/users/${user.id}`, { headers, data: { role: 'admin' } })).status()).toBe(200);
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:5174' });
  let release = () => {};
  let otherHeaders: Record<string, string> = {};
  try {
    const login = await other.post('/api/auth/login', { headers: { Origin: headers.Origin }, data: { email, password: 'assigned history password' } });
    const assigned = await login.json();
    expect((await other.post('/api/auth/change-password', { headers: { Origin: headers.Origin, 'X-CSRF-Token': assigned.csrfToken },
      data: { currentPassword: 'assigned history password', newPassword: 'replacement history password' } })).status()).toBe(204);
    const signed = await other.post('/api/auth/login', { headers: { Origin: headers.Origin }, data: { email, password: 'replacement history password' } });
    otherHeaders = { Origin: headers.Origin, 'X-CSRF-Token': (await signed.json()).csrfToken };
    let started!: () => void;
    const received = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/admin/audit?**', async route => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Retry history', exact: true }).click();
    await received;
    expect((await other.patch(`/api/admin/users/${me.user.id}`, { headers: otherHeaders, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
    const delivered = page.waitForResponse(response => response.url().includes('/api/admin/audit?'));
    release(); await delivered;
    await expect(page.getByRole('table')).toHaveCount(0);
    expect((await page.request.get('/api/admin/audit')).status()).toBe(403);
  } finally {
    release();
    expect((await other.patch(`/api/admin/users/${me.user.id}`, { headers: otherHeaders, data: { role: 'admin' } })).status()).toBe(200);
    expect((await other.patch(`/api/admin/users/${user.id}`, { headers: otherHeaders, data: { role: 'member' } })).status()).toBe(200);
    await other.dispose();
  }
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await page.unroute('**/api/admin/audit?**');
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve; });
  await page.route('**/api/admin/audit?**', async route => {
    const response = await route.fetch(); await logoutGate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  const delivered = page.waitForResponse(response => response.url().includes('/api/admin/audit?'));
  releaseLogout(); await delivered;
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('history filters and native details fit mobile, tablet and desktop with keyboard access', async ({ page }, testInfo) => {
  await page.request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calculator_calculate' } } });
  await login(page);
  await page.goto('/admin/audit?outcome=unauthenticated');
  const details = page.getByText('Attempt details', { exact: true }).first();
  await details.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('table')).toContainText('Not recorded');
  await expect(page.getByRole('table')).toContainText('No specific credential failure cause was stored.');
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(page.getByLabel('Registration ID', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`history-${width}.png`), fullPage: true });
  }
});

test('Back restores a result even when unchanged filters create identical URLs', async ({ page }) => {
  await login(page);
  await page.route('**/api/admin/audit?**', route => route.fulfill({ json: { records: [], page: 1, limit: 10, hasMore: false } }));
  await page.goto('/admin/audit');
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
  await page.goBack();
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
});
