# DAY 4 — CODEX BRIEF 1/3
## Persistent Identity, Authentication, API Keys & Role-Based Authorization

### Design interview decisions

Read [the Day 4 identity decision log](docs/day4-identity-decisions.md), [the glossary](GLOSSARY.md), and the linked ADRs alongside this brief. Accepted interview decisions take precedence where this original brief differs. In particular, preserve the existing stateless/per-request MCP transport, require MongoDB transaction support, and perform fresh administrator setup rather than migrating the test bootstrap key. All 21 interview decisions are accepted and describe planned behavior, not implemented features. The user explicitly deferred implementation.

### Objective

Replace the temporary Day 3 bootstrap authentication with a persistent MongoDB-backed identity and API-key authentication system.

Implement users, roles, password-based login, API-key generation/revocation, and role-based authorization while **preserving the existing MCP gateway architecture and execution pipeline**.

This is **Phase 1 of 3** for Day 4.

**Scope boundaries:**
- **Brief 1:** MongoDB foundation, users, authentication, API keys, roles, authorization, and secure dashboard sessions.
- **Brief 2:** Persistent upstream MCP server registry, server CRUD, dynamic connections, discovery, lifecycle management, Kubernetes integration, and security.
- **Brief 3:** React dashboard, complete management UI, end-to-end integration, Helm deployment updates, and verification.

The assignment requires individual hashed and revocable API keys, admin/member roles, and a shared gateway endpoint. Revocation must reject the user's next call. Urumi AI Internship Round 1 MCP… Urumi AI Internship Round 1 MCP…

---

## 0. First inspect the existing repository

Before implementing anything, thoroughly inspect the existing codebase.

Locate and understand:

- Gateway entry point and Fastify/HTTP server setup.
- Existing MCP Streamable HTTP endpoint and session handling.
- Current `authenticateRequest()` implementation.
- Existing `authorizeTool()` implementation.
- Shared `executeTool()` execution boundary.
- `ToolAggregator`.
- `AggregatedToolResolver`.
- `McpUpstreamInvoker`.
- `UpstreamRegistry`.
- Current bootstrap authentication using `GATEWAY_BOOTSTRAP_KEY`.
- Existing request context and audit-related interfaces.
- Current error handling, logging, and middleware patterns.
- Existing TypeScript configuration and dependencies.
- Existing test infrastructure.
- Existing Helm and Docker configuration.

**Do not assume file paths or rewrite components unnecessarily. Adapt to the actual repository structure.**

Preserve the current gateway execution sequence:

```text
MCP Request
    |
    v
Authentication
    |
    v
Authorization
    |
    v
Tool Resolution
    |
    v
Upstream Invocation
    |
    v
Audit Hook
    |
    v
MCP Response
```

Do not replace or bypass the shared execution boundary.

Keep the existing gateway behavior working throughout the migration.

---

# 1. MongoDB Integration

Add MongoDB persistence to the gateway backend using Mongoose.

### Requirements

- Reuse an existing MongoDB connection if already implemented.
- Otherwise, introduce a centralized MongoDB connection module.
- Read the connection URI from environment configuration.
- Never hardcode credentials.
- Fail clearly when MongoDB is unavailable during startup.
- Implement appropriate connection timeouts.
- Handle database disconnections gracefully.
- Ensure the gateway does not silently fall back to insecure bootstrap authentication when MongoDB fails.
- Initialize required indexes.
- Implement clean connection shutdown.

Use an environment variable such as:

```env
MONGODB_URI=mongodb://...
```

Do not commit real credentials or connection strings.

### Important

This brief only introduces persistence for authentication and users.

Upstream server configuration persistence will be implemented in Brief 2.

Avoid creating an additional database abstraction that unnecessarily complicates the existing backend.

---

# 2. Persistent User Model

Create a Mongoose `User` model.

Suggested fields:

```typescript
interface User {
  _id: ObjectId;

  email: string;

  passwordHash: string;

  role: "admin" | "member";

  status: "active" | "disabled";

  createdAt: Date;

  updatedAt: Date;
}
```

