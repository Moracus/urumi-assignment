import { test, expect } from '@playwright/test';

test('connection instructions load runtime configuration and recover from a safe error', async ({ page, request }) => {
  await request.post('/api/__test/reset-login-budget');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/runtime-config.json', async route => {
    await gate;
    await route.fulfill({ status: 503, body: 'private diagnostic' });
  });
  await page.goto('/keys');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(page.getByText('Loading connection configuration…')).toBeVisible();
  release();
  await expect(page.getByText('Unable to load connection configuration. Try again.')).toBeVisible();
  expect(await page.content()).not.toContain('private diagnostic');
  await page.unroute('**/runtime-config.json');
  await page.getByRole('button', { name: 'Retry connection configuration' }).click();
  await expect(page.getByText('Public MCP URL:')).toContainText('http://localhost:5174/mcp');
  await page.route('**/runtime-config.json', route => route.fulfill({ json: { publicMcpUrl: 'https://public-gateway.example.test/mcp' } }));
  await page.reload();
  await expect(page.getByText('Public MCP URL:')).toContainText('https://public-gateway.example.test/mcp');
  await expect(page.getByLabel('MCP client connection example')).toContainText('https://public-gateway.example.test/mcp');
  expect(await page.getByLabel('MCP client connection example').textContent()).not.toContain('urumi-calculator-mcp');
});

for (const [name, config] of [
  ['missing URL', {}], ['empty URL', { publicMcpUrl: '' }],
  ...['https://user:private@gateway.test/mcp', 'https://gateway.test/mcp?token=private',
    'https://gateway.test/mcp#private', 'ftp://gateway.test/mcp', '/mcp',
    'http://gateway.test:99999/mcp', 'https://gateway.test/other',
    ' https://gateway.test/mcp', 'https://gateway.test/mcp\n', 'https://gateway.test/mcp\\oops'].map(publicMcpUrl => [publicMcpUrl, { publicMcpUrl }]),
  ['unexpected fields', { publicMcpUrl: 'https://gateway.test/mcp', providerKey: 'private' }],
  ['non-string', { publicMcpUrl: 42 }],
] as const) {
  test(`connection instructions reject ${name}`, async ({ page, request }) => {
    await request.post('/api/__test/reset-login-budget');
    await page.route('**/runtime-config.json', route => route.fulfill({ json: config }));
    await page.goto('/keys');
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByLabel('Password', { exact: true }).fill('browser administrator password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Ask the operator to set dashboard.publicMcpUrl');
    await expect(page.locator('pre')).toHaveCount(0);
    expect(await page.content()).not.toContain('private');
  });
}
