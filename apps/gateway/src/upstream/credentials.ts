import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { z } from "zod/v4";
import { secretReference, type UpstreamRegistration } from "./registrations.js";

export type SecretReference = z.infer<typeof secretReference>;
export interface SecretReader {
  read(reference: SecretReference): Promise<string>;
}

/** External Kubernetes I/O only. Policy remains outside this injectable adapter. */
export class KubernetesSecretReader implements SecretReader {
  async read(reference: SecretReference): Promise<string> {
    const directory = "/var/run/secrets/kubernetes.io/serviceaccount";
    const [token, ca] = await Promise.all([
      readFile(`${directory}/token`, "utf8"), readFile(`${directory}/ca.crt`),
    ]);
    // Fixed in-cluster API origin; upstream configuration cannot redirect this request.
    const url = new URL(`https://kubernetes.default.svc/api/v1/namespaces/${encodeURIComponent(reference.namespace)}/secrets/${encodeURIComponent(reference.name)}`);
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(url, { ca, headers: { Authorization: `Bearer ${token.trim()}` },
        signal: AbortSignal.timeout(5_000) }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("Secret unavailable"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000) req.destroy(new Error("Secret unavailable"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.end();
    });
    const result = z.object({ data: z.record(z.string(), z.string()) }).parse(JSON.parse(body));
    const encoded = result.data[reference.key];
    if (encoded === undefined || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error("Secret unavailable");
    }
    return Buffer.from(encoded, "base64").toString("utf8");
  }
}

export class UpstreamCredentials {
  private readonly approved: SecretReference[];
  private readonly resolvedValues = new Set<string>();

  redact(text: string): string {
    for (const value of this.resolvedValues) text = text.replaceAll(value, "[redacted]");
    return text;
  }

  constructor(approved?: SecretReference[], private readonly reader: SecretReader = new KubernetesSecretReader()) {
    try {
      this.approved = z.array(secretReference).max(1000).parse(approved ?? JSON.parse(process.env.UPSTREAM_SECRET_REFERENCES ?? "[]"));
    } catch {
      throw new Error("Invalid upstream Secret configuration");
    }
  }

  validate(authentication: UpstreamRegistration["authentication"]): void {
    if (authentication.type === "none") return;
    const ref = authentication.secretRef;
    if (!this.approved.some(value => value.namespace === ref.namespace && value.name === ref.name && value.key === ref.key)) {
      throw new Error("Unapproved Secret reference");
    }
  }

  async resolve(authentication: UpstreamRegistration["authentication"] = { type: "none" }): Promise<Record<string, string>> {
    this.validate(authentication);
    if (authentication.type === "none") return {};
    try {
      const value = await this.reader.read(authentication.secretRef);
      // Values must be usable as HTTP headers, without control characters or trimming.
      if (!value || value.length > 8192 || !/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) throw new Error();
      this.resolvedValues.add(value);
      if (authentication.type === "bearer") {
        if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(value)) throw new Error();
        return { Authorization: `Bearer ${value}` };
      }
      return { [authentication.headerName]: value };
    } catch {
      throw new Error("Upstream credentials unavailable");
    }
  }
}
