import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api.js';
import { investigationLink, metricsWindow } from './investigation.js';
import { ReadState } from './ui.js';
import { outcomes, filterNames, parseHistory, historySearch, readHistoryLocation, type Filters } from './audit-query.js';

interface AuditRow {
  id: string;
  attemptId: string;
  requestId: string;
  authenticationOrigin: 'gateway_api_key' | 'dashboard_session' | null;
  keyId: string | null;
  upstreamId: string | null;
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function row(value: unknown): AuditRow {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id)
    || typeof value.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.attemptId)
    || typeof value.requestId !== 'string'
    || !nullableString(value.keyId) || !nullableString(value.upstreamId)
    || !nullableString(value.userId) || !nullableString(value.userEmail)
    || !nullableString(value.upstreamName) || !nullableString(value.upstreamDisplayName)
    || typeof value.toolName !== 'string' || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || typeof value.outcome !== 'string' || !outcomes.includes(value.outcome)) return invalid();
  if (value.authenticationOrigin !== null && value.authenticationOrigin !== 'gateway_api_key' && value.authenticationOrigin !== 'dashboard_session') return invalid();
  return { id: value.id, attemptId: value.attemptId, requestId: value.requestId, authenticationOrigin: value.authenticationOrigin,
    keyId: value.keyId, upstreamId: value.upstreamId, userId: value.userId, userEmail: value.userEmail, upstreamName: value.upstreamName,
    upstreamDisplayName: value.upstreamDisplayName, toolName: value.toolName, timestamp: value.timestamp,
    durationMs: value.durationMs, outcome: value.outcome };
}
function decode(value: unknown, page: number) {
  if (!record(value) || !Array.isArray(value.records) || value.records.length > pageSize
    || value.page !== page || value.limit !== pageSize || typeof value.hasMore !== 'boolean') return invalid();
  return { records: value.records.map(row), hasMore: value.hasMore };
}

const explanations: Record<string, string> = {
  success: 'The tool returned successfully.',
  tool_error: 'The upstream returned a valid MCP tool error (isError). This alone does not mean the server is unhealthy.',
  unauthenticated: 'Authentication did not establish a verified identity. No specific credential failure cause was stored.',
  rejected: 'The call was rejected before execution, including possible validation or dispatch rejection. No specific cause was stored.',
  unauthorized: 'Backend authorization denied this attempt.',
  not_found: 'The tool was not found in the available catalog.',
  upstream_error: 'An upstream invocation failed. No underlying error details were stored.',
  upstream_unavailable: 'The resolved upstream was unavailable.',
  upstream_timeout: 'The upstream call timed out. A write may already have completed.',
};
function AttemptDetails({ row }: { row: AuditRow }) {
  const fields = { 'Attempt ID': row.attemptId, 'Request ID': row.requestId, 'Authentication origin': row.authenticationOrigin,
    'User ID': row.userId, 'User email snapshot': row.userEmail, 'API key ID': row.keyId,
    'Registration ID': row.upstreamId, 'Server name snapshot': row.upstreamName, 'Server display snapshot': row.upstreamDisplayName };
  return <details><summary>Attempt details</summary><p>{explanations[row.outcome]}</p>
    <dl>{Object.entries(fields).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'Not recorded'}</dd></div>)}</dl>
    <p>Attribution uses historical snapshots. Unresolved attempts are not assigned to a registration. Error causes and payloads are not stored. Do not repeat a write without checking its state.</p>
  </details>;
}

