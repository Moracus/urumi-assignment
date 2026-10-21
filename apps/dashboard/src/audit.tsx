import { useEffect, useState } from 'react';
import { api, ApiError } from './api.js';

interface AuditRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  upstreamName: string | null;
  upstreamDisplayName: string | null;
  toolName: string;
  timestamp: string;
  durationMs: number;
  outcome: string;
}
const pageSize = 10;
const outcomes = ['unauthenticated', 'rejected', 'success', 'tool_error', 'unauthorized', 'not_found', 'upstream_error', 'upstream_unavailable', 'upstream_timeout'];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function row(value: unknown): AuditRow {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id)
    || !nullableString(value.userId) || !nullableString(value.userEmail)
    || !nullableString(value.upstreamName) || !nullableString(value.upstreamDisplayName)
    || typeof value.toolName !== 'string' || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || typeof value.outcome !== 'string' || !outcomes.includes(value.outcome)) return invalid();
  return { id: value.id, userId: value.userId, userEmail: value.userEmail, upstreamName: value.upstreamName,
    upstreamDisplayName: value.upstreamDisplayName, toolName: value.toolName, timestamp: value.timestamp,
    durationMs: value.durationMs, outcome: value.outcome };
}
function decode(value: unknown, page: number) {
  if (!record(value) || !Array.isArray(value.records) || value.records.length > pageSize
    || value.page !== page || value.limit !== pageSize || typeof value.hasMore !== 'boolean') return invalid();
  return { records: value.records.map(row), hasMore: value.hasMore };
}

export function ToolHistory() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setRows([]); setHasMore(false); setError('');
    void api.request(`/api/admin/audit?page=${page}&limit=${pageSize}`, 'GET', undefined, value => decode(value, page))
      .then(result => { if (active) { setRows(result.records); setHasMore(result.hasMore); } })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'The request failed. Try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, revision]);
  return <section><h1>Tool history</h1>
    <p>Tool attempts, including identified MCP rejections, newest first. History may be incomplete during storage outages.</p>
    <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh history</button>
    {loading ? <p role="status">Loading tool history…</p> : error ? <><p role="alert">{error}</p>
      <button onClick={() => setRevision(value => value + 1)}>Retry history</button></>
      : rows.length === 0 ? <p>No tool calls on this page.</p> : <div className="table-scroll" role="region" aria-label="Tool history" tabIndex={0}><table>
        <thead><tr>{['User', 'Server', 'Tool', 'Time', 'Duration', 'Outcome'].map(title => <th key={title}>{title}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td title={row.userId ?? undefined}>{row.userEmail ?? row.userId ?? 'Unauthenticated'}</td>
          <td title={row.upstreamName ?? undefined}>{row.upstreamDisplayName ?? row.upstreamName ?? 'Unresolved'}</td>
          <td>{row.toolName}</td><td><time dateTime={row.timestamp}>{new Date(row.timestamp).toLocaleString()}</time></td>
          <td>{row.durationMs} ms</td><td>{row.outcome}</td>
        </tr>)}</tbody>
      </table></div>}
    <p>Page {page}</p>
    <button disabled={loading || page === 1} onClick={() => setPage(value => value - 1)}>Previous page</button>
    <button disabled={loading || !!error || !hasMore} onClick={() => setPage(value => value + 1)}>Next page</button>
  </section>;
}
