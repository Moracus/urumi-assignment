import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});
test('real registration metrics, sortable rows, presets and safe stale reads', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Observability', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Observability', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('calculator');
  await expect(page.getByRole('columnheader', { name: 'Average duration (ms)', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Approximate p95 (ms)', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Duration samples', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show activity trend for calculator', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Activity trend for calculator', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Timeouts', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Show activity trend for calculator', exact: true }).click();
  await expect(page.getByText('Effective window (UTC):', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Attributed attempts', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Attributed attempts' })).toHaveAttribute('aria-sort', 'ascending');
  await page.getByLabel('Historical window').selectOption('hour');
  await expect(page.getByText('Loading observability…')).toHaveCount(0);
  await expect(page.getByRole('table')).toBeVisible();
  const bounds = await page.getByText('Effective window (UTC):', { exact: false }).textContent();
  await page.route('**/api/admin/observability?**', route => route.fulfill({ status: 503, json: { error: 'private diagnostic' } }));
  await page.getByRole('button', { name: 'Refresh observability' }).click();
  await expect(page.getByRole('alert')).toContainText('Service unavailable');
  await expect(page.getByText('Stale data — showing the last successful read. Refresh failed.')).toBeVisible();
  expect(await page.getByText('Effective window (UTC):', { exact: false }).textContent()).toBe(bounds);
  expect(await page.locator('body').textContent()).not.toContain('private diagnostic');
  await page.unroute('**/api/admin/observability?**');
  await page.route('**/api/admin/observability?**', route => route.fulfill({ json: { rows: [] } }));
  await page.getByRole('button', { name: 'Refresh observability' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid response');
  await page.unroute('**/api/admin/observability?**');
  await page.route('**/api/admin/observability?**', route => route.fulfill({ status: 401, json: {} }));
  await page.getByRole('button', { name: 'Refresh observability' }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('both authentication origins contribute once and members never request metrics', async ({ page }) => {
  await login(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  const issued = await page.request.post('/api/keys', { headers, data: {} });
  expect(issued.status()).toBe(201);
  const { rawKey } = await issued.json();
  const before = await (await page.request.get('/api/admin/observability?preset=hour')).json();
  const calculator = before.rows.find((row: { current: { name: string } | null }) => row.current?.name === 'calculator');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'observability-browser', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    for (let i = 0; i < 101; i++) await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } });
  } finally { await client.close(); }
  const chat = await page.request.post('/api/chat', { headers, data: { prompt: 'Acceptance: multiply 6 by 7 and get UTC time' } });
  expect(chat.status()).toBe(200);
  const after = await (await page.request.get('/api/admin/observability?preset=hour')).json();
  const observed = after.rows.find((row: { upstreamId: string }) => row.upstreamId === calculator.upstreamId);
  expect(observed.attempts - calculator.attempts).toBe(102);
  expect(observed.outcomes.success - calculator.outcomes.success).toBe(102);
  expect(observed.durationSampleCount - calculator.durationSampleCount).toBe(102);
  expect(observed.averageDurationMs).toBeGreaterThanOrEqual(0);
  expect(observed.p95DurationMs).toBeGreaterThanOrEqual(0);
  expect(observed.trend.reduce((sum: number, point: { attempts: number }) => sum + point.attempts, 0)).toBe(observed.attempts);
  await page.getByRole('link', { name: 'Observability', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: calculator.upstreamId });
  await expect(row).toContainText(String(observed.attempts));
  // Verify a separate member cannot request global metrics.
  const memberEmail = `observability-${Date.now()}@example.com`;
  const created = await page.request.post('/api/admin/users', { headers, data: { email: memberEmail, password: 'observability initial password' } });
  expect(created.status()).toBe(201);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(memberEmail);
  await page.getByLabel('Password', { exact: true }).fill('observability initial password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByLabel('Current password').fill('observability initial password');
  await page.getByLabel('New password').fill('observability replacement password');
  await page.getByRole('button', { name: 'Replace password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(memberEmail);
  await page.getByLabel('Password', { exact: true }).fill('observability replacement password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  let reads = 0;
  page.on('request', request => { if (request.url().includes('/api/admin/observability')) reads++; });
  await expect(page.getByRole('link', { name: 'Observability', exact: true })).toHaveCount(0);
  await page.goto('/admin/observability');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(reads).toBe(0);
  expect((await page.request.get('/api/admin/observability')).status()).toBe(403);
});

test('observability clears after real permission loss and ignores delayed authorized reads', async ({ page, playwright }) => {
  await page.request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calculator' } } });
  await login(page);
  await page.goto('/admin/observability');
  await expect(page.getByRole('table')).toContainText('calculator');
  await page.route('**/api/admin/observability?**', route => route.fulfill({ status: 503, json: { error: 'private diagnostic' } }));
  await page.getByRole('button', { name: 'Refresh observability', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('calculator');
  await page.unroute('**/api/admin/observability?**');
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  const email = `history-admin-${Date.now()}@example.com`;
  const created = await page.request.post('/api/admin/users', { headers, data: { email, password: 'assigned history password' } });
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  expect((await page.request.patch(`/api/admin/users/${user.id}`, { headers, data: { role: 'admin' } })).status()).toBe(200);
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:5174' });
  let release = () => {};
  let otherHeaders: Record<string, string> = {};
  try {
    const login = await other.post('/api/auth/login', { headers: { Origin: headers.Origin }, data: { email, password: 'assigned history password' } });
    const assigned = await login.json();
    expect((await other.post('/api/auth/change-password', { headers: { Origin: headers.Origin, 'X-CSRF-Token': assigned.csrfToken },
      data: { currentPassword: 'assigned history password', newPassword: 'replacement history password' } })).status()).toBe(204);
    const signed = await other.post('/api/auth/login', { headers: { Origin: headers.Origin }, data: { email, password: 'replacement history password' } });
    otherHeaders = { Origin: headers.Origin, 'X-CSRF-Token': (await signed.json()).csrfToken };
    let started!: () => void;
    const received = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/admin/observability?**', async route => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Refresh observability', exact: true }).click();
    await received;
    expect((await other.patch(`/api/admin/users/${me.user.id}`, { headers: otherHeaders, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
    const delivered = page.waitForResponse(response => response.url().includes('/api/admin/observability?'));
    release(); await delivered;
    await expect(page.getByRole('table')).toHaveCount(0);
    expect((await page.request.get('/api/admin/observability')).status()).toBe(403);
  } finally {
    release();
    expect((await other.patch(`/api/admin/users/${me.user.id}`, { headers: otherHeaders, data: { role: 'admin' } })).status()).toBe(200);
    expect((await other.patch(`/api/admin/users/${user.id}`, { headers: otherHeaders, data: { role: 'member' } })).status()).toBe(200);
    await other.dispose();
  }
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await page.unroute('**/api/admin/observability?**');
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve; });
  await page.route('**/api/admin/observability?**', async route => {
    const response = await route.fetch(); await logoutGate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Refresh observability', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  const delivered = page.waitForResponse(response => response.url().includes('/api/admin/observability?'));
  releaseLogout(); await delivered;
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('filter changes serialize reads and discard superseded results', async ({ page }) => {
  await login(page);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { started = resolve; });
  let reads = 0;
  await page.route('**/api/admin/observability?**', async route => {
    reads++;
    if (reads === 1) { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.getByRole('link', { name: 'Observability', exact: true }).click();
  await received;
  await page.getByLabel('Historical window').selectOption('week');
  await page.getByLabel('Historical window').selectOption('hour');
  expect(reads).toBe(1);
  release();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByRole('table')).toBeVisible();
  const last = await page.getByText('Effective window (UTC):', { exact: false }).textContent();
  const dates = last!.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/g)!;
  expect(Date.parse(dates[1]) - Date.parse(dates[0])).toBe(3600000);
  expect(reads).toBe(2);
});

test('automatic refresh pauses while hidden and stops after leaving the page', async ({ page }) => {
  await login(page);
  await page.clock.install();
  let reads = 0;
  await page.route('**/api/admin/observability?**', route => { reads++; return route.continue(); });
  await page.getByRole('link', { name: 'Observability', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(reads).toBe(1);
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
  await page.clock.fastForward(60000);
  expect(reads).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByRole('button', { name: 'Refresh observability' })).toBeEnabled();
  await page.clock.fastForward(60000);
  await expect.poll(() => reads).toBe(3);
  await expect(page.getByRole('button', { name: 'Refresh observability' })).toBeEnabled();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.clock.fastForward(60000);
  expect(reads).toBe(3);
});

test('runtime contract rejects arrays in enum fields', async ({ page }) => {
  await login(page);
  const response = await page.request.get('/api/admin/observability');
  expect(response.status()).toBe(200);
  const report = await response.json();
  for (const field of ['kind', 'status', 'duration', 'sampleCount', 'bucket', 'trend', 'trendBoundary', 'trendCount']) {
    const invalid = structuredClone(report);
    if (field === 'kind') invalid.rows[0].kind = ['registration'];
    else if (field === 'duration') invalid.rows[0].averageDurationMs = -1;
    else if (field === 'sampleCount') invalid.rows[0].durationSampleCount = '0';
    else if (field === 'bucket') invalid.bucket = ['hour'];
    else if (field === 'trend') invalid.rows[0].trend = [];
    else if (field === 'trendBoundary') invalid.rows[0].trend[0].from = 'invalid';
    else if (field === 'trendCount') invalid.rows[0].trend[0].timeoutCount = -1;
    else {
      const current = invalid.rows.find((row: { current: unknown }) => row.current !== null);
      expect(current).toBeTruthy();
      current.current.status = ['connected'];
    }
    await page.route('**/api/admin/observability?**', route => route.fulfill({ json: invalid }));
    await page.goto('/admin/observability');
    await expect(page.getByRole('alert')).toContainText('invalid response');
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.unroute('**/api/admin/observability?**');
  }
});


test('duration and UTC trend tables support keyboard scrolling at target widths', async ({ page }, testInfo) => {
  await login(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const existing = await (await page.request.get('/api/admin/servers/calculator')).json();
  const fixtureId = `idle_${Date.now()}`;
  const created = await page.request.post('/api/admin/servers', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken },
    data: { serverId: fixtureId, displayName: 'Idle duration fixture', url: new URL(`/controlled/${fixtureId}`, existing.server.url).href,
      transport: 'streamable-http', enabled: false, authentication: { type: 'none' } },
  });
  expect(created.status()).toBe(201);
  const report = await (await page.request.get('/api/admin/observability?preset=hour')).json();
  const idle = report.rows.find((row: { current: { displayName: string } | null }) => row.current?.displayName === 'Idle duration fixture');
  expect(idle.durationSampleCount).toBe(0);
  expect(idle.averageDurationMs).toBeNull();
  await page.goto('/admin/observability');
  await page.getByLabel('Historical window').selectOption('hour');
  const row = page.getByRole('row').filter({ hasText: idle.upstreamId });
  await expect(row.getByRole('cell', { name: '—', exact: true })).toHaveCount(3);
  const toggle = row.getByRole('button', { name: 'Show activity trend for Idle duration fixture', exact: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const region = page.getByRole('region', { name: 'Activity trend for Idle duration fixture', exact: true });
  await expect(region.getByRole('table')).toContainText('UTC start (inclusive)');
  await expect(region.getByRole('row')).toHaveCount(idle.trend.length + 1);
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await region.focus();
    await expect(region).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`observability-${width}.png`), fullPage: true });
  }
  await page.getByLabel('Activity bucket').selectOption('hour');
  await expect(page.getByText('Loading observability…')).toHaveCount(0);
  await expect(region.getByRole('row')).toHaveCount(3);
  expect((await page.request.delete(`/api/admin/servers/${fixtureId}`, { headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken } })).status()).toBe(204);
});
