import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await request.post('/api/__test/reset-login-budget');
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('chat displays actual calls, outcomes and a safely rendered final answer', async ({ page }) => {
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('Multiply 6 by 7 and get the time in UTC');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
  await expect(page.getByRole('table')).toContainText('time_current');
  await expect(page.getByRole('table')).toContainText('success');
  await expect(page.getByRole('table')).toContainText('rejected');
  await expect(page.getByLabel('Final answer')).toHaveText('42 and the UTC time. <img src=x onerror="window.modelExecuted=true">');
  expect(await page.evaluate(() => 'modelExecuted' in window)).toBe(false);
  expect(await page.locator('body').textContent()).not.toContain('synthetic-provider-secret');
});

test('chat reports provider failure without automatic resubmission and handles session expiry', async ({ page }) => {
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('provider failure');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('alert')).toContainText('Review completed calls');
  expect((await page.request.post('/api/__test/expire-session')).status()).toBe(204);
  await page.getByLabel('Prompt', { exact: true }).fill('Try again deliberately');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
});

test('unconfigured chat has a clear unavailable state', async ({ page }) => {
  await page.route('**/api/chat', route => route.fulfill({ json: { available: false } }));
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page.getByText('Chat unavailable. Ask an operator to configure the provider.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
});

test('chat retains completed call outcomes when a later provider request fails', async ({ page }) => {
  let submissions = 0;
  page.on('request', request => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') submissions++; });
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('fail after calls');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('alert')).toContainText('Review completed calls');
  await expect(page.getByRole('table')).toContainText('success');
  await expect(page.getByRole('table')).toContainText('rejected');
  await expect(page.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
  expect(submissions).toBe(1);
  expect(await page.locator('body').textContent()).not.toContain('synthetic-provider-secret');
});

test('session expiry inside the model loop shows a recoverable outcome with completed calls', async ({ page }) => {
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('expire during chat');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('alert')).toContainText('Your session or access changed');
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
  await expect(page.getByRole('alert')).toContainText('Review completed calls');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
});

test('commerce chat publishes explicit product fields and shows timezone orders with a second upstream', async ({ page }) => {
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('Publish Demo Mug at 12.50 with status=publish');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'commerce-publish' })).toContainText('woocommerce_create_product');
  await expect(page.getByRole('row').filter({ hasText: 'commerce-publish' })).toContainText('success');
  await expect(page.getByLabel('Final answer')).toHaveText('Demo Mug: publish, 12.50');

  await page.getByLabel('Prompt', { exact: true }).fill('Orders on 2026-03-08 in America/New_York and multiply 6 by 7');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'commerce-orders' })).toContainText('woocommerce_list_orders');
  await expect(page.getByRole('row').filter({ hasText: 'commerce-orders' })).toContainText('success');
  await expect(page.getByRole('row').filter({ hasText: 'commerce-calc' })).toContainText('calculator_calculate');
  await expect(page.getByRole('row').filter({ hasText: 'commerce-calc' })).toContainText('success');
  await expect(page.getByLabel('Final answer')).toHaveText('at-midnight, last-second; America/New_York: [2026-03-08T05:00:00.000Z, 2026-03-09T04:00:00.000Z); calculator: 42');
  for (const secret of ['fixture-consumer', 'fixture-secret', 'synthetic-provider-secret']) {
    expect(await page.locator('body').textContent()).not.toContain(secret);
  }
});
