// This page uses native history navigation; only non-secret investigation state goes in URLs.
export const outcomes = ['unauthenticated', 'rejected', 'success', 'tool_error', 'unauthorized', 'not_found', 'upstream_error', 'upstream_unavailable', 'upstream_timeout'];
export const filterNames = ['userId', 'upstreamId', 'toolName', 'outcome', 'activity', 'from', 'to'] as const;
export type Filters = Record<typeof filterNames[number], string>;
const empty: Filters = { userId: '', upstreamId: '', toolName: '', outcome: '', activity: '', from: '', to: '' };
const message = 'Invalid history filters. Use canonical IDs, an exact tool name, a listed outcome and ISO times with timezone (for example 2026-10-17T05:30:00+05:30). From must precede To.';
function time(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new Error(message);
  const [, year, month, day] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1] ?? 0;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days) throw new Error(message);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(message);
  return date.toISOString();
}
export function parseHistory(search: string) {
  // URLSearchParams otherwise silently accepts malformed percent escapes/UTF-8.
  try { decodeURIComponent(search); } catch { throw new Error(message); }
  const params = new URLSearchParams(search);
  const filters = { ...empty };
  let page = 1;
  for (const [name, value] of params) {
    if (params.getAll(name).length !== 1) throw new Error(message);
    if (name === 'page') {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647) throw new Error(message);
      page = Number(value);
    } else if (filterNames.some(filter => filter === name)) {
      // Assign through the known key list rather than trusting a URL property name.
      for (const key of filterNames) if (key === name) filters[key] = value;
      if (!value) throw new Error(message);
    } else throw new Error(message);
  }
  for (const key of ['userId', 'upstreamId'] as const) if (filters[key] && !/^[a-f0-9]{24}$/.test(filters[key])) throw new Error(message);
  if (filters.activity && !['attempts', 'failures', 'durations'].includes(filters.activity)) throw new Error(message);
  if (filters.toolName.length > 512 || (filters.outcome && !outcomes.includes(filters.outcome))) throw new Error(message);
  for (const key of ['from', 'to'] as const) if (filters[key]) filters[key] = time(filters[key]);
  if (filters.from && filters.to && filters.from >= filters.to) throw new Error(message);
  return { filters, page };
}
export function historySearch(filters: Filters, page: number) {
  const params = new URLSearchParams();
  for (const key of filterNames) if (filters[key]) params.set(key, filters[key]);
  params.set('page', String(page));
  return params.toString();
}
export function readHistoryLocation() {
  try { return { ...parseHistory(location.search), error: '' }; }
  catch (error) { return { filters: { ...empty }, page: 1, error: error instanceof Error ? error.message : message }; }
}
