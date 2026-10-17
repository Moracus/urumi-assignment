// External HTTP/MCP fixtures shared by gateway and browser regression tests.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { WooCommerceClient } from '../dist/woocommerce-client.js';
import { registerProductTools } from '../dist/tools/products.js';
import { registerOrderTools } from '../dist/tools/orders.js';

export async function commerceFixture() {
  const publicOrigin = 'http://store.example.test:8088';
  const requests = [];
  const errors = [];
  const products = [];
  const orders = [
    ['before-midnight', '2026-03-08T04:59:59'],
    ['at-midnight', '2026-03-08T05:00:00'],
    ['last-second', '2026-03-09T03:59:59'],
    ['next-midnight', '2026-03-09T04:00:00'],
  ].map(([number, date_created_gmt], index) => ({
    id: index + 1, number, date_created_gmt, date_created: date_created_gmt,
    status: 'processing', currency: 'USD', total: '12.50', payment_method: 'cod', line_items: [],
  }));
  const rest = Fastify();
  rest.addHook('onError', async (_request, _reply, error) => { errors.push(error); });
  rest.addHook('preHandler', async request => {
    // Recompute OAuth against the public origin independently of the actual
    // loopback destination. A signature against the internal URL fails here.
    assert.equal(request.headers.host, 'store.example.test:8088');
    const url = new URL(request.url, publicOrigin);
    const signature = url.searchParams.get('oauth_signature');
    assert.equal(url.searchParams.get('oauth_consumer_key'), 'fixture-consumer');
    url.searchParams.delete('oauth_signature');
    const normalized = [...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).sort().join('&');
    const base = `${request.method}&${encodeURIComponent(publicOrigin + url.pathname)}&${encodeURIComponent(normalized)}`;
    assert.equal(signature, createHmac('sha1', 'fixture-secret&').update(base).digest('base64'));
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: request.body });
  });
  rest.post('/wp-json/wc/v3/products', async request => {
    const product = { id: products.length + 1, ...request.body, price: request.body.regular_price,
      permalink: `${publicOrigin}/product/demo-mug`, stock_status: 'instock' };
    products.push(product);
    return product;
  });
  rest.get('/wp-json/wc/v3/products', async () => products);
  rest.get('/wp-json/wc/v3/orders/:id', async request => ({
    ...orders[0], id: Number(request.params.id), number: request.params.id,
    payment_method_title: 'Cash on delivery',
  }));
  rest.get('/wp-json/wc/v3/orders', async request => {
    const { after, before, page = '1', per_page = '10' } = request.query;
    // WooCommerce REST date_query uses exclusive after/before at second precision.
    const matching = orders.filter(order => (!after || Date.parse(order.date_created_gmt + 'Z') > Date.parse(after))
      && (!before || Date.parse(order.date_created_gmt + 'Z') < Date.parse(before)));
    return matching.slice((Number(page) - 1) * Number(per_page), Number(page) * Number(per_page));
  });
  const internalUrl = await rest.listen({ host: '127.0.0.1', port: 0 });
  const client = new WooCommerceClient({ baseUrl: publicOrigin, internalUrl,
    consumerKey: 'fixture-consumer', consumerSecret: 'fixture-secret' });
  const mcp = createMcpFastifyApp({ host: '127.0.0.1' });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'commerce-fixture', version: '1' });
    registerProductTools(server, client);
    registerOrderTools(server, client);
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  let offline = false;
  mcp.all('/mcp', (request, reply) => offline ? reply.code(503).send({ error: 'controlled outage' })
    : nodeHandler(request.raw, reply.raw, request.body));
  const address = await mcp.listen({ host: '127.0.0.1', port: 0 });
  return { config: { name: 'woocommerce', url: `${address}/mcp`, enabled: true }, requests, products, errors,
    setOffline(value) { offline = value; },
    async close() { await mcp.close(); await handler.close(); await rest.close(); },
  };
}
