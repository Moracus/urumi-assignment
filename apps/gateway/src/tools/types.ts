export interface AggregatedTool {
  name: string;

  description?: string;

  inputSchema: Record<string, unknown>;

  upstreamName: string;

  upstreamToolName: string;
}