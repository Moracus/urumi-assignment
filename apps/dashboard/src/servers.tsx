import { Dialog, ReadState, StatusBadge } from './ui.js';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api.js';
import { ServerForm, type ServerInput } from './server-form.js';

const stages = { credentials: 'Credential resolution', connection: 'Connection / handshake', discovery: 'Tool discovery', invocation: 'Tool invocation' };
const guidance = {
  credentials_unavailable: 'Ask an operator to check the approved credential reference, Secret availability and access permissions. Secret values are never shown here.',
  connection_failed: 'Check the approved registration and endpoint with an operator. Inspect operator logs for connection or handshake details.',
  discovery_failed: 'The tools could not be discovered. Ask an operator to check MCP compatibility and logs.',
  invocation_failed: 'A tool request failed. Inspect operator logs and the operation outcome before a deliberate retry.',
  dns_failed: 'The approved hostname could not be resolved. Ask an operator to check DNS and the registration.',
  tls_failed: 'TLS verification failed. Ask an operator to check the certificate and approved hostname.',
  connection_refused: 'The connection was refused. Ask an operator to check that the approved service is listening.',
  http_authentication: 'The upstream rejected HTTP authentication. Ask an operator to check the approved credential reference and upstream access policy.',
  timeout: 'The request timed out. Writes may have completed. Investigate the operation outcome before any explicit retry; no mutation is automatically replayed.',
  invalid_mcp_response: 'The upstream returned an invalid MCP response. Ask an operator to check MCP compatibility and logs.',
};
function knownStage(value: string): value is keyof typeof stages { return Object.hasOwn(stages, value); }
function knownCode(value: string): value is keyof typeof guidance { return Object.hasOwn(guidance, value); }
interface Diagnostic { stage: keyof typeof stages; code: keyof typeof guidance; observedAt: string }
function diagnostic(value: unknown): Diagnostic | null {
  if (value === undefined || value === null) return null;
  if (!record(value) || typeof value.stage !== 'string' || !knownStage(value.stage)
    || typeof value.code !== 'string' || !knownCode(value.code)
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return invalid();
  return { stage: value.stage, code: value.code, observedAt: value.observedAt };
}
interface ServerSummary {
  serverId: string;
  displayName: string;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'unreachable' | 'disabled';
  toolCount: number;
  lastConnectedAt: string | null;
  lastDiscoveredAt: string | null;
  lastError: string | null;
  diagnostic: Diagnostic | null;
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
    lastDiscoveredAt: value.lastDiscoveredAt, diagnostic: diagnostic(value.diagnostic), lastError: value.lastError ? 'Upstream unavailable' : null };
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
  return <><dl>
    <dt>Configured state</dt><dd><StatusBadge>{server.enabled ? 'Enabled' : 'Disabled'}</StatusBadge></dd>
    <dt>Runtime status</dt><dd><StatusBadge>{server.status}</StatusBadge></dd>
    <dt>Available tool count</dt><dd>{server.toolCount}</dd>
    <dt>Last connected</dt><dd>{server.lastConnectedAt ?? 'Never'}</dd>
    <dt>Last discovered</dt><dd>{server.lastDiscoveredAt ?? 'Never'}</dd>
    <dt>Last failure</dt><dd>{server.lastError ?? 'None'}</dd>
  </dl>
    {!server.enabled ? <p>This registration is disabled. Enable it deliberately to connect and discover tools.</p>
      : server.status === 'unreachable' && <section aria-label="Current server failure">
        <h3>Current server failure</h3>
        {server.diagnostic ? <><p>Failure stage: {stages[server.diagnostic.stage]}</p>
          <p>Observed: <time dateTime={server.diagnostic.observedAt}>{server.diagnostic.observedAt}</time></p>
          <p>{guidance[server.diagnostic.code]}</p></>
          : <p>The upstream is unavailable. Ask an operator to inspect the approved registration and logs.</p>}
        <p>Refresh details reads the current observation. After investigation, use Refresh discovery deliberately to check recovery; it does not retry a tool call.</p>
      </section>}
  </>;
}
function ServerDetails({ id, refreshVersion, close, changed, edit, busy }: { id: string; refreshVersion: number; close: () => void;
  changed: (notice: string, removed?: boolean) => void; edit: (server: ServerDetail) => void; busy: (value: boolean) => void }) {
  const [data, setData] = useState<{ server: ServerDetail; catalog: Tool[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirmation, setConfirmation] = useState<'disable' | 'remove' | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void Promise.all([
      api.request(`/api/admin/servers/${id}`, 'GET', undefined, value => detail(value, id)),
      api.request(`/api/admin/servers/${id}/tools`, 'GET', undefined, tools),
    ]).then(([server, catalog]) => { if (active) setData({ server, catalog }); })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, revision, refreshVersion]);
  async function act(action: 'enable' | 'disable' | 'refresh' | 'remove') {
    if (pending || loading || error) return;
    setPending(true); busy(true); setActionError('');
    try {
      if (action === 'remove') {
        await api.request(`/api/admin/servers/${id}`, 'DELETE');
        changed('Server removed. Its tools are unavailable; Kubernetes Secrets were preserved.', true);
      } else {
        const server = await api.request(`/api/admin/servers/${id}/${action}`, 'POST', undefined, value => detail(value, id));
        const label = action === 'enable' ? 'Server enabled.' : action === 'disable' ? 'Server disabled.' : 'Discovery refreshed.';
        changed(`${label} Runtime status: ${server.status}.${server.status === 'unreachable'
          ? ' Discovery failed; tools are unavailable. Inspect configuration and refresh discovery to retry.' : ''}`);
      }
      setConfirmation(null);
      // A successful mutation invalidates the previous runtime/catalog snapshot.
      setData(null); setLoading(true); setRevision(value => value + 1);
    } catch (error) { setActionError(message(error)); }
    finally { setPending(false); busy(false); }
  }
  return <section className="access-details server-details" aria-label="Server details"><h2>Server details</h2>
    <button disabled={pending} onClick={close}>Close details</button>
    {error && <button disabled={pending || loading} onClick={() => setRevision(value => value + 1)}>Retry details</button>}
    <ReadState loading={loading} error={error} hasData={!!data} loadingMessage="Loading server details…">
    {data && <>
      <h3>{data.server.displayName}</h3><p>Identifier: {data.server.serverId}</p>
      <p>Endpoint: {data.server.url}</p><p>Transport: {data.server.transport}</p>
      <ServerState server={data.server} />
      <p>Authentication type: {data.server.authentication.type}</p>
      <p>Reference configured: {data.server.authentication.referenceConfigured ? 'Yes' : 'No'}</p>
      <p>Refresh details reads saved configuration and the available catalog. Refresh discovery deliberately reconnects and discovers tools; neither action invokes a tool.</p>
      <button disabled={pending || loading || !!error || !!confirmation} onClick={() => edit(data.server)}>Edit server</button>
      <button disabled={pending || loading || !!confirmation} onClick={() => { setActionError(''); setRevision(value => value + 1); }}>Refresh details</button>
      <button disabled={pending || loading || !!error || !!confirmation || !data.server.enabled} onClick={() => void act('refresh')}>Refresh discovery</button>
      {!data.server.enabled && <p>Discovery refresh requires an enabled registration.</p>}
      {data.server.enabled
        ? <button disabled={pending || loading || !!error} onClick={() => { setActionError(''); setConfirmation('disable'); }}>Disable server</button>
        : <button disabled={pending || loading || !!error || !!confirmation} onClick={() => void act('enable')}>Enable server</button>}
      <button disabled={pending || loading || !!error} onClick={() => { setActionError(''); setConfirmation('remove'); }}>Remove server</button>
      {confirmation && <Dialog label={`${confirmation === 'disable' ? 'Disable' : 'Remove'} server confirmation`} pending={pending} close={() => setConfirmation(null)}>
        <p>{confirmation === 'disable' ? `Disable ${id}? Its tools will become unavailable to MCP clients until enabled again.`
          : `Remove ${id}? Its tools will become unavailable to MCP clients. This unregisters the configuration and closes connections. Kubernetes Secrets will not be deleted.`}</p>
        <button disabled={pending} onClick={() => void act(confirmation)}>Confirm {confirmation}</button>
        {actionError && <><p role="alert">{actionError}</p>
          <p>The change may have succeeded if its response was lost. Close this confirmation. Refresh details to check the current state before retrying. No action is automatically replayed.</p></>}
      </Dialog>}
      <h3>Available tools</h3>
      {data.catalog.length === 0 ? <p>No available tools.</p> : data.catalog.map(tool => <section key={tool.name} aria-label={tool.name}>
        <h4>{tool.name}</h4><p className="upstream-description">{tool.description ?? 'No description.'}</p>
        <pre className="tool-schema" role="region" aria-label={`Input schema for ${tool.name}`} tabIndex={0}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
      </section>)}
    </>}
    </ReadState>
    {pending && <p role="status">Updating server…</p>}{actionError && !confirmation && <><p role="alert">{actionError}</p><p>The change may have succeeded. Refresh details to check the current state before retrying. No action is automatically replayed.</p></>}
  </section>;
}
export function Servers() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ initial?: ServerDetail } | null>(null);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  async function save(id: string, input: ServerInput) {
    setPending(true);
    try {
      const server = await api.request(editor?.initial ? `/api/admin/servers/${id}` : '/api/admin/servers',
        editor?.initial ? 'PATCH' : 'POST', input, value => detail(value, id));
      setEditor(null); setSelected(id); setRevision(value => value + 1); setDetailRevision(value => value + 1);
      setNotice(server.status === 'unreachable'
        ? 'Server saved. Discovery failed; the registration remains saved. Inspect the endpoint and authentication, then edit or refresh discovery to recover.'
        : `Server saved. Runtime status: ${server.status}.`);
    } finally { setPending(false); }
  }
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void api.request('/api/admin/servers', 'GET', undefined, serverList)
      .then(value => { if (active) { setServers(value); setLoaded(true); } })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  return <section><h1>Servers</h1><p>Configured state and observed runtime status are separate. Only connected servers offer available tools.</p>
    <button disabled={pending || !!editor} onClick={() => { setNotice(''); setEditor({}); }}>Register server</button>
    <button disabled={pending || loading || !!editor} onClick={() => setRevision(value => value + 1)}>Refresh servers</button>
    {notice && <p role="status">{notice}</p>}
    {editor && <ServerForm initial={editor.initial} save={save} close={() => setEditor(null)} />}
    {error && <button disabled={pending || loading || !!editor} onClick={() => setRevision(value => value + 1)}>Retry servers</button>}
    <ReadState loading={loading} error={error} hasData={loaded} loadingMessage="Loading servers…" empty={servers.length === 0} emptyMessage="No registered servers.">
      <div className="table-scroll" role="region" aria-label="Registered servers" tabIndex={0}><table className="access-table server-table">
        <thead><tr><th>Identifier</th><th>Name</th><th>Configured state</th><th>Runtime status</th><th>Available tools</th><th>Details</th></tr></thead>
        <tbody>{servers.map(server => <tr key={server.serverId}><td>{server.serverId}</td><td>{server.displayName}</td>
          <td><StatusBadge>{server.enabled ? 'Enabled' : 'Disabled'}</StatusBadge></td><td><StatusBadge>{server.status}</StatusBadge></td><td>{server.toolCount}</td>
          <td><button disabled={pending || !!editor} aria-label={`Inspect ${server.serverId}`} onClick={() => setSelected(server.serverId)}>Inspect</button></td></tr>)}</tbody>
      </table></div>
    </ReadState>
    <div hidden={!!editor}>{selected && <ServerDetails key={selected} id={selected} refreshVersion={detailRevision} close={() => setSelected(null)}
      busy={setPending} changed={(notice, removed) => {
        setNotice(notice); if (removed) setSelected(null); setRevision(value => value + 1);
      }} edit={server => { setNotice(''); setEditor({ initial: server }); }} />}</div>
  </section>;
}
