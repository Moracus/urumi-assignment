import { test, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport, ProtocolError } from '@modelcontextprotocol/client';

async function openServers(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'Servers', exact: true }).click();
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  return new URL(server.url).origin;
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/__test/reset-login-budget')).status()).toBe(204);
});

test('one continuing administrator client follows dashboard registration, credential edits, disable, enable, refresh and removal', async ({ page }) => {
  const origin = await openServers(page);
  const me = await (await page.request.get('/api/auth/me')).json();
  const { rawKey } = await (await page.request.post('/api/keys', {
    headers: { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken }, data: { name: 'Server edit MCP client' },
  })).json();
  const client = new Client({ name: 'server-editor', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  try {
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).not.toContain('credential_edit_calculate');
    await page.getByRole('button', { name: 'Register server', exact: true }).click();
    await page.getByLabel('Server identifier', { exact: true }).fill('credential_edit');
    await page.getByLabel('Display name', { exact: true }).fill('Authenticated addition');
    await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/secured/bearer`);
    await page.getByLabel('Authentication mode').selectOption('bearer');
    await page.getByLabel('Secret namespace').fill('urumi');
    await page.getByLabel('Secret name', { exact: true }).fill('browser-private-reference');
    await page.getByLabel('Secret key').fill('token');
    await page.getByRole('button', { name: 'Save server', exact: true }).click();
    const details = page.getByRole('region', { name: 'Server details' });
    await expect(details).toContainText('Runtime statusconnected');
    const original = (await client.listTools(undefined, { cacheMode: 'bypass' })).tools.find(tool => tool.name === 'credential_edit_calculate');
    expect(original?.inputSchema).toMatchObject({ required: ['operation', 'a', 'b'], properties: { operation: { const: 'multiply' } } });
    expect((await client.callTool({ name: 'credential_edit_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content).toEqual([{ type: 'text', text: '42' }]);
    await page.getByRole('button', { name: 'Edit server', exact: true }).click();
    expect(await page.content()).not.toContain('browser-private-reference');
    await page.getByLabel('Display name', { exact: true }).fill('Credentials preserved');
    await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/secured/preserved`);
    const preserved = page.waitForRequest(request => request.method() === 'PATCH');
    await page.getByRole('button', { name: 'Save server', exact: true }).click();
    expect((await preserved).postDataJSON()).not.toHaveProperty('authentication');
    await expect(details).toContainText('Runtime statusconnected');
    expect((await client.callTool({ name: 'credential_edit_calculate', arguments: { operation: 'multiply', a: 3, b: 4 } })).content).toEqual([{ type: 'text', text: '12' }]);
    await page.getByRole('button', { name: 'Edit server', exact: true }).click();
    await page.getByLabel('Replace authentication').check();
    await page.getByLabel('Authentication mode').selectOption('header');
    await page.getByLabel('Secret namespace').fill('urumi');
    await page.getByLabel('Secret name', { exact: true }).fill('browser-replacement-reference');
    await page.getByLabel('Secret key').fill('token');
    await page.getByLabel('Custom header name').fill('X-Upstream-Token');
    await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/secured/replacement`);
    await page.getByRole('button', { name: 'Save server', exact: true }).click();
    await expect(details).toContainText('Authentication type: header');
    await expect(details).toContainText('Runtime statusconnected');
    const names = (await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name);
    expect(names).toContain('credential_edit_current');
    expect(names).not.toContain('credential_edit_calculate');
    await expect(client.callTool({ name: 'credential_edit_calculate', arguments: { operation: 'multiply', a: 1, b: 2 } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await client.callTool({ name: 'credential_edit_current', arguments: { timezone: 'UTC' } })).content).toEqual([{ type: 'text', text: 'Replacement clock' }]);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 7, b: 8 } })).content).toEqual([{ type: 'text', text: '56' }]);
    expect(JSON.stringify(await (await page.request.get('/api/admin/servers/credential_edit')).json())).not.toContain('browser-replacement-reference');
    expect(await page.content()).not.toContain('synthetic-browser');
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
    await details.getByRole('button', { name: 'Disable server', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
    await expect(details).toContainText('Runtime statusdisabled');
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).not.toContain('credential_edit_current');
    await expect(client.callTool({ name: 'credential_edit_current', arguments: { timezone: 'UTC' } })).rejects.toBeInstanceOf(ProtocolError);
    await details.getByRole('button', { name: 'Enable server', exact: true }).click();
    await expect(details).toContainText('Runtime statusconnected');
    await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Discovery refreshed.' })).toContainText('connected');
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).toContain('credential_edit_current');
    expect((await client.callTool({ name: 'credential_edit_current', arguments: { timezone: 'UTC' } })).content).toEqual([{ type: 'text', text: 'Replacement clock' }]);
    await details.getByRole('button', { name: 'Remove server', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
    await expect(details).toHaveCount(0);
    expect((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name)).not.toContain('credential_edit_current');
    await expect(client.callTool({ name: 'credential_edit_current', arguments: { timezone: 'UTC' } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 7, b: 8 } })).content).toEqual([{ type: 'text', text: '56' }]);
  } finally { await client.close(); }
});

test('registers and edits a stable namespace, and saves failed discovery for recovery', async ({ page }) => {
  const origin = await openServers(page);
  await page.getByRole('button', { name: 'Register server', exact: true }).click();
  await page.getByLabel('Server identifier', { exact: true }).fill('browser_added');
  await page.getByLabel('Display name', { exact: true }).fill('Browser addition');
  await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/mcp/browser_added`);
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Server saved.' })).toContainText('connected');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'browser_added', exact: true }) });
  await expect(row).toContainText('Browser addition');
  await page.getByRole('button', { name: 'Edit server', exact: true }).click();
  await expect(page.getByLabel('Server identifier', { exact: true })).toBeDisabled();
  await expect(page.getByText('Existing authentication is preserved unless you choose to replace it.')).toBeVisible();
  await page.getByLabel('Display name', { exact: true }).fill('Saved offline');
  await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/offline/browser_added`);
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Server saved.' })).toContainText('Discovery failed');
  await expect(row).toContainText('Saved offline');
  await expect(row).toContainText('unreachable');
  await expect(page.getByRole('region', { name: 'Server details' })).toContainText('No available tools.');
  await page.reload();
  await expect(row).toContainText('unreachable');
  await page.getByRole('button', { name: 'Inspect browser_added', exact: true }).click();
  await page.getByRole('button', { name: 'Edit server', exact: true }).click();
  await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/mcp/browser_added`);
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(row).toContainText('connected');
  await expect(page.getByRole('heading', { name: 'browser_added_calculate', exact: true })).toBeVisible();
});

