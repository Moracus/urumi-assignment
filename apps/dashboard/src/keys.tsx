import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiError, type DashboardUser } from './api.js';

interface KeyMetadata {
  id: string; name: string | null; prefix: string;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function metadata(value: unknown): KeyMetadata {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id)
    || !(value.name === null || typeof value.name === 'string') || typeof value.prefix !== 'string'
    || !timestamp(value.createdAt) || !(value.lastUsedAt === null || timestamp(value.lastUsedAt))
    || !(value.revokedAt === null || timestamp(value.revokedAt))) return invalid();
  return { id: value.id, name: value.name, prefix: value.prefix, createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt, revokedAt: value.revokedAt };
}
function keyPage(value: unknown, page: number) {
  if (!record(value) || !Array.isArray(value.keys) || value.keys.length > 10 || value.page !== page || value.limit !== 10) return invalid();
  return value.keys.map(metadata);
}
function creation(value: unknown) {
  if (!record(value) || typeof value.rawKey !== 'string' || !/^ugw_[A-Za-z0-9_-]{43}$/.test(value.rawKey)) return invalid();
  return { key: metadata(value.key), rawKey: value.rawKey };
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The request failed. Try again.'; }
function date(value: string | null) { return value ? new Date(value).toLocaleString() : '—'; }

export function ConnectionInstructions() {
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    setLoading(true); setError(''); setUrl(undefined);
    void fetch('/runtime-config.json', {
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
    }).catch(() => { throw new Error('Unable to load connection configuration. Try again.'); }).then(async response => {
      if (!response.ok) throw new Error('Unable to load connection configuration. Try again.');
      let config: unknown;
      try { config = await response.json(); }
      catch { throw new Error('Connection configuration is invalid. Ask the operator to set dashboard.publicMcpUrl.'); }
      if (!record(config) || Object.keys(config).some(key => key !== 'publicMcpUrl')) {
        throw new Error('Connection configuration is invalid. Ask the operator to set dashboard.publicMcpUrl.');
      }
      if (config.publicMcpUrl === '' || config.publicMcpUrl === undefined) {
        throw new Error('The public MCP URL has not been configured. Ask the operator to set dashboard.publicMcpUrl.');
      }
      const value = config.publicMcpUrl;
      try {
        if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || !/^https?:\/\/[^\s/@?#\\]+\/mcp$/.test(value)) throw new Error();
        const parsed = new URL(value);
        if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/mcp') throw new Error();
        if (active) setUrl(parsed.href);
      } catch { throw new Error('Connection configuration is invalid. Ask the operator to set dashboard.publicMcpUrl.'); }
    }).catch(error => {
      if (active) setError(error instanceof Error && error.name !== 'AbortError'
        ? error.message : 'Unable to load connection configuration. Try again.');
    }).finally(() => { clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [revision]);
  return <section><h2>Connect an MCP client</h2>
    {loading ? <p role="status">Loading connection configuration…</p> : url ? <><p>Public MCP URL: <code>{url}</code></p>
      <p>Use the MCP TypeScript SDK v2 with Streamable HTTP. Install <code>@modelcontextprotocol/client@^2.0.0</code> in a Node.js project and run:</p>
      <pre>{`import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client({ name: 'urumi-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(${JSON.stringify(url)}), {
  requestInit: { headers: { Authorization: 'Bearer <YOUR_GATEWAY_API_KEY>' } },
}));
try {
  console.log(await client.listTools());
  console.log(await client.callTool({ name: 'calculator.calculate',
    arguments: { operation: 'multiply', a: 6, b: 7 } }));
} finally { await client.close(); }`}</pre>
      <p>Replace the credential placeholder privately. Keep credentials out of source control and logs. Revocation rejects the next MCP request; your dashboard session remains active.</p></>
      : <><p role="alert">{error}</p><button onClick={() => setRevision(value => value + 1)}>Retry connection configuration</button></>}
  </section>;
}

export function PersonalKeys() {
  return <KeyManagement />;
}

export function UserKeys({ owner }: { owner: DashboardUser }) {
  return <KeyManagement key={`${owner.id}:${owner.status}:${owner.requiredPasswordChange}`} owner={owner} />;
}

function KeyManagement({ owner }: { owner?: DashboardUser }) {
  const path = owner ? `/api/admin/users/${owner.id}/keys` : '/api/keys';
  const eligible = !owner || (owner.status === 'active' && !owner.requiredPasswordChange);
  const [keys, setKeys] = useState<KeyMetadata[]>([]);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [confirm, setConfirm] = useState<KeyMetadata | null>(null);
  const lifetime = useRef(0);
  const secretRevision = useRef(0);
  useEffect(() => {
    const clear = () => {
      ++secretRevision.current;
      flushSync(() => { setIssued(null); setCopyStatus(''); });
    };
    window.addEventListener('pagehide', clear);
    return () => { ++lifetime.current; ++secretRevision.current; window.removeEventListener('pagehide', clear); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setListError(''); setKeys([]);
    void api.request(`${path}?page=${page}&limit=10`, 'GET', undefined, value => keyPage(value, page))
      .then(result => { if (active) setKeys(result); })
      .catch(error => { if (active) setListError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, page, revision]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || issued || !eligible) return;
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name || name.length > 100) { setError('Enter a key name of 1–100 characters.'); return; }
    const current = lifetime.current;
    const secret = ++secretRevision.current;
    setPending(true); setError(''); setNotice(''); setCopyStatus('');
    try {
      const result = await api.request(path, 'POST', { name }, creation);
      if (current !== lifetime.current) return;
      if (secret === secretRevision.current) setIssued(result.rawKey);
      form.reset(); setRevision(value => value + 1);
    } catch (error) {
      if (current === lifetime.current) {
        setError(`${message(error)} Creation may have succeeded. Refresh metadata and revoke any unwanted key before creating another.`);
        setRevision(value => value + 1);
      }
    } finally { if (current === lifetime.current) setPending(false); }
  }
  async function copy() {
    if (!issued) return;
    const secret = secretRevision.current;
    try {
      await navigator.clipboard.writeText(issued);
      if (secret === secretRevision.current) setCopyStatus('Key copied.');
    } catch { if (secret === secretRevision.current) setCopyStatus('Copy failed. Select and copy the key manually before dismissal.'); }
  }
  async function revoke() {
    if (!confirm || pending) return;
    const current = lifetime.current;
    setPending(true); setError(''); setNotice('');
    try {
      await api.request(`${path}/${confirm.id}`, 'DELETE');
      if (current !== lifetime.current) return;
      setConfirm(null); setNotice('Key revoked.'); setRevision(value => value + 1);
    } catch (error) { if (current === lifetime.current) setError(message(error)); }
    finally { if (current === lifetime.current) setPending(false); }
  }
  return <section aria-label={owner ? 'Selected user API keys' : undefined}>
    {owner ? <><h3>API keys for {owner.email}</h3><p>Owner: {owner.email} ({owner.id}). Revoked records remain visible.</p></>
      : <><h1>Personal API keys</h1><p>Manage keys belonging to your account. Revoked records remain visible.</p></>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {issued ? <section aria-label="One-time key creation"><h2>Save your new key</h2>
      {owner && <p>This key belongs to {owner.email} ({owner.id}). Share it privately with this user.</p>}
      <p>Save this key now. It cannot be recovered after dismissal.</p>
      <label>New API key<input readOnly value={issued} autoComplete="off" /></label>
      <button onClick={() => void copy()}>Copy key</button>
      <button onClick={() => { ++secretRevision.current; setIssued(null); setCopyStatus(''); }}>Dismiss key</button>
      {copyStatus && <p role="status">{copyStatus}</p>}
    </section> : !eligible ? <p>Issuance requires an active user who has completed password replacement. Existing metadata and revocation remain available.</p> : <form onSubmit={create} aria-busy={pending}>
      <label>Key name<input name="name" maxLength={100} required disabled={pending} /></label>
      <button disabled={pending}>{pending ? 'Creating key…' : 'Create key'}</button>
    </form>}
    {confirm && <section role="dialog" aria-modal="false" aria-label="Confirm revocation">
      <p>Revoke {confirm.name ?? 'Unnamed key'} ({confirm.prefix}){owner ? ` belonging to ${owner.email} (${owner.id})` : ''}? Its MCP access will end on the next request.</p>
      <button disabled={pending} onClick={() => void revoke()}>{pending ? 'Revoking…' : 'Confirm revoke'}</button>
      <button disabled={pending} onClick={() => setConfirm(null)}>Cancel</button>
    </section>}
    <h2>{owner ? 'User key metadata' : 'Your key metadata'}</h2>
    <button disabled={loading || pending} onClick={() => setRevision(value => value + 1)}>Refresh metadata</button>
    {loading ? <p role="status">Loading keys…</p> : listError ? <><p role="alert">{listError}</p>
      <button onClick={() => setRevision(value => value + 1)}>Retry keys</button></>
      : keys.length === 0 ? <p>No keys on this page.</p> : <div className="table-scroll"><table>
        <thead><tr>{['Identifier', 'Name', 'Prefix', 'Created', 'Last used', 'Revoked', 'Action'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{keys.map(key => <tr key={key.id}><td>{key.id}</td><td>{key.name ?? 'Unnamed key'}</td><td>{key.prefix}</td>
          <td>{date(key.createdAt)}</td><td>{date(key.lastUsedAt)}</td><td>{date(key.revokedAt)}</td>
          <td>{key.revokedAt ? 'Revoked' : <button disabled={pending || !!confirm} onClick={() => { setConfirm(key); setError(''); }}>Revoke {key.name ?? key.prefix}</button>}</td>
        </tr>)}</tbody></table></div>}
    <div className="pagination" aria-label="Key pages">
      <button disabled={page === 1 || loading || pending || !!confirm} onClick={() => setPage(value => value - 1)}>Previous page</button>
      <span>Page {page}</span>
      <button disabled={loading || pending || !!confirm || !!listError || keys.length < 10} onClick={() => setPage(value => value + 1)}>Next page</button>
    </div>
    {!owner && <ConnectionInstructions />}
  </section>;
}
