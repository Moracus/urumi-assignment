import type {
  UpstreamConfig,
} from "./types.js";

export function getDefaultUpstreams(): UpstreamConfig[] {
  return [
    {
      name: "woocommerce",
      url:
        process.env.WOOCOMMERCE_MCP_URL ??
        "http://urumi-woocommerce-mcp:3001/mcp",
      enabled: true,
    },
    {
      name: "calculator",
      url:
        process.env.CALCULATOR_MCP_URL ??
        "http://urumi-calculator-mcp:3002/mcp",
      enabled: true,
    },
    {
      name: "time",
      url:
        process.env.TIME_MCP_URL ??
        "http://urumi-time-mcp:3003/mcp",
      enabled: true,
    },
  ];
}