export function ToolHistory() {
  const [view, setView] = useState(readHistoryLocation);
  const [draft, setDraft] = useState<Filters>(view.filters);
  const [filterError, setFilterError] = useState('');
  const [data, setData] = useState<{ records: AuditRow[]; hasMore: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { page } = view;
  const query = historySearch(view.filters, page);
  useEffect(() => {
    const restore = () => {
      const next = readHistoryLocation();
      setView(next); setDraft(next.filters); setFilterError(''); setData(null);
      setRevision(value => value + 1);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (view.error) { setLoading(false); return; }
    // Canonical UTC URLs can be copied directly after loading an offset deep link.
    history.replaceState(null, '', `${location.pathname}?${query}`);
    let active = true;
    setLoading(true); setError('');
    void api.request(`/api/admin/audit?${query}&limit=${pageSize}`, 'GET', undefined, value => decode(value, page))
      .then(result => { if (active) setData(result); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'The request failed. Try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, page, revision, view.error]);
  function navigate(filters: Filters, page: number) {
    try {
      const next = parseHistory(historySearch(filters, page));
      history.pushState(null, '', `${location.pathname}?${historySearch(next.filters, next.page)}`);
      setView({ ...next, error: '' }); setDraft(next.filters); setFilterError(''); setData(null); setRevision(value => value + 1);
    } catch (error) { setFilterError(error instanceof Error ? error.message : 'Invalid filters.'); }
  }
  function apply(event: FormEvent) { event.preventDefault(); navigate(draft, 1); }
  const labels = { activity: 'Metric population', userId: 'User ID', upstreamId: 'Registration ID', toolName: 'Exact public tool', from: 'From (inclusive)', to: 'To (exclusive)' };
  return <section><h1>Tool history</h1>
    <p>Tool attempts, newest first. History may be incomplete during storage outages. Pages are live views; new attempts can move rows between pages.</p>
    <form className="history-filters" onSubmit={apply} aria-label="History filters">
      {filterNames.map(key => key === 'activity' ? <label key={key}>Metric population<select value={draft.activity} onChange={event => setDraft({ ...draft, activity: event.target.value })}><option value="">All recorded outcomes</option><option value="attempts">Attributed attempts</option><option value="failures">Attributed failures</option><option value="durations">Duration samples</option></select></label> : key === 'outcome' ? <label key={key}>Outcome<select aria-label="Outcome" value={draft.outcome} onChange={event => setDraft({ ...draft, outcome: event.target.value })}>
        <option value="">All outcomes</option>{outcomes.map(outcome => <option key={outcome}>{outcome}</option>)}
      </select></label> : <label key={key}>{labels[key]}<input value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
      <p>IDs must be 24 lowercase hexadecimal characters. Registration ID identifies one durable instance, including removed servers. Times require a timezone, for example 2026-10-17T05:30:00+05:30, and normalize to UTC.</p>
      <div><button>Apply filters</button><button type="button" onClick={() => navigate(parseHistory('').filters, 1)}>Clear filters</button></div>
    </form>
    {!view.error && view.filters.upstreamId && <p>
      {view.filters.from && view.filters.to && <a href={investigationLink('servers', view.filters)}>Inspect registration</a>}{' '}
      {metricsWindow(view.filters) ? <a href={investigationLink('observability', view.filters)}>Registration observability</a>
        : <span>Set both time bounds to a window of at most seven days to compare metrics.</span>}
    </p>}
    {(filterError || view.error) && <p role="alert">{filterError || view.error}</p>}
    <button disabled={loading || !!view.error} onClick={() => setRevision(value => value + 1)}>Refresh history</button>
    {error && <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Retry history</button>}
    {!view.error && <ReadState loading={loading} error={error} hasData={data !== null} empty={data?.records.length === 0}
      emptyMessage="No tool calls on this page." loadingMessage="Loading tool history…">
      <div className="table-scroll" role="region" aria-label="Tool history" tabIndex={0}><table className="history-table">
        <thead><tr>{['User', 'Server', 'Tool', 'Time', 'Duration', 'Outcome'].map(title => <th key={title}>{title}</th>)}</tr></thead>
        <tbody>{data?.records.map(row => <tr key={row.id}>
          <td title={row.userId ?? undefined}>{row.userEmail ?? row.userId ?? 'Unauthenticated'}</td>
          <td title={row.upstreamId ?? undefined}>{row.upstreamDisplayName ?? row.upstreamName ?? 'Unresolved'}</td>
          <td>{row.toolName}</td><td><time dateTime={row.timestamp}>{new Date(row.timestamp).toLocaleString()}</time></td>
          <td>{row.durationMs} ms</td><td>{row.outcome}<AttemptDetails row={row} /></td>
        </tr>)}</tbody>
      </table></div>
    </ReadState>}
    <div className="pagination"><p>Page {page}</p>
      <button disabled={loading || !!view.error || page === 1} onClick={() => navigate(view.filters, page - 1)}>Previous page</button>
      <button disabled={loading || !!error || !!view.error || !data?.hasMore || page === 2147483647} onClick={() => navigate(view.filters, page + 1)}>Next page</button>
    </div>
  </section>;
}