### Requirements

- Email must be unique.
- Normalize email addresses.
- Never store plaintext passwords.
- Hash passwords using Argon2id or bcrypt with an appropriate work factor.
- Never return `passwordHash` in API responses.
- Use the database user ID as the canonical identity.
- Support active and disabled accounts.
- Disabled users must be rejected during authentication.
- Apply role changes and account disabling to subsequent authenticated requests without requiring a gateway restart.

Keep the model simple. Do not implement organizations, multiple teams, OAuth, or complex invitation workflows.

This assignment requires one team with two roles.

---

# 3. Persistent API Key Model

Implement a separate Mongoose `ApiKey` model.

Suggested structure:

```typescript
interface ApiKey {
  _id: ObjectId;

  ownerId: ObjectId;

  keyPrefix: string;

  keyHash: string;

  name?: string;

  createdAt: Date;

  lastUsedAt: Date | null;

  revokedAt: Date | null;
}
```

### Requirements

- Every API key belongs to a real database user.
- Users can have multiple API keys.
- Keys must be cryptographically secure.
- Generate keys using Node.js `crypto.randomBytes()`.
- Use an identifiable format, for example:

```text
ugw_<random-secret>
```

- Store only a cryptographic hash of the full API key.
- Never persist the raw API key.
- Never print the raw key in logs.
- Never return key hashes in API responses.
- Return the raw key only once, immediately after creation.
- Store a short, non-sensitive prefix for dashboard identification.
- Support optional key names.
- Track creation time, last-used time, and revocation time.
- Create appropriate indexes for owner lookup and key lookup.

Use a keyed HMAC-SHA256 digest or SHA-256 for uniformly random, high-entropy API keys. If using HMAC, load its secret from configuration.

Use constant-time comparison where applicable.

Do not use reversible encryption to store gateway API keys.

### Key creation behavior

A successful creation response should resemble:

```json
{
  "id": "api-key-id",
  "name": "My Claude Code Key",
  "key": "ugw_<random-secret>",
  "prefix": "ugw_abc123...",
  "createdAt": "2026-10-14T00:00:00.000Z"
}
```

The `key` field must appear **only in the creation response**.

All later key-list responses must exclude it.

---

# 4. Replace Bootstrap Gateway Authentication

This is one of the most important parts of Brief 1.

Find the existing:

```typescript
authenticateRequest()
```

Currently, Day 3 may authenticate requests using:

```env
GATEWAY_BOOTSTRAP_KEY
```

and assign a hardcoded identity such as:

```typescript
userId: "bootstrap-admin"
```

Replace this behavior with real database-backed authentication.

### Required MCP authentication flow

```text
Incoming MCP HTTP Request
          |
          v
Read Authorization header
          |
          v
Extract Bearer API key
          |
          v
Hash provided key
          |
          v
Find matching API key in MongoDB
          |
          v
Check whether key is revoked
          |
          v
Load key owner from Users collection
          |
          v
Check whether user is active
          |
          v
Resolve actual user role
          |
          v
Create authenticated request context
          |
          v
Continue existing gateway execution
```

### Authentication rules

- Missing API key → unauthorized.
- Invalid API key → unauthorized.
- Revoked API key → unauthorized.
- Key belonging to disabled user → unauthorized.
- Key belonging to deleted user → unauthorized.
- Database lookup failure → fail closed.
- Valid API key → use actual user identity and role.

Do not accept a role, user ID, or key ID supplied by the client.

All identity information must come from trusted database records.

### Critical MCP session requirement

**Every MCP HTTP request must independently pass authentication.**

This includes requests associated with an existing Streamable HTTP session.

Do not authenticate only during MCP initialization.

Do not treat an existing MCP session ID as proof of authentication.

For every request:

1. Read its bearer API key.
2. Validate the key against current database state.
3. Verify the key is active.
4. Verify the owning user is active.
5. Resolve the current user role.
6. Ensure the authenticated identity is consistent with the session owner.
7. Continue request processing.

