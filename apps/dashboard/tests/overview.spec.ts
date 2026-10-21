import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@example.com', password = 'browser administrator password') {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}
async function openDashboard(page: Page) {
  await page.goto('/dashboard'); await login(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  return { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('administrator overview counts all user pages and registered servers but only available tools', async ({ page }) => {
  const headers = await openDashboard(page);
  let beforeUsers = 0;
  for (let number = 1; ; number++) {
    const { users } = await (await page.request.get(`/api/admin/users?page=${number}&limit=100`)).json();
    beforeUsers += users.length;
    if (users.length < 100) break;
  }
  for (let index = 0; index < 11; index++) {
    expect((await page.request.post('/api/admin/users', { headers, data: {
      email: `overview-${index}@example.com`, password: 'assigned overview member password',
    } })).status()).toBe(201);
  }
  const { servers } = await (await page.request.get('/api/admin/servers')).json();
  const beforeTools = servers.reduce((total: number, server: { toolCount: number }) => total + server.toolCount, 0);
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  for (const [id, path, enabled] of [
    ['overview_connected', '/mcp/overview_connected', true],
    ['overview_disabled', '/mcp/overview_disabled', false],
    ['overview_offline', '/offline/overview_offline', true],
  ] as const) {
    expect((await page.request.post('/api/admin/servers', { headers, data: {
      serverId: id, displayName: id, url: new URL(path, server.url).href,
      enabled, transport: 'streamable-http', authentication: { type: 'none' },
    } })).status()).toBe(201);
  }
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Administrator overview' });
  await expect(summary).toContainText(`Registered servers${servers.length + 3}`);
  await expect(summary).toContainText(`Available tools${beforeTools + 7}`);
  await expect(summary).toContainText(`Users${beforeUsers + 11}`);
  await expect(page.getByRole('link', { name: 'Manage servers', exact: true })).toHaveAttribute('href', '/admin/servers');
  await expect(page.getByRole('link', { name: 'Manage users', exact: true })).toHaveAttribute('href', '/admin/users');
});

async function createMemberAndSignIn(page: Page, email: string, headers: Record<string, string>) {
  const created = await page.request.post('/api/admin/users', { headers, data: { email, password: 'assigned overview password' } });
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  await login(page, email, 'assigned overview password');
  await page.getByLabel('Current password').fill('assigned overview password');
  await page.getByLabel('New password').fill('replacement overview password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await login(page, email, 'replacement overview password');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  return { userId: user.id, requests, headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken } };
}

test('member counts only their unrevoked keys across full pages and sees only public connection information', async ({ page }) => {
  const adminHeaders = await openDashboard(page);
  expect((await page.request.post('/api/keys', { headers: adminHeaders, data: { name: 'Other owner key' } })).status()).toBe(201);
  const { headers, requests } = await createMemberAndSignIn(page, 'overview-member@example.com', adminHeaders);
  const summary = page.getByRole('region', { name: 'Member overview' });
  await expect(summary).toContainText('Active API keys0');
  await expect(summary).toContainText('No active API keys.');
  const keyIds: string[] = [];
  const rawKeys: string[] = [];
  // Exactly two full pages require the API's empty third page to establish completeness.
  for (let index = 0; index < 20; index++) {
    const issued = await page.request.post('/api/keys', { headers, data: { name: `Overview client ${index}` } });
    expect(issued.status()).toBe(201);
    const { key, rawKey } = await issued.json(); keyIds.push(key.id); rawKeys.push(rawKey);
  }
  for (const id of [keyIds[0], keyIds[19]]) expect((await page.request.delete(`/api/keys/${id}`, { headers })).status()).toBe(204);
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await expect(summary).toContainText('Active API keys18');
  await expect(summary).toContainText('Public MCP URL: http://localhost:5174/mcp');
  await expect(summary.getByRole('link', { name: 'Manage API keys', exact: true })).toHaveAttribute('href', '/keys');
  expect(requests.some(url => new URL(url).pathname.startsWith('/api/admin/'))).toBe(false);
  expect((await page.request.get('/api/admin/servers')).status()).toBe(403);
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  const content = await page.content();
  for (const secret of rawKeys) expect(content).not.toContain(secret);
  for (const internal of ['urumi-calculator-mcp', 'browser-private-reference', 'Secret namespace', 'Other owner key']) expect(content).not.toContain(internal);
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
});

test('loading and later-page failures never show partial totals, and retry handles empty and malformed responses safely', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/users?**', async route => {
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    if (number === 1) return route.fulfill({ json: { page: 1, limit: 10,
      users: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1).padStart(24, '0') })) } });
    await gate; await route.fulfill({ status: 503, json: { error: 'mongodb://private:secret@internal' } });
  });
  await openDashboard(page);
  await expect(page.getByText('Loading summary…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh summary', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toHaveCount(0);
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toHaveCount(0);
  expect(await page.content()).not.toContain('private:secret');
  await page.unroute('**/api/admin/users?**');
  await page.getByRole('button', { name: 'Retry summary', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
  await page.route('**/api/admin/servers', route => route.fulfill({ json: { servers: [] } }));
  await page.route('**/api/admin/users?**', route => route.fulfill({ json: { users: [], page: 1, limit: 10 } }));
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await expect(page.getByText('No registered servers.', { exact: true })).toBeVisible();
  await expect(page.getByText('No available tools.', { exact: true })).toBeVisible();
  await expect(page.getByText('No users.', { exact: true })).toBeVisible();
  await page.unroute('**/api/admin/servers');
  await page.route('**/api/admin/servers', route => route.fulfill({ json: { servers: [{ serverId: 'unsafe', toolCount: -1 }] } }));
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await page.unroute('**/api/admin/servers'); await page.unroute('**/api/admin/users?**');
  await page.getByRole('button', { name: 'Retry summary', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
});

test('member summary failures do not misreport zero active keys, and malformed metadata requires a retry', async ({ page }) => {
  const headers = await openDashboard(page);
  await createMemberAndSignIn(page, 'overview-errors@example.com', headers);
  const summary = page.getByRole('region', { name: 'Member overview' });
  await expect(summary).toContainText('Active API keys0');
  await page.route('**/api/keys?**', route => route.fulfill({ status: 503, json: { error: 'private upstream Secret' } }));
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(summary).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  expect(await page.content()).not.toContain('private upstream Secret');
  await page.unroute('**/api/keys?**');
  await page.route('**/api/keys?**', route => route.fulfill({ json: { page: 1, limit: 10, keys: [{ id: '000000000000000000000001' }] } }));
  await page.getByRole('button', { name: 'Retry summary', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
  await expect(summary).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await page.unroute('**/api/keys?**');
  await page.getByRole('button', { name: 'Retry summary', exact: true }).click();
  await expect(summary).toContainText('No active API keys.');
});

test('logout and account replacement discard delayed summary pages, and expiry clears the new account summary', async ({ page }) => {
  const headers = await openDashboard(page);
  const email = 'overview-replacement@example.com';
  expect((await page.request.post('/api/admin/users', { headers, data: { email, password: 'assigned overview password' } })).status()).toBe(201);
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  let unexpectedPages = 0;
  await page.route('**/api/admin/users?**', async route => {
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    if (number === 2) { started(); await gate; }
    if (number > 2) unexpectedPages++;
    await route.fulfill({ json: { page: number, limit: 10,
      users: number > 2 ? [] : Array.from({ length: 10 }, (_, index) => ({ id: String(number * 10 + index).padStart(24, '0') })) } });
  });
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await received;
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  const delivered = page.waitForResponse(response => new URL(response.url()).searchParams.get('page') === '2');
  release(); await delivered;
  await login(page, email, 'assigned overview password');
  await page.getByLabel('Current password').fill('assigned overview password');
  await page.getByLabel('New password').fill('replacement overview password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await login(page, email, 'replacement overview password');
  const member = page.getByRole('region', { name: 'Member overview' });
  await expect(member).toContainText('Active API keys0');
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toHaveCount(0);
  expect(unexpectedPages).toBe(0);
  expect((await page.request.post('/api/__test/expire-session')).status()).toBe(204);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await expect(member).toHaveCount(0);
});

test('a backend role change replaces administrator totals with the member overview', async ({ page, playwright }) => {
  const headers = await openDashboard(page);
  const { userId } = await createMemberAndSignIn(page, 'overview-role@example.com', headers);
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:5174' });
  try {
    const loginResponse = await admin.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' },
      data: { email: 'admin@example.com', password: 'browser administrator password' } });
    expect(loginResponse.status()).toBe(200);
    const { csrfToken } = await loginResponse.json();
    const adminHeaders = { Origin: 'http://localhost:5174', 'X-CSRF-Token': csrfToken };
    expect((await admin.patch(`/api/admin/users/${userId}`, { headers: adminHeaders, data: { role: 'admin' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Member overview' })).toHaveCount(0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    await page.route('**/api/admin/servers', async route => {
      const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
    await started;
    expect((await admin.patch(`/api/admin/users/${userId}`, { headers: adminHeaders, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('region', { name: 'Member overview' })).toBeVisible();
    const delivered = page.waitForResponse(response => response.url().endsWith('/api/admin/servers'));
    release(); await delivered;
    await expect(page.getByRole('region', { name: 'Member overview' })).toContainText('Active API keys0');
    await expect(page.getByRole('region', { name: 'Administrator overview' })).toHaveCount(0);
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  } finally { await admin.dispose(); }
});
