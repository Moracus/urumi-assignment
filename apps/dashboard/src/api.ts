export interface DashboardUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  requiredPasswordChange: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface Session { user: DashboardUser; csrfToken: string }
export interface SessionState {
  session: Session | null;
  checking: boolean;
  generation: number;
  notice: string;
}
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isSession(value: unknown): value is Session {
  if (!isRecord(value) || !isRecord(value.user)) return false;
  const user = value.user;
  return typeof value.csrfToken === 'string' && /^[a-f0-9]{64}$/.test(value.csrfToken)
    && typeof user.id === 'string' && /^[a-f0-9]{24}$/.test(user.id)
    && typeof user.email === 'string'
    && (user.role === 'admin' || user.role === 'member') && user.status === 'active'
    && typeof user.requiredPasswordChange === 'boolean'
    && typeof user.createdAt === 'string' && typeof user.updatedAt === 'string';
}
function parseSession(value: unknown): Session {
  if (!isSession(value)) throw new ApiError(0, 'Service returned an invalid response. Try again later.');
  return value;
}
function sameSession(previous: Session | null, next: Session) {
  return previous?.csrfToken === next.csrfToken && previous.user.id === next.user.id
    && previous.user.email === next.user.email && previous.user.role === next.user.role
    && previous.user.status === next.user.status
    && previous.user.requiredPasswordChange === next.user.requiredPasswordChange
    && previous.user.updatedAt === next.user.updatedAt;
}
const messages: Record<number, string> = {
  400: 'Check the supplied values. Passwords must contain 12–128 characters.',
  401: 'Your session has ended. Log in again.',
  403: 'Access was refused. Session state refreshed; review the page and submit again deliberately.',
  404: 'The requested item was not found.',
  409: 'This change conflicts with the current state. Refresh and try again.',
  429: 'Too many attempts. Try again later.',
};

// Credentials and CSRF stay in memory. All callers share the same session generation.
export class DashboardApi {
  private state: SessionState = { session: null, checking: true, generation: 0, notice: '' };
  private listeners = new Set<() => void>();
  private refreshRevision = 0;
  private authenticationPending = false;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: SessionState) {
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  private async json(path: string, method = 'GET', body?: unknown, csrfToken?: string): Promise<unknown> {
    if (!path.startsWith('/api/') || path.includes('..')) throw new Error('Expected a same-origin API path');
    let response: Response;
    try {
      response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ApiError(0, 'Unable to reach the service. Check your connection and try again.'); }
    if (!response.ok) throw new ApiError(response.status, messages[response.status] ?? 'Service unavailable. Try again later.');
    if (response.status === 204) return undefined;
    try { return await response.json(); }
    catch { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
  }
  async refresh(notice = '') {
    // Focus/timer checks must not race the cookie changes made by account actions.
    // A failed mutation's explicit Forbidden refresh is still permitted.
    if (this.authenticationPending && !notice) return;
    const revision = ++this.refreshRevision;
    const generation = this.state.generation + (notice ? 1 : 0);
    if (!this.state.session || notice) this.publish({ session: null, checking: true, generation, notice });
    try {
      const session = parseSession(await this.json('/api/auth/me'));
      if (revision !== this.refreshRevision || generation !== this.state.generation) return;
      const changed = !sameSession(this.state.session, session);
      this.publish({ session, checking: false, generation: generation + (changed ? 1 : 0), notice });
    } catch (error) {
      if (revision !== this.refreshRevision || generation !== this.state.generation) return;
      this.clear(error instanceof ApiError && error.status === 401 ? notice : 'Unable to verify your session. Retry to continue.');
    }
  }
  private beginAuthentication() {
    if (this.authenticationPending) throw new ApiError(0, 'Another account action is pending. Wait for it to finish.');
    this.authenticationPending = true;
    ++this.refreshRevision;
  }
  async login(email: string, password: string) {
    this.beginAuthentication();
    const generation = this.state.generation + 1;
    this.publish({ session: null, checking: false, generation, notice: '' });
    try {
      const session = parseSession(await this.json('/api/auth/login', 'POST', { email, password }));
      if (generation === this.state.generation) this.publish({ session, checking: false, generation, notice: '' });
    } catch (error) {
      if (generation !== this.state.generation) return;
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, 'Invalid email or password.');
      throw error;
    } finally { this.authenticationPending = false; }
  }
  // Typed readers supply a decoder so untrusted JSON never needs an unchecked assertion.
  async request<T>(path: string, method: string, body: unknown, decode: (value: unknown) => T): Promise<T>;
  async request(path: string, method?: string, body?: unknown): Promise<unknown>;
  async request(path: string, method = 'GET', body?: unknown, decode?: (value: unknown) => unknown): Promise<unknown> {
    const { session, generation } = this.state;
    if (!session) throw new ApiError(401, messages[401]);
    try {
      const result = await this.json(path, method, body, method === 'GET' ? undefined : session.csrfToken);
      if (generation !== this.state.generation) throw new ApiError(0, 'Session changed. Discarded the previous response.');
      return decode ? decode(result) : result;
    } catch (error) {
      if (generation !== this.state.generation) throw new ApiError(0, 'Session changed. Discarded the previous response.');
      if (error instanceof ApiError && error.status === 401) this.clear(messages[401]);
      else if (error instanceof ApiError && error.status === 403) await this.refresh(messages[403]);
      throw error;
    }
  }
  clear(notice: string) {
    ++this.refreshRevision;
    this.publish({ session: null, checking: false, generation: this.state.generation + 1, notice });
  }
  async logout() {
    this.beginAuthentication();
    try {
      await this.request('/api/auth/logout', 'POST');
      this.clear('Logged out.');
    } finally { this.authenticationPending = false; }
  }
  async changePassword(currentPassword: string, newPassword: string) {
    this.beginAuthentication();
    try {
      await this.request('/api/auth/change-password', 'POST', { currentPassword, newPassword });
      this.clear('Password replaced. Log in with your new password.');
    } finally { this.authenticationPending = false; }
  }
}
export const api = new DashboardApi();