Bind an MCP session to its authenticated user, and reject requests attempting to reuse that session under a different user identity.

Do not allow a session established with one key to silently continue under a revoked key.

**Revocation must take effect on the next authenticated request, even if the MCP transport/session already exists.**

For streaming transports, ensure each incoming HTTP request is authenticated before it reaches the transport handler. In-flight operations already executing are not required to be canceled, but revocation must prevent subsequent requests.

Keep compatibility with the MCP SDK and existing transport architecture.

---

# 5. Bootstrap Authentication Migration

The Day 3 bootstrap key must not remain a permanent alternative gateway authentication mechanism.

Implement a secure initial administrator setup process.

### Preferred behavior

If the database contains no administrator:

- Permit one-time administrator initialization through an explicit setup mechanism.
- Require a configured bootstrap secret.
- Create a real admin database account with a hashed password.
- Perform setup atomically to prevent concurrent initialization.
- Do not automatically create a default administrator using a hardcoded password.

After the first administrator exists:

- Disable bootstrap initialization.
- Reject subsequent bootstrap setup attempts.
- Do not accept `GATEWAY_BOOTSTRAP_KEY` as an ordinary MCP bearer API key.
- Require normal database-backed authentication for all MCP requests.

Prefer a CLI-based initialization command or a tightly restricted setup endpoint.

If implementing a setup endpoint, ensure it is disabled after initialization and cannot be accessed simply because a database query temporarily fails.

Ensure startup behavior is safe when MongoDB is unavailable.

### Fresh setup requirement

The existing bootstrap key was used only for testing; no existing user or client credentials need migration:

- Document how to create the first real administrator.
- Document how to issue the first database-backed API key.
- Document how to configure external MCP clients with that new key.
- Remove reliance on the old bootstrap key afterward.

Do not leave a hidden authentication bypass for backward compatibility.

---

# 6. Authentication Context

Introduce or update a shared authenticated identity type.

Example:

```typescript
interface AuthenticatedPrincipal {
  userId: string;

  email: string;

  role: "admin" | "member";

  apiKeyId: string | null;

  authMethod: "api_key" | "session";
}
```

Also define a request context compatible with the current gateway architecture.

Example:

```typescript
interface GatewayRequestContext {
  principal: AuthenticatedPrincipal;

  requestId: string;

  timestamp: Date;

  sessionId?: string;
}
```

Adapt these types to existing interfaces rather than duplicating them.

### Requirements

The context must provide:

- Real user ID.
- Current user role.
- API key ID when applicable.
- Authentication method.
- Request identifier.
- Request timestamp.
- MCP session identity when applicable.

For MCP bearer authentication:

```typescript
authMethod: "api_key"
```

For dashboard session authentication:

```typescript
authMethod: "session"
```

### Integration

Update the existing gateway request processing to propagate authenticated identity through the existing shared execution path.

The information must be available to:

```text
authenticateRequest()
       |
       v
authorizeTool()
       |
       v
executeTool()
       |
       v
Existing Resolver
       |
       v
Existing Invoker
       |
       v
Future Audit Logger
```

Prepare the audit-related context, but do not implement the complete audit logging system in this brief.

**Do not rewrite `executeTool()` or introduce a separate tool execution path.**

Only make minimal changes required to thread identity and request context through the existing implementation.

---

# 7. Role-Based Authorization

Preserve the existing:

```typescript
authorizeTool()
```

Connect it to real database-backed roles.

### Roles

#### Admin

Can:

- Use gateway MCP tools.
- Manage users.
- Create member accounts.
- Issue API keys for members.
- Revoke API keys belonging to members.
- Manage their own API keys.

Admin-only upstream management permissions will be enforced when those endpoints are implemented in Brief 2.

#### Member

Can:

- Log in.
- View their own account details.
- Generate their own API keys.
- View metadata for their own API keys.
- Revoke their own API keys.
- Connect external MCP clients using their keys.
- Invoke permitted MCP tools.

