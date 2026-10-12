import { createHmac, randomBytes } from "node:crypto";

type HttpMethod = "GET" | "POST" | "PUT";

interface WooCommerceConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;

  // Optional internal destination for Kubernetes.
  internalUrl?: string;
}

export class WooCommerceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);

    this.name = "WooCommerceError";
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function signRequest(
  method: HttpMethod,
  url: URL,
  consumerKey: string,
  consumerSecret: string,
): void {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,

    oauth_nonce: randomBytes(16).toString("hex"),

    oauth_signature_method: "HMAC-SHA1",

    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  };

  const parameters = [
    ...Array.from(url.searchParams.entries()),
    ...Object.entries(oauthParams),
  ];

  const normalizedParams = parameters
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([keyA, valueA], [keyB, valueB]) => {
      if (keyA !== keyB) {
        return keyA < keyB ? -1 : 1;
      }

      if (valueA === valueB) return 0;

      return valueA < valueB ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;

  const signatureBaseString = [
    method,
    percentEncode(baseUrl),
    percentEncode(normalizedParams),
  ].join("&");

  const signingKey = `${percentEncode(consumerSecret)}&`;

  const signature = createHmac("sha1", signingKey)
    .update(signatureBaseString)
    .digest("base64");

  for (const [key, value] of Object.entries(oauthParams)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set("oauth_signature", signature);
}

export class WooCommerceClient {
  private config: WooCommerceConfig;

  constructor(config: WooCommerceConfig) {
    this.config = config;
  }

  private async request<T>(
    method: HttpMethod,
    endpoint: string,
    data?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`/wp-json/wc/v3${endpoint}`, this.config.baseUrl);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    signRequest(
      method,
      url,
      this.config.consumerKey,
      this.config.consumerSecret,
    );

    let response: Response;
    const requestUrl = new URL(url.toString());

    if (this.config.internalUrl) {
      const internal = new URL(this.config.internalUrl);

      requestUrl.protocol = internal.protocol;
      requestUrl.hostname = internal.hostname;
      requestUrl.port = internal.port;
    }
    console.log("[WooCommerce] Starting request", {
      method,
      destination: requestUrl.origin,
      path: requestUrl.pathname,
      hostHeader: this.config.internalUrl ? url.host : requestUrl.host,
    });

    try {
      response = await fetch(requestUrl, {
        method,

        headers: {
          "Content-Type": "application/json",
          ...(this.config.internalUrl ? { Host: url.host } : {}),
        },

        body: data === undefined ? undefined : JSON.stringify(data),

        signal: AbortSignal.timeout(10000),

        redirect: "error",
      });
    } catch (error) {
      throw new WooCommerceError(
        503,
        "woocommerce_unreachable",
        error instanceof Error
          ? `Cannot reach WooCommerce: ${error.message}`
          : "Cannot reach WooCommerce",
      );
    }
    console.log("[WooCommerce] Received response", {
      status: response.status,
    });

    const text = await response.text();

    let result: unknown;

    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new WooCommerceError(
        response.status,
        "invalid_response",
        "WooCommerce returned invalid JSON",
      );
    }

    if (!response.ok) {
      const error = result as {
        code?: string;
        message?: string;
      } | null;

      throw new WooCommerceError(
        response.status,
        error?.code ?? "woocommerce_error",
        error?.message ?? `WooCommerce returned HTTP ${response.status}`,
      );
    }

    return result as T;
  }

  get<T>(endpoint: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", endpoint, undefined, query);
  }

  post<T>(endpoint: string, data: unknown): Promise<T> {
    return this.request<T>("POST", endpoint, data);
  }

  put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.request<T>("PUT", endpoint, data);
  }
}
