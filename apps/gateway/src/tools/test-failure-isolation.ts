import { randomUUID } from "node:crypto";

import { UpstreamRegistry } from "../upstream/registry.js";
import { getDefaultUpstreams } from "../upstream/defaults.js";

import { ToolAggregator } from "./aggregator.js";
import { AggregatedToolResolver } from "./resolver.js";
import { McpUpstreamInvoker } from "./invoker.js";

import { executeTool } from "../execution/execute-tool.js";
import { ConsoleAuditLogger } from "../audit/logger.js";

import type { AuthenticatedIdentity } from "../security/identity.js";

const identity: AuthenticatedIdentity = {
  userId: "resilience-test-admin",
  role: "admin",
  keyId: "resilience-test-key",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const registry = new UpstreamRegistry();

  for (const config of getDefaultUpstreams()) {
    registry.register(config);
  }

  try {
    await registry.connectAll();

    const aggregator = new ToolAggregator(registry);

    const dependencies = {
      resolver: new AggregatedToolResolver(aggregator, registry),

      invoker: new McpUpstreamInvoker(registry),

      auditLogger: new ConsoleAuditLogger(),
    };

    async function call(toolName: string, args: Record<string, unknown>) {
      const started = performance.now();

      try {
        const response = await executeTool(
          {
            identity,
            toolName,
            arguments: args,
            requestId: randomUUID(),
          },
          dependencies,
        );

        console.log(
          `${toolName}: completed in ${performance.now() - started}ms`,
        );

        return response;
      } catch (error) {
        console.error(
          `${toolName}: ${
            error instanceof Error ? error.name : "UnknownError"
          }`,
        );

        throw error;
      }
    }

    console.log("\n=== Initial state ===");

    for (const upstream of registry.list()) {
      console.log(upstream.config.name, upstream.status);
    }

    console.log("\n=== Healthy requests ===");

    await Promise.all([
      call("calculator.calculate", {
        operation: "add",
        a: 10,
        b: 20,
      }),

      call("time.current", {
        timezone: "Asia/Kolkata",
      }),

      call("woocommerce.list_products", {
        limit: 5,
        page: 1,
      }),
    ]);

    console.log("\nStop the Calculator port-forward now.");

    console.log("Testing Calculator failure in 15 seconds...");

    await sleep(15_000);

    console.log("\n=== Failure test ===");

    try {
      await call("calculator.calculate", {
        operation: "add",
        a: 10,
        b: 20,
      });

      throw new Error("Expected Calculator failure, but call succeeded");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Expected Calculator failure, but call succeeded"
      ) {
        throw error;
      }

      console.log("Calculator failed as expected.");
    }

    console.log("\n=== Other upstreams ===");

    await Promise.all([
      call("time.current", {
        timezone: "UTC",
      }),

      call("woocommerce.list_products", {
        limit: 5,
        page: 1,
      }),
    ]);

    console.log("\n=== Registry status ===");

    for (const upstream of registry.list()) {
      console.log(`${upstream.config.name}: ${upstream.status}`);
    }

    console.log("\n=== Available tools ===");

    for (const tool of aggregator.listTools()) {
      console.log(tool.name);
    }

    console.log("\nFailure isolation verification completed.");
    console.log("\nRestore the Calculator port-forward now.");

    await sleep(15_000);

    console.log("\n=== Reconnection test ===");

    await registry.refreshAll();

    const calculatorState = registry.getState("calculator");

    console.log("Calculator status:", calculatorState?.status);

    if (calculatorState?.status !== "connected") {
      throw new Error("Calculator did not reconnect successfully");
    }

    const recovered = await call("calculator.calculate", {
      operation: "multiply",
      a: 6,
      b: 7,
    });

    if (recovered.result.isError) {
      throw new Error("Calculator returned an error after recovery");
    }

    console.log("PASS: Calculator recovered successfully");
  } finally {
    await registry.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
