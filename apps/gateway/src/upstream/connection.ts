import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export interface UpstreamConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

export async function connectToUpstream(
  name: string,
  url: string,
): Promise<UpstreamConnection> {
  const client = new Client({
    name: "urumi-gateway",
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(new URL(url));

  try {
    await client.connect(transport, {
      timeout: 5_000,
    });

    console.info(`[Gateway] Connected to upstream: ${name}`);

    return {
      client,
      transport,
    };
  } catch {
    await client.close().catch(() => {});

    throw new Error(`Unable to connect to upstream: ${name}`);
  }
}

export async function disconnectFromUpstream(
  connection: UpstreamConnection,
): Promise<void> {
  try {
    await connection.transport.terminateSession();
  } catch {
    // Continue closing even if session termination fails.
  }

  await connection.client.close();
}
