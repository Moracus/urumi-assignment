import type {
  ResolvedTool,
  ToolExecutionResult,
  UpstreamInvoker,
} from "../execution/types.js";

import type {
  UpstreamRegistry,
} from "../upstream/registry.js";

import {
  UpstreamUnavailableError,
  UpstreamTimeoutError,
  UpstreamCallError,
} from "./errors.js";

export class McpUpstreamInvoker
  implements UpstreamInvoker {

  constructor(
    private readonly registry: UpstreamRegistry,
  ) {}

  async invoke(
    tool: ResolvedTool,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const upstream = this.registry.getState(
      tool.upstreamName,
    );

    if (
      !upstream ||
      !upstream.config.enabled ||
      upstream.status !== "connected" ||
      (tool.generation !== undefined && upstream.generation !== tool.generation)
    ) {
      throw new UpstreamUnavailableError(
        tool.upstreamName,
      );
    }

    const client = this.registry.getClient(
      tool.upstreamName,
    );

    if (!client) {
      throw new UpstreamUnavailableError(
        tool.upstreamName,
      );
    }

    const expectedPublicName =
      `${tool.upstreamName}.${tool.upstreamToolName}`;

    if (tool.publicName !== expectedPublicName) {
      throw new UpstreamCallError(
        tool.upstreamName,
      );
    }

    const toolExists = upstream.tools.some(
      (registeredTool) =>
        registeredTool.name === tool.upstreamToolName,
    );

    if (!toolExists) {
      throw new UpstreamCallError(
        tool.upstreamName,
      );
    }

    let result: unknown;

    try {
      result = await this.registry.withInvocation(client, () => client.callTool(
        {
          name: tool.upstreamToolName,
          arguments: args,
        },
        {
          timeout: 10_000,
        },
      ));
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (
          error.name === "TimeoutError" ||
          /timed out|timeout/i.test(error.message)
        );

      // The connection might be unhealthy.
      // Use a generic reason rather than logging
      // the original exception or internal URL.
      await this.registry.markUnreachable(
        tool.upstreamName,
        timedOut
          ? "Tool request timed out"
          : "MCP request failed",
        client,
      );

      if (timedOut) {
        throw new UpstreamTimeoutError(
          tool.upstreamName,
        );
      }

      throw new UpstreamCallError(
        tool.upstreamName,
      );
    }

    // Validate the MCP response structure.
    if (
      !result ||
      typeof result !== "object" ||
      !("content" in result) ||
      !Array.isArray(result.content) ||
      !result.content.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          typeof item.type === "string"
      )
    ) {
      await this.registry.markUnreachable(
        tool.upstreamName,
        "Invalid MCP response",
        client,
      );

      throw new UpstreamCallError(
        tool.upstreamName,
      );
    }

    // Preserve the successful MCP protocol result,
    // including isError and structuredContent.
    return result as ToolExecutionResult;
  }
}