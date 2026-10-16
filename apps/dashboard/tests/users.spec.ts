import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

async function login(page: Page, email = 'admin@example.com', password = 'browser administrator password') {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}

async function openUsers(page: Page) {
  await page.goto('/'); await login(page);
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
}

test('last active administrator cannot demote or disable themselves', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('button', { name: 'Inspect admin@example.com', exact: true }).click();
  const details = page.getByRole('region', { name: 'User details' });
  await details.getByRole('button', { name: 'Demote to member', exact: true }).click();
  await expect(details.getByRole('alert')).toHaveText('At least one active administrator must remain. Promote or re-enable another administrator first.');
  await expect(details.locator('dd').nth(2)).toHaveText('admin');
  await details.getByRole('button', { name: 'Disable user', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
  await expect(details.getByRole('alert')).toContainText('At least one active administrator must remain');
  await expect(details.locator('dd').nth(3)).toHaveText('active');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});

test('administrator creates and inspects a member who replaces the assigned password and logs in afresh', async ({ page }) => {
  await openUsers(page);
  const email = `dashboard-member-${Date.now()}@example.com`;
  await page.getByLabel('Member email').fill(email);
  await page.getByLabel('Assigned password').fill('assigned browser member password');
  const created = page.waitForResponse(response => response.url().endsWith('/api/admin/users') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { user } = await response.json();
  expect(user.role).toBe('member'); expect(user.requiredPasswordChange).toBe(true);
  expect(response.request().postDataJSON()).toEqual({ email, password: 'assigned browser member password' });
  await expect(page.getByLabel('Assigned password')).toHaveValue('');
  const detail = page.getByRole('region', { name: 'User details' });
  await expect(detail).toContainText(email);
  await expect(detail).toContainText('member');
  await expect(detail).toContainText('Required');
  await expect(detail).toContainText(user.id);
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
  await page.getByRole('button', { name: 'Log out' }).click();
  await login(page, email, 'assigned browser member password');
  await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
  await page.getByLabel('Current password').fill('assigned browser member password');
  await page.getByLabel('New password').fill('replacement browser member password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await login(page, email, 'replacement browser member password');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  expect((await page.request.get(`/api/admin/users/${user.id}`)).status()).toBe(403);
  expect((await page.request.post('/api/admin/users', { headers, data: { email: 'forbidden@example.com', password: 'assigned password' } })).status()).toBe(403);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByLabel('Assigned password')).toHaveCount(0);
});

test('bounded account pages reach real users beyond the first page and inspect authoritative details', async ({ page }) => {
  await openUsers(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  const emails: string[] = [];
  for (let index = 0; index < 11; index++) {
    const email = `page-${Date.now()}-${index}@example.com`;
    const created = await page.request.post('/api/admin/users', { headers, data: { email, password: 'assigned pagination password' } });
    expect(created.status()).toBe(201); emails.push(email);
  }
  await page.getByRole('button', { name: 'Refresh users' }).click();
  await expect(page.getByRole('row')).toHaveCount(11);
  const seen: string[] = [];
  let currentPage = 1;
  for (let number = 1; number <= 10; number++) {
    currentPage = number;
    await expect(page.getByText(`Page ${number}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Loading users…')).toHaveCount(0);
    seen.push(...await page.getByRole('cell').allTextContents());
    const next = page.getByRole('button', { name: 'Next page' });
    if (await next.isDisabled()) break;
    await next.click();
  }
  for (const email of emails) expect(seen).toContain(email);
  // The API has no total: an exact multiple of ten permits an empty final page.
  if (await page.getByText('No users on this page.').isVisible()) {
    await page.getByRole('button', { name: 'Previous page' }).click();
    currentPage--;
  }
  const last = emails[10];
  await page.getByRole('button', { name: `Inspect ${last}`, exact: true }).click();
  await expect(page.getByRole('region', { name: 'User details' })).toContainText(last);
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByRole('region', { name: 'User details' })).toHaveCount(0);
  while (currentPage > 1) {
    await page.getByRole('button', { name: 'Previous page' }).click();
    currentPage--;
    await expect(page.getByText(`Page ${currentPage}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Loading users…')).toHaveCount(0);
  }
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
});

test('creation validates passwords, reports duplicate emails, clears passwords and prevents duplicate submissions', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a valid member email.');
  await page.getByLabel('Member email').fill('new@example.com');
  await page.getByLabel('Assigned password').fill('short');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('12–128 characters');
  await expect(page.getByLabel('Assigned password')).toHaveValue('');
  await page.getByLabel('Member email').fill('admin@example.com');
  await page.getByLabel('Assigned password').fill('assigned duplicate password');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('That email already has an account');
  await expect(page.getByLabel('Assigned password')).toHaveValue('');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/users', async route => {
    await gate; await route.fulfill({ status: 503, json: { error: 'mongodb://private:secret@internal' } });
  });
  await page.getByLabel('Member email').fill('pending@example.com');
  await page.getByLabel('Assigned password').fill('assigned pending password');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Creating member…' })).toBeDisabled();
  await expect(page.getByLabel('Assigned password')).toHaveValue('');
  await expect(page.getByLabel('Assigned password')).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(page.getByRole('button', { name: 'Create member', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
});

test('list loading, unavailable, empty and malformed response states are safe and recoverable', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/users?**', async route => {
    await gate; await route.fulfill({ status: 503, json: { error: 'private diagnostic' } });
  });
  await openUsers(page);
  await expect(page.getByText('Loading users…')).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/admin/users?**');
  await page.route('**/api/admin/users?**', route => route.fulfill({ json: { users: [], page: 1, limit: 10 } }));
  await page.getByRole('button', { name: 'Retry users' }).click();
  await expect(page.getByText('No users on this page.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.unroute('**/api/admin/users?**');
  await page.route('**/api/admin/users?**', route => route.fulfill({ json: { users: [{ email: 'unsafe partial account' }], page: 1, limit: 10 } }));
  await page.getByRole('button', { name: 'Refresh users' }).click();
  await expect(page.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
  await page.unroute('**/api/admin/users?**');
  await page.getByRole('button', { name: 'Retry users' }).click();
  await expect(page.getByRole('table')).toContainText('admin@example.com');
});

test('details loading and safe errors allow retry; logout discards a delayed detail response', async ({ page }) => {
  await openUsers(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/users/*', async route => {
    await gate; await route.fulfill({ status: 503, json: { error: 'private detail' } });
  });
  await page.getByRole('button', { name: 'Inspect admin@example.com', exact: true }).click();
  await expect(page.getByText('Loading user details…')).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/admin/users/*');
  await page.getByRole('button', { name: 'Retry details' }).click();
  await expect(page.getByRole('region', { name: 'User details' })).toContainText('admin@example.com');
  await page.getByRole('button', { name: 'Close details' }).click();
  let delayed!: () => void;
  const delay = new Promise<void>(resolve => { delayed = resolve; });
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/admin/users/*', async route => {
    const response = await route.fetch(); started(); await delay; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Inspect admin@example.com', exact: true }).click();
  await received;
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  delayed();
  await expect(page.getByRole('region', { name: 'User details' })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});
