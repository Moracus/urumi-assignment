import { useEffect, useState } from 'react';
import { api, ApiError } from './api.js';

interface ServerSummary {
  serverId: string;
  displayName: string;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'unreachable' | 'disabled';
  toolCount: number;
  lastConnectedAt: string | null;
  lastDiscoveredAt: string | null;
  lastError: string | null;
}
interface ServerDetail extends ServerSummary {
  url: string;
  transport: 'streamable-http';
  authentication: { type: 'none' | 'bearer' | 'header'; referenceConfigured: boolean };
}
interface Tool { name: string; description?: string; inputSchema: Record<string, unknown> }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
function timestamp(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function summary(value: unknown): ServerSummary {
  if (!record(value) || typeof value.serverId !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(value.serverId)
    || typeof value.displayName !== 'string' || typeof value.enabled !== 'boolean'
    || (value.status !== 'disconnected' && value.status !== 'connecting' && value.status !== 'connected'
      && value.status !== 'unreachable' && value.status !== 'disabled')
    || typeof value.toolCount !== 'number' || !Number.isSafeInteger(value.toolCount) || value.toolCount < 0
    || !timestamp(value.lastConnectedAt) || !timestamp(value.lastDiscoveredAt)
    || (value.lastError !== null && typeof value.lastError !== 'string')) return invalid();
  return { serverId: value.serverId, displayName: value.displayName, enabled: value.enabled,
    status: value.status, toolCount: value.toolCount, lastConnectedAt: value.lastConnectedAt,
    lastDiscoveredAt: value.lastDiscoveredAt, lastError: value.lastError ? 'Upstream unavailable' : null };
}
function serverList(value: unknown) {
  if (!record(value) || !Array.isArray(value.servers)) return invalid();
  return value.servers.map(summary);
}
function detail(value: unknown, id: string): ServerDetail {
  if (!record(value) || !record(value.server)) return invalid();
  const server = value.server;
  const base = summary(server);
  if (base.serverId !== id || typeof server.url !== 'string' || server.transport !== 'streamable-http'
    || !record(server.authentication)
    || (server.authentication.type !== 'none' && server.authentication.type !== 'bearer' && server.authentication.type !== 'header')
    || typeof server.authentication.referenceConfigured !== 'boolean') return invalid();
  return { ...base, url: server.url, transport: server.transport,
    authentication: { type: server.authentication.type, referenceConfigured: server.authentication.referenceConfigured } };
}
function tools(value: unknown): Tool[] {
  if (!record(value) || !Array.isArray(value.tools)) return invalid();
  return value.tools.map(tool => {
    if (!record(tool) || typeof tool.name !== 'string'
      || (tool.description !== undefined && typeof tool.description !== 'string') || !record(tool.inputSchema)) return invalid();
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  });
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The request failed. Try again.'; }
function ServerState({ server }: { server: ServerSummary }) {
  return <dl>
    <dt>Configured state</dt><dd>{server.enabled ? 'Enabled' : 'Disabled'}</dd>
    <dt>Runtime status</dt><dd>{server.status}</dd>
    <dt>Available tool count</dt><dd>{server.toolCount}</dd>
    <dt>Last connected</dt><dd>{server.lastConnectedAt ?? 'Never'}</dd>
    <dt>Last discovered</dt><dd>{server.lastDiscoveredAt ?? 'Never'}</dd>
    <dt>Last failure</dt><dd>{server.lastError ?? 'None'}</dd>
  </dl>;
}
function ServerDetails({ id, close, changed }: { id: string; close: () => void; changed: () => void }) {
  const [data, setData] = useState<{ server: ServerDetail; catalog: Tool[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setData(null); setError('');
    void Promise.all([
      api.request(`/api/admin/servers/${id}`, 'GET', undefined, value => detail(value, id)),
      api.request(`/api/admin/servers/${id}/tools`, 'GET', undefined, tools),
    ]).then(([server, catalog]) => { if (active) setData({ server, catalog }); })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, revision]);
  async function refreshDiscovery() {
    if (pending) return;
    setPending(true); setActionError('');
    try {
      await api.request(`/api/admin/servers/${id}/refresh`, 'POST', undefined, value => detail(value, id));
      setRevision(value => value + 1); changed();
    } catch (error) { setActionError(message(error)); }
    finally { setPending(false); }
  }
  return <section aria-label="Server details"><h2>Server details</h2>
    <button onClick={close}>Close details</button>
    {loading ? <p role="status">Loading server details…</p> : error ? <><p role="alert">{error}</p>
      <button onClick={() => setRevision(value => value + 1)}>Retry details</button></> : data && <>
      <h3>{data.server.displayName}</h3><p>Identifier: {data.server.serverId}</p>
      <p>Endpoint: {data.server.url}</p><p>Transport: {data.server.transport}</p>
      <ServerState server={data.server} />
      <p>Authentication type: {data.server.authentication.type}</p>
      <p>Reference configured: {data.server.authentication.referenceConfigured ? 'Yes' : 'No'}</p>
      <button disabled={pending} onClick={() => { setActionError(''); setRevision(value => value + 1); }}>Refresh details</button>
      <button disabled={pending || !data.server.enabled} onClick={() => void refreshDiscovery()}>Refresh discovery</button>
      {!data.server.enabled && <p>Discovery refresh requires an enabled registration.</p>}
      <h3>Available tools</h3>
      {data.catalog.length === 0 ? <p>No available tools.</p> : data.catalog.map(tool => <section key={tool.name} aria-label={tool.name}>
        <h4>{tool.name}</h4><p className="upstream-description">{tool.description ?? 'No description.'}</p>
        <pre className="tool-schema" aria-label={`Input schema for ${tool.name}`} tabIndex={0}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
      </section>)}
    </>}
    {pending && <p role="status">Refreshing discovery…</p>}{actionError && <p role="alert">{actionError}</p>}
  </section>;
}
export function Servers() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setServers([]); setError('');
    void api.request('/api/admin/servers', 'GET', undefined, serverList)
      .then(value => { if (active) setServers(value); })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  return <section><h1>Servers</h1><p>Configured state and observed runtime status are separate. Only connected servers offer available tools.</p>
    <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh servers</button>
    {loading ? <p role="status">Loading servers…</p> : error ? <><p role="alert">{error}</p>
      <button onClick={() => setRevision(value => value + 1)}>Retry servers</button></>
      : servers.length === 0 ? <p>No registered servers.</p> : <div className="table-scroll"><table>
        <thead><tr><th>Identifier</th><th>Name</th><th>Configured state</th><th>Runtime status</th><th>Available tools</th><th>Details</th></tr></thead>
        <tbody>{servers.map(server => <tr key={server.serverId}><td>{server.serverId}</td><td>{server.displayName}</td>
          <td>{server.enabled ? 'Enabled' : 'Disabled'}</td><td>{server.status}</td><td>{server.toolCount}</td>
          <td><button onClick={() => setSelected(server.serverId)}>Inspect {server.serverId}</button></td></tr>)}</tbody>
      </table></div>}
    {selected && <ServerDetails key={selected} id={selected} close={() => setSelected(null)} changed={() => setRevision(value => value + 1)} />}
  </section>;
}