test('forms reject invalid syntax and backend destination or reference denials remain recoverable', async ({ page }) => {
  const origin = await openServers(page);
  await page.getByRole('button', { name: 'Register server', exact: true }).click();
  await page.getByLabel('Server identifier', { exact: true }).fill('validation-example');
  await page.getByLabel('Display name', { exact: true }).fill('Validation example');
  await page.getByLabel('Endpoint', { exact: true }).fill('ftp://example.com/mcp');
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use an HTTP or HTTPS endpoint');
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://urumi-mariadb:3306/mcp', 'https://unapproved.example/mcp']) {
    await page.getByLabel('Endpoint', { exact: true }).fill(url);
    const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/admin/servers'));
    await page.getByRole('button', { name: 'Save server', exact: true }).click();
    expect((await response).status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText('operator-approved');
  }
  await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/mcp/validation-example`);
  await page.getByLabel('Authentication mode').selectOption('header');
  await page.getByLabel('Secret namespace').fill('urumi');
  await page.getByLabel('Secret name', { exact: true }).fill('unapproved-reference');
  await page.getByLabel('Secret key').fill('token');
  for (const header of ['Authorization', 'Host', 'Cookie', 'X-Forwarded-For', 'Mcp-Session-Id', 'Content-Type', 'Not a header']) {
    await page.getByLabel('Custom header name').fill(header);
    await page.getByRole('button', { name: 'Save server', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('custom HTTP header name');
  }
  await page.getByLabel('Custom header name').fill('X-Upstream-Token');
  const denied = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/admin/servers'));
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  expect((await denied).status()).toBe(400);
  await expect(page.getByRole('alert')).toContainText('exact Secret reference');
  // Browser constraint validation must reject malformed references as the backend does.
  const namespace = page.getByLabel('Secret namespace');
  await namespace.fill('Invalid_Namespace');
  expect(await namespace.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await namespace.fill('urumi');
  const secret = page.getByLabel('Secret name', { exact: true });
  await secret.fill('invalid..name');
  expect(await secret.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await secret.fill('browser-private-reference');
  expect(await secret.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await page.getByLabel('Secret key').fill('invalid/key');
  expect(await page.getByLabel('Secret key').evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await page.getByLabel('Secret key').fill('token');
  // Explicitly select none to recover, without accidentally submitting stale reference fields.
  await page.getByLabel('Authentication mode').selectOption('none');
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Server details' })).toContainText('Runtime statusconnected');
  await page.getByRole('button', { name: 'Edit server', exact: true }).click();
  await page.getByLabel('Endpoint', { exact: true }).fill('http://169.254.169.254/latest/meta-data');
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('operator-approved');
  const { server } = await (await page.request.get('/api/admin/servers/validation-example')).json();
  expect(server.url).toBe(`${origin}/mcp/validation-example`);
  await page.getByRole('button', { name: 'Cancel editing' }).click();
  await expect(page.getByRole('region', { name: 'Server details' })).toContainText('Runtime statusconnected');
});

test('pending saves prevent duplicate actions and late responses cannot restore forms after logout', async ({ page }) => {
  const origin = await openServers(page);
  await page.getByRole('button', { name: 'Register server', exact: true }).click();
  await page.getByLabel('Server identifier', { exact: true }).fill('delayed_save');
  await page.getByLabel('Display name', { exact: true }).fill('Delayed save');
  await page.getByLabel('Endpoint', { exact: true }).fill(`${origin}/mcp/delayed_save`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saved!: () => void;
  const received = new Promise<void>(resolve => { saved = resolve; });
  await page.route('**/api/admin/servers', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); saved(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await received;
  await expect(page.getByRole('button', { name: 'Saving server…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel editing' })).toBeDisabled();
  await expect(page.getByLabel('Endpoint', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('region', { name: 'Server editor' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Server details' })).toHaveCount(0);
  await expect(page.getByText('Server saved.', { exact: false })).toHaveCount(0);
});
