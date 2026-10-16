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
const gateway = await createGatewayApp({ mongodbUri: uri.toString(), upstreams: [] });
await gateway.listen({ host: '127.0.0.1', port: 3009 });
const vite = await createServer({
  // Test arrangement only; this middleware is absent from production Vite config.
  plugins: [{ name: 'expire-test-session', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
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
  await storage.connection.dropDatabase();
  await storage.close();
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