Cannot:

- Create or manage other users.
- View other users' API keys.
- Revoke other users' keys.
- Change roles.
- Access admin-only endpoints.
- Manage upstream server registrations.

### Tool authorization

Enforce permissions consistently during:

```text
tools/list
```

and:

```text
tools/call
```

For `tools/list`:

- Resolve the authenticated user role.
- Filter tools through the existing authorization logic.
- Return only tools accessible to that role.

For `tools/call`:

- Resolve the requested tool through the existing resolver.
- Apply `authorizeTool()` before invocation.
- Reject unauthorized calls.
- Never invoke an upstream tool before authorization succeeds.

Reuse existing Day 3 tool permission rules.

Do not replace existing permission logic with an unconditional rule allowing every authenticated user to call every tool.

Preserve existing admin/member restrictions, including any read/write tool distinctions already implemented.

An unauthorized tool must not become executable merely because a client already knows its name.

---

# 8. Dashboard Login and Sessions

Implement the backend authentication foundation for the React dashboard.

The complete React UI belongs to Brief 3.

### Login endpoint

Implement:

```http
POST /api/auth/login
```

Request:

```json
{
  "email": "admin@example.com",
  "password": "password"
}
```

Behavior:

1. Validate input.
2. Find user by normalized email.
3. Verify password hash.
4. Reject disabled users.
5. Create a secure server-side session.
6. Set an HTTP-only session cookie.
7. Return safe user information.

Use generic authentication error messages to avoid revealing whether an email exists.

Apply basic rate limiting to login attempts.

### Session architecture

Use an opaque, cryptographically random session ID.

Store sessions server-side in MongoDB, or use an existing compatible persistent session mechanism if available.

Do not store privileged identity information in an unsigned browser cookie.

Cookie requirements:

```text
HttpOnly
Secure in HTTPS environments
SameSite=Lax or Strict
Appropriate Path
Explicit expiration
```

Avoid enabling insecure production cookie settings merely to simplify local testing.

Sessions must:

- Survive page refreshes.
- Persist across backend restarts.
- Have a reasonable expiration.
- Be invalidatable on logout.
- Be invalidated when the associated user is disabled.
- Use the user's current database role rather than trusting a stale role embedded in the session.

### Current user endpoint

Implement:

```http
GET /api/auth/me
```

Authenticated response:

```json
{
  "user": {
    "id": "user-id",
    "email": "member@example.com",
    "role": "member",
    "status": "active"
  }
}
```

Return an appropriate unauthorized response when no valid session exists.

### Logout endpoint

Implement:

```http
POST /api/auth/logout
```

Requirements:

- Invalidate the server-side session.
- Clear the session cookie.
- Reject subsequent requests using that session.
- Do not revoke the user's MCP API keys during logout.

Dashboard sessions and MCP API keys are separate authentication mechanisms.

### CSRF protection

Implement CSRF protection for cookie-authenticated state-changing endpoints.

Use a session-bound CSRF token or an established compatible CSRF mechanism.

Require CSRF validation for:

```text
POST
PUT
PATCH
DELETE
```

where cookie-authenticated sessions are used.

Validate request origins where appropriate.

Do not rely solely on `SameSite` cookies for CSRF protection.

Do not require dashboard CSRF tokens for bearer-authenticated MCP requests.

---

# 9. API Key Management Endpoints

Implement the backend endpoints required by the future dashboard.

### Member self-service

```http
GET /api/keys
POST /api/keys
DELETE /api/keys/:keyId
```

All endpoints require a valid dashboard session.

`GET /api/keys`

Returns only keys owned by the currently authenticated user.

Example:

```json
[
  {
    "id": "key-id",
    "name": "Claude Code",
    "prefix": "ugw_abc123...",
    "createdAt": "2026-10-14T00:00:00.000Z",
    "lastUsedAt": null,
    "revokedAt": null,
    "status": "active"
  }
]
```

`POST /api/keys`

