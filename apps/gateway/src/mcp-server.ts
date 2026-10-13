import { randomUUID } from "node:crypto";

import {
  McpServer,
  fromJsonSchema,
} from "@modelcontextprotocol/server";

import type {
  AuthenticatedIdentity,
} from "./security/identity.js";

import {
  authorizeTool,
} from "./security/authorization.js";

import {
  executeTool,
  type ExecutionDependencies,
} from "./execution/execute-tool.js";

import type {
  ToolAggregator,
} from "./tools/aggregator.js";

export interface GatewayMcpDependencies {
  aggregator: ToolAggregator;
  execution: ExecutionDependencies;
}

export function createGatewayMcpServer(
  identity: AuthenticatedIdentity,
  dependencies: GatewayMcpDependencies,
): McpServer {
  const server = new McpServer({
    name: "urumi-mcp-gateway",
    version: "1.0.0",
  });

  // Read the current catalog for this request.
  const tools = dependencies.aggregator.listTools();

  for (const tool of tools) {
    // Hide tools the authenticated user cannot invoke.
    try {
      authorizeTool(identity, tool.name);
    } catch {
      continue;
    }

    server.registerTool(
      tool.name,
      {
        description:
          tool.description ??
          `Execute ${tool.name}`,

        inputSchema: fromJsonSchema<
          Record<string, unknown>
        >(tool.inputSchema),
      },

      async (args) => {
        try {
          const response = await executeTool(
            {
              identity,
              toolName: tool.name,
              arguments: args,
              requestId: randomUUID(),
            },
            dependencies.execution,
          );

          // Preserve the upstream MCP result.
          return response.result as any;
        } catch (error) {
          // Do not leak internal connection details.
          let message = "Tool execution failed";

          if (error instanceof Error) {
            if (
              error.name === "UpstreamUnavailableError"
            ) {
              message = "Upstream server unavailable";
            } else if (
              error.name === "UpstreamTimeoutError"
            ) {
              message = "Upstream request timed out";
            } else if (
              error.name === "AuthorizationError"
            ) {
              message = "Tool execution forbidden";
            } else if (
              error.name === "ToolNotFoundError"
            ) {
              message = "Tool not found";
            }
          }

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: message,
              },
            ],
          };
        }
      },
    );
  }

  return server;
}