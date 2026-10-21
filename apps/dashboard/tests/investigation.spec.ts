import { test, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  return { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('inspection, metric totals and matching history preserve one concrete window and identity', async ({ page }) => {
  const headers = await login(page);
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const issued = await page.request.post('/api/keys', { headers, data: {} });
  expect(issued.status()).toBe(201);
  const { rawKey, key } = await issued.json();
  const client = new Client({ name: 'investigation', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } });
  } finally {
    try { await client.close(); }
    finally { expect((await page.request.delete(`/api/keys/${key.id}`, { headers })).status()).toBe(204); }
  }
  await page.goto('/admin/servers');
  await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details', exact: true });
  await details.getByRole('link', { name: 'Registration observability', exact: true }).click();
  const metricsUrl = new URL(page.url());
  expect(metricsUrl.searchParams.get('upstreamId')).toBe(server.registrationId);
  const from = metricsUrl.searchParams.get('from')!, to = metricsUrl.searchParams.get('to')!;
  expect(Date.parse(to) - Date.parse(from)).toBe(86400000);
  const row = page.getByRole('row').filter({ hasText: server.registrationId });
  const total = Number(await row.getByRole('link', { name: /^Matching attributed attempts: / }).textContent());
  expect(total).toBeGreaterThan(0);
  await row.getByRole('link', { name: /^Matching attributed attempts: / }).click();
  const historyUrl = new URL(page.url());
  for (const [key, value] of Object.entries({ upstreamId: server.registrationId, from, to, activity: 'attempts', page: '1' })) expect(historyUrl.searchParams.get(key)).toBe(value);
  const history = await (await page.request.get(`/api/admin/audit?${historyUrl.searchParams}&limit=100`)).json();
  expect(history.records).toHaveLength(total);
  expect(history.records.every((record: { upstreamId: string }) => record.upstreamId === server.registrationId)).toBe(true);
  await expect(page.getByRole('table')).toContainText('calculator_calculate');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Observability', exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe(metricsUrl.search);
  await page.goForward();
  await expect(page.getByLabel('Registration ID', { exact: true })).toHaveValue(server.registrationId);
  await page.getByRole('link', { name: 'Inspect registration', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Server details', exact: true })).toContainText(server.registrationId);
  expect(new URL(page.url()).searchParams.get('from')).toBe(from);
  expect(new URL(page.url()).searchParams.get('to')).toBe(to);
});

async function fixture(page: Page, id: string) {
  const headers = await login(page);
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const origin = new URL(server.url).origin;
  const input = { serverId: id, displayName: 'Investigation calculator', url: `${origin}/controlled/${id}`,
    transport: 'streamable-http', enabled: true, authentication: { type: 'none' } };
  const created = await page.request.post('/api/admin/servers', { headers, data: input });
  expect(created.status()).toBe(201);
  const registration = (await created.json()).server;
  const issued = await page.request.post('/api/keys', { headers, data: {} });
  expect(issued.status()).toBe(201);
  const { rawKey, key } = await issued.json();
  const client = new Client({ name: 'linked-investigation', version: '1' });
  const cleanup = async () => {
    try { await client.close(); }
    finally { expect((await page.request.delete(`/api/keys/${key.id}`, { headers })).status()).toBe(204); }
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
  } catch (error) { await cleanup(); throw error; }
  return { headers, input, registration, client, cleanup, mode: async (mode: string) => {
    expect((await page.request.post(`${origin}/control/${id}`, { data: { mode } })).status()).toBe(204);
  } };
}

test('controlled success, tool error, timeout, healthy isolation and recovery link to exact populations and UTC buckets', async ({ page }) => {
  test.setTimeout(60000);
  const id = `diagnostic_journey_${Date.now()}`;
  const { headers, registration, client, cleanup, mode } = await fixture(page, id);
  const from = new Date(Date.now() - 1000).toISOString();
  try {
    await mode('valid');
    expect((await client.callTool({ name: `${id}_calculate`, arguments: {} })).isError).not.toBe(true);
    await mode('tool_error');
    expect((await client.callTool({ name: `${id}_calculate`, arguments: {} })).isError).toBe(true);
    await mode('timeout');
    expect((await client.callTool({ name: `${id}_calculate`, arguments: {} }, { timeout: 15000 })).isError).toBe(true);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content).toEqual([{ type: 'text', text: '42' }]);
    expect((await client.callTool({ name: 'time_current', arguments: { timezone: 'UTC' } })).isError).not.toBe(true);
    await mode('valid');
    expect((await page.request.post(`/api/admin/servers/${id}/refresh`, { headers })).status()).toBe(200);
    expect((await client.callTool({ name: `${id}_calculate`, arguments: {} })).isError).not.toBe(true);
    const to = new Date().toISOString();
    const query = new URLSearchParams({ upstreamId: registration.registrationId, from, to });
    await page.goto(`/admin/observability?${query}`);
    const row = page.getByRole('row').filter({ hasText: registration.registrationId });
    for (const [label, expected, population, outcome] of [
      ['Matching attributed attempts', 4, 'attempts', ''], ['Matching failures', 2, 'failures', ''],
      ['Matching duration samples', 3, 'durations', ''], ['Matching timeouts', 1, '', 'upstream_timeout'],
      ['Matching tool_error', 1, '', 'tool_error'],
    ] as const) {
      await expect(row.getByRole('link', { name: new RegExp(`^${label}: `) })).toHaveText(String(expected));
      await expect(row.getByRole('link', { name: new RegExp(`^${label}: `) })).toHaveAccessibleName(`${label}: ${expected}`);
      await row.getByRole('link', { name: new RegExp(`^${label}: `) }).click();
      await expect(page.getByRole('row')).toHaveCount(expected + 1);
      expect(new URL(page.url()).searchParams.get('activity') ?? '').toBe(population);
      expect(new URL(page.url()).searchParams.get('outcome') ?? '').toBe(outcome);
      await page.goBack();
      await expect(row).toBeVisible();
    }
    await row.getByRole('button', { name: 'Show activity trend for Investigation calculator', exact: true }).click();
    const region = page.getByRole('region', { name: 'Activity trend for Investigation calculator', exact: true });
    await expect(region.getByRole('link', { name: /^Matching bucket attempts: / })).toHaveText('4');
    await region.getByRole('link', { name: /^Matching bucket failures: / }).click();
    await expect(page.getByRole('row')).toHaveCount(3);
    expect(new URL(page.url()).searchParams.get('from')).toBe(from);
    expect(new URL(page.url()).searchParams.get('to')).toBe(to);
    // Exact filters intersect the metric population rather than silently overriding it.
    await page.getByLabel('Outcome', { exact: true }).selectOption('success');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.getByText('No tool calls on this page.')).toBeVisible();
    for (const activity of ['attempts', 'failures', 'durations']) {
      const response = await page.request.get(`/api/admin/audit?${query}&activity=${activity}&outcome=unauthorized`);
      expect(response.status()).toBe(200);
      expect((await response.json()).records).toEqual([]);
    }
    expect((await page.request.get(`/api/admin/audit?${query}&activity=all`)).status()).toBe(400);
    expect((await page.request.get(`/api/admin/audit?${query}&activity=attempts&activity=failures`)).status()).toBe(400);
    let mutations = 0;
    page.on('request', request => { if (request.method() !== 'GET' && !request.url().includes('/api/auth/')) mutations++; });
    await page.getByRole('link', { name: 'Registration observability', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh observability', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh observability', exact: true })).toBeEnabled();
    await row.getByRole('link', { name: 'Inspect registration', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh details', exact: true })).toBeEnabled();
    expect(mutations).toBe(0);
  } finally {
    try { await mode('valid'); } finally { await cleanup(); }
  }
});

test('rename and removal/recreation retain historical identity, exact filters and browser navigation', async ({ page }) => {
  const id = `linked_${Date.now()}`;
  const { headers, input, registration, client, cleanup } = await fixture(page, id);
  try { await client.callTool({ name: `${id}_calculate`, arguments: { operation: 'multiply', a: 3, b: 4 } }); }
  finally { await cleanup(); }
  const me = await (await page.request.get('/api/auth/me')).json();
  const query = new URLSearchParams({ upstreamId: registration.registrationId, from: new Date(Date.now() - 60000).toISOString(),
    to: new Date().toISOString(), userId: me.user.id, toolName: `${id}_calculate`, outcome: 'success' });
  expect((await page.request.patch(`/api/admin/servers/${id}`, { headers, data: { displayName: 'Renamed calculator' } })).status()).toBe(200);
  await page.goto(`/admin/audit?${query}`);
  await expect(page.getByRole('table')).toContainText('Investigation calculator');
  await page.getByRole('link', { name: 'Registration observability', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: registration.registrationId });
  await expect(row).toContainText('Renamed calculator');
  await expect(row).toContainText('Historical names: Investigation calculator');
  await page.getByRole('link', { name: 'Resume exact history filters', exact: true }).click();
  for (const [key, value] of query) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  await page.getByRole('link', { name: 'Inspect registration', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Server details', exact: true })).toContainText('Renamed calculator');
  const inspectionUrl = page.url();
  expect((await page.request.delete(`/api/admin/servers/${id}`, { headers })).status()).toBe(204);
  const recreated = await page.request.post('/api/admin/servers', { headers, data: { ...input, displayName: 'Replacement calculator' } });
  expect(recreated.status()).toBe(201);
  const replacementId = (await recreated.json()).server.registrationId;
  expect(replacementId).not.toBe(registration.registrationId);
  await page.goto(inspectionUrl);
  await expect(page.getByRole('region', { name: 'Historical registration', exact: true })).toContainText(registration.registrationId);
  await expect(page.getByRole('region', { name: 'Server details', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Registration observability', exact: true }).click();
  await expect(row).toContainText('Removed registration');
  await expect(page.getByRole('table')).not.toContainText(replacementId);
  await row.getByRole('link', { name: /^Matching attributed attempts: / }).click();
  await expect(page.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Exact public tool', { exact: true }).fill('unknown_tool');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('table')).toContainText(`${id}_calculate`);
  await page.goForward();
  await expect(page.getByLabel('Exact public tool', { exact: true })).toHaveValue('unknown_tool');
});

test('fixed links survive refresh, stale and empty reads, with keyboard trends at 360/768/1440px', async ({ page }, testInfo) => {
  await login(page);
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const query = new URLSearchParams({ upstreamId: server.registrationId, from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() });
  await page.goto(`/admin/observability?${query}`);
  const row = page.getByRole('row').filter({ hasText: server.registrationId });
  const link = row.getByRole('link', { name: /^Matching attributed attempts: / });
  await expect(link).toBeVisible();
  const url = page.url(), target = await link.getAttribute('href');
  await row.getByRole('button', { name: 'Show activity trend for calculator', exact: true }).focus();
  await page.keyboard.press('Enter');
  const region = page.getByRole('region', { name: 'Activity trend for calculator', exact: true });
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await region.focus();
    await expect(region).toBeFocused();
    await region.evaluate(node => { node.scrollLeft = 0; });
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('region', { name: 'Recorded gateway attempts', exact: true }).evaluate(node => { node.scrollLeft = 0; });
    await region.evaluate(node => { node.scrollLeft = 0; });
    await page.screenshot({ path: testInfo.outputPath(`investigation-${width}.png`), fullPage: true });
  }
  for (const view of ['servers', 'audit']) {
    await page.goto(`/admin/${view}?${query}`);
    await expect(page.getByRole('link', { name: 'Registration observability', exact: true })).toBeVisible();
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${view}-${width}.png`), fullPage: true });
    }
  }
  await page.goto(url);
  await expect(link).toBeVisible();
  await page.route('**/api/admin/observability?**', route => route.fulfill({ status: 503, json: { error: 'private upstream diagnostic' } }));
  await page.getByRole('button', { name: 'Refresh observability', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stale data' })).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await link.getAttribute('href')).toBe(target);
  await link.click();
  await expect(page.getByRole('heading', { name: 'Tool history', exact: true })).toBeVisible();
  await page.route('**/api/admin/audit?**', route => route.fulfill({ status: 503, json: {} }));
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Service unavailable');
  await page.unroute('**/api/admin/audit?**');
  await page.getByLabel('Exact public tool', { exact: true }).fill('no_such_tool');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByText('No tool calls on this page.')).toBeVisible();
  await page.unroute('**/api/admin/observability?**');
  const missing = new URLSearchParams(query); missing.set('upstreamId', '000000000000000000000000');
  await page.goto(`/admin/observability?${missing}`);
  await expect(page.getByText('No registrations or recorded attempts in this window.')).toBeVisible();
  // Freeze means even a successful later refresh sends the exact same historical bounds.
  await page.goto(url);
  const request = page.waitForRequest(request => request.url().includes('/api/admin/observability?'));
  await page.getByRole('button', { name: 'Refresh observability', exact: true }).click();
  const sent = new URL((await request).url());
  expect(sent.searchParams.get('from')).toBe(query.get('from'));
  expect(sent.searchParams.get('to')).toBe(query.get('to'));
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);

});

test('invalid investigation URLs issue no metrics reads and Back/Forward restores registration selection', async ({ page }) => {
  await login(page);
  const { servers } = await (await page.request.get('/api/admin/servers')).json();
  let reads = 0;
  await page.route('**/api/admin/observability?**', route => { reads++; return route.continue(); });
  for (const query of ['upstreamId=calculator', 'from=2026-10-20T00:00:00Z', 'bucket=', 'bucket=hour&bucket=day', 'activity=all', 'toolName=%ZZ', 'page=1&page=2',
    'from=2026-10-01T00:00:00Z&to=2026-10-20T00:00:00Z']) {
    await page.goto(`/admin/observability?${query}`);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  }
  expect(reads).toBe(0);
  await page.getByRole('button', { name: 'Reset investigation', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.goto('/admin/servers');
  await page.getByRole('button', { name: 'Inspect calculator', exact: true }).click();
  const first = page.url();
  await page.getByRole('button', { name: 'Inspect time', exact: true }).click();
  const second = page.url();
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Server details', exact: true })).toContainText(servers.find((s: { serverId: string }) => s.serverId === 'calculator').registrationId);
  expect(page.url()).toBe(first);
  await page.goForward();
  await expect(page.getByRole('region', { name: 'Server details', exact: true })).toContainText(servers.find((s: { serverId: string }) => s.serverId === 'time').registrationId);
  expect(page.url()).toBe(second);
});

for (const view of ['servers', 'observability', 'audit']) test(`delayed linked ${view} reads cannot restore data after session expiry`, async ({ page }) => {
  await login(page);
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const query = new URLSearchParams({ upstreamId: server.registrationId, from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() });
  await page.goto(`/admin/${view}?${query}`);
  const refresh = page.getByRole('button', { name: view === 'servers' ? 'Refresh details' : view === 'audit' ? 'Refresh history' : 'Refresh observability', exact: true });
  await expect(refresh).toBeEnabled();
  let release!: () => void, received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { received = resolve; });
  const pattern = view === 'servers' ? '**/api/admin/servers/calculator' : `**/api/admin/${view}?**`;
  await page.route(pattern, async route => {
    const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
  });
  try {
    await refresh.click(); await started;
    expect((await page.request.post('/api/__test/expire-session')).status()).toBe(204);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    const delivered = page.waitForResponse(response => response.url().includes(view === 'servers' ? '/api/admin/servers/calculator' : `/api/admin/${view}?`));
    release(); await delivered;
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Registration observability', exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('role changes discard delayed inspection and members cannot read any linked administrator view', async ({ page, playwright }) => {
  const headers = await login(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const query = new URLSearchParams({ upstreamId: server.registrationId, from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() });
  const email = `investigation-admin-${Date.now()}@example.com`;
  const assignedPassword = 'assigned investigation password', password = 'replacement investigation password';
  const created = await page.request.post('/api/admin/users', { headers, data: { email, password: assignedPassword } });
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  expect((await page.request.patch(`/api/admin/users/${user.id}`, { headers, data: { role: 'admin' } })).status()).toBe(200);
  const other = await playwright.request.newContext({ baseURL: headers.Origin });
  let otherHeaders: Record<string, string> = {}, release = () => {};
  try {
    const initial = await other.post('/api/auth/login', { headers: { Origin: headers.Origin }, data: { email, password: assignedPassword } });
    expect((await other.post('/api/auth/change-password', { headers: { Origin: headers.Origin, 'X-CSRF-Token': (await initial.json()).csrfToken },
      data: { currentPassword: assignedPassword, newPassword: password } })).status()).toBe(204);
    const signed = await other.post('/api/auth/login', { headers: { Origin: headers.Origin }, data: { email, password } });
    otherHeaders = { Origin: headers.Origin, 'X-CSRF-Token': (await signed.json()).csrfToken };
    await page.goto(`/admin/servers?${query}`);
    const refresh = page.getByRole('button', { name: 'Refresh details', exact: true });
    await expect(refresh).toBeEnabled();
    let received!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { received = resolve; });
    await page.route('**/api/admin/servers/calculator', async route => {
      const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
    });
    await refresh.click(); await started;
    expect((await other.patch(`/api/admin/users/${me.user.id}`, { headers: otherHeaders, data: { role: 'member' } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
    const delivered = page.waitForResponse(response => response.url().endsWith('/api/admin/servers/calculator'));
    release(); await delivered;
    await expect(page.getByRole('region', { name: 'Server details', exact: true })).toHaveCount(0);
    let reads = 0;
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/admin/')) reads++; });
    for (const view of ['servers', 'observability', 'audit']) {
      await page.goto(`/admin/${view}?${query}`);
      await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      expect((await page.request.get(`/api/admin/${view}?${view === 'servers' ? '' : query}`)).status()).toBe(403);
    }
    expect(reads).toBe(0);
  } finally {
    release();
    expect((await other.patch(`/api/admin/users/${me.user.id}`, { headers: otherHeaders, data: { role: 'admin' } })).status()).toBe(200);
    expect((await other.patch(`/api/admin/users/${user.id}`, { headers: otherHeaders, data: { role: 'member' } })).status()).toBe(200);
    await other.dispose();
  }
});
