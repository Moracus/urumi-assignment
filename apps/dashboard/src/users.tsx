import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type DashboardUser } from './api.js';

const pageSize = 10;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function user(value: unknown): DashboardUser {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id)
    || typeof value.email !== 'string'
    || (value.role !== 'admin' && value.role !== 'member')
    || (value.status !== 'active' && value.status !== 'disabled')
    || typeof value.requiredPasswordChange !== 'boolean' || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return invalid();
  return { id: value.id, email: value.email, role: value.role, status: value.status,
    requiredPasswordChange: value.requiredPasswordChange, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function userResponse(value: unknown) { return record(value) ? user(value.user) : invalid(); }
function userPage(value: unknown, page: number) {
  if (!record(value) || !Array.isArray(value.users) || value.users.length > pageSize
    || value.page !== page || value.limit !== pageSize) return invalid();
  return value.users.map(user);
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The request failed. Try again.'; }

function UserDetails({ id, close }: { id: string; close: () => void }) {
  const [account, setAccount] = useState<DashboardUser | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setAccount(null); setError('');
    void api.request(`/api/admin/users/${id}`, 'GET', undefined, userResponse)
      .then(value => { if (active) setAccount(value); })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, revision]);
  return <section aria-label="User details"><h2>User details</h2>
    <button onClick={close}>Close details</button>
    {loading ? <p role="status">Loading user details…</p> : error ? <><p role="alert">{error}</p>
      <button onClick={() => setRevision(value => value + 1)}>Retry details</button></> : account && <dl>
      <dt>Identifier</dt><dd>{account.id}</dd><dt>Email</dt><dd>{account.email}</dd>
      <dt>Role</dt><dd>{account.role}</dd><dt>Status</dt><dd>{account.status}</dd>
      <dt>Password replacement</dt><dd>{account.requiredPasswordChange ? 'Required' : 'Complete'}</dd>
      <dt>Created</dt><dd>{new Date(account.createdAt).toLocaleString()}</dd>
      <dt>Updated</dt><dd>{new Date(account.updatedAt).toLocaleString()}</dd>
    </dl>}
  </section>;
}

export function Users() {
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setUsers([]); setListError('');
    void api.request(`/api/admin/users?page=${page}&limit=${pageSize}`, 'GET', undefined, value => userPage(value, page))
      .then(value => { if (active) setUsers(value); })
      .catch(error => { if (active) setListError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, revision]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    form.reset(); setError(''); setNotice('');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      setError('Enter a valid member email.'); return;
    }
    if ([...password].length < 12 || [...password].length > 128) {
      setError('Assigned passwords must contain 12–128 characters.'); return;
    }
    setPending(true);
    try {
      const account = await api.request('/api/admin/users', 'POST', { email, password }, userResponse);
      setSelected(account.id); setNotice('Member created. They must replace their assigned password and log in again.');
      setPage(1); setRevision(value => value + 1);
    } catch (error) {
      setError(error instanceof ApiError && error.status === 409 ? 'That email already has an account. Use a different email.'
        : error instanceof ApiError && error.status === 400 ? 'Check the email and assigned password. Passwords must contain 12–128 characters.'
        : message(error));
    } finally { setPending(false); }
  }
  return <section><h1>Users</h1>
    <h2>Create member</h2>
    <p>New accounts are members and must replace their assigned password. Promotion is a separate action.</p>
    <form onSubmit={create} noValidate aria-busy={pending}>
      <label>Member email<input name="email" type="email" autoComplete="off" required maxLength={254} disabled={pending} /></label>
      <label>Assigned password<input name="password" type="password" autoComplete="new-password" required disabled={pending} /></label>
      <p>Use 12–128 characters. Share the assigned password privately with the member.</p>
      <button disabled={pending}>{pending ? 'Creating member…' : 'Create member'}</button>
    </form>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {selected && <UserDetails key={selected} id={selected} close={() => setSelected(null)} />}
    <h2>Accounts</h2>
    <button disabled={loading || pending} onClick={() => { setLoading(true); setRevision(value => value + 1); }}>Refresh users</button>
    {loading ? <p role="status">Loading users…</p> : listError ? <><p role="alert">{listError}</p>
      <button onClick={() => { setLoading(true); setRevision(value => value + 1); }}>Retry users</button></>
      : users.length === 0 ? <p>No users on this page.</p> : <div className="table-scroll"><table>
        <thead><tr>{['Email', 'Role', 'Status', 'Password replacement', 'Action'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{users.map(account => <tr key={account.id}><td>{account.email}</td><td>{account.role}</td><td>{account.status}</td>
          <td>{account.requiredPasswordChange ? 'Required' : 'Complete'}</td>
          <td><button onClick={() => setSelected(account.id)}>Inspect {account.email}</button></td>
        </tr>)}</tbody>
      </table></div>}
    <div className="pagination" aria-label="User pages">
      <button disabled={page === 1 || loading || pending} onClick={() => { setLoading(true); setPage(value => value - 1); }}>Previous page</button>
      <span>Page {page}</span>
      <button disabled={loading || pending || !!listError || users.length < pageSize || page >= 2147483647}
        onClick={() => { setLoading(true); setPage(value => value + 1); }}>Next page</button>
    </div>
  </section>;
}
