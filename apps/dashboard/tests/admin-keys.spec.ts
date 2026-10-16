import { test, expect, type Page } from '@playwright/test';

const origin = 'http://localhost:5174';
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});
async function openOwner(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const admin = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': admin.csrfToken };
  const email = `assisted-${Date.now()}@example.com`;
  const created = await page.request.post('/api/admin/users', { headers, data: { email, password: 'assigned member password' } });
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  // Complete the real first-login flow in an independent browser API context.
  const member = await page.context().browser()!.newContext({ baseURL: origin });
  const restricted = await (await member.request.post('/api/auth/login', { headers: { Origin: origin }, data: { email, password: 'assigned member password' } })).json();
  expect((await member.request.post('/api/auth/change-password', { headers: { Origin: origin, 'X-CSRF-Token': restricted.csrfToken }, data: { currentPassword: 'assigned member password', newPassword: 'final member password' } })).status()).toBe(204);
  const session = await (await member.request.post('/api/auth/login', { headers: { Origin: origin }, data: { email, password: 'final member password' } })).json();
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.getByText('Loading users…')).toHaveCount(0);
  // The newly created user can be beyond the first bounded account page.
  while (!(await page.getByRole('button', { name: `Inspect ${email}`, exact: true }).count())) {
    await expect(page.getByText('Loading users…')).toHaveCount(0);
    if (await page.getByRole('button', { name: `Inspect ${email}`, exact: true }).count()) break;
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
  }
  await page.getByRole('button', { name: `Inspect ${email}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `API keys for ${email}`, exact: true })).toBeVisible();
  return { user, email, headers, member, memberHeaders: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, path: `/api/admin/users/${user.id}/keys` };
}

test('administrator issues an owner-attributed key once and confirms revocation; backend enforces ownership', async ({ page, context }) => {
  const f = await openOwner(page);
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const panel = page.getByRole('region', { name: 'Selected user API keys' });
    await expect(panel).toContainText(f.user.id);
    await panel.getByLabel('Key name').fill('Assisted client');
    const response = page.waitForResponse(r => new URL(r.url()).pathname === f.path && r.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    const issued = await response;
    expect(issued.status()).toBe(201);
    const { key, rawKey } = await issued.json();
    await expect(panel.getByLabel('New API key', { exact: true })).toHaveValue(rawKey);
    await expect(panel.getByRole('region', { name: 'One-time key creation' })).toContainText(f.email);
    await panel.getByRole('button', { name: 'Copy key', exact: true }).click();
    await expect(panel.getByText('Key copied.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rawKey);
    const own = await (await f.member.request.get('/api/keys')).json();
    expect(own.keys.map((item: { id: string }) => item.id)).toContain(key.id);
    const adminOwn = await (await page.request.get('/api/keys')).json();
    expect(adminOwn.keys.map((item: { id: string }) => item.id)).not.toContain(key.id);
    const metadata = await page.request.get(f.path);
    expect((await metadata.json()).keys).toEqual(own.keys);
    expect(await metadata.text()).not.toContain(rawKey);
    expect(Object.keys(own.keys[0]).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt']);
    // A member cannot use any administrator key operation, including for themselves.
    for (const target of [f.user.id, (await (await page.request.get('/api/auth/me')).json()).user.id]) {
      const path = `/api/admin/users/${target}/keys`;
      expect((await f.member.request.get(path)).status()).toBe(403);
      expect((await f.member.request.post(path, { headers: f.memberHeaders, data: { name: 'Forbidden' } })).status()).toBe(403);
      expect((await f.member.request.delete(`${path}/${key.id}`, { headers: f.memberHeaders })).status()).toBe(403);
    }
    expect((await page.request.delete(`/api/keys/${key.id}`, { headers: f.headers })).status()).toBe(404);
    await panel.getByRole('button', { name: 'Dismiss key' }).click();
    expect(await page.content()).not.toContain(rawKey);
    await panel.getByRole('button', { name: 'Revoke Assisted client', exact: true }).click();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await (await f.member.request.get('/api/keys')).json()).keys[0].revokedAt).toBeNull();
    await panel.getByRole('button', { name: 'Revoke Assisted client', exact: true }).click();
    await expect(panel.getByRole('dialog')).toContainText(f.email);
    await panel.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await expect(panel.getByRole('row').filter({ hasText: 'Assisted client' })).toContainText('Revoked');
    expect((await (await f.member.request.get('/api/keys')).json()).keys[0].revokedAt).not.toBeNull();
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  } finally { await f.member.close(); }
});

test('selected-user metadata pages are bounded and retain only safe fields', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const ids: string[] = [];
    for (let index = 0; index < 11; index++) {
      const response = await page.request.post(f.path, { headers: f.headers, data: { name: `Paged ${index}` } });
      expect(response.status()).toBe(201); ids.push((await response.json()).key.id);
    }
    const panel = page.getByRole('region', { name: 'Selected user API keys' });
    await panel.getByRole('button', { name: 'Refresh metadata' }).click();
    await expect(panel.getByRole('row')).toHaveCount(11);
    for (const id of ids.slice(0, 10)) await expect(panel.getByRole('table')).toContainText(id);
    const next = page.waitForResponse(r => new URL(r.url()).pathname === f.path && new URL(r.url()).searchParams.get('page') === '2');
    await panel.getByRole('button', { name: 'Next page' }).click();
    const response = await next;
    expect(new URL(response.url()).searchParams.get('limit')).toBe('10');
    await expect(panel.getByRole('row')).toHaveCount(2);
    await expect(panel.getByRole('table')).toContainText(ids[10]);
    await expect(panel.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await panel.getByRole('button', { name: 'Previous page' }).click();
    await expect(panel.getByRole('row')).toHaveCount(11);
    // Invalid page envelopes cannot masquerade as an authoritative bounded page.
    const data = await (await page.request.get(`${f.path}?page=1&limit=10`)).json();
    await page.route(`**${f.path}?**`, route => route.fulfill({ json: { ...data, page: 2 } }));
    await panel.getByRole('button', { name: 'Refresh metadata' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
    await page.unroute(`**${f.path}?**`);
    await panel.getByRole('button', { name: 'Retry keys' }).click();
    await expect(panel.getByRole('row')).toHaveCount(11);
  } finally { await f.member.close(); }
});

test('closing selected-user details discards a pending raw credential and resets owner state', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const panel = page.getByRole('region', { name: 'Selected user API keys' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    let rawKey = '';
    await page.route(`**${f.path}`, async route => {
      const response = await route.fetch(); rawKey = (await response.json()).rawKey;
      received(); await gate; await route.fulfill({ response });
    });
    await panel.getByLabel('Key name').fill('Delayed assistance');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    await started;
    await expect(panel.getByRole('button', { name: 'Creating key…' })).toBeDisabled();
    await page.getByRole('button', { name: 'Close details' }).click();
    const completed = page.waitForResponse(r => new URL(r.url()).pathname === f.path && r.request().method() === 'POST');
    release(); await completed;
    await page.getByRole('button', { name: 'Inspect admin@example.com', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'API keys for admin@example.com', exact: true })).toBeVisible();
    await expect(panel.getByLabel('New API key', { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(rawKey);
    await page.getByRole('button', { name: `Inspect ${f.email}`, exact: true }).click();
    await expect(panel.getByRole('table')).toContainText('Delayed assistance');
    await expect(panel.getByLabel('New API key', { exact: true })).toHaveCount(0);
    await page.unroute(`**${f.path}`);
    await panel.getByLabel('Key name').fill('Visible assistance');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(panel.getByLabel('New API key', { exact: true })).toBeVisible();
    const visibleKey = await panel.getByLabel('New API key', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(visibleKey);
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  } finally { await f.member.close(); }
});

test('disabling the selected owner clears issued credentials and reloads permanently revoked metadata', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const panel = page.getByRole('region', { name: 'Selected user API keys' });
    await panel.getByLabel('Key name').fill('Invalidated assistance');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    const secret = panel.getByLabel('New API key', { exact: true });
    await expect(secret).toBeVisible();
    const rawKey = await secret.inputValue();
    await page.getByRole('button', { name: 'Disable user', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
    await expect(secret).toHaveCount(0);
    await expect(panel.getByRole('row').filter({ hasText: 'Invalidated assistance' })).toContainText('Revoked');
    expect(await page.content()).not.toContain(rawKey);
    await expect(panel.getByLabel('Key name')).toHaveCount(0);
    await page.getByRole('button', { name: 'Re-enable user', exact: true }).click();
    await expect(panel.getByLabel('Key name')).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    await page.route(`**${f.path}`, async route => {
      const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
    });
    await panel.getByLabel('Key name').fill('Late invalidated assistance');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    await started;
    await page.getByRole('button', { name: 'Disable user', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
    await expect(panel.getByRole('row').filter({ hasText: 'Late invalidated assistance' })).toContainText('Revoked');
    const completed = page.waitForResponse(r => new URL(r.url()).pathname === f.path && r.request().method() === 'POST');
    release(); await completed;
    await expect(secret).toHaveCount(0);
  } finally { await f.member.close(); }
});
