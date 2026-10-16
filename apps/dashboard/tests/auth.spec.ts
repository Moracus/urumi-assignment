import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@example.com', password = 'browser administrator password') {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}

test('login validation, safe failure, session restoration and server logout', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText('Email and password are required.')).toBeVisible();
  await login(page, 'admin@example.com', 'incorrect browser password');
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
  await login(page);
  await expect(page.getByRole('navigation')).toContainText('admin@example.com');
  await expect(page.getByRole('navigation')).toContainText('admin');
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === 'urumi_dashboard');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.path).toBe('/api');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Logged out.')).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
});

async function createMember(page: Page) {
  const admin = await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' },
    data: { email: 'admin@example.com', password: 'browser administrator password' } });
  expect(admin.status()).toBe(200);
  const email = `member-${Date.now()}@example.com`;
  const created = await page.request.post('/api/admin/users', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': (await admin.json()).csrfToken },
    data: { email, password: 'assigned member password' },
  });
  expect(created.status()).toBe(201);
  await page.context().clearCookies();
  return { email, userId: (await created.json()).user.id };
}

test('restricted member replaces password, logs in afresh, and cannot access administrator pages', async ({ page }) => {
  const { email } = await createMember(page);
  await page.goto('/admin/users');
  await login(page, email, 'assigned member password');
  await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/keys')).status()).toBe(403);
  await page.goto('/admin/servers');
  await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
  await page.getByLabel('Current password').fill('assigned member password');
  await page.getByLabel('New password').fill('final member password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByText('Password replaced. Log in with your new password.')).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await login(page, email, 'final member password');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  expect((await page.request.get('/api/admin/servers')).status()).toBe(403);
});

test('invalid CSRF refreshes authoritative state and requires deliberate logout resubmission', async ({ page }) => {
  await page.route('**/api/auth/login', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), csrfToken: '0'.repeat(64) } });
  });
  await page.goto('/login');
  await login(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  let attempts = 0;
  page.on('request', request => { if (request.url().endsWith('/api/auth/logout')) attempts++; });
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('status')).toContainText('submit again deliberately');
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  expect(attempts).toBe(1);
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Logged out.')).toBeVisible();
  expect(attempts).toBe(2);
});

test('logout failure is accurate; successful logout preserves gateway key authentication', async ({ page }) => {
  await page.goto('/'); await login(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  const issued = await page.request.post('/api/keys', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken }, data: { name: 'logout browser test' } });
  expect(issued.status()).toBe(201);
  const { rawKey } = await issued.json();
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, json: { error: 'unsafe internal detail' } }));
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('alert')).toContainText('Logout was not confirmed.');
  await expect(page.getByRole('alert')).not.toContainText('unsafe internal detail');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  await page.unroute('**/api/auth/logout');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Logged out.')).toBeVisible();
  const mcp = await page.request.post('/mcp', { headers: { Authorization: `Bearer ${rawKey}`, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'browser-test', version: '1' } } } });
  expect(mcp.status()).toBe(200);
});

test('server-invalidated session clears account display and a stale response cannot restore it', async ({ page }) => {
  await page.goto('/'); await login(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/keys', async route => {
    const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
  });
  const pending = page.evaluate(async () => {
    const path = '/src/api.ts'; const { api } = await import(path);
    try { await api.request('/api/keys'); return 'accepted'; } catch { return 'discarded'; }
  });
  await started;
  const session = await (await page.request.get('/api/auth/me')).json();
  expect((await page.request.post('/api/auth/logout', { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': session.csrfToken } })).status()).toBe(204);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  release(); expect(await pending).toBe('discarded');
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
});

test('login pending state blocks duplicates and never sends management bearer credentials', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/login', async route => { await gate; await route.continue(); });
  const credentials: (string | undefined)[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) credentials.push(request.headers().authorization);
  });
  await page.goto('/');
  await login(page);
  await expect(page.getByRole('button', { name: 'Logging in…' })).toBeDisabled();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  release();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  expect(credentials.every(value => value === undefined)).toBe(true);
  expect((await page.request.post('/api/auth/logout', { headers: { Origin: 'https://untrusted.example' } })).status()).toBe(403);
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});

test('account role changes and disabling are authoritative at revalidation', async ({ page, playwright }) => {
  const { email, userId } = await createMember(page);
  await page.goto('/'); await login(page, email, 'assigned member password');
  await page.getByLabel('Current password').fill('assigned member password');
  await page.getByLabel('New password').fill('final member password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await login(page, email, 'final member password');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:5174' });
  try {
    const session = await (await admin.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' },
      data: { email: 'admin@example.com', password: 'browser administrator password' } })).json();
    const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': session.csrfToken };
    expect((await admin.patch(`/api/admin/users/${userId}`, { headers, data: { role: 'admin' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();
    expect((await admin.patch(`/api/admin/users/${userId}`, { headers, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);
    expect((await admin.patch(`/api/admin/users/${userId}`, { headers, data: { status: 'disabled' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
  } finally { await admin.dispose(); }
});

test('malformed service responses display safe errors', async ({ page }) => {
  await page.route('**/api/auth/login', route => route.fulfill({ status: 200, contentType: 'application/json', body: 'private upstream diagnostic' }));
  await page.goto('/'); await login(page);
  await expect(page.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
});
