import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('mobile navigation supports keyboard disclosure, Escape and direct nested routes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page);
  const menu = page.getByRole('button', { name: 'Navigation', exact: true });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Servers', exact: true })).toBeHidden();
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/admin/servers');
  await expect(page.getByRole('heading', { name: 'Servers', exact: true })).toBeVisible();
  await menu.click();
  await expect(page.getByRole('link', { name: 'Servers', exact: true })).toHaveAttribute('aria-current', 'page');
});

for (const width of [360, 768, 1440]) {
  test(`shell and account pages fit ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
    await signIn(page);
    for (const path of ['/dashboard', '/admin/users', '/admin/servers', '/keys', '/admin/audit', '/chat']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(/Loading (users|servers|keys|summary|tool history)…/)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${path.replaceAll('/', '-')}-${width}.png`), fullPage: true });
    }
    await page.getByLabel('Prompt', { exact: true }).fill('Multiply 6 by 7 and get the time in UTC');
    await page.getByRole('button', { name: 'Send prompt' }).click();
    await expect(page.getByRole('region', { name: 'Chat tool calls' })).toContainText('calculator_calculate');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`chat-result-${width}.png`), fullPage: true });
    await page.goto('/admin/servers');
    await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'calculator_calculate', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit server', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`server-form-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
    await page.getByRole('button', { name: 'Disable server', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`dialog-${width}.png`), fullPage: false });
    await page.keyboard.press('Escape');
    const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
    const email = `shell-${width}@example.com`;
    expect((await page.request.post('/api/admin/users', {
      headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': csrfToken },
      data: { email, password: 'assigned shell password' },
    })).status()).toBe(201);
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('assigned shell password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Replace your password' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`password-${width}.png`), fullPage: true });
  });
}

test('summary retains explicitly stale authorized data after invalid refresh and clears on logout', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
  await page.route('**/api/admin/servers', route => route.fulfill({ status: 200, json: {} }));
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('invalid response');
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Administrator overview' })).toHaveCount(0);
});

test('confirmation focuses Cancel, contains keyboard focus, restores focus and guards pending Escape', async ({ page }) => {
  await signIn(page); await page.goto('/admin/servers');
  await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Disable server', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Disable server confirmation' });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Confirm disable', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/servers/calculator/disable', async route => {
    await gate; await route.fulfill({ status: 503, json: {} });
  });
  await dialog.getByRole('button', { name: 'Confirm disable', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
});
