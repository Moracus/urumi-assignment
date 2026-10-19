import { test, expect, type Page } from '@playwright/test';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function openServer(page: Page, id: string) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'Servers', exact: true }).click();
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  expect((await page.request.post('/api/admin/servers', { headers, data: {
    serverId: id, displayName: id, url: new URL(`/controlled/${id}`, server.url).href,
    transport: 'streamable-http', enabled: true, authentication: { type: 'none' },
  } })).status()).toBe(201);
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  await page.getByRole('button', { name: `Inspect ${id}`, exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  await expect(details).toContainText('Runtime statusconnected');
  return { details, headers, upstreamOrigin: new URL(server.url).origin };
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('confirmed dashboard disable withdraws cached tools, cancellation preserves access, and enable rediscovers', async ({ page }) => {
  const { details, headers } = await openServer(page, 'lifecycle');
  const { rawKey } = await (await page.request.post('/api/keys', { headers, data: { name: 'Lifecycle client' } })).json();
  const client = new Client({ name: 'lifecycle', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('lifecycle_calculate');
    await details.getByRole('button', { name: 'Disable server', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Disable server confirmation' });
    await expect(dialog).toContainText('tools will become unavailable');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await client.callTool({ name: 'lifecycle_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content)
      .toEqual([{ type: 'text', text: '42' }]);
    await details.getByRole('button', { name: 'Disable server', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm disable', exact: true }).click();
    await expect(details).toContainText('Runtime statusdisabled');
    await expect(details).toContainText('No available tools.');
    await expect(details.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeDisabled();
    expect((await page.request.post('/api/admin/servers/lifecycle/refresh', { headers })).status()).toBe(409);
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).not.toContain('lifecycle_calculate');
    await expect(client.callTool({ name: 'lifecycle_calculate', arguments: { operation: 'multiply', a: 2, b: 3 } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await client.callTool({ name: 'time_current', arguments: { timezone: 'UTC' } })).content).toEqual([{ type: 'text', text: '2026-10-16T00:00:00Z' }]);
    await details.getByRole('button', { name: 'Enable server', exact: true }).click();
    await expect(details).toContainText('Runtime statusconnected');
    await expect(page.getByRole('status').filter({ hasText: 'Server enabled.' })).toContainText('connected');
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).toContain('lifecycle_calculate');
  } finally { await client.close(); }
});

test('removal confirms its impact, cancellation preserves registration, and a pending removal cannot be duplicated', async ({ page }) => {
  const { details, headers } = await openServer(page, 'remove_lifecycle');
  const { rawKey } = await (await page.request.post('/api/keys', { headers, data: {} })).json();
  const client = new Client({ name: 'removal', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  try {
    await client.listTools();
    await details.getByRole('button', { name: 'Remove server', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove server confirmation' });
    await expect(dialog).toContainText('tools will become unavailable');
    await expect(dialog).toContainText('Secrets will not be deleted');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await page.request.get('/api/admin/servers/remove_lifecycle')).status()).toBe(200);
    await details.getByRole('button', { name: 'Remove server', exact: true }).click();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let mutations = 0;
    await page.route('**/api/admin/servers/remove_lifecycle', async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      mutations++; await gate; await route.continue();
    });
    await dialog.getByRole('button', { name: 'Confirm remove', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm remove', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(details.getByRole('button', { name: 'Close details', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh servers', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Register server', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Inspect calculator', exact: true })).toBeDisabled();
    release();
    await expect(details).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Server removed.' })).toBeVisible();
    expect(mutations).toBe(1);
    expect((await page.request.get('/api/admin/servers/remove_lifecycle')).status()).toBe(404);
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).not.toContain('remove_lifecycle_calculate');
    await expect(client.callTool({ name: 'remove_lifecycle_calculate', arguments: { operation: 'multiply', a: 2, b: 3 } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 7, b: 8 } })).content).toEqual([{ type: 'text', text: '56' }]);
  } finally { await client.close(); }
});

test('failed enable and refresh show actual outcomes, isolate cached calls, and rediscover a changed catalog on recovery', async ({ page }) => {
  const { details, headers, upstreamOrigin } = await openServer(page, 'recovery_lifecycle');
  const { rawKey } = await (await page.request.post('/api/keys', { headers, data: {} })).json();
  const client = new Client({ name: 'recovery', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  const mode = async (value: string) => expect((await page.request.post(`${upstreamOrigin}/control/recovery_lifecycle`, { data: { mode: value } })).status()).toBe(204);
  try {
    await client.listTools();
    await details.getByRole('button', { name: 'Disable server', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
    await expect(details).toContainText('Runtime statusdisabled');
    await mode('offline');
    await details.getByRole('button', { name: 'Enable server', exact: true }).click();
    await expect(details).toContainText('Configured stateEnabled');
    await expect(details).toContainText('Runtime statusunreachable');
    await expect(page.getByRole('status').filter({ hasText: 'Server enabled.' })).toContainText('Discovery failed');
    await expect(details).toContainText('No available tools.');
    await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Discovery refreshed.' })).toContainText('unreachable');
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).not.toContain('recovery_lifecycle_calculate');
    await expect(client.callTool({ name: 'recovery_lifecycle_calculate', arguments: { operation: 'multiply', a: 2, b: 3 } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content).toEqual([{ type: 'text', text: '42' }]);
    await expect(details).toContainText('Upstream unavailable');
    expect(await page.content()).not.toContain('synthetic-browser-one');
    expect(await page.content()).not.toContain('private upstream diagnostic');
    await mode('changed');
    await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
    await expect(details).toContainText('Runtime statusconnected');
    await expect(details.getByRole('heading', { name: 'recovery_lifecycle_current', exact: true })).toBeVisible();
    const catalog = (await client.listTools(undefined, { cacheMode: 'bypass' })).tools;
    expect(catalog.find(tool => tool.name === 'recovery_lifecycle_current')?.inputSchema).toMatchObject({ properties: { timezone: { const: 'UTC' } } });
    expect(catalog.map(tool => tool.name)).not.toContain('recovery_lifecycle_calculate');
    expect((await client.callTool({ name: 'recovery_lifecycle_current', arguments: { timezone: 'UTC' } })).content).toEqual([{ type: 'text', text: 'Replacement clock' }]);
  } finally { await mode('valid'); await client.close(); }
});

test('pending disable prevents competing actions and an ambiguous failure requires inspection before deliberate retry', async ({ page }) => {
  const { details } = await openServer(page, 'failed_lifecycle');
  await page.route('**/api/admin/servers', route => route.fulfill({ status: 503, json: { error: 'private diagnostic' } }));
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(details).toContainText('Runtime statusconnected');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const committed = new Promise<void>(resolve => { received = resolve; });
  let submissions = 0;
  await page.route('**/api/admin/servers/failed_lifecycle/disable', async route => {
    submissions++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received(); await gate;
    await route.fulfill({ status: 503, json: { error: 'private credential and endpoint' } });
  });
  await details.getByRole('button', { name: 'Disable server', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
  await committed;
  await expect(page.getByRole('button', { name: 'Confirm disable', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry servers', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: 'Edit server', exact: true })).toBeDisabled();
  release();
  await expect(details.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(details).toContainText('Refresh details to check the current state before retrying.');
  expect(submissions).toBe(1);
  expect(await page.content()).not.toContain('private credential');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(details).toContainText('Runtime statusdisabled');
  await expect(details.getByRole('button', { name: 'Enable server', exact: true })).toBeEnabled();
});

test('pending enable cannot be duplicated and its delayed outcome is discarded after logout', async ({ page }) => {
  const { details, headers } = await openServer(page, 'late_lifecycle');
  expect((await page.request.post('/api/admin/servers/late_lifecycle/disable', { headers })).status()).toBe(200);
  await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(details).toContainText('Runtime statusdisabled');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const committed = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/admin/servers/late_lifecycle/enable', async route => {
    const response = await route.fetch(); received(); await gate; await route.fulfill({ response });
  });
  await details.getByRole('button', { name: 'Enable server', exact: true }).click();
  await committed;
  await expect(details.getByRole('button', { name: 'Enable server', exact: true })).toBeDisabled();
  await expect(details.getByRole('button', { name: 'Remove server', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  release();
  await expect(details).toHaveCount(0);
  await expect(page.getByText('Server enabled.', { exact: false })).toHaveCount(0);
});
