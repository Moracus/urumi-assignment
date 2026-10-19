import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod/v4';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGatewayApp } from '../dist/app.js';
import { connectIdentityStorage } from '../dist/identity/storage.js';
import { initializeAdministrator } from '../dist/identity/initial-setup.js';
import { hashPassword } from '../dist/identity/passwords.js';
import { commerceFixture } from '../../woocommerce-mcp/test/commerce-fixture.mjs';

const origin = 'http://localhost:3000';
const password = 'commerce regression administrator password';
const providerBody = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }) })) });

async function fixture(t, respond) {
  assert.ok(process.env.MONGODB_TEST_URI, 'Use the disposable MongoDB integration runner');
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/urumi_commerce_${randomUUID().replaceAll('-', '')}`;
  const previous = { origins: process.env.DASHBOARD_TRUSTED_ORIGINS, http: process.env.DASHBOARD_ALLOW_HTTP };
  process.env.DASHBOARD_TRUSTED_ORIGINS = origin;
  process.env.DASHBOARD_ALLOW_HTTP = 'true';
  const storage = await connectIdentityStorage(uri.toString());
  t.after(async () => { await storage.connection.dropDatabase(); await storage.close();
    for (const [key, value] of [['DASHBOARD_TRUSTED_ORIGINS', previous.origins], ['DASHBOARD_ALLOW_HTTP', previous.http]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await initializeAdministrator(storage, { email: 'admin@example.com', password, suppliedSecret: 'test', configuredSecret: 'test' });
  await storage.users.create({ email: 'member@example.com', passwordHash: await hashPassword(password),
    role: 'member', status: 'active', requiredPasswordChange: false });
  const commerce = await commerceFixture();
  t.after(() => commerce.close());
  const calculator = createMcpFastifyApp({ host: '127.0.0.1' });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'calculator', version: '1' });
    server.registerTool('calculate', { description: 'Multiply two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a * b) }] }));
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  let calculatorOffline = false;
  calculator.all('/mcp', (request, reply) => calculatorOffline
    ? reply.code(503).send({ error: 'private synthetic-provider-secret' })
    : nodeHandler(request.raw, reply.raw, request.body));
  t.after(async () => { await calculator.close(); await handler.close(); });
  const calculatorAddress = await calculator.listen({ host: '127.0.0.1', port: 0 });
  const provider = Fastify();
  const providerErrors = [];
  provider.addHook('onError', async (_request, _reply, error) => { providerErrors.push(error); });
  provider.post('/completion', async request => respond(providerBody.parse(request.body), commerce));
  t.after(() => provider.close());
  const endpoint = `${await provider.listen({ host: '127.0.0.1', port: 0 })}/completion`;
  const upstreams = [commerce.config, { name: 'calculator', url: `${calculatorAddress}/mcp`, enabled: true }];
  const gateway = await createGatewayApp({ mongodbUri: uri.toString(), upstreams,
    destinations: { allowLoopback: true, rules: upstreams.map(server => ({ origin: new URL(server.url).origin, cidrs: ['127.0.0.1/32'] })) },
    chat: { apiKey: 'synthetic-provider-secret', endpoint } });
  t.after(() => gateway.close());
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  async function login(email) {
    const response = await gateway.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    return { origin, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
  }
  const headers = await login('admin@example.com');
  return { commerce, gateway, headers, address, login,
    setCalculatorOffline(value) { calculatorOffline = value; },
    async chat(prompt, session = headers) {
      const response = await gateway.inject({ method: 'POST', url: '/api/chat', headers: session, payload: { prompt } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(providerErrors, []);
      return response.json();
    },
  };
}

function calls(proposals) {
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: proposals.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] };
}
const answer = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const resultData = result => JSON.parse(JSON.parse(result.content).content[0].text);

test('commerce chat queries a timezone day through the real adapter and pairs a second upstream result', async t => {
  const f = await fixture(t, body => {
    const results = body.messages.filter(message => message.role === 'tool');
    if (!results.length) {
      const orders = body.tools.find(tool => tool.function.description.startsWith('List WooCommerce orders')).function;
      const calculator = body.tools.find(tool => tool.function.description === 'Multiply two numbers').function;
      assert.ok(orders.parameters.properties.date);
      assert.ok(orders.parameters.properties.timezone);
      return calls([['orders-day', orders.name, { date: '2026-03-08', timezone: 'America/New_York' }],
        ['multiply', calculator.name, { a: 6, b: 7 }]]);
    }
    assert.deepEqual(results.map(result => result.tool_call_id), ['orders-day', 'multiply']);
    const orders = resultData(results[0]);
    assert.deepEqual(orders.orders.map(order => order.number), ['at-midnight', 'last-second']);
    assert.deepEqual(orders.date_range, { date: '2026-03-08', timezone: 'America/New_York', start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' });
    assert.equal(JSON.parse(results[1].content).content[0].text, '42');
    return answer('Two orders in the selected day; 6 times 7 is 42.');
  });
  const result = await f.chat('Get orders for March 8 2026 in America/New_York and multiply 6 by 7');
  assert.deepEqual(f.commerce.errors, []);
  assert.equal(result.answer, 'Two orders in the selected day; 6 times 7 is 42.');
  assert.deepEqual(result.calls.map(call => [call.id, call.toolName, call.outcome]), [
    ['orders-day', 'woocommerce_list_orders', 'success'], ['multiply', 'calculator_calculate', 'success'],
  ]);
  const request = f.commerce.requests[0];
  assert.equal(request.query.after, '2026-03-08T04:59:59Z');
  assert.equal(request.query.before, '2026-03-09T04:00:00Z');
  assert.equal(request.query.dates_are_gmt, 'true');
  const audit = (await f.gateway.inject({ url: '/api/admin/audit', headers: f.headers })).json().records;
  assert.deepEqual(audit.map(row => row.toolName).sort(), ['calculator_calculate', 'woocommerce_list_orders']);
  assert.ok(audit.every(row => row.authenticationOrigin === 'dashboard_session' && row.keyId === null && row.outcome === 'success'));
});

test('administrator commerce chat propagates published product fields while members cannot write', async t => {
  let member = false;
  let draft = false;
  const f = await fixture(t, body => {
    const results = body.messages.filter(message => message.role === 'tool');
    const product = body.tools.find(tool => tool.function.description.startsWith('Create a new simple product'));
    if (!results.length) {
      if (member) {
        assert.equal(product, undefined, 'members never discover the write tool');
        return calls([['forged-write', 'woocommerce_create_product', { name: 'Forbidden Mug', regular_price: '99.00', status: 'publish' }]]);
      }
      assert.deepEqual(product.function.parameters.properties.status.enum, ['draft', 'publish']);
      return calls([['create-mug', product.function.name, { name: 'Demo Mug', regular_price: '12.50', ...(draft ? {} : { status: 'publish' }) }]]);
    }
    assert.equal(results[0].tool_call_id, member ? 'forged-write' : 'create-mug');
    if (member) assert.equal(JSON.parse(results[0].content).isError, true);
    else {
      const result = resultData(results[0]).product;
      assert.equal(result.name, 'Demo Mug');
      assert.equal(result.regular_price, '12.50');
      assert.equal(result.status, draft ? 'draft' : 'publish');
      assert.equal(result.permalink, 'http://store.example.test:8088/product/demo-mug');
    }
    return answer(member ? 'Product creation denied.' : draft ? 'Draft created.' : 'Demo Mug published at 12.50.');
  });
  const published = await f.chat('Create Demo Mug at 12.50 with explicit status=publish');
  assert.equal(published.answer, 'Demo Mug published at 12.50.');
  assert.equal(published.calls[0].toolName, 'woocommerce_create_product');
  assert.equal(published.calls[0].outcome, 'success');
  assert.deepEqual(f.commerce.requests[0].body, { name: 'Demo Mug', type: 'simple', regular_price: '12.50', description: '', status: 'publish' });
  draft = true;
  await f.chat('Create a draft Demo Mug at 12.50');
  assert.equal(f.commerce.products[1].status, 'draft', 'existing omitted-status consumers retain the safe draft default');
  member = true;
  const memberHeaders = await f.login('member@example.com');
  const denied = await f.chat('Create Forbidden Mug', memberHeaders);
  assert.equal(denied.calls[0].outcome, 'rejected');
  const issued = await f.gateway.inject({ method: 'POST', url: '/api/keys', headers: memberHeaders, payload: {} });
  assert.equal(issued.statusCode, 201);
  const client = new Client({ name: 'commerce-member', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${issued.json().rawKey}` } },
  }));
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'woocommerce_create_product'));
  await client.callTool({ name: 'woocommerce_create_product', arguments: { name: 'Forbidden Mug', regular_price: '99.00', status: 'publish' } }).then(
    result => assert.equal(result.isError, true), error => assert.equal(error.name, 'ProtocolError'),
  );
  assert.equal(f.commerce.products.length, 2, 'denied member requests have no commerce side effect');
  assert.deepEqual(f.commerce.errors, []);
  const rows = (await f.gateway.inject({ url: '/api/admin/audit', headers: f.headers })).json().records;
  assert.equal(rows.filter(row => row.toolName === 'woocommerce_create_product' && row.outcome === 'success').length, 2);
  assert.ok(rows.some(row => row.toolName === 'woocommerce_create_product' && row.outcome === 'unauthorized' && row.authenticationOrigin === 'gateway_api_key'));
});

