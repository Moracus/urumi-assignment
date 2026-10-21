import { ApiError } from './api.js';
const outcomes = ['success', 'tool_error', 'upstream_error', 'upstream_unavailable', 'upstream_timeout', 'rejected', 'unauthorized', 'not_found', 'unauthenticated'] as const;
export interface Observability {
  from: string; to: string; generatedAt: string;
  rows: {
    kind: 'registration' | 'legacy' | 'unattributed'; upstreamId: string | null;
    historicalNames: { name: string | null; displayName: string | null }[];
    current: { name: string; displayName: string; status: string } | null;
    outcomes: Record<typeof outcomes[number], number>;
    attempts: number; failures: number; errorRate: number | null;
  }[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function nullableText(value: unknown, max: number): value is string | null { return value === null || text(value, max); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function valid(value: unknown): value is Observability {
  if (!record(value) || !['from', 'to', 'generatedAt'].every(key => text(value[key], 30) && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value[key]) && Number.isFinite(Date.parse(value[key])))
    || !Array.isArray(value.rows) || value.rows.length > 500) return false;
  return value.rows.every(row => {
    if (!record(row) || typeof row.kind !== 'string' || !['registration', 'legacy', 'unattributed'].includes(row.kind)
      || !(row.upstreamId === null || text(row.upstreamId, 24) && /^[a-f0-9]{24}$/.test(row.upstreamId))
      || !Array.isArray(row.historicalNames) || row.historicalNames.length > 4500
      || !row.historicalNames.every(name => record(name) && nullableText(name.name, 100) && nullableText(name.displayName, 200))
      || !record(row.outcomes) || !outcomes.every(key => record(row.outcomes) && count(row.outcomes[key]))
      || !count(row.attempts) || !count(row.failures)
      || !(row.errorRate === null || typeof row.errorRate === 'number' && Number.isFinite(row.errorRate) && row.errorRate >= 0 && row.errorRate <= 1)) return false;
    return row.current === null || record(row.current) && text(row.current.name, 100) && text(row.current.displayName, 200)
      && typeof row.current.status === 'string' && ['disabled', 'disconnected', 'connecting', 'connected', 'unreachable'].includes(row.current.status);
  });
}
export function decodeObservability(value: unknown): Observability {
  if (!valid(value)) throw new ApiError(0, 'Service returned an invalid response. Try again later.');
  return value;
}
