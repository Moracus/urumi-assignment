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
  const navigation = page.getByRole('button', { name: 'Navigation', exact: true });
  if (await navigation.isVisible()) await navigation.click();
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

test('loss of administrator permission clears one-time keys and rejects a delayed metadata refresh', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const panel = page.getByRole('region', { name: 'Selected user API keys' });
    await panel.getByLabel('Key name').fill('Permission transition');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(panel.getByLabel('New API key', { exact: true })).toBeVisible();
    const rawKey = await panel.getByLabel('New API key', { exact: true }).inputValue();
    const admin = (await (await page.request.get('/api/auth/me')).json()).user;
    expect((await page.request.patch(`/api/admin/users/${f.user.id}`, { headers: f.headers, data: { role: 'admin' } })).status()).toBe(200);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    await page.route(`**${f.path}?**`, async route => {
      const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
    });
    await panel.getByRole('button', { name: 'Refresh metadata' }).click();
    await started;
    expect((await f.member.request.patch(`/api/admin/users/${admin.id}`, { headers: f.memberHeaders, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
    const completed = page.waitForResponse(r => new URL(r.url()).pathname === f.path);
    release(); await completed;
    await expect(panel).toHaveCount(0);
    expect(await page.content()).not.toContain(rawKey);
    expect(await page.content()).not.toContain('Permission transition');
    expect((await page.request.get(f.path)).status()).toBe(403);
    // Restore the fixture administrator for following journeys.
    expect((await f.member.request.patch(`/api/admin/users/${admin.id}`, { headers: f.memberHeaders, data: { role: 'admin' } })).status()).toBe(200);
    expect((await f.member.request.patch(`/api/admin/users/${f.user.id}`, { headers: f.memberHeaders, data: { role: 'member' } })).status()).toBe(200);
  } finally { await f.member.close(); }
});

for (const width of [360, 768, 1440]) {
  test(`user details, key tables and keyboard confirmations fit ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await openOwner(page);
    try {
      const details = page.getByRole('region', { name: 'User details' });
      const panel = page.getByRole('region', { name: 'Selected user API keys' });
      const keyName = 'Long gateway client identifier '.repeat(3);
      await panel.getByLabel('Key name').fill(keyName);
      await panel.getByRole('button', { name: 'Create key', exact: true }).click();
      await expect(panel.getByLabel('New API key', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Dismiss key' }).click();
      const scroll = panel.getByRole('region', { name: 'API key metadata', exact: true });
      await expect(scroll).toContainText(keyName.trim());
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`user-details-${width}.png`), fullPage: true });
      await scroll.focus(); await page.keyboard.press('End');
      const revoke = panel.getByRole('button', { name: `Revoke ${keyName.trim()}`, exact: true });
      await revoke.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Confirm revocation', exact: true });
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`key-confirmation-${width}.png`) });
      await page.keyboard.press('Escape'); await expect(revoke).toBeFocused();
      await details.getByRole('button', { name: 'Reset password', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toContainText(f.email);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`reset-confirmation-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.goto('/keys');
      await page.getByLabel('Key name').fill(keyName);
      await page.getByRole('button', { name: 'Create key', exact: true }).click();
      await expect(page.getByLabel('New API key', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Dismiss key' }).click();
      await expect(page.getByText('Loading keys…')).toHaveCount(0);
      while (!(await page.getByRole('row').filter({ hasText: keyName.trim() }).count())) {
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await expect(page.getByText('Loading keys…')).toHaveCount(0);
      }
      await expect(page.getByRole('table')).toContainText(keyName.trim());
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`personal-keys-${width}.png`), fullPage: true });
    } finally { await f.member.close(); }
  });
}

test('failed detail refresh retains account context while clearing the one-time credential', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const details = page.getByRole('region', { name: 'User details' });
    const panel = page.getByRole('region', { name: 'Selected user API keys' });
    await panel.getByLabel('Key name').fill('Discard on refresh');
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(panel.getByLabel('New API key', { exact: true })).toBeVisible();
    const rawKey = await panel.getByLabel('New API key', { exact: true }).inputValue();
    await expect(panel.getByRole('table')).toContainText('Discard on refresh');
    await page.route(`**${f.path}?**`, route => route.fulfill({ status: 503, json: {} }));
    await panel.getByRole('button', { name: 'Refresh metadata', exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
    await page.route(`**/api/admin/users/${f.user.id}`, route => route.fulfill({ status: 503, json: {} }));
    await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(details.getByRole('status').filter({ hasText: 'Stale data' })).toHaveCount(2);
    await expect(panel.getByRole('table')).toContainText('Discard on refresh');
    await expect(details).toContainText(f.email);
    await expect(panel.getByLabel('New API key', { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(rawKey);
    await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  } finally { await f.member.close(); }
});

test('lost password reset acknowledgement provides investigation guidance without replay', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const details = page.getByRole('region', { name: 'User details' });
    let submissions = 0;
    await page.route(`**/api/admin/users/${f.user.id}/reset-password`, async route => {
      submissions++; await route.fetch(); await route.abort('failed');
    });
    await details.getByRole('button', { name: 'Reset password', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset password confirmation' });
    await dialog.getByLabel('Temporary password', { exact: true }).fill('uncertain assigned password');
    await dialog.getByRole('button', { name: 'Confirm password reset', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Reset may have succeeded. Refresh details');
    await expect(dialog.getByLabel('Temporary password', { exact: true })).toHaveValue('');
    expect(submissions).toBe(1);
    await page.keyboard.press('Escape');
    await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(details.locator('dd').nth(4)).toHaveText('Required');
    await expect(details.getByRole('button', { name: 'Create key', exact: true })).toHaveCount(0);
    expect(submissions).toBe(1);
    expect((await f.member.request.get('/api/auth/me')).status()).toBe(401);
    const login = await f.member.request.post('/api/auth/login', { headers: { Origin: origin }, data: { email: f.email, password: 'uncertain assigned password' } });
    expect(login.status()).toBe(200);
    expect((await login.json()).user.requiredPasswordChange).toBe(true);
  } finally { await f.member.close(); }
});


test('successful password reset refreshes both account details and the account table', async ({ page }) => {
  const f = await openOwner(page);
  try {
    const row = page.getByRole('region', { name: 'User accounts', exact: true }).getByRole('row').filter({ hasText: f.email });
    await expect(row).toContainText('Complete');
    const details = page.getByRole('region', { name: 'User details' });
    await details.getByRole('button', { name: 'Reset password', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset password confirmation' });
    await dialog.getByLabel('Temporary password', { exact: true }).fill('assigned reset consistency password');
    await dialog.getByRole('button', { name: 'Confirm password reset', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('Required');
    await expect(details.locator('dd').nth(4)).toHaveText('Required');
    expect((await f.member.request.get('/api/auth/me')).status()).toBe(401);
  } finally { await f.member.close(); }
});
