import { test, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function inspect(page: Page, id: string) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.goto('/admin/servers');
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://localhost:5174', 'X-CSRF-Token': me.csrfToken };
  const { server } = await (await page.request.get('/api/admin/servers/calculator')).json();
  const upstreamOrigin = new URL(server.url).origin;
  const mode = async (value: string) => expect((await page.request.post(`${upstreamOrigin}/control/${id}`, { data: { mode: value } })).status()).toBe(204);
  await mode('auth');
  expect((await page.request.post('/api/admin/servers', { headers, data: {
    serverId: id, displayName: id, url: `${upstreamOrigin}/controlled/${id}`,
    transport: 'streamable-http', enabled: true, authentication: { type: 'none' },
  } })).status()).toBe(201);
  await page.getByRole('button', { name: 'Refresh servers', exact: true }).click();
  await page.getByRole('button', { name: `Inspect ${id}`, exact: true }).click();
  const details = page.getByRole('region', { name: 'Server details' });
  return { details, headers, mode, upstreamOrigin };
}

for (const width of [360, 768, 1440]) test(`diagnostic guidance is safe, readable and recoverable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const id = `diagnostic_${width}`;
  const { details, mode } = await inspect(page, id);
  const failure = details.getByRole('region', { name: 'Current server failure' });
  await expect(failure).toContainText('Failure stage: Connection / handshake');
  await expect(failure).toContainText('upstream rejected HTTP authentication');
  await expect(failure.locator('time')).toHaveAttribute('datetime', /T/);
  expect(await page.content()).not.toContain('synthetic-diagnostic-secret');
  expect(await page.content()).not.toContain('https://private.example/diagnostic');
  await mode('discovery_error');
  await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
  await expect(failure).toContainText('Failure stage: Tool discovery');
  await expect(failure).toContainText('tools could not be discovered');
  await expect(failure).not.toContainText('hostname could not be resolved');
  await expect(details).toContainText('No available tools.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/urumi-55-diagnostics-${width}.png`, fullPage: true });
  await mode('valid');
  await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
  await expect(details).toContainText('Runtime statusconnected');
  await expect(failure).toHaveCount(0);
  await page.route(`**/api/admin/servers/${id}`, route => route.fulfill({ status: 503, json: { error: 'synthetic-diagnostic-secret' } }));
  await details.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(details.getByRole('alert')).toHaveText('Service unavailable. Try again later.');
  await expect(details).toContainText('Stale data');
  await expect(failure).toHaveCount(0);
});

test('invocation diagnostics preserve tool errors, isolate failures and explain uncertain writes without replay', async ({ page }) => {
  test.setTimeout(60000);
  const { details, headers, mode, upstreamOrigin } = await inspect(page, 'diagnostic_calls');
  await mode('tool_error');
  await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
  await expect(details).toContainText('Runtime statusconnected');
  const { rawKey } = await (await page.request.post('/api/keys', { headers, data: {} })).json();
  const client = new Client({ name: 'diagnostics-browser', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5174/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  const refreshDetails = async () => { await details.getByRole('button', { name: 'Refresh details', exact: true }).click(); };
  try {
    const error = await client.callTool({ name: 'diagnostic_calls_calculate', arguments: {} });
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toEqual({ reason: 'valid tool error' });
    await refreshDetails();
    await expect(details).toContainText('Runtime statusconnected');
    await expect(details.getByRole('region', { name: 'Current server failure' })).toHaveCount(0);
    for (const [value, copy] of [['invocation_error', 'A tool request failed.'], ['invalid', 'invalid MCP response'], ['timeout', 'Writes may have completed.']]) {
      await mode(value);
      if (value !== 'invocation_error') {
        await details.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
        await expect(details).toContainText('Runtime statusconnected');
      }
      await client.callTool({ name: 'diagnostic_calls_calculate', arguments: {} }, { timeout: 15000 });
      await refreshDetails();
      const failure = details.getByRole('region', { name: 'Current server failure' });
      await expect(failure).toContainText('Failure stage: Tool invocation');
      await expect(failure).toContainText(copy);
      expect((await client.callTool({ name: 'calculator_calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).content).toEqual([{ type: 'text', text: '42' }]);
      expect(await page.content()).not.toContain('synthetic-diagnostic-secret');
      expect(await page.content()).not.toContain('https://private.example/diagnostic');
    }
    await expect(details).toContainText('Investigate the operation outcome before any explicit retry');
    await refreshDetails();
    expect((await (await page.request.get(`${upstreamOrigin}/control/diagnostic_calls`)).json()).timeoutCalls).toBe(1);
  } finally { await mode('valid'); await client.close(); }
});
