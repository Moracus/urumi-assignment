import { test, expect, type Page } from '@playwright/test';

async function openServers(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.goto('/admin/servers');
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('read refresh retains the last authorized list and catalog with explicit stale state without discovery', async ({ page }) => {
  await openServers(page);
  await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  const catalog = details.getByRole('heading', { name: 'calculator_calculate', exact: true });
  await expect(catalog).toBeVisible();
  let mutations = 0;
  page.on('request', request => {
    if (request.url().includes('/api/admin/servers') && request.method() !== 'GET') mutations++;
  });
  await page.route('**/api/admin/servers/calculator/tools', route => route.fulfill({ status: 503, json: { error: 'private diagnostic' } }));
  await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(details.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(catalog).toBeVisible();
  await expect(details.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Disable server', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: 'Edit server', exact: true })).toBeDisabled();
  await page.route('**/api/admin/servers', route => route.fulfill({ status: 503, json: {} }));
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Registered servers', exact: true })).toContainText('calculator');
  await expect(catalog).toBeVisible();
  await page.unroute('**/api/admin/servers/calculator/tools');
  await details.getByRole('button', { name: 'Retry details', exact: true }).click();
  await expect(details.getByRole('status').filter({ hasText: 'Stale data' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Disable server', exact: true })).toBeEnabled();
  expect(mutations).toBe(0);
});

test('permission loss clears retained inspection and discards delayed administrator reads', async ({ page, playwright }) => {
  await openServers(page);
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:5174' });
  let release = () => {};
  try {
    const login = await admin.post('/api/auth/login', { headers: { Origin: 'http://localhost:5174' },
      data: { email: 'admin@example.com', password: 'browser administrator password' } });
    const { csrfToken } = await login.json();
    const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': csrfToken };
    const email = 'server-permission@example.com';
    const created = await admin.post('/api/admin/users', { headers, data: { email, password: 'assigned server password' } });
    expect(created.status()).toBe(201);
    const { user } = await created.json();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('assigned server password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.getByLabel('Current password').fill('assigned server password');
    await page.getByLabel('New password').fill('replacement server password');
    await page.getByRole('button', { name: 'Replace password', exact: true }).click();
    expect((await admin.patch(`/api/admin/users/${user.id}`, { headers, data: { role: 'admin' } })).status()).toBe(200);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('replacement server password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.goto('/admin/servers');
    await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
    const details = page.getByRole('region', { name: 'Server details' });
    await expect(details.getByRole('heading', { name: 'calculator_calculate', exact: true })).toBeVisible();
    let started!: () => void;
    const received = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/admin/servers/calculator/tools', async route => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
    });
    await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await received;
    await expect(details.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
    expect((await admin.patch(`/api/admin/users/${user.id}`, { headers, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
    const delivered = page.waitForResponse(response => response.url().endsWith('/calculator/tools'));
    release(); await delivered;
    await expect(details).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Registered servers', exact: true })).toHaveCount(0);
    expect((await page.request.get('/api/admin/servers/calculator/tools')).status()).toBe(403);
  } finally { release(); await admin.dispose(); }
});

for (const width of [360, 768, 1440]) {
  test(`server inspection and editing fit ${width}px with complete long schemas and keyboard confirmations`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await openServers(page);
    const longValue = 'LongCatalogValue'.repeat(30);
    const { tools } = await (await page.request.get('/api/admin/servers/calculator/tools')).json();
    // Supplement real discovery with a catalog containing unusually long data.
    const catalog = tools.map((tool: { name: string; description?: string; inputSchema: object }) => tool.name === 'calculator_calculate'
      ? { ...tool, description: `Multiline description\n${longValue}`, inputSchema: { ...tool.inputSchema,
        $defs: { nested: { type: 'object', properties: { [longValue]: { type: 'string', enum: [longValue] } } } } } } : tool);
    await page.route('**/api/admin/servers/calculator/tools', route => route.fulfill({ json: { tools: catalog } }));
    await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
    const details = page.getByRole('region', { name: 'Server details' });
    const schema = details.getByRole('region', { name: 'Input schema for calculator_calculate', exact: true });
    await expect(schema).toHaveText(JSON.stringify(catalog.find((tool: { name: string }) => tool.name === 'calculator_calculate').inputSchema, null, 2));
    await schema.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(() => schema.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`inspection-${width}.png`), fullPage: true });
    await details.getByRole('button', { name: 'Edit server', exact: true }).click();
    await expect(page.getByLabel('Display name', { exact: true })).toBeFocused();
    await page.getByLabel('Replace authentication').check();
    await page.getByLabel('Authentication mode').selectOption('header');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`editing-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    const disable = details.getByRole('button', { name: 'Disable server', exact: true });
    await disable.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Disable server confirmation' });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Confirm disable', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(cancel).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`confirmation-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(disable).toBeFocused();
  });
}

test('inspects real discovered catalogs, preserves schemas and renders hostile descriptions as text', async ({ page }) => {
  await openServers(page);
  const response = await page.request.get('/api/admin/servers');
  const { servers } = await response.json();
  const calculator = servers.find((server: { serverId: string }) => server.serverId === 'calculator');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'calculator', exact: true }) });
  await expect(row).toContainText('Enabled');
  await expect(row).toContainText('connected');
  await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  await expect(details).toContainText(calculator.lastConnectedAt);
  await expect(details).toContainText(calculator.lastDiscoveredAt);
  await expect(details).toContainText('Authentication type: none');
  await expect(details).toContainText('Reference configured: No');
  await expect(details).toContainText(`Available tool count${calculator.toolCount}`);
  const { tools } = await (await page.request.get('/api/admin/servers/calculator/tools')).json();
  for (const tool of tools) {
    const catalogEntry = details.getByRole('region', { name: tool.name, exact: true });
    await expect(catalogEntry.getByRole('heading')).toHaveText(tool.name);
    await expect(catalogEntry.locator('pre')).toHaveText(JSON.stringify(tool.inputSchema, null, 2));
  }
  await expect(details).toContainText('<img src=x onerror="window.upstreamExecuted=true">');
  await expect(details.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'upstreamExecuted'))).toBeUndefined();
  await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
  await expect(details.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeEnabled();
});

test('enabled failed registrations remain unreachable with safe failures and an empty catalog', async ({ page }) => {
  await openServers(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const url = new URL('/offline', server.url).href;
  const created = await page.request.post('/api/admin/servers', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken },
    data: { serverId: 'offline', displayName: 'Offline fixture', url, transport: 'streamable-http', enabled: true, authentication: { type: 'none' } },
  });
  expect(created.status()).toBe(201);
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Offline fixture' });
  await expect(row).toContainText('Enabled');
  await expect(row).toContainText('unreachable');
  await row.getByRole('button', { name: 'Inspect offline', exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  await expect(details).toContainText('Upstream unavailable');
  await expect(details).toContainText('No available tools.');
  await expect(details).not.toContainText('private upstream diagnostic');
  await expect(details).toContainText('Never');
});

test('disabled authenticated registrations expose only safe authentication metadata and cannot refresh discovery', async ({ page }) => {
  await openServers(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const created = await page.request.post('/api/admin/servers', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken },
    data: { serverId: 'authenticated', displayName: 'Authenticated fixture', url: new URL('/authenticated', server.url).href,
      transport: 'streamable-http', enabled: false, authentication: { type: 'bearer',
        secretRef: { namespace: 'urumi', name: 'browser-private-reference', key: 'token' } } },
  });
  expect(created.status()).toBe(201);
  const payload = await created.json();
  expect(payload.server.authentication).toEqual({ type: 'bearer', referenceConfigured: true });
  expect(JSON.stringify(payload)).not.toContain('browser-private-reference');
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect authenticated', exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  await expect(details).toContainText('Authentication type: bearer');
  await expect(details).toContainText('Reference configured: Yes');
  await expect(details).toContainText('Runtime statusdisabled');
  await expect(details).toContainText('No available tools.');
  await expect(details.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeDisabled();
  expect(await page.content()).not.toContain('browser-private-reference');
});

test('list loading, safe failures, empty and malformed responses recover with explicit retry', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/servers', async route => {
    await gate; await route.fulfill({ status: 503, json: { error: 'private upstream credential' } });
  });
  await openServers(page);
  await expect(page.getByText('Loading servers…')).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/admin/servers');
  await page.route('**/api/admin/servers', route => route.fulfill({ json: { servers: [] } }));
  await page.getByRole('button', { name: 'Retry servers', exact: true }).click();
  await expect(page.getByText('No registered servers.')).toBeVisible();
  await page.unroute('**/api/admin/servers');
  await page.route('**/api/admin/servers', route => route.fulfill({ json: { servers: [{ enabled: true }] } }));
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service returned an invalid response. Try again later.');
  await page.unroute('**/api/admin/servers');
  await page.getByRole('button', { name: 'Retry servers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect calculator', exact: true })).toBeVisible();
});

