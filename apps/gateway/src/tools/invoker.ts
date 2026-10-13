import type {
  ResolvedTool,
  ToolExecutionResult,
  UpstreamInvoker,
} from "../execution/types.js";

import type { UpstreamRegistry } from "../upstream/registry.js";

import {
  UpstreamUnavailableError,
  UpstreamTimeoutError,
  UpstreamCallError,
} from "./errors.js";

export class McpUpstreamInvoker implements UpstreamInvoker {
  constructor(private readonly registry: UpstreamRegistry) {}

  async invoke(
    tool: ResolvedTool,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const upstream = this.registry.getState(tool.upstreamName);

    // Never invoke a disabled or disconnected server.
    if (
      !upstream ||
      !upstream.config.enabled ||
      upstream.status !== "connected"
    ) {
      throw new UpstreamUnavailableError(tool.upstreamName);
    }

    const client = this.registry.getClient(tool.upstreamName);

    if (!client) {
      throw new UpstreamUnavailableError(tool.upstreamName);
    }

    // Defense in depth: confirm the discovered upstream
    // actually provides the requested original tool.
    const toolExists = upstream.tools.some(
      (registeredTool) => registeredTool.name === tool.upstreamToolName,
    );

    if (!toolExists) {
      throw new UpstreamCallError(tool.upstreamName);
    }

    const expectedPublicName = `${tool.upstreamName}.${tool.upstreamToolName}`;

    if (tool.publicName !== expectedPublicName) {
      throw new UpstreamCallError(tool.upstreamName);
    }

    try {
      const result = await client.callTool(
        {
          name: tool.upstreamToolName,
          arguments: args,
        },
        {
          timeout: 10_000,
        },
      );

      // The MCP client may return either tool content or
      // a result object that includes additional fields.
      // Preserve the upstream MCP result without converting
      // successful tool errors into transport exceptions.
      if (!result || !("content" in result) || !Array.isArray(result.content)) {
        throw new Error("Invalid MCP tool result");
      }

      return result as ToolExecutionResult;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          /timed out|timeout/i.test(error.message))
      ) {
        throw new UpstreamTimeoutError(tool.upstreamName);
      }

      throw new UpstreamCallError(tool.upstreamName);
    }
  }
}
