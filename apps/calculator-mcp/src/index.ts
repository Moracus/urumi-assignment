import Fastify from 'fastify';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 3002);

app.get('/health/live', async () => ({ status: 'ok', service: 'calculator-mcp' }));
app.get('/health/ready', async () => ({ status: 'ok', service: 'calculator-mcp' }));

// Day 2/3: implement real Streamable HTTP MCP at POST/GET /mcp.
// A health endpoint is NOT an MCP implementation.

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
