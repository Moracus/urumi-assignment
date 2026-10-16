// Read-only unless credentials are supplied for a disposable verification account.
// No credential, cookie, CSRF token, or response body is printed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

const origin = new URL(process.env.DASHBOARD_ORIGIN);
const gateway = new URL(process.env.PUBLIC_MCP_URL);
// Optional local ingress tunnel. Preserve the public Host and Origin on requests.
const transport = process.env.INGRESS_TRANSPORT_URL;
async function request(publicUrl, path, options = {}) {
  const url = new URL(path, publicUrl);
  const target = transport ? new URL(url.pathname + url.search, transport) : url;
  // Node Fetch may discard an explicit Host; use HTTP directly for ingress tunnels.
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(target, {
      method: options.method ?? 'GET', headers: { host: url.host, ...options.headers },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve({ status: response.statusCode, headers, text: async () => body, json: async () => JSON.parse(body) });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Deployment request timed out')));
    req.on('error', reject);
    req.end(options.body);
  });
}
const index = await request(origin, '/');
assert.equal(index.status, 200);
const html = await index.text();
assert.match(html, /<div id="root">/);
for (const path of ['/login', '/keys', '/admin/users', '/admin/servers/unknown']) {
  const response = await request(origin, path);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
}
for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) {
  const response = await request(origin, asset[1]);
  assert.equal(response.status, 200);
  assert.ok(!response.headers.get('content-type')?.includes('text/html'));
}
assert.equal((await request(origin, '/assets/missing.js')).status, 404);
assert.equal((await request(origin, '/mcp')).status, 404);
assert.equal((await request(origin, '/api/auth/me')).status, 401);
assert.equal((await request(gateway, '/mcp')).status, 401);
console.log('Deployment SPA deep links, assets, API routing and MCP separation passed');

if (process.env.DASHBOARD_PASSWORD_FILE && process.env.DASHBOARD_EMAIL) {
  const password = (await readFile(process.env.DASHBOARD_PASSWORD_FILE, 'utf8')).trim();
  const loginOptions = { method: 'POST', headers: { origin: origin.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.DASHBOARD_EMAIL, password }) };
  assert.equal((await request(origin, '/api/auth/login', { ...loginOptions,
    headers: { ...loginOptions.headers, origin: 'https://untrusted.invalid' } })).status, 403);
  const login = await request(origin, '/api/auth/login', loginOptions);
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\/api/i);
  assert.equal(/; Secure/i.test(setCookie), origin.protocol === 'https:');
  const cookie = setCookie.split(';')[0];
  const { csrfToken, user } = await login.json();
  assert.equal(user.requiredPasswordChange, false, 'Use an eligible disposable account');
  assert.equal((await request(origin, '/api/auth/me', { headers: { cookie } })).status, 200);
  assert.equal((await request(origin, '/api/keys', { method: 'POST', headers: {
    cookie, origin: origin.origin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request(origin, '/api/auth/logout', { method: 'POST', headers: {
    cookie, origin: 'https://untrusted.invalid', 'x-csrf-token': csrfToken } })).status, 403);
  assert.equal((await request(gateway, '/mcp', { headers: { cookie } })).status, 401);
  assert.equal((await request(origin, '/api/auth/logout', { method: 'POST', headers: {
    cookie, origin: origin.origin, 'x-csrf-token': csrfToken } })).status, 204);
  assert.equal((await request(origin, '/api/auth/me', { headers: { cookie } })).status, 401);
  console.log('Deployment session cookie, trusted Origin, CSRF, logout and bearer separation passed');
} else {
  console.log('Session checks NOT EXECUTED: supply a disposable account email and password file');
}
