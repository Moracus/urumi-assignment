import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const loader = new URL('./run-with-env.mjs', import.meta.url).href;

test('workspace env loads from any cwd, preserves shell overrides, and isolates service ports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urumi-env-'));
  try {
    const path = join(directory, '.env');
    writeFileSync(path, 'GATEWAY_PORT=3100\nTIME_MCP_PORT=3103\nHOST=127.0.0.1\n');
    for (const [service, overrides, port, host] of [
      ['gateway', {}, '3100', '127.0.0.1'],
      ['time-mcp', {}, '3103', '127.0.0.1'],
      ['gateway', { GATEWAY_PORT: '3200', HOST: 'localhost' }, '3200', 'localhost'],
      ['gateway', { PORT: '3300' }, '3300', '127.0.0.1'],
    ]) {
      const env = { ...process.env };
      for (const key of ['PORT', 'GATEWAY_PORT', 'TIME_MCP_PORT', 'HOST']) delete env[key];
      Object.assign(env, overrides);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { loadWorkspaceEnv } from ${JSON.stringify(loader)};
         loadWorkspaceEnv(${JSON.stringify(service)}, ${JSON.stringify(path)});
         console.log(JSON.stringify([process.env.PORT, process.env.HOST]));`],
      { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [port, host]);
    }
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { loadWorkspaceEnv } from ${JSON.stringify(loader)};
       loadWorkspaceEnv('gateway', ${JSON.stringify(join(directory, 'missing'))});`],
    { encoding: 'utf8' });
    assert.equal(missing.status, 0, missing.stderr);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('launcher forwards arguments and child exit status', () => {
  const script = new URL('./run-with-env.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, 'calculator-mcp', process.execPath,
    '--input-type=module', '-e',
    'if (process.argv[1] !== "argument with spaces") process.exit(1); process.exit(7);',
    'argument with spaces'], { encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
});
