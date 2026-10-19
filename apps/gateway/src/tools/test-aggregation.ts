import { UpstreamRegistry } from "../upstream/registry.js";

import {
  getDefaultUpstreams,
} from "../upstream/defaults.js";

import { ToolAggregator } from "./aggregator.js";

import {
  AggregatedToolResolver,
} from "./resolver.js";

async function main() {
  const registry = new UpstreamRegistry();

  try {
    for (const config of getDefaultUpstreams()) {
      registry.register(config);
    }

    console.log("Connecting to upstreams...");

    await registry.connectAll();

    const aggregator = new ToolAggregator(registry);

    const resolver = new AggregatedToolResolver(
      aggregator,
    );

    console.log("\n=== Aggregated Tools ===");

    const tools = aggregator.listTools();

    for (const tool of tools) {
      console.log(`\nName: ${tool.name}`);
      console.log(`Description: ${tool.description ?? ""}`);
      console.log(`Upstream: ${tool.upstreamName}`);
      console.log(`Original name: ${tool.upstreamToolName}`);
      console.log(
        `Input schema: ${JSON.stringify(tool.inputSchema)}`,
      );
    }

    console.log(`\nTotal tools: ${tools.length}`);

    console.log("\n=== Resolution Test ===");

    const resolved = await resolver.resolve(
      "calculator_calculate",
    );

    console.log(resolved);

    console.log("\n=== Unknown Tool Test ===");

    const unknown = await resolver.resolve(
      "woocommerce_delete_customer",
    );

    console.log(unknown);

    if (tools.length !== 7) {
      throw new Error(
        `Expected 7 tools, found ${tools.length}`,
      );
    }

    if (
      resolved?.upstreamName !== "calculator" ||
      resolved.upstreamToolName !== "calculate"
    ) {
      throw new Error("Calculator resolution failed");
    }

    if (unknown !== null) {
      throw new Error("Unknown tool was incorrectly resolved");
    }

    console.log("\nAggregation verification passed.");
  } finally {
    await registry.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});