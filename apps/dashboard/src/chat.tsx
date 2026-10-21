import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api.js';

interface ChatCall { id: string; toolName: string | null; outcome: string }
interface ChatResult { answer: string; calls: ChatCall[]; error?: string }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Review tool history before submitting again.'); }
function decode(value: unknown): ChatResult {
  if (!record(value) || typeof value.answer !== 'string' || !Array.isArray(value.calls) || value.calls.length > 8
    || (value.error !== undefined && typeof value.error !== 'string')) return invalid();
  const calls = value.calls.map((call: unknown): ChatCall => {
    if (!record(call) || typeof call.id !== 'string' || (call.toolName !== null && typeof call.toolName !== 'string')
      || typeof call.outcome !== 'string') return invalid();
    return { id: call.id, toolName: call.toolName, outcome: call.outcome };
  });
  return { answer: value.answer, calls, ...(value.error ? { error: value.error } : {}) };
}

export function Chat() {
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ChatResult | null>(null);
  useEffect(() => {
    let active = true;
    setChecking(true); setAvailable(false); setError('');
    void api.request('/api/chat', 'GET', undefined, value => {
      if (!record(value) || typeof value.available !== 'boolean') return invalid();
      return value.available;
    }).then(value => { if (active) setAvailable(value); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'Unable to check chat.'); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [revision]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !available) return;
    const prompt = String(new FormData(event.currentTarget).get('prompt') ?? '').trim();
    if (!prompt || prompt.length > 8000) { setError('Enter a prompt of 1–8000 characters.'); return; }
    setPending(true); setError(''); setResult(null);
    try {
      const response = await api.request('/api/chat', 'POST', { prompt }, decode);
      setResult(response);
      if (response.error) setError(response.error);
    } catch (error) {
      setError(`${error instanceof Error ? error.message : 'Chat failed.'} Review tool history before repeating a write; it may already have completed.`);
    } finally { setPending(false); }
  }
  return <section><h1>Chat</h1>
    <p>Each prompt starts a new conversation using your current tool permissions. Calls may change shared store data.</p>
    <p>For published products, request status=publish. For today’s orders, include an IANA timezone such as Asia/Kolkata.</p>
    {checking ? <p role="status">Checking chat availability…</p> : !available && <>
      <p role="status">Chat unavailable. Ask an operator to configure the provider.</p>
      <button onClick={() => setRevision(value => value + 1)}>Check availability</button>
    </>}
    <form onSubmit={submit} aria-busy={pending}>
      <label>Prompt<textarea name="prompt" required maxLength={8000} disabled={checking || !available || pending} /></label>
      <button disabled={checking || !available || pending}>{pending ? 'Running tools…' : 'Send prompt'}</button>
    </form>
    {pending && <p role="status">Waiting for the provider and tools. Avoid resubmitting this prompt.</p>}
    {error && <p role="alert">{error}</p>}
    {result && <>
      {result.calls.length > 0 ? <div className="table-scroll" role="region" aria-label="Chat tool calls" tabIndex={0}><table><caption>Tool calls</caption><thead><tr><th>Call ID</th><th>Tool</th><th>Outcome</th></tr></thead>
        <tbody>{result.calls.map(call => <tr key={call.id}><td>{call.id}</td><td>{call.toolName ?? 'Unknown tool'}</td><td>{call.outcome}</td></tr>)}</tbody></table></div>
        : <p>No tools executed.</p>}
      {result.answer && <p aria-label="Final answer" style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>}
    </>}
  </section>;
}
