import { z } from "zod/v4";
const time = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const outcomeSchema = z.object({ success: count, tool_error: count, upstream_error: count,
  upstream_unavailable: count, upstream_timeout: count, rejected: count, unauthorized: count,
  not_found: count, unauthenticated: count });
const currentSchema = z.object({ name: z.string().max(100), displayName: z.string().max(200), status: z.enum([
  "disabled", "disconnected", "connecting", "connected", "unreachable",
]) });
export const observabilitySchema = z.object({ from: time, to: time, generatedAt: time,
  rows: z.array(z.object({ kind: z.enum(["registration", "legacy", "unattributed"]), upstreamId: z.string().regex(/^[a-f0-9]{24}$/).nullable(),
    historicalNames: z.array(z.object({ name: z.string().max(100).nullable(), displayName: z.string().max(200).nullable() })).max(4500),
    current: currentSchema.nullable(), outcomes: outcomeSchema, attempts: count, failures: count,
    errorRate: z.number().min(0).max(1).nullable(),
  })).max(500),
});
export type Observability = z.infer<typeof observabilitySchema>;
