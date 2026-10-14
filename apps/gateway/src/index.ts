import { createGatewayApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = await createGatewayApp({ host });

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
