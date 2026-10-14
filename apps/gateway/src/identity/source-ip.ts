import { isIP, SocketAddress } from "node:net";
import type { FastifyRequest } from "fastify";

// Equivalent IPv6 spellings must share proxy trust and the same source-IP budget.
function normalize(ip: string) {
  const canonical = isIP(ip) === 6 ? new SocketAddress({ address: ip, family: "ipv6" }).address : ip;
  return canonical.startsWith("::ffff:") && isIP(canonical.slice(7)) === 4 ? canonical.slice(7) : canonical;
}

export function loginSourceIp(request: FastifyRequest, trustedProxies: string[]) {
  let ip = normalize(request.ip);
  const trusted = new Set(trustedProxies.map(normalize));
  const header = request.headers["x-forwarded-for"];
  if (!trusted.has(ip) || typeof header !== "string") return ip;
  const forwarded = header.split(",").map((address) => address.trim());
  if (forwarded.some((address) => !isIP(address))) return ip;
  for (const address of forwarded.reverse()) {
    if (!trusted.has(ip)) break;
    ip = normalize(address);
  }
  return ip;
}

export function isDashboardHttps(request: FastifyRequest, trustedProxies: string[]) {
  return request.protocol === "https" || (trustedProxies.map(normalize).includes(normalize(request.ip))
    && request.headers["x-forwarded-proto"] === "https");
}