test('commerce date errors and an unavailable server retain paired feedback and healthy upstream execution', async t => {
  let args = { date: '2026-03-08' };
  let offline = false;
  const f = await fixture(t, (body, commerce) => {
    const results = body.messages.filter(message => message.role === 'tool');
    if (!results.length) {
      const orders = body.tools.find(tool => tool.function.description.startsWith('List WooCommerce orders')).function;
      const calculator = body.tools.find(tool => tool.function.description === 'Multiply two numbers').function;
      if (offline) commerce.setOffline(true);
      return calls([['bad-orders', orders.name, args], ['healthy-calc', calculator.name, { a: 6, b: 7 }]]);
    }
    assert.deepEqual(results.map(result => result.tool_call_id), ['bad-orders', 'healthy-calc']);
    assert.equal(JSON.parse(results[0].content).isError, true);
    assert.equal(JSON.parse(results[1].content).content[0].text, '42');
    return answer('Orders unavailable for this request; calculator returned 42.');
  });
  for (const invalid of [
    { date: '2026-03-08' }, { timezone: 'America/New_York' },
    { date: '2026-03-08', timezone: 'Mars/Olympus' },
    { date: '2026-03-08', timezone: 'America/New_York', after: '2026-03-08T00:00:00Z' },
    { date: '2011-12-30', timezone: 'Pacific/Apia' },
    { date: '2010-03-05', timezone: 'Antarctica/Casey' },
  ]) {
    args = invalid;
    const result = await f.chat('Query a calendar day and multiply 6 by 7');
    assert.deepEqual(result.calls.map(call => call.outcome), ['tool_error', 'success']);
    assert.equal(result.answer, 'Orders unavailable for this request; calculator returned 42.');
  }
  assert.equal(f.commerce.requests.length, 0, 'invalid ranges never reach WooCommerce');
  offline = true;
  args = { date: '2026-03-08', timezone: 'America/New_York' };
  const unavailable = await f.chat('Get orders and multiply 6 by 7');
  assert.deepEqual(unavailable.calls.map(call => call.outcome), ['upstream_error', 'success']);
  assert.equal(f.commerce.requests.length, 0);
});

