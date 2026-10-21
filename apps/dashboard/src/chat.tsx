import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api.js';
import { ReadState, StatusBadge } from './ui.js';

const outcomes = {
  unauthenticated: 'Authentication is required. Log in again before submitting a new prompt.',
  success: 'Completed successfully.',
  tool_error: 'The tool returned an error. Review the answer before deciding what to do next.',
  rejected: 'The request was rejected before tool execution.',
  unauthorized: 'Current permissions do not allow this call.',
  not_found: 'The tool is no longer available.',
  upstream_unavailable: 'The upstream is unavailable.',
  upstream_timeout: 'The call timed out. A write may have completed; inspect its state before repeating it.',
  upstream_error: 'Execution failed. A write may have completed; inspect its state before repeating it.',
};
function isOutcome(value: unknown): value is keyof typeof outcomes {
  return typeof value === 'string' && Object.hasOwn(outcomes, value);
}
interface ChatCall { id: string; toolName: string | null; outcome: keyof typeof outcomes }
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
      || !isOutcome(call.outcome)) return invalid();
    return { id: call.id, toolName: call.toolName, outcome: call.outcome };
  });
  return { answer: value.answer, calls, ...(value.error ? { error: value.error } : {}) };
}

export function Chat() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [availabilityError, setAvailabilityError] = useState('');
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [result, setResult] = useState<ChatResult | null>(null);
  useEffect(() => {
    let active = true;
    setChecking(true); setAvailabilityError('');
    void api.request('/api/chat', 'GET', undefined, value => {
      if (!record(value) || typeof value.available !== 'boolean') return invalid();
      return value.available;
    }).then(value => { if (active) setAvailable(value); })
      .catch(error => { if (active) setAvailabilityError(error instanceof Error ? error.message : 'Unable to check chat.'); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [revision]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || checking || !available || availabilityError) return;
    const prompt = String(new FormData(event.currentTarget).get('prompt') ?? '').trim();
    if (!prompt || prompt.length > 8000) { setError('Enter a prompt of 1–8000 characters.'); return; }
    setPending(true); setError(''); setResult(null); setSubmittedPrompt(prompt);
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
    <ReadState loading={checking} error={availabilityError} hasData={available !== null} loadingMessage="Checking chat availability…">
      <p role="status">{available ? 'Chat configured. Provider connectivity is checked when you send a prompt.' : 'Chat unavailable. Ask an operator to configure the provider.'}</p>
    </ReadState>
    <button className="secondary" disabled={checking || pending} onClick={() => setRevision(value => value + 1)}>Check availability</button>
    <form className="chat-composer" onSubmit={submit} aria-busy={pending}>
      <label htmlFor="chat-prompt">Prompt</label>
      <p id="prompt-guidance">One independent prompt, up to 8000 characters. Check store state before repeating a write.</p>
      <textarea id="chat-prompt" name="prompt" aria-describedby="prompt-guidance" rows={6} required maxLength={8000} disabled={checking || !available || Boolean(availabilityError) || pending} />
      <button disabled={checking || !available || Boolean(availabilityError) || pending}>{pending ? 'Running tools…' : 'Send prompt'}</button>
    </form>
    {pending && <p role="status">Waiting for the provider and tools. Avoid resubmitting this prompt.</p>}
    {error && <p role="alert">{error}</p>}
    {submittedPrompt && <section aria-label="Submitted prompt"><h2>Submitted prompt</h2><p className="chat-text">{submittedPrompt}</p></section>}
    {result && <>
      <h2>Prompt result</h2>
      {result.calls.length > 0 ? <><p id="chat-scroll-guidance">Scroll horizontally to read call IDs, tool names and outcomes.</p><div className="table-scroll" role="region" aria-label="Chat tool calls" aria-describedby="chat-scroll-guidance" tabIndex={0}><table><caption>Tool calls</caption><thead><tr><th>Call ID</th><th>Tool</th><th>Outcome</th></tr></thead>
        <tbody>{result.calls.map(call => <tr key={call.id}><td>{call.id}</td><td>{call.toolName ?? 'Unknown tool'}</td><td><StatusBadge>{call.outcome}</StatusBadge><p>{outcomes[call.outcome]}</p></td></tr>)}</tbody></table></div></>
        : <p>No tools executed.</p>}
      {result.answer && <section aria-label="Answer"><h2>Answer</h2><p aria-label="Final answer" className="chat-text">{result.answer}</p></section>}
    </>}
  </section>;
}