Generates a new API key for the current user.

Return the raw key only in this response.

`DELETE /api/keys/:keyId`

Soft-revokes the selected key.

Do not permanently delete the database record.

Preserve revocation metadata.

Members must not revoke keys they do not own.

### Admin key management

Implement:

```http
GET /api/admin/users/:userId/keys
POST /api/admin/users/:userId/keys
DELETE /api/admin/users/:userId/keys/:keyId
```

Requirements:

- Admin-only.
- Admin can list key metadata for a user.
- Admin can generate a new key for a user.
- Admin can revoke a user's key.
- Raw keys must never be returned when listing existing keys.
- Never expose key hashes.

Ensure the key being revoked belongs to the user specified in the route.

Return appropriate `401`, `403`, and `404` errors without leaking sensitive information.

### Immediate revocation

API-key validation must query current revocation state.

Do not use an indefinitely cached authentication result.

If caching is already present, modify it so revocation takes effect by the next request.

Revoked keys must fail even when the MCP client has an established session.

---

# 10. User Management Endpoints

Implement minimal admin-controlled member management.

```http
GET /api/admin/users

POST /api/admin/users

GET /api/admin/users/:userId

PATCH /api/admin/users/:userId
```

### User creation

Admin can create a member account using:

```json
{
  "email": "member@example.com",
  "password": "initial-password",
  "role": "member"
}
```

The backend must hash the password before saving it.

Do not implement email delivery or complex invitation token flows.

Simple admin-created accounts are acceptable for this assignment.

### User updates

Support:

- Updating account status.
- Changing roles where permitted.

Protect against:

- Unauthorized role escalation.
- Members modifying their own role.
- Members accessing admin endpoints.
- Accidentally disabling or demoting the last active administrator.

All role and status changes must be enforced during subsequent authentication and authorization.

---

# 11. Middleware Separation

Implement clear authentication and authorization middleware for dashboard API routes.

Suggested responsibilities:

```typescript
requireDashboardSession()
```

Validates dashboard session cookies.

```typescript
requireRole("admin")
```

Allows only administrators.

```typescript
requireCsrf()
```

Validates CSRF protection for state-changing dashboard routes.

```typescript
authenticateRequest()
```

Continues to authenticate MCP requests using bearer API keys.

### Important

Do not allow dashboard session cookies to authenticate the public MCP endpoint.

Do not allow MCP API keys to silently authenticate dashboard management endpoints.

The two mechanisms must remain separate.

Expected behavior:

```text
React Dashboard
      |
      v
HTTP-only Session Cookie
      |
      v
Dashboard API Authentication
      |
      v
Admin / Member Routes
```

```text
Claude Code / Cursor / MCP Inspector
      |
      v
Bearer API Key
      |
      v
Gateway authenticateRequest()
      |
      v
Existing MCP Execution Pipeline
```

Both resolve to the same persistent user identity model.

However, they must not share authentication credentials or accidentally bypass each other's security checks.

---

# 12. Security Requirements

Implement the following safeguards:

- Cryptographically secure API-key generation.
- API-key hashing.
- Password hashing.
- No hardcoded administrator credentials.
- No persistent bootstrap authentication bypass.
- No raw API-key storage.
- No password hashes or key hashes in API responses.
- No credentials in application logs.
- Rate limiting for login.
- Secure dashboard cookies.
- Server-side session invalidation.
- CSRF protection.
- Input validation.
- Database-backed authorization.
- Ownership enforcement for member key operations.
- Immediate API-key revocation.
- Reject disabled users.
- Safe handling of MongoDB failures.
- Consistent authentication errors.
- No client-controlled role or identity.
- No unauthorized user-management access.

Use existing project libraries when suitable instead of adding unnecessary dependencies.

---

# 13. Tests

Add automated tests using the repository's existing testing framework.

If none exists, introduce a minimal suitable TypeScript testing setup.

### User authentication tests

Verify:

