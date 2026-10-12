import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

export function createCalculatorMcpServer(): McpServer {
  const server = new McpServer({
    name: "urumi-calculator-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "calculate",
    {
      description:
        "Perform basic arithmetic operations on two numbers.",

      inputSchema: z.object({
        operation: z.enum([
          "add",
          "subtract",
          "multiply",
          "divide",
        ]),

        a: z.number(),

        b: z.number(),
      }),
    },

    async ({ operation, a, b }) => {
      try {
        let result: number;

        switch (operation) {
          case "add":
            result = a + b;
            break;

          case "subtract":
            result = a - b;
            break;

          case "multiply":
            result = a * b;
            break;

          case "divide":
            if (b === 0) {
              throw new Error("Division by zero is not allowed");
            }

            result = a / b;
            break;
        }

        if (!Number.isFinite(result)) {
          throw new Error("Calculation produced a non-finite result");
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                operation,
                a,
                b,
                result,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,

          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Calculation failed",
            },
          ],
        };
      }
    },
  );

  return server;
}