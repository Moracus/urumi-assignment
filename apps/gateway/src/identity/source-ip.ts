import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// Normalize the common IPv4-mapped socket representation before comparing addresses.
function normalize(ip: string) { return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip; }

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
