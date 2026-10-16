// Run from the repository root with the dashboard test dependencies installed.
// Uses a disposable eligible account; logs no passwords, cookies or response bodies.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const origin = new URL(process.env.DASHBOARD_ORIGIN);
const require = createRequire(`${process.cwd()}/apps/dashboard/package.json`);
const { chromium, expect } = require('@playwright/test');
let browser;
let stage = 'launch';
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.VERIFICATION_ALLOW_SELF_SIGNED === 'true' });
  const page = await context.newPage();
  stage = 'direct link';
  await page.goto(new URL('/keys', origin).href);
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  stage = 'login';
  await page.getByLabel('Email').fill(process.env.DASHBOARD_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(await readFile(process.env.DASHBOARD_PASSWORD_FILE, 'utf8'));
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('navigation')).toContainText(process.env.DASHBOARD_EMAIL);
  stage = 'session reload';
  await page.goto(new URL('/keys', origin).href);
  await expect(page.getByRole('heading', { name: 'Personal API keys', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Personal API keys', exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find(c => c.name === 'urumi_dashboard');
  if (!cookie || cookie.secure !== (origin.protocol === 'https:') || !cookie.httpOnly || cookie.path !== '/api') throw new Error();
  stage = 'CSRF and logout';
  if ((await page.request.post(new URL('/api/keys', origin).href, { headers: { Origin: origin.origin }, data: {} })).status() !== 403) throw new Error();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByText('Logged out.')).toBeVisible();
  if ((await page.request.get(new URL('/api/auth/me', origin).href)).status() !== 401) throw new Error();
  console.log('Production-image browser deep link, HTTPS login, Secure cookie, reload, CSRF and logout passed');
} catch { console.error(`Production-image browser check failed at ${stage}`); process.exitCode = 1; }
finally { await browser?.close(); }
