import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { api, type DashboardUser } from './api.js';
import { PersonalKeys } from './keys.js';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request failed. Try again.';
}
function Login() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!email || !password) { setError('Email and password are required.'); return; }
    setError(''); setPending(true); form.reset();
    try { await api.login(email, password); }
    catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  return <section><h1>Log in</h1><form onSubmit={submit} noValidate aria-busy={pending}>
    <label>Email<input name="email" type="email" autoComplete="username" required disabled={pending} /></label>
    <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={pending} /></label>
    {error && <p role="alert">{error}</p>}
    <button disabled={pending}>{pending ? 'Logging in…' : 'Log in'}</button>
  </form></section>;
}
function PasswordReplacement() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = String(data.get('currentPassword') ?? '');
    const replacement = String(data.get('newPassword') ?? '');
    if ([current, replacement].some(value => [...value].length < 12 || [...value].length > 128)) {
      setError('Passwords must contain 12–128 characters.'); return;
    }
    if (current === replacement) { setError('New password must be different.'); return; }
    setError(''); setPending(true); form.reset();
    try { await api.changePassword(current, replacement); }
    catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  return <section><h1>Replace your password</h1><p>Replace your assigned password to continue. You will then log in again.</p>
    <form onSubmit={submit} noValidate aria-busy={pending}>
      <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required disabled={pending} /></label>
      <label>New password<input name="newPassword" type="password" autoComplete="new-password" required disabled={pending} /></label>
      {error && <p role="alert">{error}</p>}
      <button disabled={pending}>{pending ? 'Replacing password…' : 'Replace password'}</button>
    </form></section>;
}
function ProtectedDashboard({ user, path }: { user: DashboardUser; path: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const restricted = user.requiredPasswordChange;
  const adminPage = path.startsWith('/admin/');
  const allowed = !adminPage || user.role === 'admin';
  const titles: Record<string, string> = { '/dashboard': 'Dashboard', '/keys': 'Personal API keys', '/admin/users': 'Users', '/admin/servers': 'Servers' };
  const title = restricted ? 'Replace your password' : !allowed ? 'Access denied' : titles[path] ?? 'Page not found';
  async function logout() {
    if (pending) return;
    setPending(true); setError('');
    try { await api.logout(); }
    catch (error) { setError(`Logout was not confirmed. ${errorMessage(error)}`); }
    finally { setPending(false); }
  }
  return <>
    <nav aria-label="Account and pages">
      <p>{user.email} · {user.role}</p>
      <p>Current page: {title}</p>
      {!restricted && <div className="links">
        <a href="/dashboard" aria-current={path === '/dashboard' ? 'page' : undefined}>Dashboard</a>
        <a href="/keys" aria-current={path === '/keys' ? 'page' : undefined}>API keys</a>
        {user.role === 'admin' && <>
          <a href="/admin/users" aria-current={path === '/admin/users' ? 'page' : undefined}>Users</a>
          <a href="/admin/servers" aria-current={path === '/admin/servers' ? 'page' : undefined}>Servers</a>
        </>}
      </div>}
      <button onClick={logout} disabled={pending}>{pending ? 'Logging out…' : 'Log out'}</button>
    </nav>
    {error && <p role="alert">{error}</p>}
    {restricted ? <PasswordReplacement /> : path === '/keys' ? <PersonalKeys /> : <section><h1>{title}</h1>
      {!allowed ? <p>Administrator access is required for this page.</p>
        : path === '/dashboard' ? <p>You are signed in to Urumi MCP Gateway.</p>
        : titles[path] ? <p>{title} management will be available in a subsequent dashboard update.</p>
        : <a href="/dashboard">Return to dashboard</a>}
    </section>}
  </>;
}
export function App() {
  const state = useSyncExternalStore(api.subscribe, api.getSnapshot);
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    void api.refresh();
    const refresh = () => { if (document.visibilityState === 'visible') void api.refresh(); };
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(interval); window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  useEffect(() => {
    if (state.checking) return;
    const target = state.session
      ? state.session.user.requiredPasswordChange ? '/change-password'
        : ['/', '/login', '/change-password'].includes(path) ? '/dashboard' : path
      : '/login';
    if (target !== path) { history.replaceState(null, '', target); setPath(target); }
  }, [state.checking, state.session, path]);
  return <main><header>Urumi MCP Gateway</header>
    {state.notice && <p role="status">{state.notice}</p>}
    {state.checking ? <p role="status">Checking session…</p> : state.session
      ? <ProtectedDashboard key={state.generation} user={state.session.user} path={path} />
      : <><Login /><button className="secondary" onClick={() => void api.refresh()}>Retry session check</button></>}
  </main>;
}
