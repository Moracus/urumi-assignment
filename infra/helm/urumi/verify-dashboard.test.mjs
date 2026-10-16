import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Exercise the verifier's failure output through its HTTP/process boundary.
test('cookie attribute failures never disclose the session credential', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'urumi-dashboard-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const passwordFile = join(directory, 'password');
  await writeFile(passwordFile, 'synthetic verification password', { mode: 0o600 });
  const sentinel = 'synthetic-session-that-must-not-be-logged';
  let attributes;
  const server = createServer((request, response) => {
    if (request.url === '/mcp') {
      response.writeHead(request.headers.host === 'gateway.test' ? 401 : 404).end();
    } else if (request.url === '/assets/missing.js') {
      response.writeHead(404).end();
    } else if (request.url === '/api/auth/me') {
      response.writeHead(401).end();
    } else if (request.url === '/api/auth/login') {
      if (request.headers.origin === 'https://untrusted.invalid') {
        response.writeHead(403).end();
      } else {
        response.writeHead(200, { 'content-type': 'application/json',
          'set-cookie': `urumi_dashboard=${sentinel}; ${attributes}` });
        response.end(JSON.stringify({ user: { requiredPasswordChange: false }, csrfToken: 'synthetic-csrf' }));
      }
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<div id="root"></div>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (attributes of ['Path=/api; SameSite=Lax', 'Path=/api; HttpOnly', 'Path=/wrong; HttpOnly; SameSite=Lax']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['infra/helm/urumi/verify-dashboard.mjs'], {
        env: { ...process.env, DASHBOARD_ORIGIN: 'http://dashboard.test', PUBLIC_MCP_URL: 'http://gateway.test/mcp',
          INGRESS_TRANSPORT_URL: `http://127.0.0.1:${server.address().port}`, DASHBOARD_EMAIL: 'verification@example.com',
          DASHBOARD_PASSWORD_FILE: passwordFile },
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.ok(result.output.includes('cookie attribute') || result.output.includes('cookie path'), 'Expected cookie validation failure');
    assert.ok(!result.output.includes(sentinel), 'Session credential must never appear in verifier output');
  }
});
