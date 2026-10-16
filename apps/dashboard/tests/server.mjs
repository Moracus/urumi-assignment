import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'vite';
import { createGatewayApp } from '../../gateway/dist/app.js';
import { connectIdentityStorage } from '../../gateway/dist/identity/storage.js';
import { initializeAdministrator } from '../../gateway/dist/identity/initial-setup.js';

if (!process.env.MONGODB_TEST_URI) throw new Error('MONGODB_TEST_URI must point to a disposable replica set');
const uri = new URL(process.env.MONGODB_TEST_URI);
uri.pathname = `/urumi_browser_${randomUUID().replaceAll('-', '')}`;
process.env.DASHBOARD_ALLOW_HTTP = 'true';
process.env.DASHBOARD_TRUSTED_ORIGINS = 'http://localhost:5174';
const storage = await connectIdentityStorage(uri.toString());
await initializeAdministrator(storage, {
  email: 'admin@example.com', password: 'browser administrator password',
  suppliedSecret: 'test-only', configuredSecret: 'test-only',
});
// Resolve controlled-upstream dependencies from the gateway workspace that owns them.
const requireGateway = createRequire(new URL('../../gateway/package.json', import.meta.url));
const { createMcpFastifyApp } = requireGateway('@modelcontextprotocol/fastify');
const { toNodeHandler } = requireGateway('@modelcontextprotocol/node');
const { createMcpHandler, McpServer } = requireGateway('@modelcontextprotocol/server');
const { z } = requireGateway('zod/v4');
const upstream = createMcpFastifyApp({ host: '127.0.0.1' });
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'browser-controlled', version: '1' });
  server.registerTool('calculate', { description: '<img src=x onerror="window.upstreamExecuted=true">', inputSchema: z.object({ operation: z.literal('multiply'), a: z.number(), b: z.number() }) },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a * b) }] }));
  server.registerTool('current', { inputSchema: z.object({ timezone: z.string() }) },
    async () => ({ content: [{ type: 'text', text: '2026-10-16T00:00:00Z' }] }));
  server.registerTool('list_products', {}, async () => ({ content: [{ type: 'text', text: 'Controlled product' }] }));
  for (const name of ['create_product', 'update_order_status']) {
    server.registerTool(name, {}, async () => ({ content: [{ type: 'text', text: 'WRITE WAS INVOKED' }] }));
  }
  return server;
});
const nodeHandler = toNodeHandler(handler);
const replacementHandler = createMcpHandler(() => {
  const server = new McpServer({ name: 'replacement-controlled', version: '1' });
  server.registerTool('current', { description: 'Replacement catalog', inputSchema: z.object({ timezone: z.literal('UTC') }) },
    async () => ({ content: [{ type: 'text', text: 'Replacement clock' }] }));
  return server;
});
const replacementNodeHandler = toNodeHandler(replacementHandler);
upstream.all('/offline', async (_request, reply) => reply.code(503).send({ error: 'private upstream diagnostic' }));
upstream.all('/offline/:namespace', async (_request, reply) => reply.code(503).send({ error: 'private upstream diagnostic' }));
upstream.all('/mcp/:namespace', (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
upstream.all('/secured/:variant', (request, reply) => {
  const replacement = request.params.variant === 'replacement';
  const authorized = replacement ? request.headers['x-upstream-token'] === 'synthetic-browser-two'
    : request.headers.authorization === 'Bearer synthetic-browser-one';
  if (!authorized) return reply.code(401).send({ error: 'Unauthorized' });
  return (replacement ? replacementNodeHandler : nodeHandler)(request.raw, reply.raw, request.body);
});
upstream.addHook('onClose', () => handler.close());
upstream.addHook('onClose', () => replacementHandler.close());
const upstreamAddress = await upstream.listen({ host: '127.0.0.1', port: 0 });
const gateway = await createGatewayApp({ mongodbUri: uri.toString(),
  approvedSecrets: ['browser-private-reference', 'browser-replacement-reference'].map(name => ({ namespace: 'urumi', name, key: 'token' })),
  secretReader: { async read(reference) {
    if (reference.name === 'browser-private-reference') return 'synthetic-browser-one';
    if (reference.name === 'browser-replacement-reference') return 'synthetic-browser-two';
    throw new Error('Secret unavailable');
  } },
  upstreams: ['calculator', 'time', 'woocommerce'].map(name => ({ name, url: `${upstreamAddress}/mcp/${name}`, enabled: true })),
  destinations: { allowLoopback: true, rules: [{ origin: upstreamAddress, cidrs: ['127.0.0.1/32'] }] },
});
await gateway.listen({ host: '127.0.0.1', port: 3009 });
const vite = await createServer({
  define: { 'import.meta.env.VITE_PUBLIC_MCP_URL': JSON.stringify('http://localhost:5174/mcp') },
  // Test arrangement only; this middleware is absent from production Vite config.
  plugins: [{ name: 'expire-test-session', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url === '/api/__test/reset-login-budget' && request.method === 'POST') {
        await storage.loginThrottles.deleteMany({});
        response.statusCode = 204; response.end(); return;
      }
      if (request.url !== '/api/__test/expire-session' || request.method !== 'POST') return next();
      const cookie = (request.headers.cookie ?? '').split(';').map(value => value.trim())
        .find(value => value.startsWith('urumi_dashboard='))?.slice('urumi_dashboard='.length);
      if (!cookie) { response.statusCode = 400; response.end(); return; }
      try {
        await storage.sessions.updateOne({ credentialHash: createHash('sha256').update(cookie).digest('hex') },
          { $set: { expiresAt: new Date(Date.now() - 1) } });
        response.statusCode = 204; response.end();
      } catch { response.statusCode = 503; response.end(); }
    });
  } }],
  server: { host: 'localhost', port: 5174, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3009', '/mcp': 'http://127.0.0.1:3009' } },
});
await vite.listen();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await vite.close();
  await gateway.close();
  await upstream.close();
  await storage.connection.dropDatabase();
  await storage.close();
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