1. Admin account can be initialized securely.
2. Bootstrap initialization cannot be repeated.
3. Bootstrap key cannot authenticate normal MCP requests after setup.
4. Passwords are hashed.
5. Valid credentials allow login.
6. Invalid credentials fail.
7. Disabled accounts cannot log in.
8. Session persists across requests.
9. Logout invalidates the session.
10. Role changes are reflected in subsequent requests.

### API-key tests

Verify:

1. API-key generation returns a raw key exactly once.
2. MongoDB stores only the hash.
3. Correct key authenticates successfully.
4. Invalid key fails.
5. Revoked key fails.
6. Revocation takes effect without restarting the gateway.
7. Disabled user's key fails.
8. Members can create their own keys.
9. Members can revoke their own keys.
10. Members cannot access another user's keys.
11. Admin can manage member keys.
12. Key-list responses never expose raw secrets.
13. Last-used metadata updates correctly.

### MCP integration tests

Verify:

1. MCP initialize requires valid bearer authentication.
2. `tools/list` requires valid authentication.
3. `tools/call` requires valid authentication.
4. Every request in an existing MCP session is independently authenticated.
5. Revoked keys fail on subsequent requests from established MCP sessions.
6. Sessions cannot be hijacked using another user's key.
7. Role-restricted tools are hidden from unauthorized users.
8. Direct calls to unauthorized tools are rejected.
9. Actual database user identity reaches the shared execution path.
10. Existing tool aggregation and invocation continue working.

### Dashboard security tests

Verify:

1. Dashboard endpoints require session authentication.
2. MCP bearer credentials do not bypass dashboard login.
3. Dashboard cookies do not bypass MCP bearer authentication.
4. Member requests to admin endpoints return `403`.
5. Missing CSRF tokens reject state-changing dashboard requests.
6. Valid CSRF tokens permit authorized state changes.
7. Session invalidation works after logout.
8. Disabling a user invalidates their access.

Mock external upstream MCP servers where needed, but test authentication against realistic database state.

---

# 14. Preserve Existing Gateway Functionality

Do not regress the Day 3 system.

Specifically preserve:

- Existing MCP Streamable HTTP implementation.
- Existing `ToolAggregator`.
- Existing `AggregatedToolResolver`.
- Existing `McpUpstreamInvoker`.
- Existing `UpstreamRegistry`.
- Existing tool namespace/collision handling.
- Existing `authorizeTool()` behavior.
- Existing shared `executeTool()` execution boundary.
- Existing upstream timeout behavior.
- Existing upstream failure isolation.
- Existing recovery/reconnection logic.
- Existing WooCommerce, Calculator, and Time integrations.

Do not implement server CRUD or dynamic registry persistence yet.

That belongs to Brief 2.

For this phase, the gateway may continue using its existing upstream configuration source.

The authentication migration must not break existing registered upstreams.

---

# 15. Configuration

Add required environment configuration.

Suggested variables:

```env
MONGODB_URI=

SESSION_SECRET=

API_KEY_HMAC_SECRET=

GATEWAY_BOOTSTRAP_KEY=

NODE_ENV=
```

Only introduce variables actually required by the chosen implementation.

Document:

- Which variables are required.
- Which secrets must be generated.
- How the administrator is initialized.
- How to create the first persistent API key.
- How to configure MCP clients with the new persistent API key; the old test bootstrap key is not accepted.
- How database connectivity affects gateway readiness.
- How local development differs from Kubernetes deployment.

Add safe example environment values where appropriate.

Never commit real credentials.

For Kubernetes deployments, sensitive configuration must come from Kubernetes Secrets.

Full Helm changes and MongoDB persistent deployment will be finalized in Brief 3.

---

# 16. Implementation Constraints

Follow these rules strictly:

1. **Inspect before modifying.** Understand the existing gateway architecture before writing code.

2. **Make incremental changes.** Avoid unnecessary refactoring of unrelated Day 1–3 components.

3. **Preserve the shared execution boundary.** Do not build a second path for MCP tool invocation.