test('commerce chat preserves existing explicit range, status and pagination consumers', async t => {
  const f = await fixture(t, body => {
    const results = body.messages.filter(message => message.role === 'tool');
    if (!results.length) {
      const orders = body.tools.find(tool => tool.function.description.startsWith('List WooCommerce orders')).function;
      return calls([['legacy-range', orders.name, { after: '2026-03-08T04:59:59Z', before: '2026-03-09T04:00:00Z', status: 'processing', limit: 1, page: 2 }]]);
    }
    const result = resultData(results[0]);
    assert.equal(result.date_range, undefined);
    assert.equal(result.page, 2);
    assert.deepEqual(result.orders.map(order => order.number), ['last-second']);
    return answer('Legacy range returned page two.');
  });
  const result = await f.chat('Get the second page of processing orders in this explicit range');
  assert.equal(result.answer, 'Legacy range returned page two.');
  const query = f.commerce.requests[0].query;
  assert.equal(query.dates_are_gmt, undefined);
  assert.equal(query.after, '2026-03-08T04:59:59Z');
  assert.equal(query.before, '2026-03-09T04:00:00Z');
  assert.equal(query.status, 'processing');
  assert.equal(query.per_page, '1');
  assert.equal(query.page, '2');
  assert.deepEqual(f.commerce.errors, []);
});

