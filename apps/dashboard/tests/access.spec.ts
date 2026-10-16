import { test, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport, SdkHttpError } from '@modelcontextprotocol/client';

const origin = 'http://localhost:5174';
const password = 'assigned access member password';
async function login(page: Page, email: string, suppliedPassword: string) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(suppliedPassword);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}
async function create(page: Page) {
  await login(page, 'admin@example.com', 'browser administrator password');
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  const email = `access-${Date.now()}@example.com`;
  await page.getByLabel('Member email').fill(email);
  await page.getByLabel('Assigned password').fill(password);
  const response = page.waitForResponse(response => response.url().endsWith('/api/admin/users') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(page.getByRole('region', { name: 'User details' })).toContainText(email);
  return { email };
}
async function replacePassword(page: Page, email: string) {
  await login(page, email, password);
  await page.getByLabel('Current password').fill(password);
  await page.getByLabel('New password').fill('replacement access member password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await login(page, email, 'replacement access member password');
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('access actions prevent duplicate submissions and show safe validation, failure and malformed-response states', async ({ page }) => {
  await create(page);
  const details = page.getByRole('region', { name: 'User details' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let submitted = 0;
  await page.route('**/api/admin/users/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    submitted++; await gate;
    await route.fulfill({ status: 400, json: { error: 'private validation detail' } });
  });
  await details.getByRole('button', { name: 'Promote to administrator', exact: true }).click();
  await expect(details.getByText('Updating user access…')).toBeVisible();
  for (const button of await details.getByRole('button').all()) await expect(button).toBeDisabled();
  release();
  await expect(details.getByRole('alert')).toHaveText('The access change was rejected. Reload details and review the account before trying again.');
  expect(submitted).toBe(1);
  await expect(details.locator('dd').nth(2)).toHaveText('member');
  await page.unroute('**/api/admin/users/*');
  await page.route('**/api/admin/users/*', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 503, json: { error: 'mongodb://private:secret@internal' } }) : route.continue());
  await details.getByRole('button', { name: 'Promote to administrator', exact: true }).click();
  await expect(details.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/admin/users/*');
  await page.route('**/api/admin/users/*', route => route.request().method() === 'PATCH'
    ? route.fulfill({ json: { user: { role: 'admin' } } }) : route.continue());
  await details.getByRole('button', { name: 'Promote to administrator', exact: true }).click();
  await expect(details.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
  await expect(details.locator('dd').nth(2)).toHaveText('member');
  await page.unroute('**/api/admin/users/*');
  await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(details.getByRole('alert')).toHaveCount(0);
  await details.getByRole('button', { name: 'Disable user', exact: true }).click();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/admin/users/*', async route => {
    const response = await route.fetch(); received(); await pending; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
  await started;
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  const completed = page.waitForResponse(response => response.request().method() === 'PATCH');
  finish(); await completed;
  await expect(details).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('promotion grants equal administrator authority and self-demotion clears administrator views', async ({ page, browser }) => {
  const account = await create(page);
  const details = page.getByRole('region', { name: 'User details' });
  await details.getByRole('button', { name: 'Promote to administrator', exact: true }).click();
  await expect(details.locator('dd').nth(2)).toHaveText('admin');
  await expect(page.getByRole('row').filter({ hasText: account.email }).getByRole('cell').nth(1)).toHaveText('admin');
  const context = await browser.newContext();
  const promoted = await context.newPage();
  try {
    await replacePassword(promoted, account.email);
    await promoted.getByRole('link', { name: 'Users', exact: true }).click();
    await promoted.getByRole('button', { name: 'Inspect admin@example.com', exact: true }).click();
    const original = promoted.getByRole('region', { name: 'User details' });
    await original.getByRole('button', { name: 'Demote to member', exact: true }).click();
    await expect(original.locator('dd').nth(2)).toHaveText('member');
    await original.getByRole('button', { name: 'Promote to administrator', exact: true }).click();
    await expect(original.locator('dd').nth(2)).toHaveText('admin');
    const inspectSelf = promoted.getByRole('button', { name: `Inspect ${account.email}`, exact: true });
    for (;;) {
      await expect(promoted.getByRole('button', { name: 'Refresh users', exact: true })).toBeEnabled();
      if (await inspectSelf.count()) break;
      const next = promoted.getByLabel('User pages', { exact: true }).getByRole('button', { name: 'Next page', exact: true });
      if (await next.isDisabled()) { await expect(inspectSelf).toBeVisible(); break; }
      await next.click();
      await expect(promoted.getByText('Loading users…')).toHaveCount(0);
    }
    await inspectSelf.click();
    await original.getByRole('button', { name: 'Demote to member', exact: true }).click();
    await expect(promoted.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(promoted.getByRole('region', { name: 'User details' })).toHaveCount(0);
    expect((await promoted.request.get('/api/admin/users')).status()).toBe(403);
  } finally { await context.close(); }
});

test('disable and re-enable permanently withdraw old sessions and keys including a continuing MCP client', async ({ page, browser, playwright }) => {
  const account = await create(page);
  const details = page.getByRole('region', { name: 'User details' });
  const context = await browser.newContext();
  const member = await context.newPage();
  const client = new Client({ name: 'disable-access-test', version: '1' });
  try {
    await replacePassword(member, account.email);
    await member.getByRole('link', { name: 'API keys', exact: true }).click();
    await member.getByLabel('Key name').fill('Withdrawn client');
    await member.getByRole('button', { name: 'Create key', exact: true }).click();
    const raw = member.getByLabel('New API key', { exact: true });
    await expect(raw).toBeVisible();
    const rawKey = await raw.inputValue();
    const cookies = await context.cookies(`${origin}/api/auth/me`);
    const oldCookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    const call = () => client.callTool({ name: 'calculator.calculate', arguments: { operation: 'multiply', a: 6, b: 7 } });
    expect((await call()).content).toEqual([{ type: 'text', text: '42' }]);
    await details.getByRole('button', { name: 'Disable user', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await member.request.get('/api/auth/me')).status()).toBe(200);
    await details.getByRole('button', { name: 'Disable user', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('permanently invalidated');
    await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
    await expect(details.locator('dd').nth(3)).toHaveText('disabled');
    await member.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(member.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    expect(await member.content()).not.toContain(rawKey);
    await expect(member.getByRole('table')).toHaveCount(0);
    await expect(call()).rejects.toBeInstanceOf(SdkHttpError);
    await login(member, account.email, 'replacement access member password');
    await expect(member.getByRole('alert')).toHaveText('Invalid email or password.');
    await details.getByRole('button', { name: 'Re-enable user', exact: true }).click();
    await expect(details.locator('dd').nth(3)).toHaveText('active');
    const oldSession = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Cookie: oldCookie } });
    try { expect((await oldSession.get('/api/auth/me')).status()).toBe(401); }
    finally { await oldSession.dispose(); }
    try { await call(); throw new Error('Old key regained access'); }
    catch (error) {
      expect(error).toBeInstanceOf(SdkHttpError);
      if (error instanceof SdkHttpError) expect(error.data.status).toBe(401);
    }
    await login(member, account.email, 'replacement access member password');
    await member.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(member.getByRole('row').filter({ hasText: 'Withdrawn client' })).toContainText('Revoked');
    await member.getByLabel('Key name').fill('Fresh client');
    await member.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(raw).toBeVisible();
    const fresh = new Client({ name: 'fresh-access-test', version: '1' });
    try {
      await fresh.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${await raw.inputValue()}` } },
      }));
      expect((await fresh.listTools()).tools.map(tool => tool.name)).toContain('calculator.calculate');
    } finally { await fresh.close(); }
  } finally { await client.close(); await context.close(); }
});
