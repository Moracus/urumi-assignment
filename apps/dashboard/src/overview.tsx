import { ReadState } from './ui.js';
import { useEffect, useState } from 'react';
import { api, ApiError, type DashboardUser } from './api.js';
import { ConnectionInstructions } from './keys.js';

const pageSize = 10;
type Summary = { role: 'admin'; servers: number; tools: number; users: number }
  | { role: 'member'; activeKeys: number };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
function serverTotals(value: unknown) {
  if (!record(value) || !Array.isArray(value.servers)) return invalid();
  let tools = 0;
  for (const server of value.servers) {
    if (!record(server) || typeof server.serverId !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(server.serverId)
      || typeof server.toolCount !== 'number' || !Number.isSafeInteger(server.toolCount) || server.toolCount < 0) return invalid();
    tools += server.toolCount;
  }
  return { servers: value.servers.length, tools };
}
async function countPages(path: string, collection: 'users' | 'keys', contribution: (entry: Record<string, unknown>) => number, signal: AbortSignal) {
  let count = 0;
  for (let page = 1; page <= 2147483647; page++) {
    signal.throwIfAborted();
    const result = await api.request(`${path}?page=${page}&limit=${pageSize}`, 'GET', undefined, value => {
      if (!record(value) || value.page !== page || value.limit !== pageSize) return invalid();
      const entries = value[collection];
      if (!Array.isArray(entries) || entries.length > pageSize) return invalid();
      let matches = 0;
      for (const entry of entries) {
        if (!record(entry) || typeof entry.id !== 'string' || !/^[a-f0-9]{24}$/.test(entry.id)) return invalid();
        matches += contribution(entry);
      }
      return { size: entries.length, matches };
    });
    signal.throwIfAborted();
    count += result.matches;
    if (result.size < pageSize) return count;
  }
  return invalid();
}
async function loadSummary(role: DashboardUser['role'], signal: AbortSignal): Promise<Summary> {
  if (role === 'member') {
    const activeKeys = await countPages('/api/keys', 'keys', entry => {
      if (entry.revokedAt !== null && (typeof entry.revokedAt !== 'string' || !Number.isFinite(Date.parse(entry.revokedAt)))) return invalid();
      return entry.revokedAt === null ? 1 : 0;
    }, signal);
    return { role, activeKeys };
  }
  const [servers, users] = await Promise.all([
    api.request('/api/admin/servers', 'GET', undefined, serverTotals),
    countPages('/api/admin/users', 'users', () => 1, signal),
  ]);
  return { role, ...servers, users };
}
export function Overview({ role }: { role: DashboardUser['role'] }) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setLoading(true);
    void loadSummary(role, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setData(value); setLoading(false); } })
      .catch(error => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : 'The request failed. Try again.'); setLoading(false);
        }
        controller.abort();
      });
    return () => controller.abort();
  }, [role, revision]);
  return <section><h1>Dashboard</h1>
    <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh summary</button>
    {error && <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Retry summary</button>}
    <ReadState loading={loading} error={error} hasData={data !== null}>
    {data?.role === 'admin' ? <section aria-label="Administrator overview">
      <h2>Administrator overview</h2>
      <dl><dt>Registered servers</dt><dd>{data.servers}</dd><dt>Available tools</dt><dd>{data.tools}</dd><dt>Users</dt><dd>{data.users}</dd></dl>
      {data.servers === 0 && <p>No registered servers.</p>}{data.tools === 0 && <p>No available tools.</p>}
      {data.users === 0 && <p>No users.</p>}
      <p>Counts include all pages. Refresh to see current changes.</p>
      <p><a href="/admin/servers">Manage servers</a> · <a href="/admin/users">Manage users</a></p>
    </section> : data?.role === 'member' && <section aria-label="Member overview">
      <h2>Member overview</h2><dl><dt>Active API keys</dt><dd>{data.activeKeys}</dd></dl>
      {data.activeKeys === 0 && <p>No active API keys.</p>}
      <p>Counts include all pages. Refresh to see current changes.</p>
      <p><a href="/keys">Manage API keys</a></p><ConnectionInstructions />
    </section>}
    </ReadState>
  </section>;
}