test('server withdrawal blocks stale MCP and provider calls while healthy commerce remains available', async t => {
  for (const action of ['disable', 'remove']) {
    await t.test(action, async t => {
      let f;
      f = await fixture(t, async body => {
        const results = body.messages.filter(message => message.role === 'tool');
        if (results.length) {
          assert.deepEqual(results.map(result => result.tool_call_id), ['withdrawn', 'healthy']);
          assert.equal(JSON.parse(results[0].content).isError, true);
          assert.equal(resultData(results[1]).orders.length, 4);
          assert.ok(!body.tools.some(tool => tool.function.description === 'Multiply two numbers'), 'fresh provider discovery withdraws the server');
          return answer('Calculator withdrawn; commerce still works.');
        }
        const calculator = body.tools.find(tool => tool.function.description === 'Multiply two numbers').function.name;
        const orders = body.tools.find(tool => tool.function.description.startsWith('List WooCommerce orders')).function.name;
        // Change configuration after the provider receives its catalog, before it
        // returns proposed calls. No registry internals or browser transcript involved.
        const response = await f.gateway.inject({ method: action === 'disable' ? 'POST' : 'DELETE',
          url: `/api/admin/servers/calculator${action === 'disable' ? '/disable' : ''}`, headers: f.headers });
        assert.equal(response.statusCode, action === 'disable' ? 200 : 204);
        return calls([['withdrawn', calculator, { a: 6, b: 7 }], ['healthy', orders, {}]]);
      });
      const member = await f.login('member@example.com');
      const issued = await f.gateway.inject({ method: 'POST', url: '/api/keys', headers: member, payload: {} });
      assert.equal(issued.statusCode, 201);
      const client = new Client({ name: 'withdrawal-acceptance', version: '1' });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`${f.address}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${issued.json().rawKey}` } },
      }));
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'calculator_calculate'));
      const result = await f.chat('Calculate and get orders while the server is withdrawn');
      assert.deepEqual(result.calls.map(call => [call.toolName, call.outcome]), [
        ['calculator_calculate', 'rejected'], ['woocommerce_list_orders', 'success'],
      ]);
      assert.ok(!(await client.listTools(undefined, { cacheMode: 'bypass' })).tools.some(tool => tool.name === 'calculator_calculate'));
      await assert.rejects(client.callTool({ name: 'calculator_calculate', arguments: { a: 6, b: 7 } }), { name: 'ProtocolError' });
      assert.notEqual((await client.callTool({ name: 'woocommerce_list_orders', arguments: {} })).isError, true);
      const rows = (await f.gateway.inject({ url: '/api/admin/audit', headers: f.headers })).json().records;
      assert.ok(rows.some(row => row.toolName === 'calculator_calculate' && row.authenticationOrigin === 'dashboard_session' && row.outcome === 'rejected'));
      assert.ok(rows.some(row => row.toolName === 'calculator_calculate' && row.authenticationOrigin === 'gateway_api_key' && row.outcome === 'not_found'));
      if (action === 'disable') {
        assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/admin/servers/calculator/enable', headers: f.headers })).statusCode, 200);
        assert.ok((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.some(tool => tool.name === 'calculator_calculate'));
        assert.deepEqual((await client.callTool({ name: 'calculator_calculate', arguments: { a: 6, b: 7 } })).content, [{ type: 'text', text: '42' }]);
      } else assert.equal((await f.gateway.inject({ url: '/api/admin/servers/calculator', headers: f.headers })).statusCode, 404);
      const serialized = JSON.stringify({ result, rows });
      for (const secret of [issued.json().rawKey, 'synthetic-provider-secret', 'fixture-consumer', 'fixture-secret']) assert.ok(!serialized.includes(secret));
      assert.deepEqual(f.commerce.errors, []);
    });
  }
});


