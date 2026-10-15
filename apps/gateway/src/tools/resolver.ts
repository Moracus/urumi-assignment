import type {
  ResolvedTool,
  ToolResolver,
} from "../execution/types.js";

import type {
  UpstreamRegistry,
} from "../upstream/registry.js";

import type {
  ToolAggregator,
} from "./aggregator.js";

import {
  UpstreamUnavailableError,
} from "./errors.js";

export class AggregatedToolResolver
  implements ToolResolver {

  constructor(
    private readonly aggregator: ToolAggregator,
    private readonly registry?: UpstreamRegistry,
  ) {}

  async resolve(
    publicToolName: string,
  ): Promise<ResolvedTool | null> {
    // First, resolve currently available tools.
    const tool = this.aggregator.getTool(
      publicToolName,
    );

    if (tool) {
      return {
        publicName: tool.name,
        generation: tool.generation,
        upstreamName: tool.upstreamName,
        upstreamToolName: tool.upstreamToolName,
      };
    }

    // If no registry was provided, preserve the
    // original resolver behavior.
    if (!this.registry) {
      return null;
    }

    // Check previously discovered tools.
    for (const upstream of this.registry.list()) {
      if (!upstream.config.enabled) {
        continue;
      }

      const match = upstream.tools.find(
        (registeredTool) =>
          `${upstream.config.name}.${registeredTool.name}` ===
          publicToolName,
      );

      if (
        match &&
        upstream.status !== "connected"
      ) {
        throw new UpstreamUnavailableError(
          upstream.config.name,
        );
      }
    }

    return null;
  }
}