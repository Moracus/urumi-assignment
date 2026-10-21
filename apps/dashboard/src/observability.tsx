import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { concreteWindow, investigationLink, metricsWindow, useInvestigation } from './investigation.js';
import { ReadState } from './ui.js';
import { decodeObservability as decode, type Observability as Report } from './observability-contract.js';

const outcomes = ['success', 'tool_error', 'upstream_error', 'upstream_unavailable', 'upstream_timeout', 'rejected', 'unauthorized', 'not_found', 'unauthenticated'] as const;
type Sort = 'server' | 'attempts' | 'failures' | 'errorRate' | 'status';
export function Observability() {
  const inFlight = useRef<Promise<unknown> | null>(null);
  const view = useInvestigation();
  const { bucket } = view;
  const { from, to, upstreamId: filter } = view.filters;
  const viewError = view.error || (!metricsWindow(view.filters) ? 'Observability requires a window of at most seven days.' : '');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [id, setId] = useState(filter);
  useEffect(() => { setId(filter); setData(null); }, [filter, from, to, bucket]);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [sort, setSort] = useState<Sort>('server');
  const [descending, setDescending] = useState(false);
  useEffect(() => {
    if (viewError) { setData(null); setError(''); setLoading(false); return; }
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      // A replacement view waits for the previous bounded read before starting.
      await inFlight.current;
      if (!active || document.visibilityState !== 'visible') { pending = false; return; }
      setLoading(true); setError('');
      try {
        const read = api.request(`/api/admin/observability?${new URLSearchParams({ from, to, ...(filter ? { upstreamId: filter } : {}), ...(bucket ? { bucket } : {}) })}`, 'GET', undefined, decode);
        inFlight.current = read.catch(() => undefined);
        const result = await read;
        if (active) setData(result);
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'The request failed. Try again.'); }
      finally { pending = false; if (active) setLoading(false); }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60000);
    const visible = () => { void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [from, to, filter, bucket, revision, viewError]);
  function order(key: Sort) { if (sort === key) setDescending(!descending); else { setSort(key); setDescending(false); } }
  function name(row: Report['rows'][number]) { return row.current?.displayName ?? row.historicalNames.map(n => n.displayName ?? n.name ?? 'Unresolved').join(', '); }
  function rowKey(row: Report['rows'][number]) { return row.upstreamId ?? JSON.stringify([row.kind, row.historicalNames]); }
  const rows = [...(data?.rows ?? [])].sort((a, b) => {
    const result = sort === 'server' ? name(a).localeCompare(name(b)) : sort === 'status' ? (a.current?.status ?? '').localeCompare(b.current?.status ?? '')
      : (a[sort] ?? -1) - (b[sort] ?? -1);
    return descending ? -result : result;
  });
  function metricLink(row: Report['rows'][number], count: number, activity: string, label: string, outcome = '', window: { from: string; to: string } | null = data) {
    if (!row.upstreamId || !window) return count;
    return <a aria-label={`${label}: ${count}`} href={investigationLink('audit', { ...view.filters, upstreamId: row.upstreamId,
      from: window.from, to: window.to, userId: '', toolName: '', outcome, activity })}>{count}</a>;
  }
  const activeTrend = rows.find(row => rowKey(row) === expanded);
  return <section><h1>Observability</h1>
    <p>Recorded gateway attempts, including failures before an upstream is reached. Audit storage coverage is incomplete; missing writes are not backfilled. Current health is separate from historical outcomes.</p>
    <label>Historical window<select value="" onChange={e => { view.navigate({ ...view.filters, ...concreteWindow(e.target.value) }); setData(null); }}>
      <option value="">Fixed investigation window</option>
      <option value="hour">Last hour</option><option value="day">Last 24 hours</option><option value="week">Last seven days</option>
    </select></label>
    <label>Activity bucket<select value={bucket} onChange={e => { view.navigate(view.filters, e.target.value); setData(null); }}>
      <option value="">Automatic</option><option value="5minute">5 minutes</option><option value="hour">1 hour</option><option value="day">1 day</option>
    </select></label>
    <form onSubmit={e => { e.preventDefault(); view.navigate({ ...view.filters, upstreamId: id }); setData(null); setRevision(v => v + 1); }}>
      <label>Registration ID<input value={id} pattern="[a-f0-9]{24}" onChange={e => setId(e.target.value)} /></label><button>Apply registration filter</button>
    </form>
    <button disabled={loading || !!viewError} onClick={() => setRevision(v => v + 1)}>Refresh observability</button>
    <p>Visible pages refresh every 60 seconds. Refresh reads recorded metrics and current status only. The historical window stays fixed; choose a preset again to capture a new window.</p>
    {viewError && <><p role="alert">{viewError}</p><button onClick={view.reset}>Reset investigation</button></>}
    {(view.filters.userId || view.filters.toolName || view.filters.outcome || view.filters.activity) && <p>Metrics cover all users, tools and outcomes for this registration/window. <a href={investigationLink('audit', view.filters)}>Resume exact history filters</a></p>}
    {data && <p>Effective window (UTC): <time>{data.from}</time> inclusive to <time>{data.to}</time> exclusive. Last successful refresh: <time>{data.generatedAt}</time>.</p>}
    <ReadState loading={loading} error={error} hasData={data !== null} empty={data?.rows.length === 0} emptyMessage="No registrations or recorded attempts in this window." loadingMessage="Loading observability…">
      <div className="table-scroll" role="region" aria-label="Recorded gateway attempts" tabIndex={0}><table className="observability-table">
        <thead><tr>{(['server', 'status', 'attempts', 'failures', 'errorRate'] as const).map(key => <th key={key} aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}>
          <button onClick={() => order(key)}>{{ server: 'Server', status: 'Current health', attempts: 'Attributed attempts', failures: 'Failures', errorRate: 'Failure rate' }[key]}</button>
        </th>)}<th>Average duration (ms)</th><th>Approximate p95 (ms)</th><th>Duration samples</th><th>Timeouts</th><th>Recorded outcome breakdown</th><th>Activity trend</th></tr></thead>
        <tbody>{rows.map(row => <tr key={rowKey(row)}>
          <td>{name(row)}<p>{row.upstreamId ?? (row.kind === 'legacy' ? 'Legacy name-only group' : 'Unattributed group')}</p>
            {row.upstreamId && <p><a href={investigationLink('servers', { ...view.filters, upstreamId: row.upstreamId })}>Inspect registration</a></p>}
            {row.current && row.historicalNames.length > 0 && <p>Historical names: {row.historicalNames.map(n => `${n.displayName ?? n.name ?? 'Unresolved'} (${n.name ?? 'unrecorded'})`).join(', ')}</p>}</td>
          <td>{row.current?.status ?? (row.kind === 'registration' ? 'Removed registration' : 'No current match')}</td>
          <td>{metricLink(row, row.attempts, 'attempts', 'Matching attributed attempts')}</td><td>{metricLink(row, row.failures, 'failures', 'Matching failures')}</td><td>{row.errorRate === null ? '—' : `${(100 * row.errorRate).toFixed(2)}%`}</td>
          <td>{row.averageDurationMs === null ? '—' : row.averageDurationMs.toFixed(2)}</td>
          <td>{row.p95DurationMs === null ? '—' : row.p95DurationMs.toFixed(2)}</td><td>{metricLink(row, row.durationSampleCount, 'durations', 'Matching duration samples')}</td><td>{metricLink(row, row.timeoutCount, '', 'Matching timeouts', 'upstream_timeout')}</td>
          <td><dl>{outcomes.map(outcome => <div key={outcome}><dt>{outcome}</dt><dd>{metricLink(row, row.outcomes[outcome], '', `Matching ${outcome}`, outcome)}</dd></div>)}</dl></td>
          <td><button aria-expanded={expanded === rowKey(row)} aria-controls={expanded === rowKey(row) ? 'activity-trend-panel' : undefined}
            onClick={() => setExpanded(expanded === rowKey(row) ? null : rowKey(row))}>Show activity trend for {name(row)}</button></td>
        </tr>)}</tbody>
      </table></div>
      {activeTrend && <div id="activity-trend-panel" className="table-scroll" role="region" aria-label={`Activity trend for ${name(activeTrend)}`} tabIndex={0}><table className="activity-trend-table">
        <caption>Activity trend for {name(activeTrend)}</caption>
        <thead><tr><th scope="col">UTC start (inclusive)</th><th scope="col">UTC end (exclusive)</th><th scope="col">Attributed attempts</th><th scope="col">Failures</th><th scope="col">Timeouts</th>{outcomes.map(outcome => <th scope="col" key={outcome}>{outcome}</th>)}</tr></thead>
        <tbody>{activeTrend.trend.map(point => <tr key={point.from}><th scope="row">{point.from}</th><td>{point.to}</td><td>{metricLink(activeTrend, point.attempts, 'attempts', 'Matching bucket attempts', '', point)}</td><td>{metricLink(activeTrend, point.failures, 'failures', 'Matching bucket failures', '', point)}</td><td>{metricLink(activeTrend, point.timeoutCount, '', 'Matching bucket timeouts', 'upstream_timeout', point)}</td>{outcomes.map(outcome => <td key={outcome}>{metricLink(activeTrend, point.outcomes[outcome], '', `Matching bucket ${outcome}`, outcome, point)}</td>)}</tr>)}</tbody>
      </table></div>}
    </ReadState>
    <p>Durations measure recorded gateway execution, including gateway work before audit insertion and excluding the wait for insertion. Only success and tool_error contribute to the average and approximate p95; timeouts are counted separately. Duration samples show the population size. An em dash (—) means no samples. Activity buckets use UTC boundaries with partial edges clipped to the effective window; {data?.bucket ?? 'automatic'} buckets, at most 169 per row.</p>
    <p>Attributed attempts = success + tool_error + upstream_error + upstream_unavailable + upstream_timeout for one durable registration. Failures exclude success. Rejected, unauthorized, not_found and unauthenticated outcomes are shown separately and excluded from the rate. Legacy and unattributed groups have no per-registration rate.</p>
  </section>;
}