test('chat detects a transport outage within bounds, isolates healthy tools and recovers for the continuing MCP client', async t => {
  let offline = true;
  let f;
  f = await fixture(t, body => {
    const results = body.messages.filter(message => message.role === 'tool');
    if (results.length) {
      assert.deepEqual(results.map(result => result.tool_call_id), ['calculator-call', 'orders-call']);
      assert.equal(JSON.parse(results[0].content).isError === true, offline);
      assert.equal(resultData(results[1]).orders.length, 4);
      assert.equal(body.tools.some(tool => tool.function.description === 'Multiply two numbers'), !offline);
      return answer(offline ? 'Calculator unavailable; orders succeeded.' : 'Calculator and orders succeeded.');
    }
    const calculator = body.tools.find(tool => tool.function.description === 'Multiply two numbers').function.name;
    const orders = body.tools.find(tool => tool.function.description.startsWith('List WooCommerce orders')).function.name;
    f.setCalculatorOffline(offline);
    return calls([['calculator-call', calculator, { a: 6, b: 7 }], ['orders-call', orders, {}]]);
  });
  const issued = await f.gateway.inject({ method: 'POST', url: '/api/keys', headers: f.headers, payload: {} });
  const client = new Client({ name: 'outage-acceptance', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${issued.json().rawKey}` } },
  }));
  await client.listTools();
  const started = Date.now();
  const failed = await f.chat('Calculate and list orders during outage');
  assert.ok(Date.now() - started < 15_000, 'immediate transport failure must remain bounded');
  assert.deepEqual(failed.calls.map(call => call.outcome), ['upstream_error', 'success']);
  const status = (await f.gateway.inject({ url: '/api/admin/servers/calculator', headers: f.headers })).json().server;
  assert.equal(status.status, 'unreachable');
  assert.equal(status.lastError, 'Upstream unavailable');
  assert.ok(!(await client.listTools(undefined, { cacheMode: 'bypass' })).tools.some(tool => tool.name === 'calculator_calculate'));
  await assert.rejects(client.callTool({ name: 'calculator_calculate', arguments: { a: 6, b: 7 } }), { name: 'ProtocolError' });
  assert.notEqual((await client.callTool({ name: 'woocommerce_list_orders', arguments: {} })).isError, true);
  assert.equal((await f.gateway.inject({ url: '/health/ready' })).statusCode, 200);
  offline = false;
  f.setCalculatorOffline(false);
  const refreshed = await f.gateway.inject({ method: 'POST', url: '/api/admin/servers/calculator/refresh', headers: f.headers });
  assert.equal(refreshed.json().server.status, 'connected');
  assert.deepEqual((await client.callTool({ name: 'calculator_calculate', arguments: { a: 6, b: 7 } })).content, [{ type: 'text', text: '42' }]);
  assert.deepEqual((await f.chat('Calculate and list orders after recovery')).calls.map(call => call.outcome), ['success', 'success']);
  const records = (await f.gateway.inject({ url: '/api/admin/audit', headers: f.headers })).json().records;
  assert.ok(records.some(row => row.toolName === 'calculator_calculate' && row.outcome === 'upstream_error' && row.authenticationOrigin === 'dashboard_session'));
  const serialized = JSON.stringify({ failed, status, records });
  for (const secret of [issued.json().rawKey, 'synthetic-provider-secret', 'fixture-consumer', 'fixture-secret']) assert.ok(!serialized.includes(secret));
});
