import type {
  UpstreamRegistry,
} from "../upstream/registry.js";

import type {
  AggregatedTool,
} from "./types.js";
import { makePublicToolName } from "./public-name.js";

export class ToolAggregator {
  constructor(
    private readonly registry: UpstreamRegistry,
  ) {}

  listTools(includeUnavailable = false): AggregatedTool[] {
    const aggregated = new Map<
      string,
      AggregatedTool
    >();

    const upstreams = this.registry.list();
    const collisions = new Set<string>();

    for (const upstream of upstreams) {
      // Reserve cached names even while unreachable, so an outage cannot
      // transfer a name (and its permissions) to a different upstream.
      if (!upstream.config.enabled) {
        continue;
      }

      const upstreamName = upstream.config.name;

      for (const tool of upstream.tools) {
        const publicName = makePublicToolName(upstreamName, tool.name);

        if (aggregated.has(publicName)) {
          collisions.add(publicName);
          continue;
        }

        aggregated.set(publicName, {
          name: publicName,
          generation: upstream.generation,

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
    ).filter(tool => !collisions.has(tool.name) && (includeUnavailable ||
      upstreams.some(upstream => upstream.config.name === tool.upstreamName && upstream.status === "connected")));
  }

  getTool(
    publicName: string,
    includeUnavailable = false,
  ): AggregatedTool | null {
    return (
      this.listTools(includeUnavailable).find(
        (tool) => tool.name === publicName,
      ) ?? null
    );
  }
}
