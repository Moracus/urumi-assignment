import { isIP } from "node:net";

export interface DashboardConfig {
  trustedOrigins: string[];
  allowHttp: boolean;
  trustedProxies: string[];
}

export function dashboardConfig(): DashboardConfig {
  const localHttp = process.env.DASHBOARD_ALLOW_HTTP ?? "false";
  if (!["true", "false"].includes(localHttp)
    || (process.env.NODE_ENV === "production" && localHttp === "true")) {
    throw new Error("Invalid dashboard HTTP configuration");
  }
  const allowHttp = localHttp === "true";
  const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const trustedOrigins = list(process.env.DASHBOARD_TRUSTED_ORIGINS);
  for (const origin of trustedOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new Error("Invalid dashboard Origin configuration"); }
    if (origin !== parsed.origin || (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:"))) {
      throw new Error("Invalid dashboard Origin configuration");
    }
  }
  const trustedProxies = list(process.env.DASHBOARD_TRUSTED_PROXIES);
  if (trustedProxies.some((ip) => !isIP(ip))) throw new Error("Invalid dashboard proxy configuration");
  return { trustedOrigins, allowHttp, trustedProxies };
}
