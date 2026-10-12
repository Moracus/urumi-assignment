import { McpServer } from "@modelcontextprotocol/server";

import { WooCommerceClient } from "./woocommerce-client.js";

import { registerProductTools } from "./tools/products.js";
import { registerOrderTools } from "./tools/orders.js";

const consumerKey = process.env.WC_CONSUMER_KEY;
const consumerSecret = process.env.WC_CONSUMER_SECRET;

if (!consumerKey || !consumerSecret) {
  throw new Error(
    "Missing WooCommerce API credentials"
  );
}

const client = new WooCommerceClient({
  baseUrl: process.env.WC_URL ?? "http://localhost:8080",
  internalUrl: process.env.WC_INTERNAL_URL,
  consumerKey,
  consumerSecret,
});;

export function createWooCommerceMcpServer(): McpServer {
  const server = new McpServer({
    name: "urumi-woocommerce-mcp",
    version: "1.0.0",
  });

  registerProductTools(server, client);
  registerOrderTools(server, client);

  return server;
}