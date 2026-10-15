export interface AggregatedTool {
  generation?: number;
  name: string;

  description?: string;

  inputSchema: Record<string, unknown>;

  upstreamName: string;

  upstreamToolName: string;
}