// Read-only: executes bounded probes in existing Pods; creates no resources.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { createRequire } from 'node:module';

const timeout = 4000;
function tcp(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeout);
    socket.once('connect', () => finish('connected'));
    socket.once('error', () => finish('error'));
  });
}

async function inPod(config, control) {
  const results = {};
  for (const target of config.targets) {
    if (!control || target.expect === 'denied') results[target.name] = await tcp(target.host, target.port);
  }
  if (control) return results;
  const resolver = new Resolver({ timeout, tries: 1 });
  try {
    await resolver.resolve4(config.dnsName);
    results.dnsUdp = 'ok';
  } catch { results.dnsUdp = 'error'; }
  finally { resolver.cancel(); }
  // The UDP lookup above uses the Pod resolver. Test TCP access to that same resolver.
  const address = readFileSync('/etc/resolv.conf', 'utf8').match(/^nameserver\s+(\S+)/m)?.[1];
  results.dnsTcp = address ? await tcp(address, 53) : 'error';
  try {
    // Use the deployed driver's real URI, including TLS/SRV/replica-set discovery.
    // Never return this URI or raw driver errors to the operator terminal.
    const require = createRequire('/app/apps/gateway/package.json');
    const mongoose = require('mongoose');
    const connection = mongoose.createConnection();
    try {
      await connection.openUri(process.env.MONGODB_URI, { serverSelectionTimeoutMS: timeout, connectTimeoutMS: timeout });
      await connection.db.admin().command({ ping: 1 }, { timeoutMS: timeout });
      results.mongodb = 'ok';
    } finally { await connection.close(); }
  } catch { results.mongodb = 'error'; }
  const directory = '/var/run/secrets/kubernetes.io/serviceaccount';
  for (const [name, ref] of Object.entries(config.secretReads)) {
    try {
      const token = readFileSync(`${directory}/token`, 'utf8').trim();
      const ca = readFileSync(`${directory}/ca.crt`);
      results[name] = await new Promise(resolve => {
        const request = https.get(`https://kubernetes.default.svc/api/v1/namespaces/${encodeURIComponent(ref.namespace)}/secrets/${encodeURIComponent(ref.name)}`,
          { ca, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) }, response => {
            // Discard Secret bodies; never log or decode their contents.
            response.resume();
            response.once('end', () => resolve(response.statusCode));
            response.once('error', () => resolve('error'));
          });
        request.once('error', () => resolve('error'));
      });
    } catch { results[name] = 'error'; }
  }
  return results;
}

function validate(config) {
  if (!config.namespace || !config.gatewayPod || !config.controlNamespace || !config.controlPod || !config.dnsName) throw Error('Pod, namespace and DNS settings required');
  if (!Array.isArray(config.targets) || config.targets.length < 5) throw Error('Provide all upstreams and two denied controls');
  const names = new Set();
  for (const target of config.targets) {
    if (!/^[a-zA-Z0-9_-]+$/.test(target.name) || names.has(target.name) || !target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !['allowed', 'denied'].includes(target.expect)) throw Error('Invalid target');
    names.add(target.name);
  }
  for (const [name, port] of Object.entries({ woocommerce: 3001, calculator: 3002, time: 3003 })) {
    if (!config.targets.some(t => t.name === name && t.port === port && t.expect === 'allowed')) throw Error('All three internal MCP targets required');
  }
  for (const name of ['deniedSameNamespace', 'deniedOtherNamespace']) {
    if (!config.targets.some(t => t.name === name && t.expect === 'denied')) throw Error('Same-namespace and cross-namespace denied controls required');
  }
  for (const name of ['approvedSecret', 'deniedSecret', 'deniedNamespaceSecret']) {
    const ref = config.secretReads?.[name];
    if (!ref || !/^[a-z0-9.-]+$/.test(ref.name) || !/^[a-z0-9-]+$/.test(ref.namespace)) throw Error('Three Secret read references required');
  }
  if (config.secretReads.approvedSecret.namespace !== config.namespace || config.secretReads.deniedSecret.namespace !== config.namespace || config.secretReads.deniedNamespaceSecret.namespace === config.namespace) throw Error('Secret read namespace mismatch');
}

if (process.argv[2] === '--in-pod') {
  try {
    const config = JSON.parse(process.argv[3]);
    console.log(JSON.stringify(await inPod(config, process.argv[4] === 'control')));
  } catch { process.exitCode = 1; }
} else if (process.argv.length !== 3 || process.argv[2] === '--help') {
  console.log('Usage: node infra/helm/urumi/verify-gateway-egress.mjs /path/to/nonsecret-probes.json\nSee docs/operations/gateway-egress.md. Requires existing gateway and Node.js control Pods.');
  if (process.argv[2] !== '--help') process.exitCode = 1;
} else {
  try {
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    validate(config);
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    function probe(namespace, pod, mode) {
      const result = spawnSync('kubectl', ['exec', '-i', '-n', namespace, pod, '--', 'node', '--input-type=module', '-', '--in-pod', JSON.stringify(config), mode],
        { input: source, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw Error('Pod probe failed; check kubectl context, exec permission and Node.js availability');
      return JSON.parse(result.stdout);
    }
    const control = probe(config.controlNamespace, config.controlPod, 'control');
    const gateway = probe(config.namespace, config.gatewayPod, 'gateway');
    let failed = false;
    function check(name, success) {
      console.log(`${success ? 'PASS' : 'FAIL'} ${name}`);
      failed ||= !success;
    }
    for (const target of config.targets) {
      check(target.name, target.expect === 'allowed' ? gateway[target.name] === 'connected' :
        control[target.name] === 'connected' && gateway[target.name] === 'timeout');
    }
    check('DNS UDP resolution', gateway.dnsUdp === 'ok');
    check('DNS TCP reachability', gateway.dnsTcp === 'connected');
    check('MongoDB driver ping', gateway.mongodb === 'ok');
    check('approved live Secret GET', gateway.approvedSecret === 200);
    check('unapproved live Secret GET', gateway.deniedSecret === 403);
    check('cross-namespace live Secret GET', gateway.deniedNamespaceSecret === 403);
    if (failed) process.exitCode = 1;
  } catch (error) {
    // Do not print remote output, config, Secret bodies or connection errors.
    console.error(error instanceof SyntaxError ? 'Invalid configuration or probe response' : 'Verification failed; check nonsecret configuration and prerequisites');
    process.exitCode = 1;
  }
}
