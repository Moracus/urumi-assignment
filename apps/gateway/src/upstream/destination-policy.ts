import type { LookupAddress, LookupAllOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector } from "undici";
import { networkFailure, SafeUpstreamFailure } from "./diagnostics.js";
import { z } from "zod/v4";

const ruleSchema = z.object({
  origin: z.string(),
  cidrs: z.array(z.string()).min(1),
}).strict();
export interface DestinationRule { origin: string; cidrs: string[] }
export interface DestinationOptions {
  rules?: DestinationRule[];
  allowLoopback?: boolean;
  deniedCidrs?: string[];
}
// Only external DNS/socket I/O is replaceable. Policy always runs before dialing.
export interface DestinationNetwork {
  lookup?: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;
  dial?: ReturnType<typeof buildConnector>;
}
const denied = () => new Error("Upstream destination denied");
const defaults: DestinationRule[] = [
  ["urumi-woocommerce-mcp", 3001], ["urumi-calculator-mcp", 3002], ["urumi-time-mcp", 3003],
].flatMap(([name, port]) => [String(name), `${name}.urumi.svc`, `${name}.urumi.svc.cluster.local`].map(host => ({
  origin: `http://${host}:${port}`, cidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
})));

interface AddressRange { block: BlockList; family: number }
function subnet(cidr: string): AddressRange {
  const [address, prefix, extra] = cidr.split("/");
  const family = isIP(address);
  if (!family || prefix === undefined || extra !== undefined || !/^\d+$/.test(prefix)) throw denied();
  const block = new BlockList();
  block.addSubnet(address, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  return { block, family };
}
const contains = (range: AddressRange, address: string) => range.family === isIP(address) && range.block.check(address, range.family === 4 ? "ipv4" : "ipv6");
const forbidden = ["0.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "224.0.0.0/3", "::/128", "64:ff9b::/96", "64:ff9b:1::/48", "168.63.129.16/32", "fd00:ec2::254/128", "fd20:ce::254/128", "::ffff:0:0/96", "fe80::/10", "ff00::/8", "2001::/32", "2002::/16"].map(subnet);
const loopback = ["127.0.0.0/8", "::1/128"].map(subnet);

export class DestinationPolicy {
  private readonly rules: { origin: string; ranges: AddressRange[] }[];
  private readonly allowLoopback: boolean;
  private readonly deniedRanges: AddressRange[];
  constructor(options?: DestinationOptions) {
    try {
      const extra = z.array(ruleSchema).parse(options?.rules ?? JSON.parse(process.env.UPSTREAM_DESTINATION_RULES ?? "[]"));
      const deniedCidrs = z.array(z.string()).parse(options?.deniedCidrs ?? JSON.parse(process.env.UPSTREAM_DENIED_CIDRS ?? "[]"));
      const apiAddress = process.env.KUBERNETES_SERVICE_HOST;
      if (apiAddress) {
        const family = isIP(apiAddress);
        if (!family) throw denied();
        deniedCidrs.push(`${apiAddress}/${family === 4 ? 32 : 128}`);
      }
      this.deniedRanges = [...forbidden, ...deniedCidrs.map(subnet)];
      const setting = process.env.UPSTREAM_ALLOW_LOOPBACK;
      if (setting !== undefined && setting !== "true" && setting !== "false") throw denied();
      this.allowLoopback = options?.allowLoopback ?? setting === "true";
      if (this.allowLoopback && process.env.NODE_ENV === "production") throw denied();
      this.rules = [...defaults, ...extra].map(rule => {
        const url = this.parse(rule.origin);
        if (url.pathname !== "/" || url.search || rule.origin.replace(/\/$/, "") !== url.origin) throw denied();
        const ranges = rule.cidrs.map(subnet);
        return { origin: url.origin, ranges };
      });
      for (const rule of this.rules) this.validate(rule.origin);
    } catch { throw new Error("Invalid upstream destination configuration"); }
  }
  private parse(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw denied(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw denied();
    // Administrative endpoints cannot become MCP destinations through an allowlist typo.
    if (/(^|[.-])(kubernetes|metadata|localhost\.localdomain|etcd|redis|mongodb|mariadb|postgres|kube-apiserver|kubelet)([.-]|$)/i.test(url.hostname) ||
      [22, 53, 2375, 2376, 2379, 2380, 3306, 5432, 6379, 6443, 10250, 27017].includes(Number(url.port || (url.protocol === "https:" ? 443 : 80)))) throw denied();
    return url;
  }
  validate(value: string): URL {
    const url = this.parse(value);
    const rules = this.rules.filter(rule => rule.origin === url.origin);
    if (!rules.length) throw denied();
    const address = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(address)) this.validateAddress(url, address);
    return url;
  }
  private validateAddress(url: URL, address: string): void {
    if (!isIP(address) || this.deniedRanges.some(block => contains(block, address)) ||
      (!this.allowLoopback && loopback.some(block => contains(block, address))) ||
      !this.rules.some(rule => rule.origin === url.origin && rule.ranges.some(block => contains(block, address)))) throw denied();
  }
  dispatcher(value: string, network: DestinationNetwork = {}): Agent {
    const url = this.validate(value);
    const dial = network.dial ?? buildConnector({ timeout: 5_000 });
    return new Agent({ connect: (options, callback) => {
      // Resolve once, check EVERY answer, then pass a literal to the socket API.
      // TLS still verifies the approved hostname through servername.
      void (async () => {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let addresses: LookupAddress[];
        try {
          addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
            (network.lookup ?? lookup)(host, { all: true, verbatim: true }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new SafeUpstreamFailure("timeout")), 4_500);
              timer.unref();
            }),
          ]);
        } finally { clearTimeout(timer); }
        if (!addresses.length) throw denied();
        for (const answer of addresses) this.validateAddress(url, answer.address);
        dial({ ...options, hostname: addresses[0].address, servername: isIP(host) ? undefined : host }, (error, socket) => { if (error) callback(networkFailure(error), null); else callback(null, socket); });
      })().catch(error => callback(error instanceof SafeUpstreamFailure ? error : networkFailure(error), null));
    } });
  }
}
