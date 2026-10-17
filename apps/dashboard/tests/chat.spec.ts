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
  await expect(page.getByRole('table')).toContainText('calculator.calculate');
  await expect(page.getByRole('table')).toContainText('time.current');
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
