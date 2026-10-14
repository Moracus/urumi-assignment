import { createGatewayApp } from "./app.js";
import { IdentityStorageError } from "./identity/storage.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

// Startup errors may contain URIs or credentials. Emit a fixed diagnostic only.
const app = await createGatewayApp({ host }).catch((error) => {
  const stage = error instanceof IdentityStorageError ? error.stage : "application";
  console.error(`Gateway startup failed (${stage}); check configuration and identity storage`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ port, host });
  app.log.info(`MCP Gateway listening on ${host}:${port}`);
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
