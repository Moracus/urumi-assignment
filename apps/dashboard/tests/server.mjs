import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'vite';
import { createGatewayApp } from '../../gateway/dist/app.js';
import { connectIdentityStorage } from '../../gateway/dist/identity/storage.js';
import { initializeAdministrator } from '../../gateway/dist/identity/initial-setup.js';
import { commerceFixture } from '../../woocommerce-mcp/test/commerce-fixture.mjs';

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
function controlledHandler(namespace) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'browser-controlled', version: '1' });
    server.registerTool('calculate', { description: `${namespace === 'calculator' ? 'Default calculator fixture. ' : ''}<img src=x onerror="window.upstreamExecuted=true">`, inputSchema: z.object({ operation: z.literal('multiply'), a: z.number(), b: z.number() }) },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a * b) }] }));
    server.registerTool('current', { description: namespace === 'time' ? 'Default time fixture clock' : 'Shared fixture clock', inputSchema: z.object({ timezone: z.string() }) },
      async () => ({ content: [{ type: 'text', text: '2026-10-16T00:00:00Z' }] }));
    server.registerTool('list_products', {}, async () => ({ content: [{ type: 'text', text: 'Controlled product' }] }));
    server.registerTool('list_orders', {}, async () => ({ content: [{ type: 'text', text: 'Controlled orders' }] }));
    server.registerTool('get_order', { inputSchema: z.object({ order_id: z.number().int().positive() }) },
      async ({ order_id }) => ({ content: [{ type: 'text', text: `Controlled order ${order_id}` }] }));
    for (const name of ['create_product', 'update_order_status']) {
      server.registerTool(name, {}, async () => ({ content: [{ type: 'text', text: 'WRITE WAS INVOKED' }] }));
    }
    return server;
  });
}
const handler = controlledHandler('shared');
const calculatorHandler = controlledHandler('calculator');
const timeHandler = controlledHandler('time');
const nodeHandler = toNodeHandler(handler);
const defaultNodeHandlers = { calculator: toNodeHandler(calculatorHandler), time: toNodeHandler(timeHandler) };
const replacementHandler = createMcpHandler(() => {
  const server = new McpServer({ name: 'replacement-controlled', version: '1' });
  server.registerTool('current', { description: 'Replacement catalog', inputSchema: z.object({ timezone: z.literal('UTC') }) },
    async () => ({ content: [{ type: 'text', text: 'Replacement clock' }] }));
  return server;
});
const replacementNodeHandler = toNodeHandler(replacementHandler);
// Test-only public boundary for changing a controlled upstream without touching registry internals.
const upstreamModes = new Map();
upstream.post('/control/:namespace', async (request, reply) => {
  const mode = request.body?.mode;
  if (!['valid', 'changed', 'offline'].includes(mode)) return reply.code(400).send();
  upstreamModes.set(request.params.namespace, mode);
  return reply.code(204).send();
});
upstream.all('/controlled/:namespace', (request, reply) => {
  const mode = upstreamModes.get(request.params.namespace) ?? 'valid';
  if (mode === 'offline') return reply.code(503).send({ error: 'private upstream diagnostic with synthetic-browser-one' });
  return (mode === 'changed' ? replacementNodeHandler : nodeHandler)(request.raw, reply.raw, request.body);
});
upstream.all('/offline', async (_request, reply) => reply.code(503).send({ error: 'private upstream diagnostic' }));
upstream.all('/offline/:namespace', async (_request, reply) => reply.code(503).send({ error: 'private upstream diagnostic' }));
upstream.all('/mcp/:namespace', (request, reply) =>
  (defaultNodeHandlers[request.params.namespace] ?? nodeHandler)(request.raw, reply.raw, request.body));
