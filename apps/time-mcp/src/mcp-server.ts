import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

export function createTimeMcpServer(): McpServer {
  const server = new McpServer({
    name: "urumi-time-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "current",
    {
      description:
        "Get the current date and time in a specified IANA timezone.",

      inputSchema: z.object({
        timezone: z.string().default("UTC"),
      }),
    },

    async ({ timezone }) => {
      try {
        const now = new Date();

        const formatter = new Intl.DateTimeFormat(
          "en-GB",
          {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          }
        );

        const parts = formatter.formatToParts(now);

        const get = (type: string) =>
          parts.find((part) => part.type === type)?.value ?? "";

        const date = `${get("year")}-${get("month")}-${get("day")}`;

        const time = `${get("hour")}:${get("minute")}:${get("second")}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                timezone,
                date,
                time,
                iso: now.toISOString(),
                unixTimestamp: Math.floor(now.getTime() / 1000),
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
                error instanceof RangeError
                  ? "Invalid timezone. Use an IANA timezone such as Asia/Kolkata."
                  : "Unable to retrieve current time",
            },
          ],
        };
      }
    }
  );

  return server;
}