4. **Reuse existing authorization.** Extend `authorizeTool()` instead of replacing it.

5. **Use persistent identity everywhere.** Remove hardcoded `bootstrap-admin` identity from normal execution.

6. **Authenticate every MCP request.** Existing Streamable HTTP sessions must not bypass API-key validation.

7. **Fail closed.** Database outages must not enable bootstrap fallback or unauthenticated execution.

8. **Keep session and API-key auth separate.** Dashboard sessions authenticate dashboard APIs; bearer keys authenticate MCP requests.

9. **Do not implement the React dashboard yet.** Implement backend endpoints that Brief 3 can consume.

10. **Do not implement dynamic server management yet.** That belongs to Brief 2.

11. **Preserve existing TypeScript conventions.** Use strict typing and avoid unnecessary `any`.

12. **Do not expose secrets.** Ensure sensitive values cannot leak through logs, errors, or serialization.

13. **Do not silently remove working features.** Existing upstream tool calls must continue functioning.

14. **Keep implementation understandable.** Favor straightforward, maintainable architecture suitable for a technical walkthrough.

---

# 17. Definition of Done

Brief 1 is complete only when all of the following are true:

- [ ] MongoDB connection works.
- [ ] Persistent `User` model exists.
- [ ] Persistent `ApiKey` model exists.
- [ ] Admin can be initialized securely.
- [ ] Bootstrap authentication is no longer accepted for normal MCP operation.
- [ ] Users can log in using email and password.
- [ ] Dashboard sessions are persistent and secure.
- [ ] Logout invalidates sessions.
- [ ] CSRF protection is enforced.
- [ ] Admin can create member accounts.
- [ ] Admin/member roles are enforced by the backend.
- [ ] Members can generate and revoke their own keys.
- [ ] Admin can issue and revoke member keys.
- [ ] Raw API keys are returned only once.
- [ ] API keys are stored hashed.
- [ ] API-key metadata is persisted.
- [ ] MCP clients authenticate using database-backed API keys.
- [ ] Every MCP request independently validates authentication.
- [ ] Revoked keys fail immediately on subsequent requests, including existing sessions.
- [ ] Hardcoded `bootstrap-admin` identity is removed from normal operation.
- [ ] Real identity and API-key IDs propagate through the shared execution path.
- [ ] Existing `authorizeTool()` enforces real roles.
- [ ] Permissions apply to both `tools/list` and `tools/call`.
- [ ] Dashboard session auth remains separate from MCP bearer auth.
- [ ] Existing gateway routing, aggregation, and invocation continue working.
- [ ] Existing WooCommerce, Calculator, and Time integrations are not broken.
- [ ] Relevant automated tests pass.

---

# 18. Expected Codex Output

Implement this phase directly in the existing repository.

After implementation, provide:

**A. Files changed**

List all created and modified files and briefly explain their purpose.

**B. Architecture summary**

Explain:

- MongoDB connection.
- User and API-key models.
- Password verification.
- Dashboard session authentication.
- MCP API-key authentication.
- Role authorization.
- Bootstrap migration.
- Identity propagation through the gateway.

**C. API documentation**

Document the new authentication, user, and API-key endpoints with sample requests and responses.

**D. Verification results**

Run the relevant tests, TypeScript checks, and builds.

Clearly distinguish successful checks from anything that could not be verified.

**E. Manual testing instructions**

Provide exact steps to:

1. Start the necessary services.
2. Initialize the first administrator.
3. Log in.
4. Create a member.
5. Generate an API key.
6. Connect an MCP client.
7. Call an existing tool.
8. Revoke the API key.
9. Verify the next MCP request is rejected.
10. Verify member/admin restrictions.

**F. Remaining work**

Clearly identify which parts remain for Brief 2 and Brief 3.

Do not implement those phases prematurely.

### Final instruction

**Prioritize a working, secure authentication migration over unnecessary architectural complexity. The gateway must finish this phase using real MongoDB-backed users and revocable API keys, without sacrificing any existing Day 3 MCP functionality.**
