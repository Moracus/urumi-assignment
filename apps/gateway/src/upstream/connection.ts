import { diagnose, SafeUpstreamFailure } from "./diagnostics.js";
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
  headers: Record<string, string> = {},
): Promise<UpstreamConnection> {
  const client = new Client({
    name: "urumi-gateway",
    version: "1.0.0",
  });

  const approved = policy.validate(url);
  const dispatcher = policy.dispatcher(url, network);
  const transport = new StreamableHTTPClientTransport(approved, {
    requestInit: { headers },
    fetch: async (input, init) => {
      const requested = new URL(input);
      if (requested.href !== approved.href) throw new Error("Upstream destination denied");
      const guardedInit = { ...init, dispatcher, redirect: "manual" as const };
      let response: Response;
      try { response = await fetch(requested, guardedInit); }
      catch (error) {
        // fetch wraps socket errors; accept only our own sanitized adapter evidence.
        if (error instanceof Error && error.cause instanceof SafeUpstreamFailure) throw error.cause;
        throw error;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new SafeUpstreamFailure("http_authentication");
      }
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
  } catch (error) {
    await client.close().catch(() => {});
    await dispatcher.destroy();

    throw new SafeUpstreamFailure(diagnose("connection", error).code);
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