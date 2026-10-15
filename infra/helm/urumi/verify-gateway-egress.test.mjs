// CLI regression tests substitute only the external kubectl process.
// These are not live networking or Kubernetes authorization checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const config = {
  namespace: 'urumi', gatewayPod: 'gateway', controlNamespace: 'verification', controlPod: 'control', dnsName: 'calculator.urumi.svc.cluster.local',
  targets: [
    { name: 'woocommerce', host: 'woocommerce', port: 3001, expect: 'allowed' },
    { name: 'calculator', host: 'calculator', port: 3002, expect: 'allowed' },
    { name: 'time', host: 'time', port: 3003, expect: 'allowed' },
    { name: 'deniedSameNamespace', host: 'unrelated.urumi', port: 8080, expect: 'denied' },
    { name: 'deniedOtherNamespace', host: 'unrelated.other', port: 8080, expect: 'denied' },
  ],
  secretReads: {
    approvedSecret: { namespace: 'urumi', name: 'approved' },
    deniedSecret: { namespace: 'urumi', name: 'unapproved' },
    deniedNamespaceSecret: { namespace: 'other', name: 'unapproved' },
  },
};
const goodGateway = { woocommerce: 'connected', calculator: 'connected', time: 'connected', deniedSameNamespace: 'timeout', deniedOtherNamespace: 'timeout', dnsUdp: 'ok', dnsTcp: 'connected', mongodb: 'ok', approvedSecret: 200, deniedSecret: 403, deniedNamespaceSecret: 403 };
const goodControl = { deniedSameNamespace: 'connected', deniedOtherNamespace: 'connected' };
function run(gateway = goodGateway, control = goodControl, input = config) {
  const directory = mkdtempSync(join(tmpdir(), 'urumi-egress-cli-'));
  try {
    const kubectl = join(directory, 'kubectl');
    writeFileSync(kubectl, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => console.log(JSON.stringify(process.argv.at(-1) === 'control' ? ${JSON.stringify(control)} : ${JSON.stringify(gateway)})));\n`, { mode: 0o700 });
    const file = join(directory, 'config.json');
    writeFileSync(file, JSON.stringify(input));
    return spawnSync(process.execPath, [resolve('infra/helm/urumi/verify-gateway-egress.mjs'), file], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, timeout: 10000,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('complete controlled matrix passes without printing remote payloads', () => {
  const result = run({ ...goodGateway, secretBody: 'synthetic-private-material' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PASS approved live Secret GET/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-material/);
});

test('a dead control or refused gateway socket cannot pass as egress denial', () => {
  for (const result of [run(goodGateway, { ...goodControl, deniedSameNamespace: 'timeout' }), run({ ...goodGateway, deniedOtherNamespace: 'error' })]) {
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL denied/);
  }
});

test('a missing Secret or broken required dependency fails verification', () => {
  for (const replacement of [{ deniedSecret: 404 }, { approvedSecret: 403 }, { mongodb: 'error' }, { dnsUdp: 'error' }, { time: 'timeout' }]) {
    const result = run({ ...goodGateway, ...replacement });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL/);
  }
});

test('incomplete verification matrices fail before kubectl', () => {
  const result = run(goodGateway, goodControl, { ...config, targets: config.targets.slice(0, 3) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Verification failed/);
  assert.equal(result.stdout, '');
});
