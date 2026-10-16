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
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: SessionState) {
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  private async json<T>(path: string, method = 'GET', body?: unknown, csrfToken?: string): Promise<T> {
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
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; }
    catch { throw new ApiError(0, 'Service returned an invalid response. Try again later.'); }
  }
  async refresh(notice = '') {
    const generation = this.state.generation + 1;
    this.publish({ session: null, checking: true, generation, notice });
    try {
      const session = await this.json<Session>('/api/auth/me');
      if (generation === this.state.generation) this.publish({ session, checking: false, generation, notice });
    } catch (error) {
      if (generation !== this.state.generation) return;
      this.publish({ session: null, checking: false, generation,
        notice: error instanceof ApiError && error.status === 401 ? notice : 'Unable to verify your session. Retry to continue.' });
    }
  }
  async login(email: string, password: string) {
    const generation = this.state.generation + 1;
    this.publish({ session: null, checking: false, generation, notice: '' });
    try {
      const session = await this.json<Session>('/api/auth/login', 'POST', { email, password });
      if (generation === this.state.generation) this.publish({ session, checking: false, generation, notice: '' });
    } catch (error) {
      if (generation !== this.state.generation) return;
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, 'Invalid email or password.');
      throw error;
    }
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const { session, generation } = this.state;
    if (!session) throw new ApiError(401, messages[401]);
    try {
      const result = await this.json<T>(path, method, body, method === 'GET' ? undefined : session.csrfToken);
      if (generation !== this.state.generation) throw new ApiError(0, 'Session changed. Discarded the previous response.');
      return result;
    } catch (error) {
      if (generation !== this.state.generation) throw new ApiError(0, 'Session changed. Discarded the previous response.');
      if (error instanceof ApiError && error.status === 401) this.clear(messages[401]);
      else if (error instanceof ApiError && error.status === 403) await this.refresh(messages[403]);
      throw error;
    }
  }
  clear(notice: string) {
    this.publish({ session: null, checking: false, generation: this.state.generation + 1, notice });
  }
  async logout() {
    await this.request<void>('/api/auth/logout', 'POST');
    this.clear('Logged out.');
  }
  async changePassword(currentPassword: string, newPassword: string) {
    await this.request<void>('/api/auth/change-password', 'POST', { currentPassword, newPassword });
    this.clear('Password replaced. Log in with your new password.');
  }
}
export const api = new DashboardApi();
