import { DestinationPolicy, type DestinationNetwork } from "./destination-policy.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export interface UpstreamConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  closeNetwork(): Promise<void>;
}

export async function connectToUpstream(
  name: string,
  url: string,
  policy = new DestinationPolicy(),
  network?: DestinationNetwork,
): Promise<UpstreamConnection> {
  const client = new Client({
    name: "urumi-gateway",
    version: "1.0.0",
  });

  const approved = policy.validate(url);
  const dispatcher = policy.dispatcher(url, network);
  const transport = new StreamableHTTPClientTransport(approved, {
    fetch: async (input, init) => {
      const requested = new URL(input);
      if (requested.href !== approved.href) throw new Error("Upstream destination denied");
      const guardedInit = { ...init, dispatcher, redirect: "manual" as const };
      const response = await fetch(requested, guardedInit);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("Upstream redirect denied");
      }
      return response;
    },
  });

  try {
    await client.connect(transport, {
      timeout: 5_000,
    });

    console.info(`[Gateway] Connected to upstream: ${name}`);

    return {
      client,
      transport,
      closeNetwork: () => dispatcher.destroy(),
    };
  } catch {
    await client.close().catch(() => {});
    await dispatcher.destroy();

    throw new Error(`Unable to connect to upstream: ${name}`);
  }
}

export async function disconnectFromUpstream(
  connection: UpstreamConnection,
): Promise<void> {
  try {
    await connection.client.close();
  } finally {
    await connection.closeNetwork();
  }
}