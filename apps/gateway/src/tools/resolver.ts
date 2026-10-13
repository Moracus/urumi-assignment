import type {
  ResolvedTool,
  ToolResolver,
} from "../execution/types.js";

import type {
  ToolAggregator,
} from "./aggregator.js";

export class AggregatedToolResolver
  implements ToolResolver {

  constructor(
    private readonly aggregator: ToolAggregator,
  ) {}

  async resolve(
    publicToolName: string,
  ): Promise<ResolvedTool | null> {
    const tool = this.aggregator.getTool(
      publicToolName,
    );

    if (!tool) {
      return null;
    }

    return {
      publicName: tool.name,

      upstreamName: tool.upstreamName,

      upstreamToolName:
        tool.upstreamToolName,
    };
  }
}