import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from './api.js';

interface InitialServer { serverId: string; displayName: string; url: string }
interface SecretReference { namespace: string; name: string; key: string }
type Authentication = { type: 'none' } | { type: 'bearer'; secretRef: SecretReference }
  | { type: 'header'; headerName: string; secretRef: SecretReference };
export interface ServerInput {
  displayName: string;
  url: string;
  authentication?: Authentication;
  transport?: 'streamable-http';
  enabled?: boolean;
  serverId?: string;
}

// Keep the form's syntax checks aligned with registrations.ts. Exact destination
// and Secret approvals are enforced by the backend, never inferred in the browser.
const namespacePattern = '[a-z0-9](?:[a-z0-9\\x2d]*[a-z0-9])?';
const secretNamePattern = '[a-z0-9](?:[a-z0-9\\x2d]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9\\x2d]*[a-z0-9])?)*';
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reservedHeader = /^(authorization|proxy-.*|host|cookie|set-cookie|connection|content-.*|transfer-encoding|upgrade|te|trailer|keep-alive|accept.*|origin|referer|user-agent|forwarded|x-forwarded-.*|x-real-ip|x-http-.*|sec-.*|mcp-.*|last-event-id)$/i;

export function ServerForm({ initial, save, close }: {
  initial?: InitialServer;
  save: (id: string, input: ServerInput) => Promise<void>;
  close: () => void;
}) {
  const [id, setId] = useState(initial?.serverId ?? '');
  const [name, setName] = useState(initial?.displayName ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [replace, setReplace] = useState(false);
  const [mode, setMode] = useState<'none' | 'bearer' | 'header'>('none');
  const [namespace, setNamespace] = useState('');
  const [secretName, setSecretName] = useState('');
  const [key, setKey] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    const form = formRef.current;
    form?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
    const previous = previousFocus.current;
    return () => { queueMicrotask(() => {
      // Strict Mode replays effects while the form remains mounted.
      if (form?.isConnected) return;
      if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled')) previous.focus();
      else document.getElementById('main-content')?.focus();
    }); };
  }, []);
  const authenticationIncluded = !initial || replace;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    let endpoint: URL;
    try {
      endpoint = new URL(url);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
    } catch { setError('Use an HTTP or HTTPS endpoint without credentials or a fragment.'); return; }
    if (!name.trim()) { setError('Enter a display name.'); return; }
    if (authenticationIncluded && mode === 'header' && (!headerPattern.test(headerName) || reservedHeader.test(headerName))) {
      setError('Use a custom HTTP header name. Authentication, routing, cookie, proxy and protocol headers are reserved.'); return;
    }
    const input: ServerInput = { displayName: name.trim(), url: endpoint.href };
    if (!initial) Object.assign(input, { serverId: id, transport: 'streamable-http', enabled: true });
    if (authenticationIncluded) {
      const secretRef = { namespace, name: secretName, key };
      input.authentication = mode === 'none' ? { type: 'none' } : mode === 'bearer'
        ? { type: 'bearer', secretRef } : { type: 'header', secretRef, headerName };
    }
    setPending(true);
    try { await save(id, input); }
    catch (error) {
      setError(error instanceof ApiError && error.status === 400
        ? 'Check the server fields. The endpoint and exact Secret reference must be operator-approved; custom headers must be permitted.'
        : error instanceof Error ? error.message : 'Unable to save. Try again.');
    } finally { setPending(false); }
  }
  return <section aria-label="Server editor" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pending) close(); }
  }}><h2>{initial ? 'Edit server' : 'Register server'}</h2>
    <p>Streamable HTTP only. The identifier is the immutable public tool namespace. New registrations are enabled.</p>
    <form className="access-form" ref={formRef} aria-busy={pending} onSubmit={event => void submit(event)}>
      <fieldset disabled={pending}>
        <label>Server identifier<input required maxLength={100} pattern="[a-z][a-z0-9_\x2d]*" value={id} disabled={!!initial} onChange={event => setId(event.target.value)} /></label>
        <label>Display name<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Endpoint<input required type="url" value={url} onChange={event => setUrl(event.target.value)} /></label>
        <p>The endpoint must already be approved by the operator's destination and network policies.</p>
        {initial && <><p>Existing authentication is preserved unless you choose to replace it.</p>
          <label><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Replace authentication</label></>}
        {authenticationIncluded && <>
          <label>Authentication mode<select value={mode} onChange={event => {
            const value = event.target.value;
            if (value === 'none' || value === 'bearer' || value === 'header') setMode(value);
          }}><option value="none">None</option><option value="bearer">Bearer</option><option value="header">Custom header</option></select></label>
          {mode !== 'none' && <>
            <p>Enter an approved, pre-provisioned Kubernetes Secret reference. Credential values are never entered or retrieved here.</p>
            <label>Secret namespace<input required maxLength={63} pattern={namespacePattern} value={namespace} onChange={event => setNamespace(event.target.value)} /></label>
            <label>Secret name<input required maxLength={253} pattern={secretNamePattern} value={secretName} onChange={event => setSecretName(event.target.value)} /></label>
            <label>Secret key<input required maxLength={253} pattern="[a-zA-Z0-9._\x2d]+" value={key} onChange={event => setKey(event.target.value)} /></label>
            {mode === 'header' && <label>Custom header name<input required maxLength={100} value={headerName} onChange={event => setHeaderName(event.target.value)} /></label>}
          </>}
        </>}
      </fieldset>
      <button disabled={pending} type="submit">{pending ? 'Saving server…' : 'Save server'}</button>
      <button disabled={pending} type="button" onClick={close}>Cancel editing</button>
    </form>
    {pending && <p role="status">Saving configuration and attempting discovery…</p>}
    {error && <p role="alert">{error} The save may have succeeded if its response was lost. Cancel editing and inspect the registration before retrying. No save is automatically replayed.</p>}
  </section>;
}
