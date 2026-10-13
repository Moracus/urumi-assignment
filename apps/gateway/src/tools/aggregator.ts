import type {
  UpstreamRegistry,
} from "../upstream/registry.js";

import type {
  AggregatedTool,
} from "./types.js";

export class ToolAggregator {
  constructor(
    private readonly registry: UpstreamRegistry,
  ) {}

  listTools(): AggregatedTool[] {
    const aggregated = new Map<
      string,
      AggregatedTool
    >();

    const upstreams = this.registry.list();

    for (const upstream of upstreams) {
      // Ignore disabled or unreachable upstreams.
      if (
        !upstream.config.enabled ||
        upstream.status !== "connected"
      ) {
        continue;
      }

      const upstreamName = upstream.config.name;

      for (const tool of upstream.tools) {
        const publicName =
          `${upstreamName}.${tool.name}`;

        if (aggregated.has(publicName)) {
          throw new Error(
            `Tool name collision: ${publicName}`,
          );
        }

        aggregated.set(publicName, {
          name: publicName,

          description: tool.description,

          inputSchema: structuredClone(
            tool.inputSchema,
          ),

          upstreamName,

          upstreamToolName: tool.name,
        });
      }
    }

    // Return tools in a predictable order.
    return [...aggregated.values()].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
  }

  getTool(
    publicName: string,
  ): AggregatedTool | null {
    return (
      this.listTools().find(
        (tool) => tool.name === publicName,
      ) ?? null
    );
  }
}