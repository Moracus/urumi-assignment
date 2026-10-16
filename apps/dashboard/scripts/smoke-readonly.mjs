import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Credentials stay in process memory; never print tool results (orders may hold
// customer data) or raw exceptions, which may contain URLs and credentials.
async function main() {
  const endpoint = new URL(process.env.URUMI_MCP_URL ?? '');
  const rawKey = process.env.URUMI_API_KEY;
  const orderId = Number(process.env.URUMI_ORDER_ID);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !rawKey || !Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error('Invalid configuration');
  }
  const client = new Client({ name: 'urumi-readonly-smoke', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
    }));
    const names = new Set((await client.listTools(undefined, { cacheMode: 'bypass' })).tools.map(tool => tool.name));
    const calls = [
      ['calculator.calculate', { operation: 'multiply', a: 6, b: 7 }],
      ['time.current', { timezone: 'UTC' }],
      ['woocommerce.list_products', { limit: 1, page: 1 }],
      ['woocommerce.list_orders', { limit: 1, page: 1 }],
      ['woocommerce.get_order', { order_id: orderId }],
    ];
    for (const [name, args] of calls) {
      if (!names.has(name)) throw new Error('Required tool unavailable');
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
      if (result.isError) throw new Error('Tool reported failure');
      console.log(`PASS ${name}`);
    }
  } finally { await client.close(); }
}

try { await main(); }
catch {
  console.error('Read-only smoke failed. Check URUMI_MCP_URL, URUMI_API_KEY, URUMI_ORDER_ID and upstream availability.');
  process.exitCode = 1;
}
