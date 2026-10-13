import { UpstreamRegistry } from "./registry.js";

import {
  getDefaultUpstreams,
} from "./defaults.js";

async function main() {
  const registry = new UpstreamRegistry();

  try {
    // Register the three upstreams.
    for (const config of getDefaultUpstreams()) {
      registry.register(config);
    }

    console.log("Connecting to upstream MCP servers...");

    // Connect and discover tools.
    await registry.connectAll();

    // Print discovery results.
    for (const upstream of registry.list()) {
      console.log(
        `\nUpstream: ${upstream.config.name}`,
      );

      console.log(
        `Status: ${upstream.status}`,
      );

      console.log(
        `Tools: ${upstream.tools.length}`,
      );

      for (const tool of upstream.tools) {
        console.log(`  - ${tool.name}`);
      }

      if (upstream.lastError) {
        console.log(
          `Error: ${upstream.lastError}`,
        );
      }
    }

    // Verify discovery refresh.
    console.log("\nRefreshing tools...");

    await registry.refreshAll();

    console.log("Refresh complete.");
  } finally {
    // Close MCP sessions and HTTP connections.
    await registry.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});