test('detail failures retry, pending refresh is bounded in the UI, and logout discards delayed catalogs', async ({ page }) => {
  await openServers(page);
  await page.route('**/api/admin/servers/calculator/tools', route => route.fulfill({ status: 503, json: { error: 'private diagnostic' } }));
  await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  await expect(details.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await page.unroute('**/api/admin/servers/calculator/tools');
  await details.getByRole('button', { name: 'Retry details', exact: true }).click();
  await expect(details.getByRole('heading', { name: 'calculator_calculate', exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/servers/calculator/refresh', async route => {
    await gate; await route.fulfill({ status: 503, json: { error: 'private credential' } });
  });
  await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
  await expect(details.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: 'Refresh details', exact: true })).toBeDisabled();
  release();
  await expect(details.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  let finish!: () => void;
  const delay = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/admin/servers/calculator/tools', async route => {
    const response = await route.fetch(); await delay; await route.fulfill({ response });
  });
  await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(details.getByText('Refreshing data…')).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  finish();
  await expect(details).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('members cannot inspect server APIs or administrator pages', async ({ page }) => {
  await openServers(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const email = `server-member-${Date.now()}@example.com`;
  expect((await page.request.post('/api/admin/users', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken },
    data: { email, password: 'assigned server member password' },
  })).status()).toBe(201);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('assigned server member password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByLabel('Current password').fill('assigned server member password');
  await page.getByLabel('New password').fill('replacement server member password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('replacement server member password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  for (const path of ['/api/admin/servers', '/api/admin/servers/calculator', '/api/admin/servers/calculator/tools']) {
    expect((await page.request.get(path)).status()).toBe(403);
  }
  await expect(page.getByRole('link', { name: 'Servers', exact: true })).toHaveCount(0);
  await page.goto('/admin/servers');
  await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('transient disconnected and connecting observations are displayed independently of enabled state', async ({ page }) => {
  await openServers(page);
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  // Supplement the real MCP cases with transient observations that normally end
  // before a browser can inspect them deterministically.
  for (const status of ['disconnected', 'connecting']) {
    const observation = { ...server, status, toolCount: 0, lastConnectedAt: null, lastDiscoveredAt: null };
    await page.route('**/api/admin/servers', route => route.fulfill({ json: { servers: [observation] } }));
    await page.route('**/api/admin/servers/calculator', route => route.fulfill({ json: { server: observation } }));
    await page.route('**/api/admin/servers/calculator/tools', route => route.fulfill({ json: { tools: [] } }));
    await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
    await expect(page.getByRole('cell', { name: status, exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Enabled', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
    const details = page.getByRole('region', { name: 'Server details' });
    await expect(details).toContainText(`Runtime status${status}`);
    await expect(details).toContainText('No available tools.');
    await details.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.unroute('**/api/admin/servers');
    await page.unroute('**/api/admin/servers/calculator');
    await page.unroute('**/api/admin/servers/calculator/tools');
  }
});
