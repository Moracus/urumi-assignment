import { randomUUID } from "node:crypto";

import { UpstreamRegistry } from "../upstream/registry.js";

import { getDefaultUpstreams } from "../upstream/defaults.js";

import { ToolAggregator } from "./aggregator.js";

import { AggregatedToolResolver } from "./resolver.js";

import { McpUpstreamInvoker } from "./invoker.js";

import { ConsoleAuditLogger } from "../audit/logger.js";

import { executeTool } from "../execution/execute-tool.js";

import type { AuthenticatedIdentity } from "../security/identity.js";
import {
  ToolNotFoundError,
} from "../execution/execute-tool.js";

async function main() {
  const registry = new UpstreamRegistry();

  for (const config of getDefaultUpstreams()) {
    registry.register(config);
  }

  try {
    console.log("Connecting to upstream MCP servers...");

    await registry.connectAll();

    const aggregator = new ToolAggregator(registry);

    const resolver = new AggregatedToolResolver(aggregator, registry);

    const invoker = new McpUpstreamInvoker(registry);

    const auditLogger = new ConsoleAuditLogger();

    const dependencies = {
      resolver,
      invoker,
      auditLogger,
    };

    const identity: AuthenticatedIdentity = {
      userId: "test-admin",
      role: "admin",
      keyId: "test-key",
    };

    console.log("\n=== Available tools ===");

    for (const tool of aggregator.listTools()) {
      console.log(`- ${tool.name}`);
    }

    async function callTool(toolName: string, args: Record<string, unknown>) {
      console.log(`\nCalling ${toolName}...`);

      const response = await executeTool(
        {
          identity,
          toolName,
          arguments: args,
          requestId: randomUUID(),
        },
        dependencies,
      );

      console.log(JSON.stringify(response, null, 2));

      return response;
    }

    // Test Calculator
    const calculatorResult = await callTool("calculator_calculate", {
      operation: "add",
      a: 10,
      b: 20,
    });

    if (calculatorResult.result.isError) {
      throw new Error("Calculator test failed");
    }

    // Test Time
    const timeResult = await callTool("time_current", {
      timezone: "Asia/Kolkata",
    });

    if (timeResult.result.isError) {
      throw new Error("Time test failed");
    }

    // Test WooCommerce read-only operation
    const productsResult = await callTool("woocommerce_list_products", {
      limit: 5,
      page: 1,
    });

    if (productsResult.result.isError) {
      throw new Error("WooCommerce test failed");
    }

    console.log("\n=== Authorization Test ===");

    const memberIdentity: AuthenticatedIdentity = {
      userId: "test-member",
      role: "member",
      keyId: "member-key",
    };

    try {
      await executeTool(
        {
          identity: memberIdentity,

          toolName: "woocommerce_create_product",

          arguments: {
            name: "Unauthorized Product",
            regular_price: "100",
          },

          requestId: randomUUID(),
        },
        dependencies,
      );

      throw new Error("SECURITY FAILURE: unauthorized call succeeded");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AuthorizationError") {
        throw error;
      }

      console.log("PASS: Unauthorized product creation rejected");
    }

    console.log("\n=== MCP Tool Error Test ===");

    const errorResult = await executeTool(
      {
        identity,

        toolName: "calculator_calculate",

        arguments: {
          operation: "divide",
          a: 10,
          b: 0,
        },

        requestId: randomUUID(),
      },
      dependencies,
    );

    if (errorResult.result.isError !== true) {
      throw new Error("Expected division-by-zero MCP tool error");
    }

    console.log("PASS: MCP tool error preserved correctly");

    console.log("\n=== Unknown Tool Test ===");

    try {
      await executeTool(
        {
          identity,

          toolName: "woocommerce_delete_everything",

          arguments: {},

          requestId: randomUUID(),
        },
        dependencies,
      );

      throw new Error("SECURITY FAILURE: unknown tool was executed");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ToolNotFoundError") {
        throw error;
      }

      console.log("PASS: Unknown tool rejected");
    }

    console.log("\nAll three upstream routing tests passed.");
  } finally {
    await registry.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
