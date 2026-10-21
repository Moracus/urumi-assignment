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
  const bodies: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') bodies.push(request.postDataJSON()); });
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
  expect(bodies).toEqual([{ prompt: 'Publish Demo Mug at 12.50 with status=publish' },
    { prompt: 'Orders on 2026-03-08 in America/New_York and multiply 6 by 7' }]);
  await expect(page.getByRole('region', { name: 'Submitted prompt' })).not.toContainText('Publish Demo Mug');
  for (const secret of ['fixture-consumer', 'fixture-secret', 'synthetic-provider-secret']) {
    expect(await page.locator('body').textContent()).not.toContain(secret);
  }
});

for (const width of [360, 768, 1440]) {
  test(`long chat content and keyboard tool summaries fit ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/chat');
    const prompt = `Long answer ${'long-prompt-'.repeat(90)}`;
    await page.getByLabel('Prompt', { exact: true }).fill(prompt);
    await page.getByRole('button', { name: 'Send prompt' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Submitted prompt' })).toContainText(prompt);
    await expect(page.getByLabel('Final answer')).toContainText('long-answer-'.repeat(100));
    const calls = page.getByRole('region', { name: 'Chat tool calls' });
    await expect(calls).toHaveAccessibleDescription('Scroll horizontally to read call IDs, tool names and outcomes.');
    await calls.focus();
    await expect(calls).toBeFocused();
    if (width === 360) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => calls.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    await expect(calls).toContainText('Completed successfully.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`chat-long-${width}.png`), fullPage: true });
  });
}

test('failed availability refresh retains stale configuration and the answer without replaying a prompt', async ({ page }) => {
  let submissions = 0;
  page.on('request', request => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') submissions++; });
  await page.goto('/chat');
  await page.getByLabel('Prompt', { exact: true }).fill('Multiply 6 by 7');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByLabel('Final answer')).toBeVisible();
  await page.route('**/api/chat', route => route.fulfill({ status: 503, body: 'private provider diagnostic' }));
  await page.getByRole('button', { name: 'Check availability' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Service unavailable');
  await expect(page.getByLabel('Final answer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
  expect(await page.content()).not.toContain('private provider diagnostic');
  await page.unroute('**/api/chat');
  await page.getByRole('button', { name: 'Check availability' }).click();
  await expect(page.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toHaveCount(0);
  expect(submissions).toBe(1);
});

test('malformed execution response explains uncertain writes and is never automatically resubmitted', async ({ page }) => {
  let submissions = 0;
  await page.route('**/api/chat', route => {
    if (route.request().method() === 'GET') return route.continue();
    submissions++;
    return route.fulfill({ json: { answer: 'unverified answer', calls: [{ id: 'bad', toolName: 'calculator_calculate', outcome: 'invented' }] } });
  });
  await page.goto('/chat');
  await page.getByLabel('Prompt', { exact: true }).fill('Do something deliberately');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid response');
  await expect(page.getByRole('alert')).toContainText('may already have completed');
  await expect(page.getByLabel('Final answer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check availability' }).click();
  await expect(page.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
  expect(submissions).toBe(1);
});

test('logout rejects a delayed chat result and clears the submitted prompt for the next session', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/chat', async route => {
    if (route.request().method() === 'GET') return route.continue();
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await page.goto('/chat');
  await page.getByLabel('Prompt', { exact: true }).fill('Protected delayed prompt');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await received;
  await expect(page.getByRole('status').filter({ hasText: 'Waiting for the provider' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Running tools…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  const delivered = page.waitForResponse(response => response.url().endsWith('/api/chat') && response.request().method() === 'POST');
  release(); await delivered;
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.goto('/chat');
  await expect(page.getByLabel('Prompt', { exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Submitted prompt' })).toHaveCount(0);
  await expect(page.getByLabel('Final answer')).toHaveCount(0);
});

test('verified role changes clear completed chat data and reject a delayed result', async ({ page, playwright }) => {
  const origin = { Origin: 'http://localhost:5174' };
  const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
  const email = 'chat-role-change@example.com';
  const created = await page.request.post('/api/admin/users', {
    headers: { ...origin, 'X-CSRF-Token': csrfToken }, data: { email, password: 'assigned chat password' },
  });
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  const memberLogin = await page.request.post('/api/auth/login', { headers: origin, data: { email, password: 'assigned chat password' } });
  expect(memberLogin.status()).toBe(200);
  const memberSession = await memberLogin.json();
  expect((await page.request.post('/api/auth/change-password', {
    headers: { ...origin, 'X-CSRF-Token': memberSession.csrfToken },
    data: { currentPassword: 'assigned chat password', newPassword: 'replacement chat password' },
  })).status()).toBe(204);
  expect((await page.request.post('/api/auth/login', { headers: origin, data: { email, password: 'replacement chat password' } })).status()).toBe(200);
  await page.goto('/chat');
  await page.getByLabel('Prompt', { exact: true }).fill('Member completed prompt');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(page.getByLabel('Final answer')).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/chat', async route => {
    if (route.request().method() === 'GET') return route.continue();
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await page.getByLabel('Prompt', { exact: true }).fill('Member delayed prompt');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await received;
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:5174' });
  try {
    const response = await admin.post('/api/auth/login', { headers: origin,
      data: { email: 'admin@example.com', password: 'browser administrator password' } });
    expect(response.status()).toBe(200);
    const { csrfToken: adminToken } = await response.json();
    expect((await admin.patch(`/api/admin/users/${user.id}`, {
      headers: { ...origin, 'X-CSRF-Token': adminToken }, data: { role: 'admin' },
    })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByLabel('Prompt', { exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Submitted prompt' })).toHaveCount(0);
    const delivered = page.waitForResponse(result => result.url().endsWith('/api/chat') && result.request().method() === 'POST');
    release(); await delivered;
    await expect(page.getByLabel('Final answer')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Submitted prompt' })).toHaveCount(0);
    await page.unroute('**/api/chat');
    await page.getByLabel('Prompt', { exact: true }).fill('Administrator completed prompt');
    await page.getByRole('button', { name: 'Send prompt' }).click();
    await expect(page.getByLabel('Final answer')).toBeVisible();
    expect((await admin.patch(`/api/admin/users/${user.id}`, {
      headers: { ...origin, 'X-CSRF-Token': adminToken }, data: { role: 'member' },
    })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByLabel('Final answer')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Submitted prompt' })).toHaveCount(0);
  } finally { release(); await admin.dispose(); }
});