upstream.all('/secured/:variant', (request, reply) => {
  const replacement = request.params.variant === 'replacement';
  const authorized = replacement ? request.headers['x-upstream-token'] === 'synthetic-browser-two'
    : request.headers.authorization === 'Bearer synthetic-browser-one';
  if (!authorized) return reply.code(401).send({ error: 'Unauthorized' });
  return (replacement ? replacementNodeHandler : nodeHandler)(request.raw, reply.raw, request.body);
});
// Deterministic external provider boundary; production uses the fixed OpenAI endpoint.
upstream.post('/provider/chat/completions', async (request, reply) => {
  const { messages, tools } = request.body;
  const prompt = messages.find(message => message.role === 'user')?.content;
  const results = messages.filter(message => message.role === 'tool');
  const proposedCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const toolCalls = calls => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] });
  const final = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
  if (prompt === 'Acceptance: multiply 6 by 7 and get UTC time') {
    if (results.length) {
      if (results.length !== 2 || results[0].tool_call_id !== 'acceptance-calc' || results[1].tool_call_id !== 'acceptance-clock') {
        return reply.code(400).send({ error: 'Unpaired acceptance results' });
      }
      const values = results.map(result => JSON.parse(result.content).content[0].text);
      return final(`Acceptance: ${values[0]}; ${values[1]}`);
    }
    const calculator = tools.find(tool => tool.function.description?.startsWith('Default calculator fixture.')).function.name;
    const time = tools.find(tool => tool.function.description === 'Default time fixture clock').function.name;
    return toolCalls([proposedCall('acceptance-calc', calculator, { operation: 'multiply', a: 6, b: 7 }),
      proposedCall('acceptance-clock', time, { timezone: 'UTC' })]);
  }
  if (prompt === 'Publish Demo Mug at 12.50 with status=publish') {
    if (results.length) {
      const product = JSON.parse(JSON.parse(results[0].content).content[0].text).product;
      return final(`${product.name}: ${product.status}, ${product.regular_price}`);
    }
    const product = tools.find(tool => tool.function.description?.startsWith('Create a new simple product')).function.name;
    return toolCalls([proposedCall('commerce-publish', product, { name: 'Demo Mug', regular_price: '12.50', status: 'publish' })]);
  }
  if (prompt === 'Orders on 2026-03-08 in America/New_York and multiply 6 by 7') {
    if (results.length) {
      const orders = JSON.parse(JSON.parse(results.find(result => result.tool_call_id === 'commerce-orders').content).content[0].text);
      const calculation = JSON.parse(results.find(result => result.tool_call_id === 'commerce-calc').content).content[0].text;
      return final(`${orders.orders.map(order => order.number).join(', ')}; ${orders.date_range.timezone}: [${orders.date_range.start}, ${orders.date_range.end}); calculator: ${calculation}`);
    }
    const orders = tools.find(tool => tool.function.description?.startsWith('List WooCommerce orders')).function.name;
    const calculator = tools.find(tool => tool.function.description?.startsWith('Default calculator fixture.')).function.name;
    return toolCalls([proposedCall('commerce-orders', orders, { date: '2026-03-08', timezone: 'America/New_York' }),
      proposedCall('commerce-calc', calculator, { operation: 'multiply', a: 6, b: 7 })]);
  }
  if (messages.some(message => message.role === 'user' && message.content === 'provider failure')) {
    return reply.code(500).send({ error: 'private synthetic-provider-secret' });
  }
  if (messages.some(message => message.role === 'tool')) {
    if (prompt?.startsWith('Long answer ')) return final('long-answer-'.repeat(300) + '\nSecond line.');
    if (messages.some(message => message.role === 'user' && message.content === 'expire during chat')) {
      await storage.sessions.updateMany({}, { $set: { expiresAt: new Date(0) } });
    }
    if (messages.some(message => message.role === 'user' && message.content === 'fail after calls')) {
      return reply.code(503).send({ error: 'private synthetic-provider-secret' });
    }
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '42 and the UTC time. <img src=x onerror="window.modelExecuted=true">' } }] };
  }
  const calculator = tools.find(tool => tool.function.description?.startsWith('Default calculator fixture.')).function.name;
  const time = tools.find(tool => tool.function.description === 'Default time fixture clock').function.name;
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'browser-calc', type: 'function', function: { name: calculator, arguments: JSON.stringify({ operation: 'multiply', a: 6, b: 7 }) } },
    { id: 'browser-clock', type: 'function', function: { name: time, arguments: JSON.stringify({ timezone: 'UTC' }) } },
    { id: 'browser-invalid', type: 'function', function: { name: calculator, arguments: JSON.stringify({ operation: 'multiply', a: 'six', b: 7 }) } },
  ] } }] };
});
upstream.addHook('onClose', () => handler.close());
upstream.addHook('onClose', () => calculatorHandler.close());
upstream.addHook('onClose', () => timeHandler.close());
upstream.addHook('onClose', () => replacementHandler.close());
const upstreamAddress = await upstream.listen({ host: '127.0.0.1', port: 0 });
const commerce = await commerceFixture();
const gateway = await createGatewayApp({ mongodbUri: uri.toString(),
  chat: { apiKey: 'synthetic-provider-secret', endpoint: `${upstreamAddress}/provider/chat/completions` },
  approvedSecrets: ['browser-private-reference', 'browser-replacement-reference'].map(name => ({ namespace: 'urumi', name, key: 'token' })),
  secretReader: { async read(reference) {
    if (reference.name === 'browser-private-reference') return 'synthetic-browser-one';
    if (reference.name === 'browser-replacement-reference') return 'synthetic-browser-two';
    throw new Error('Secret unavailable');
  } },
  upstreams: [...['calculator', 'time'].map(name => ({ name, url: `${upstreamAddress}/mcp/${name}`, enabled: true })), commerce.config],
  destinations: { allowLoopback: true, rules: [upstreamAddress, new URL(commerce.config.url).origin].map(origin => ({ origin, cidrs: ['127.0.0.1/32'] })) },
});
await gateway.listen({ host: '127.0.0.1', port: 3009 });
process.env.DASHBOARD_PUBLIC_MCP_URL = 'http://localhost:5174/mcp';
const vite = await createServer({
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
  await commerce.close();
  await storage.connection.dropDatabase();
  await storage.close();
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
