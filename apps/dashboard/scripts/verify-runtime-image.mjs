// Build once, then run: node apps/dashboard/scripts/verify-runtime-image.mjs <image>
// Browser API fixtures isolate static-image behavior; this is not a live gateway check.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const image = process.argv[2];
if (!image) throw new Error('Pass the dashboard image tag to verify');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const imageId = docker('image', 'inspect', '--format', '{{.Id}}', image);
const directory = mkdtempSync(join(tmpdir(), 'urumi-runtime-'));
const browser = await chromium.launch();
const results = [];
try {
  for (const [name, config, expected] of [
    ['local', { publicMcpUrl: 'http://gateway.localhost:8080/mcp' }, 'http://gateway.localhost:8080/mcp'],
    ['production-like', { publicMcpUrl: 'https://gateway.example.test/mcp' }, 'https://gateway.example.test/mcp'],
    ['missing URL', {}, 'not been configured'],
    ['empty URL', { publicMcpUrl: '' }, 'not been configured'],
    ['embedded credential', { publicMcpUrl: 'https://user:private@gateway.test/mcp' }, 'configuration is invalid'],
    ['wrong path', { publicMcpUrl: 'https://gateway.test/other' }, 'configuration is invalid'],
    ['missing file', undefined, 'Unable to load connection configuration'],
  ]) {
    const file = join(directory, `config-${results.length}.json`);
    writeFileSync(file, JSON.stringify(config ?? {}));
    const id = docker('run', '-d', '--rm', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '-p', '127.0.0.1::8080', ...(config === undefined ? [] : ['--mount', `type=bind,src=${file},dst=/usr/share/nginx/html/runtime-config.json,readonly`]), imageId);
    const context = await browser.newContext();
    try {
      assert.equal(docker('inspect', '--format', '{{.Image}}', id), imageId);
      const binding = docker('port', id, '8080/tcp');
      const origin = `http://${binding}`;
      for (let attempt = 0; ; attempt++) {
        try { if ((await fetch(`${origin}/health/live`)).ok) break; } catch { /* wait for nginx */ }
        if (attempt === 50) throw new Error('Image did not become ready');
        await setTimeout(100);
      }
      for (const path of ['/keys', '/admin/servers', '/admin/users']) {
        assert.equal((await fetch(`${origin}${path}`)).status, 200);
      }
      for (const path of ['/mcp', '/api/auth/me', '/assets/missing.js']) {
        assert.equal((await fetch(`${origin}${path}`)).status, 404);
      }
      const response = await fetch(`${origin}/runtime-config.json`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (config === undefined) assert.equal(response.status, 404);
      else {
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(await response.json(), config);
      }
      const page = await context.newPage();
      // Synthetic authenticated member: only static rendering/configuration is under test here.
      await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/me') return route.fulfill({ json: {
          csrfToken: 'a'.repeat(64), user: { id: '1'.repeat(24), email: 'fixture@example.test',
            role: 'member', status: 'active', requiredPasswordChange: false,
            createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' },
        } });
        if (path === '/api/keys') return route.fulfill({ json: { keys: [], page: 1, limit: 10 } });
        return route.fulfill({ status: 404, json: {} });
      });
      await page.goto(`${origin}/keys`);
      await page.getByRole('heading', { name: 'Personal API keys' }).waitFor();
      await page.getByText(expected, { exact: false }).first().waitFor();
      if (name === 'local' || name === 'production-like') {
        assert.match(await page.locator('pre').innerText(), /<YOUR_GATEWAY_API_KEY>/);
        assert.ok((await page.locator('pre').innerText()).includes(expected));
        await page.goto(`${origin}/`);
        await page.getByText('Public MCP URL:').waitFor();
        assert.ok((await page.getByText('Public MCP URL:').innerText()).includes(expected));
      } else {
        assert.equal(await page.locator('pre').count(), 0);
        assert.ok(!(await page.content()).includes('private'));
      }
      assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
      results.push(name);
    } finally {
      await context.close();
      docker('stop', id);
    }
  }
  console.log(JSON.stringify({ imageId, passed: results, liveGatewayOrClusterChecked: false }, null, 2));
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
