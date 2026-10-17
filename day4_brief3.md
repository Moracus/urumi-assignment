# DAY 4 — CODEX BRIEF 3/3
## React Admin Dashboard, Team Management UI, Kubernetes Deployment & End-to-End Integration

### Objective

Complete **Day 4 of the Urumi AI MCP Gateway assignment** by building the React dashboard, connecting it to the backend capabilities implemented in Briefs 1 and 2, finalizing Kubernetes/Helm configuration, and verifying the complete system end to end.

This is **Phase 3 of 3**, the final Day 4 implementation phase.

By the end of this phase, the system must support:

- Admins logging in and managing registered upstream MCP servers.
- Admins creating and managing team members.
- Admins issuing and revoking API keys.
- Members logging in and managing their own API keys.
- Members connecting external MCP clients using their gateway URL and API key.
- Dynamic upstream additions, edits, disabling, removal, and reconnection through the dashboard.
- Live tool catalog updates without restarting the gateway.
- Persistent users, API keys, sessions, and upstream registrations across gateway restarts.
- Secure Kubernetes credential management and network isolation.
- Existing WooCommerce, Calculator, and Time MCP tools continuing to function.
- Backend-enforced role-based access control.

The original assignment specifically requires a React dashboard where admins can view server statuses and tools, manage servers and members, and where members can generate their own API keys without accessing upstream credentials. Urumi AI Internship Round 1 MCP…

**Important:** This phase is primarily frontend development, deployment integration, and system verification. Do not rewrite functionality already completed in Briefs 1 and 2.

---

# 0. Project Context and Implementation Boundaries

This project already contains a working Kubernetes-based MCP gateway developed across Days 1–3 and extended through Day 4 Briefs 1 and 2.

### Existing architecture

The project contains:

```text
WooCommerce Store
       |
       v
WooCommerce MCP Server
       |
       v
MCP Gateway
       |
       +---- Calculator MCP Server
       |
       +---- Time MCP Server
       |
       v
Aggregated MCP Endpoint
       |
       v
External MCP Clients
```

The gateway already includes:

- MCP Streamable HTTP transport.
- Tool aggregation.
- Tool resolution.
- Upstream invocation.
- Tool namespace/collision handling.
- Authentication and authorization.
- Failure isolation.
- Upstream recovery and reconnection.
- Shared execution boundary.
- Kubernetes deployment infrastructure.

### Brief 1 — Expected existing functionality

Brief 1 introduced:

- MongoDB connection.
- Persistent users.
- Admin/member roles.
- Password hashing.
- Login verification.
- Secure dashboard sessions.
- Logout/session invalidation.
- CSRF protection.
- API-key generation and hashing.
- API-key revocation.
- Database-backed MCP authentication.
- Bootstrap authentication migration.
- Persistent request identity.
- Role-based authorization.
- User management APIs.
- API-key management APIs.

### Brief 2 — Expected existing functionality

Brief 2 introduced:

- Persistent upstream server registrations.
- `UpstreamServer` Mongoose model.
- MongoDB-backed upstream configuration.
- Migration of WooCommerce, Calculator, and Time.
- Dynamic `UpstreamRegistry` operations.
- Server registration and editing.
- Server enable/disable/remove.
- Manual refresh/reconnection.
- Dynamic tool discovery.
- Aggregated tool catalog synchronization.
- Connection status tracking.
- Sanitized error reporting.
- Admin server management APIs.
- Kubernetes Secret references.
- URL validation and SSRF protection.
- Kubernetes RBAC and NetworkPolicy security.

### Your responsibility

**Inspect the actual repository and determine which capabilities are genuinely implemented.**

Do not assume everything listed above works simply because it appeared in previous briefs.

Your job is to:

1. Build the React dashboard.
2. Integrate existing backend APIs.
3. Fix necessary integration gaps.
4. Finalize Kubernetes and Helm configuration.
5. Run end-to-end verification.
6. Preserve existing functionality.
7. Document the completed system.

Avoid unrelated refactoring.

---

# 1. Inspect the Repository Before Implementation

Before writing code, inspect:

### Frontend

- Existing React application, if present.
- Frontend framework and build tool.
- Existing routes.
- Existing styling and component conventions.
- Existing API client utilities.
- Existing environment variables.
- Existing frontend Dockerfile.
- Existing dashboard Helm templates.
- Existing ingress configuration.

If a React application already exists, extend it.

If no suitable frontend exists, create a minimal React + TypeScript application using Vite.

Prefer the project's existing styling approach.

Do not introduce a large UI framework unless justified by the current codebase.

### Backend

Inspect the routes implemented in Briefs 1 and 2.

Identify the actual endpoints for:

```text
Authentication
Current user
Logout
CSRF token
Users
API keys
Upstream servers
Server status
Server tools
Enable / disable
Refresh / reconnect
```

Do not blindly assume the endpoint paths from the briefs match the implementation.

Adapt the frontend to the actual API contracts.

If essential backend functionality is missing, implement the smallest compatible correction.

### Gateway

Inspect:

```typescript
authenticateRequest()

authorizeTool()

executeTool()

ToolAggregator

AggregatedToolResolver

McpUpstreamInvoker

UpstreamRegistry
```

Do not rewrite them.

### Infrastructure

Inspect:

- Gateway Dockerfile.
- Dashboard Dockerfile.
- Helm charts.
- Local values.
- Production values.
- MongoDB configuration.
- Kubernetes Secrets.
- ServiceAccounts.
- RBAC.
- NetworkPolicies.
- Services.
- Ingress.
- PersistentVolumeClaims.
- Readiness and liveness probes.

Use the repository's actual paths and conventions.

---

# 2. React Dashboard Architecture

Build a minimal, functional, maintainable React dashboard.

### Recommended stack

Use the existing frontend dependencies wherever possible.

If starting from scratch:

```text
React
TypeScript
Vite
React Router
Fetch API or existing HTTP client
Existing CSS solution
```

Optional:

```text
TanStack Query
```

Use it only if it meaningfully simplifies API state management.

Avoid unnecessary dependencies.

### Suggested component architecture

Adapt to existing project conventions:

```text
Dashboard Application
│
├── Authentication
│   ├── Login
│   ├── Session Provider
│   ├── Protected Routes
│   └── Logout
│
├── Dashboard Layout
│   ├── Sidebar
│   ├── Header
│   └── Role-Based Navigation
│
├── Servers
│   ├── Server List
│   ├── Server Details
│   ├── Add Server
│   ├── Edit Server
│   ├── Enable / Disable
│   ├── Remove Server
│   ├── Refresh Server
│   └── Discovered Tools
│
├── Team
│   ├── Member List
│   ├── Create Member
│   ├── Member Details
│   └── Member API Keys
│
├── API Keys
│   ├── My API Keys
│   ├── Generate Key
│   ├── One-Time Key Display
│   └── Revoke Key
│
└── Shared Components
    ├── Status Indicator
    ├── Confirmation Dialog
    ├── Loading State
    ├── Empty State
    ├── Error Message
    └── Success Notification
```

Keep components reasonably modular.

Avoid putting the entire application into one large React file.

---

# 3. Dashboard Routing

Implement protected dashboard routes.

Suggested routes:

| Route | Access | Purpose |
|---|---|---|
| `/login` | Public | Login |
| `/dashboard` | Admin/Member | Dashboard home |
| `/dashboard/keys` | Admin/Member | Own API keys |
| `/dashboard/servers` | Admin | Registered MCP servers |
| `/dashboard/servers/new` | Admin | Add upstream |
| `/dashboard/servers/:id` | Admin | Server details |
| `/dashboard/servers/:id/edit` | Admin | Edit upstream |
| `/dashboard/members` | Admin | Team management |
| `/dashboard/members/new` | Admin | Create member |
| `/dashboard/members/:id` | Admin | Member details |

Adjust routes to existing project conventions.

### Route protection

Implement:

```typescript
ProtectedRoute
```

and:

```typescript
AdminRoute
```

or equivalent abstractions.

### Requirements

- Unauthenticated users are redirected to login.
- Authenticated members can access their own dashboard.
- Admins can access admin routes.
- Members cannot access admin-only routes.
- Unauthorized navigation displays an appropriate error or redirects safely.
- Reloading a protected route preserves the session.
- Refreshing the page does not unnecessarily log out the user.

### Critical security rule

Frontend route protection improves user experience.

**Actual authorization must remain enforced by the backend.**

Do not rely on hiding buttons or routes to protect server management operations.

---

# 4. Login and Session Integration

Connect the React application to the Brief 1 authentication system.

### Login page

Create a simple login form containing:

```text
Email

Password

Login Button
```

### Behavior

On submission:

1. Validate required fields.
2. Send credentials to the existing backend login endpoint.
3. Allow the browser to receive the HTTP-only session cookie.
4. Fetch the authenticated user.
5. Determine the user's role from the backend.
6. Redirect to the appropriate dashboard.
7. Display safe errors when authentication fails.

### Session handling

Use the existing:

```http
GET /api/auth/me
```

or the actual equivalent.

On application initialization:

```text
React Application Loads
          |
          v
Request Current User
          |
          v
Backend Validates Session
          |
          +---- Valid
          |       |
          |       v
          |   Restore User State
          |       |
          |       v
          |   Render Dashboard
          |
          +---- Invalid
                  |
                  v
              Login Page
```

### Important

Do not store:

- Passwords.
- Session IDs.
- Raw API keys.
- Authentication secrets.

in:

```text
localStorage
sessionStorage
```

Dashboard authentication must use the existing secure server-side session cookie.

### Cookie handling

Ensure frontend requests correctly send session cookies.

Prefer same-origin dashboard/API deployment through Ingress.

If cross-origin requests are unavoidable, configure CORS and credentials narrowly.

Do not enable wildcard credentialed CORS.

---

# 5. CSRF Integration

Brief 1 introduced CSRF protection for cookie-authenticated state-changing requests.

Integrate it into the React API client.

### Requirements

- Obtain the CSRF token through the existing backend mechanism.
- Include the token in appropriate state-changing requests.
- Handle expired or invalid tokens.
- Reinitialize CSRF state after login when necessary.
- Clear authentication-related client state on logout.
- Do not disable CSRF validation to make frontend requests work.

Expected flow:

```text
Authenticated Dashboard
          |
          v
Obtain CSRF Token
          |
          v
POST / PATCH / DELETE
          |
          v
Attach CSRF Token
          |
          v
Backend Validates Session + CSRF
          |
          v
Execute Authorized Operation
```

Do not require dashboard CSRF tokens when authenticating external MCP clients using bearer API keys.

---

# 6. Logout and Session Invalidation

Implement a visible logout control.

### Required behavior

When the user logs out:

1. Call the existing logout endpoint.
2. Invalidate the server-side session.
3. Clear React authentication state.
4. Clear cached sensitive API responses.
5. Redirect to login.

After logout:

- Protected routes must not remain accessible.
- Reloading the dashboard must not restore the invalidated session.
- The previous session cookie must not authorize further requests.

### Important

Logging out of the dashboard must not automatically revoke the user's MCP API keys.

These are separate authentication mechanisms.

---

# 7. Dashboard Layout and Navigation

Implement a clean, functional application layout.

### Admin navigation

Suggested:

```text
Dashboard

MCP Servers

Team Members

My API Keys

Logout
```

### Member navigation

Suggested:

```text
Dashboard

My API Keys

Logout
```

### Requirements

- Navigation reflects the authenticated user's role.
- Current page is identifiable.
- User email and role are displayed.
- Layout works on desktop.
- Basic responsiveness is sufficient.
- No unnecessary visual complexity.

Prefer a practical admin interface over decorative UI.

The purpose is to demonstrate the functionality clearly during the technical walkthrough.

---

# 8. Dashboard Home

Implement a minimal landing page.

### Admin home

Show a summary of:

- Total registered upstream servers.
- Connected servers.
- Unreachable servers.
- Disabled servers.
- Total discovered tools.
- Total team members.

Use existing API data.

Do not hardcode counts.

### Member home

Show:

- Logged-in user email.
- User role.
- Number of active API keys.
- Gateway MCP endpoint information.
- A short explanation of connecting an MCP client.

### Important

Do not expose upstream server credentials or internal credential details to members.

Members interact with the gateway, not individual upstream credentials.

---

# 9. Member Self-Service API-Key Management

Implement the complete API-key interface.

This is a mandatory Day 4 capability.

### API-key list

Build:

```text
My API Keys
```

Display:

| Field | Description |
|---|---|
| Name | Optional key label |
| Prefix | Non-sensitive key identifier |
| Created | Creation timestamp |
| Last Used | Most recent usage |
| Status | Active or Revoked |
| Actions | Revoke |

### Requirements

- Fetch keys belonging to the logged-in user.
- Display only the safe metadata returned by the backend.
- Never request or display stored key hashes.
- Never attempt to retrieve old raw API keys.
- Show empty state when no keys exist.
- Show loading and error states.

### Generate key

Add:

```text
Generate API Key
```

Allow an optional label such as:

```text
Claude Code

Cursor

MCP Inspector

Development Key
```

On creation:

1. Call the backend key-generation endpoint.
2. Receive the newly generated raw API key.
3. Display it in a one-time creation screen.
4. Provide a Copy button.
5. Warn that the key cannot be retrieved again.
6. Return to the key list after the user dismisses the screen.

### One-time display

Example:

```text
API Key Created Successfully

Your key:

ugw_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

[Copy API Key]

Save this key now.
It will not be shown again.
```

### Security requirements

- Keep the raw key only in temporary component memory.
- Do not persist it in browser storage.
- Do not include it in URLs.
- Do not print it in console logs.
- Do not expose it through analytics or error reporting.
- Clear the value when the creation screen closes or unmounts.
- Do not display the raw key again after page refresh.

### Revoke key

Implement a confirmation dialog.

Example:

```text
Revoke API Key?

This key will immediately stop working.

[Cancel] [Revoke]
```

On confirmation:

1. Call the backend revocation endpoint.
2. Update the list.
3. Display revoked status.
4. Show success or error feedback.

Do not silently delete the key from the UI if the backend preserves revoked records.

---

# 10. Admin API-Key Management

Admins must be able to manage keys belonging to team members.

Integrate the Brief 1 admin key-management APIs.

### Member details

Display:

- Email.
- Role.
- Account status.
- Creation date.
- Associated API-key metadata.

### Admin actions

Support:

```text
Issue API Key

Revoke API Key
```

### Important

When an administrator generates a key for another user:

- Display the raw key only once.
- Clearly indicate which user owns it.
- Never store it in frontend persistent storage.
- Never expose other existing raw keys.

If the administrator dismisses the creation response, that raw key cannot be retrieved again.

### Ownership

All API-key ownership rules must be enforced by the backend.

The frontend must not construct arbitrary user ownership based on untrusted client input.

---

# 11. Team Member Management

Build the admin member-management interface.

### Member list

Display:

```text
Email

Role

Status

Created At

Actions
```

### Create member

Implement a simple form:

```text
Email

Initial Password

Role
```

Use the existing admin user-creation endpoint.

### Requirements

- Only admins can access member management.
- Validate required fields.
- Display duplicate-email errors.
- Display password validation errors.
- Show success feedback.
- Refresh the member list after creation.
- Never display stored password hashes.

### Edit member

Where supported by the backend, allow:

- Change role.
- Enable/disable account.

### Security

Preserve the backend protection against:

- Members promoting themselves.
- Members managing other users.
- Disabling the last active administrator.
- Removing all administrative access.

### Scope limitation

Do not implement email invitations, password reset emails, or complex identity-provider integration unless already present.

Simple admin-created accounts are sufficient for Day 4.

---

# 12. Admin MCP Server List

Implement the main MCP server management page.

Suggested route:

```text
/dashboard/servers
```

### Required information

Display:

| Field | Description |
|---|---|
| Name | Server display name |
| Status | Connected, Unreachable, Disabled |
| Enabled | Current configured state |
| Tool Count | Number of discovered tools |
| Last Connected | Last successful connection |
| Last Discovery | Last successful tool discovery |
| Actions | View, Edit, Enable/Disable, Refresh, Remove |

### Requirements

- Fetch registrations from the backend.
- Display the actual connection status.
- Do not infer `connected` merely from `enabled = true`.
- Support loading, empty, and error states.
- Refresh the list after mutations.
- Ensure a disabled server is visually distinguishable from an unreachable server.

### Status handling

Use the existing statuses:

```typescript
type UpstreamStatus =
  | "connected"
  | "unreachable"
  | "disabled";
```

If Brief 2 introduced additional transitional statuses, support them appropriately.

### Important

The frontend must display backend-reported state rather than maintaining a competing local source of truth.

---

# 13. Add MCP Server

Implement:

```text
Add MCP Server
```

### Form fields

Support:

```text
Server Name

MCP Endpoint URL

Transport

Authentication Type

Credential Reference / Credential Input

Enabled
```

Transport should follow the backend's supported transport types.

For Day 4, Streamable HTTP is mandatory.

Do not invent support for transports that the backend cannot actually connect to.

### Authentication types

Support the modes implemented in Brief 2:

```text
None

Bearer Token

Custom Header
```

### Credential handling

Prefer Kubernetes Secret references.

If Brief 2 supports administrator-supplied credentials through a secure Secret-creation endpoint, integrate that flow.

If the backend only supports existing Secret references, expose an appropriate reference selector/input and explain the requirement in the UI.

Do not create a frontend-only credential workflow that is unsupported by the backend.

### Submission behavior

On submission:

1. Validate fields.
2. Call the backend registration endpoint.
3. Display the registration result.
4. Show the connection/discovery status.
5. Navigate to server details or refresh the list.

### Connection failures

A failed connection must not appear as a successful connection.

If registration succeeds but discovery fails, display:

```text
Server registered, but connection failed.
```

Show the sanitized error provided by the backend.

Allow manual refresh/reconnection.

Do not expose raw internal stack traces.

---

# 14. Edit MCP Server

Implement:

```text
Edit Server
```

Support the editable fields provided by Brief 2.

Typical fields:

- Name.
- URL.
- Authentication type.
- Credential reference.
- Custom header configuration.

### Requirements

- Load existing safe configuration.
- Prepopulate non-sensitive values.
- Do not expose existing credential values.
- Allow replacement of credential references where supported.
- Submit changes to the backend.
- Display updated status.
- Handle reconnection failures.

### Important

A URL or credential change may trigger:

```text
Old Connection Closed
        |
        v
New Configuration Applied
        |
        v
Reconnect
        |
        v
Fresh Tool Discovery
        |
        v
Catalog Updated
```

The frontend must accurately reflect the backend's result.

Do not assume the new connection is healthy simply because the update request succeeded.

---

# 15. Enable and Disable MCP Servers

Implement enable/disable controls.

### Disable

When the administrator disables a server:

1. Display a confirmation.
2. Explain that its tools will become unavailable.
3. Call the backend disable endpoint.
4. Refresh the server status.
5. Refresh displayed tool information.

### Enable

When enabling:

1. Call the backend enable endpoint.
2. Display connecting state if available.
3. Fetch the updated status.
4. Display successful connection or sanitized failure.

### Critical behavior

Disabling a server must result in:

- Its tools disappearing from new aggregated `tools/list` responses.
- Its tools becoming unavailable to already-connected MCP clients.
- Its runtime connection being closed.
- Other upstreams remaining functional.

The frontend must not merely hide tools locally.

**Verify that the backend and live registry actually enforce the change.**

---

# 16. Remove MCP Server

Implement server removal with an explicit confirmation dialog.

Example:

```text
Remove MCP Server?

Server: Calculator

Removing this server will unregister it from
the gateway and make its tools unavailable.

[Cancel] [Remove Server]
```

### Requirements

- Admin-only action.
- Require confirmation.
- Call the backend removal endpoint.
- Update the server list.
- Ensure removed tools disappear from the aggregated catalog.
- Display success or error feedback.

### Important

Removing a server must not automatically delete unrelated Kubernetes Secrets.

Do not implement frontend-side Kubernetes resource deletion.

Credential lifecycle is controlled by the backend and infrastructure configuration.

---

# 17. Server Details and Tool Discovery UI

Build a server details page.

### Server information

Display:

```text
Name

Server ID

Endpoint URL

Transport

Authentication Type

Enabled State

Connection Status

Last Successful Connection

Last Tool Discovery

Last Error
```

Only show values returned by the authorized backend response.

Never reveal Secret values or resolved credentials.

### Discovered tools

Display the actual tools discovered by the gateway.

Example:

```text
WooCommerce

Tools:

1. list_products
2. create_product
3. list_orders
4. get_order
5. update_order_status
```

Use the real tool definitions rather than hardcoded examples.

### Input schema display

For each tool, display:

- Tool name.
- Description.
- Input schema.

A collapsible JSON viewer is sufficient.

Example:

```json
{
  "type": "object",
  "properties": {
    "product_id": {
      "type": "integer"
    }
  },
  "required": ["product_id"]
}
```

The schema above is illustrative.

### Requirements

- Display valid JSON formatting.
- Support empty schemas.
- Handle large schemas without breaking layout.
- Safely render untrusted tool descriptions as text.
- Do not inject upstream-provided HTML.
- Do not expose upstream credentials.

### Refresh button

Add:

```text
Refresh / Reconnect
```

On click:

1. Call the backend refresh endpoint.
2. Display progress.
3. Fetch updated server status.
4. Fetch discovered tools again.
5. Display success or failure.

---

# 18. Shared UI States and Error Handling

Every major screen must support:

### Loading

Examples:

```text
Loading servers...

Loading API keys...

Connecting to MCP server...
```

### Empty

Examples:

```text
No API keys found.

No MCP servers registered.

No tools discovered.
```

### Success

Examples:

```text
API key created.

Server disabled.

Member created.

Server reconnected successfully.
```

### Error

Examples:

```text
Unable to load servers.

Permission denied.

Connection timed out.

API key could not be revoked.
```

### Requirements

- Do not display raw backend stack traces.
- Do not swallow API errors silently.
- Distinguish `401` from `403`.
- Redirect to login on invalid dashboard sessions.
- Show access-denied feedback for authorization failures.
- Prevent accidental duplicate submissions.
- Disable action buttons while operations are in progress.
- Avoid optimistic UI updates that incorrectly claim a backend operation succeeded.

Build a reusable API error-handling pattern.

---

# 19. API Client Integration

Create or reuse a centralized frontend API client.

Its responsibilities should include:

- Consistent backend base URL.
- Session cookie handling.
- CSRF token handling.
- JSON serialization.
- Typed responses.
- Authentication failure handling.
- Standardized errors.

### Important

Do not introduce multiple competing API clients for different dashboard features.

Use a consistent abstraction.

### Suggested API groups

```typescript
authApi

usersApi

apiKeysApi

serversApi
```

Adapt naming to the project structure.

### Security

Never attach a user's MCP API key to dashboard requests.

Dashboard APIs must use session authentication.

The gateway MCP endpoint must continue using bearer API keys for external clients.

---

# 20. Gateway Connection Instructions for Members

Add a small informational section to the member dashboard.

Display the externally accessible gateway MCP URL.

For example:

```text
Gateway MCP Endpoint

https://gateway.example.com/mcp
```

Use the actual configured public URL.

Do not hardcode a development URL into production builds.

Provide basic instructions:

```text
1. Generate an API key.

2. Copy the key.

3. Configure your MCP client with the gateway URL.

4. Use the API key as a Bearer token.

5. Connect and list available tools.
```

### Example configuration

Where compatible with the existing gateway transport and a supported MCP client, show an illustrative configuration:

```json
{
  "mcpServers": {
    "urumi-gateway": {
      "type": "http",
      "url": "https://gateway.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Adapt the example to the actual MCP client being demonstrated.

Do not claim every MCP client supports identical configuration syntax.

### Important

Members should need only:

- Gateway URL.
- Their own API key.

They must not need:

- WooCommerce credentials.
- Calculator server credentials.
- Time server credentials.
- Kubernetes Secret references.
- Individual upstream URLs.

---

# 21. Docker Integration

Finalize the dashboard Docker build.

### Requirements

- Use a production-appropriate multi-stage build.
- Build the React application.
- Serve static assets using the project's existing web server approach.
- Avoid shipping unnecessary development dependencies.
- Do not bake secrets into the frontend image.
- Support SPA route fallback.
- Keep the container compatible with Kubernetes security settings.

### Configuration

Public frontend configuration may include:

```text
Public Dashboard URL

Public Gateway URL

API Base Path
```

Do not expose:

```text
MongoDB URI

Session Secret

API Key HMAC Secret

Kubernetes Credentials

Upstream Bearer Tokens
```

### Gateway Dockerfile

Review and update only where required for:

- MongoDB dependencies.
- Kubernetes Secret resolution.
- Production build changes.
- Startup scripts.
- Database migrations.
- Health checks.

Do not unnecessarily rebuild the gateway's architecture.

---

# 22. MongoDB Kubernetes Deployment

Finalize MongoDB deployment with persistent storage.

If MongoDB already exists in the cluster, inspect and reuse the existing deployment where appropriate.

Otherwise, add an appropriate Helm-managed MongoDB deployment.

### Requirements

- PersistentVolumeClaim.
- Internal Kubernetes Service.
- Secure credentials.
- Kubernetes Secret for database authentication.
- Resource requests and limits.
- Readiness and liveness probes.
- Persistent data across pod recreation.
- No public ingress.
- Restricted network access.

### Persistence verification

Create representative data:

```text
Admin User

Member User

API Keys

Registered MCP Servers
```

Restart the gateway.

Verify the records still exist.

Also verify MongoDB persistence independently by restarting or recreating the MongoDB pod without deleting its PVC.

### Important

Gateway restarts must not:

- Lose users.
- Lose API keys.
- Re-enable disabled servers.
- Recreate deleted servers.
- Duplicate default upstreams.
- Lose persistent server configuration.

---

# 23. Final Helm Configuration

The assignment requires a local Kubernetes deployment and a production-like VPS deployment using the same Helm charts, with environment differences expressed through values files. Urumi AI Internship Round 1 MCP…

Review and finalize the existing Helm charts.

### Required components

Ensure the Helm-managed deployment includes the relevant components:

```text
WooCommerce Store

WooCommerce Database

WooCommerce MCP Server

Calculator MCP Server

Time MCP Server

MongoDB

MCP Gateway Backend

React Dashboard
```

Reuse existing Helm resources.

Do not create duplicate workloads.

### Required configuration

Review:

- Deployments.
- StatefulSets where appropriate.
- Services.
- Ingress.
- ConfigMaps.
- Secrets.
- PVCs.
- ServiceAccounts.
- RBAC.
- NetworkPolicies.
- Health probes.
- Resource requests and limits.

### Values files

Maintain the repository's equivalent of:

```text
values-local.yaml

values-prod.yaml
```

### Local configuration

Support the existing local Kubernetes environment.

For example:

```text
Kind / k3d / Minikube
```

Use the project's existing local domain and ingress strategy.

### Production-like configuration

Support deployment to k3s or an equivalent VPS Kubernetes cluster.

Differences should be configurable through Helm values:

```text
Domains

Ingress Hosts

TLS

Storage Classes

Image Tags

Resource Limits

Secret References

MongoDB Persistence
```

Do not create a separate, incompatible production deployment system.

### Secret handling

Use Kubernetes Secrets for sensitive configuration.

Do not commit real credentials.

Ensure Helm templates do not expose secret values through ConfigMaps or frontend environment variables.

---

# 24. Kubernetes RBAC Verification

Brief 2 should have implemented narrowly scoped Kubernetes Secret access.

Verify it now against the actual cluster configuration.

### Requirements

- Gateway uses a dedicated ServiceAccount.
- Secret access is restricted to authorized resources.
- Gateway cannot read unrelated application Secrets.
- Gateway does not have cluster-admin permissions.
- Secret access is limited to necessary operations.
- Members cannot trigger arbitrary Kubernetes Secret reads through dashboard APIs.

### Important RBAC detail

If the implementation supports dynamic Secret creation, verify what permission is actually granted.

Do not assume Kubernetes RBAC can restrict Secret creation by resource name.

Where broad creation permission would be required, either:

- Use pre-provisioned Secret references, or
- Use an appropriately isolated credential-management design.

Choose the least-privileged implementation compatible with the actual Day 4 functionality.

### Verification

Where a live cluster is available, use Kubernetes authorization checks to confirm both allowed and denied operations.

Document the actual ServiceAccount, namespace, and relevant permissions.

---

# 25. Kubernetes NetworkPolicy Verification

Review the existing NetworkPolicies.

Verify:

### Gateway access

The gateway can reach:

```text
MongoDB

WooCommerce MCP Server

Calculator MCP Server

Time MCP Server

Kubernetes API, only if required
```

### Isolation

Verify:

- MongoDB is not publicly accessible.
- WooCommerce MCP server remains internal-only.
- Upstream MCP servers are not exposed through public ingress.
- Unrelated application databases remain inaccessible from the gateway.
- Unauthorized cross-namespace traffic remains restricted.
- Dynamic server registration cannot automatically bypass network restrictions.

### Dynamic server testing

Attempt to register:

1. A valid approved MCP endpoint.
2. An unauthorized internal endpoint.
3. A cloud metadata endpoint.
4. An invalid URL.

Confirm the backend rejects disallowed destinations.

Where an endpoint passes application validation but is denied by a NetworkPolicy, ensure the resulting connection failure is handled safely.

Do not weaken existing NetworkPolicies merely to make dynamic registration work.

---

# 26. Readiness, Liveness, and Startup Behavior

Finalize workload probes.

### Gateway readiness

The gateway should become ready only when essential dependencies required for safe operation are available.

At minimum:

- Application initialization completed.
- MongoDB connection is usable.
- Authentication configuration is valid.
- Required startup migrations or initialization completed.

### Important

Do not make gateway readiness depend on every upstream being connected.

An unreachable Time server must not make the entire gateway unavailable if WooCommerce and Calculator remain healthy.

### Liveness

Liveness should indicate whether the gateway process is healthy.

Do not use temporary upstream connection failures as a reason to repeatedly restart the gateway.

### Dashboard

Ensure the dashboard has an appropriate health check.

### MongoDB

Ensure database readiness reflects database availability.

### Resource configuration

All relevant workloads should have reasonable requests and limits.

Do not introduce unnecessarily high resource requirements for local Kubernetes.

---

# 27. End-to-End Authentication Verification

Verify the complete Brief 1 functionality through both UI and direct API calls.

### Scenario A — Administrator login

1. Open the dashboard.
2. Log in as an administrator.
3. Confirm the session is created.
4. Refresh the page.
5. Confirm the session persists.
6. Confirm admin navigation appears.
7. Confirm admin endpoints work.

### Scenario B — Member creation

1. Log in as admin.
2. Open Team Members.
3. Create a member.
4. Verify the member appears in the list.
5. Log out.
6. Log in as the member.
7. Confirm member navigation appears.

### Scenario C — Member restrictions

As the member:

- Attempt to access server management routes.
- Attempt to call admin server APIs directly.
- Attempt to manage another user's keys.
- Attempt to modify roles.

Verify backend authorization rejects these actions.

### Scenario D — Member API key

1. Open My API Keys.
2. Generate a key.
3. Copy it.
4. Confirm it appears only once.
5. Refresh the page.
6. Confirm only the prefix/metadata remains visible.
7. Verify the database stores only its hash.

### Scenario E — MCP authentication

1. Connect an MCP client using the member's key.
2. Call `tools/list`.
3. Invoke an authorized tool.
4. Confirm the call succeeds.
5. Revoke the key from the dashboard.
6. Attempt another MCP request.
7. Confirm authentication fails.

### Important

Revocation must fail on the next request even when the external MCP client has an existing Streamable HTTP session.

Do not rely on restarting the client or gateway.

---

# 28. End-to-End Dynamic Upstream Verification

Verify the complete Brief 2 functionality through the dashboard.

### Scenario A — Existing upstreams

After startup, verify:

```text
WooCommerce

Calculator

Time
```

are registered in MongoDB.

Verify the dashboard displays their actual statuses.

Confirm their discovered tools appear.

### Scenario B — Add upstream

1. Log in as admin.
2. Open MCP Servers.
3. Add a valid test upstream.
4. Save the configuration.
5. Confirm runtime connection.
6. Confirm tool discovery.
7. Query gateway `tools/list`.
8. Verify the new tools appear.

No gateway restart should be required.

### Scenario C — Disable upstream

1. Connect an external MCP client.
2. Confirm the target upstream's tools are visible.
3. Disable the upstream through the dashboard.
4. Request `tools/list` again.
5. Confirm the tools disappear.
6. Attempt to invoke an old cached tool.
7. Confirm invocation is rejected.

### Scenario D — Re-enable upstream

1. Enable the server.
2. Confirm reconnection.
3. Confirm fresh discovery.
4. Confirm tools return.

### Scenario E — Update URL

1. Edit an upstream URL.
2. Save.
3. Confirm the previous connection is retired.
4. Confirm the new destination is used.
5. Confirm status and tools update.

### Scenario F — Remove upstream

1. Remove the test upstream.
2. Confirm removal.
3. Verify tools disappear.
4. Restart the gateway.
5. Verify the removed server does not reappear.

### Scenario G — Connection failure

1. Make one upstream unreachable.
2. Confirm the dashboard reports `unreachable`.
3. Verify sanitized failure information.
4. Confirm other upstreams still work.
5. Restore the failed upstream.
6. Trigger refresh/reconnect.
7. Confirm tools are rediscovered.

---

# 29. Verify Existing MCP Tool Execution

Ensure Day 4 changes have not broken the existing gateway.

Test the real:

```text
WooCommerce MCP Server

Calculator MCP Server

Time MCP Server
```

### WooCommerce

Verify the existing implemented tools, including:

- List products.
- Create product.
- List orders.
- Get order.
- Update order status.

Use the actual tool names exposed by the gateway.

### Calculator

Invoke at least one working calculator tool.

### Time

Invoke at least one working time tool.

### Cross-upstream verification

Through one authenticated MCP client:

1. List tools from all three servers.
2. Invoke a WooCommerce tool.
3. Invoke a Calculator tool.
4. Invoke a Time tool.

All calls must go through the gateway.

Do not access upstream MCP servers directly from the external client.

### Architecture preservation

Confirm execution still uses:

```text
Authentication
      |
      v
Authorization
      |
      v
Resolution
      |
      v
Invocation
      |
      v
Audit Hook
```

Do not create a frontend-specific or admin-specific bypass around the existing tool execution architecture.

---

# 30. Existing MCP Sessions and Live Changes

Test changes against already-connected MCP clients.

### Requirements

Verify:

- Revoked keys fail on the next authenticated request.
- Disabled upstream tools become uncallable.
- Removed upstream tools become uncallable.
- Newly registered tools appear on subsequent `tools/list` requests.
- Re-enabled upstream tools become available.
- Tool authorization remains enforced.
- Session identity cannot be changed by supplying another user's key.
- Healthy upstreams remain available when another upstream fails.

### Important

A successful dashboard action is not sufficient proof.

Verify the actual behavior through the MCP protocol.

This is particularly important for:

```text
tools/list
```

and:

```text
tools/call
```

---

# 31. Gateway Identity and Audit Readiness

Day 4 must preserve the request identity established in Brief 1.

Verify that the existing shared execution path receives:

```typescript
{
  userId: string;

  email: string;

  role: "admin" | "member";

  apiKeyId: string | null;

  authMethod: "api_key" | "session";

  requestId: string;
}
```

Adapt to the actual context type.

### Requirements

- MCP calls use the correct database-backed user identity.
- API-key IDs are available for attribution.
- Dashboard session identity resolves to a real user.
- Authorization uses the current role.
- The future audit logger can access user, server, tool, and request context.

### Important scope boundary

Do not build a separate audit logging architecture in this phase.

If existing audit hooks are incomplete, make the minimum compatibility fixes required to preserve identity propagation.

Full persistent audit logging and audit dashboard functionality should remain a separate follow-up unless already implemented.

However, do not remove any working audit functionality from previous days.

The original assignment ultimately requires audit records containing user, server, tool, timestamp, duration, and outcome. Urumi AI Internship Round 1 MCP…

Day 4 must leave the existing execution path ready for that requirement.

---

# 32. Frontend Security Review

Perform a security review of the dashboard implementation.

Verify:

### Authentication

- Sessions use secure HTTP-only cookies.
- Sessions persist across refreshes.
- Logout invalidates sessions.
- Expired sessions are rejected.
- Disabled users lose access.
- Current user roles are enforced server-side.

### API keys

- Raw keys are displayed only once.
- Keys are not stored in browser storage.
- Key hashes never reach the browser.
- Revocation is immediate.
- Users cannot access other users' keys.

### Server management

- Members cannot access admin APIs.
- Server credentials are never returned.
- Secret references are handled according to backend policy.
- URL validation is enforced server-side.
- Unsafe destinations are rejected.
- Error messages are sanitized.

### CSRF

- State-changing cookie-authenticated requests require valid CSRF protection.
- Frontend requests include the correct token.
- MCP bearer authentication remains separate.

### Rendering

- Untrusted upstream tool descriptions are rendered safely.
- No arbitrary HTML injection.
- No unsafe credential interpolation.
- No secrets printed to browser logs.

### Deployment

- No production secrets in the frontend bundle.
- No hardcoded MongoDB credentials.
- No public MongoDB ingress.
- No unrestricted Kubernetes Secret access.

---

# 33. Automated Frontend Tests

Add targeted tests using the repository's existing frontend test framework.

If none exists, use a minimal suitable testing setup.

### Authentication tests

Verify:

1. Login form validates required fields.
2. Successful login redirects correctly.
3. Failed login displays an error.
4. Session restoration works.
5. Protected routes reject unauthenticated access.
6. Admin routes reject members.
7. Logout clears authenticated UI state.

### API-key tests

Verify:

1. API-key list loads.
2. Empty state renders.
3. Key creation works.
4. Raw key appears only on creation.
5. Copy action works.
6. Closing creation view clears raw key.
7. Revocation requires confirmation.
8. Revoked status updates.
9. API errors display correctly.

### Server management tests

Verify:

1. Server list renders.
2. Connection statuses display correctly.
3. Server details load.
4. Discovered tools render.
5. Input schemas render safely.
6. Add server submits correct data.
7. Edit server submits correct data.
8. Disable requires confirmation.
9. Remove requires confirmation.
10. Refresh/reconnect updates status.
11. Failure messages remain sanitized.

### Role-based navigation

Verify:

- Admin sees admin navigation.
- Member does not see admin navigation.
- Direct member access to protected frontend routes fails.
- Backend still rejects unauthorized API calls.

Use API mocking for frontend tests where appropriate.

Do not replace backend integration tests with frontend mocks.

---

# 34. Kubernetes and Helm Validation

Run appropriate chart validation.

Use repository-specific paths.

Suggested checks:

```bash
helm lint <chart-path>
```

```bash
helm template <release-name> <chart-path> \
  -f values-local.yaml
```

```bash
helm template <release-name> <chart-path> \
  -f values-prod.yaml
```

Check rendered resources for:

- Valid manifests.
- Correct namespaces.
- Correct Secret references.
- Correct ServiceAccount names.
- RBAC permissions.
- NetworkPolicies.
- Persistence configuration.
- Probe configuration.
- Resource limits.
- Ingress routing.

### Important

Do not claim successful Kubernetes deployment merely because Helm templates render.

If a live cluster is available, deploy and verify the workloads.

If no live cluster is available, clearly distinguish template validation from runtime verification.

---

# 35. End-to-End Deployment Verification

Where a Kubernetes cluster is available, deploy the full system.

### Required checks

Verify:

```text
MongoDB is running.

Gateway is running.

Dashboard is running.

WooCommerce is running.

WooCommerce MCP server is running.

Calculator MCP server is running.

Time MCP server is running.
```

Verify:

- Dashboard URL works.
- Login works.
- Gateway MCP endpoint works.
- MongoDB persistence works.
- API-key authentication works.
- Server management works.
- Tool aggregation works.
- Kubernetes NetworkPolicies are effective.
- Gateway remains functional when an upstream fails.

### Restart tests

Restart the gateway.

Verify:

```text
Users remain.

API keys remain.

Sessions remain valid where expected.

Server registrations remain.

Disabled servers remain disabled.

Removed servers remain removed.

Enabled servers reconnect.

Tools are rediscovered.
```

Restart MongoDB without destroying its persistent volume.

Verify data remains.

### Important

Do not perform destructive cluster operations without checking the existing deployment context.

Do not delete persistent volumes containing user data.

---

# 36. Documentation

Update project documentation to reflect the final Day 4 implementation.

### README

Document:

1. Prerequisites.
2. Environment variables.
3. MongoDB setup.
4. Local development setup.
5. Kubernetes deployment.
6. Initial admin creation.
7. Dashboard login.
8. Member creation.
9. API-key generation.
10. MCP client connection.
11. Server registration.
12. Server enable/disable/remove.
13. Manual refresh/reconnection.
14. Troubleshooting.
15. Gateway restart behavior.

### Architecture documentation

Explain:

```text
React Dashboard
       |
       v
Session-Authenticated Backend APIs
       |
       +---- MongoDB
       |
       +---- User / API Key Management
       |
       +---- Upstream Registry Management
                   |
                   v
              UpstreamRegistry
                   |
                   v
              ToolAggregator
                   |
                   v
              MCP Upstreams
```

Also explain the separate external-client path:

```text
External MCP Client
       |
       v
Gateway URL + Bearer API Key
       |
       v
Database Authentication
       |
       v
Role Authorization
       |
       v
Tool Resolution
       |
       v
Upstream Invocation
```

### Security documentation

Explain:

- Password hashing.
- API-key hashing.
- One-time raw API-key display.
- API-key revocation.
- Bootstrap-key migration.
- Dashboard session security.
- CSRF protection.
- Admin/member authorization.
- Kubernetes Secret references.
- Secret-resolution permissions.
- SSRF protection.
- NetworkPolicy isolation.

### Deployment documentation

Explain the differences between:

```text
Local Kubernetes

Production-like k3s
```

Include:

- DNS and ingress.
- Storage classes.
- Persistent volumes.
- TLS configuration.
- Kubernetes Secrets.
- Helm values.
- Image configuration.
- Upgrade and rollback approach.

Do not document unsupported capabilities as though they have been implemented.

---

# 37. Assignment Demonstration Readiness

The original assignment expects an end-to-end demonstration with two users, gateway tool aggregation, API-key revocation, upstream disabling, and failure isolation. Urumi AI Internship Round 1 MCP…

Prepare Day 4 functionality for that demonstration.

### Administrator demonstration

Show:

1. Administrator logs in.
2. Dashboard displays registered servers.
3. WooCommerce, Calculator, and Time appear.
4. Admin views discovered tools.
5. Admin registers another MCP server.
6. The gateway discovers its tools.
7. Admin disables the new server.
8. Its tools disappear.
9. Admin re-enables it.
10. Its tools return.
11. Admin removes it.
12. Admin creates a member.

### Member demonstration

Show:

1. Member logs in.
2. Member cannot access admin server management.
3. Member creates an API key.
4. Raw key is displayed once.
5. Member copies the key.
6. Member connects MCP Inspector, Claude Code, or Cursor.
7. Client lists tools from enabled upstreams.
8. Client invokes a permitted tool.
9. Member revokes the API key.
10. The next client request fails.

### Failure isolation demonstration

Show:

1. One upstream becomes unreachable.
2. Dashboard reflects its failure.
3. Other upstream tools remain available.
4. Failed server reconnects.
5. Discovered tools become available again.

### Persistence demonstration

Show:

1. Upstream configuration exists in MongoDB.
2. Gateway restarts.
3. Registrations are restored.
4. Disabled state persists.
5. Deleted servers are not recreated.

### Day 5 boundary

The original assignment also requires a chat agent and persistent audit logs.

Those features remain separate from the Day 4 scope unless already present.

Do not build an unrelated chat agent during this brief.

However, ensure the dashboard and gateway architecture can support the future agent using the same authenticated tool execution path.

---

# 38. Implementation Constraints

Follow these rules strictly:

1. **Inspect before implementing.** Determine the actual state of Briefs 1 and 2.

2. **Do not rewrite completed backend systems.** Reuse existing authentication, API keys, registry, and tool aggregation.

3. **Use the existing React project if available.** Avoid unnecessary frontend reinitialization.

4. **Keep the UI minimal but complete.** Functional clarity matters more than elaborate design.

5. **Enforce permissions in the backend.** Frontend role-based navigation is not sufficient security.

6. **Keep dashboard sessions separate from MCP bearer authentication.**

7. **Never store raw API keys in browser storage.**

8. **Show raw API keys only once.**

9. **Never expose upstream credentials.**

10. **Do not hardcode backend API responses or server lists.**

11. **Use live registry status.** Do not invent connection states.

12. **Do not bypass the shared MCP execution boundary.**

13. **Do not weaken Kubernetes security to simplify deployment.**

14. **Do not create duplicate Helm resources.**

15. **Preserve the existing WooCommerce deployment and persistent data.**

16. **Preserve existing Calculator and Time MCP functionality.**

17. **Do not reintroduce bootstrap-key authentication for normal MCP operation.**

18. **Do not implement unnecessary OAuth, multi-tenancy, or multi-store provisioning.**

19. **Do not implement the Day 5 chat agent or full audit dashboard in this phase.**

20. **Test actual MCP behavior, not just successful dashboard API responses.**

21. **Document limitations accurately.**

22. **Do not claim verification was completed when it was not performed.**

---

# 39. Definition of Done

Brief 3 is complete only when the following are satisfied.

## A. Authentication UI

- [ ] Login page works.
- [ ] Password verification uses Brief 1 backend.
- [ ] Session persists across page refreshes.
- [ ] Protected routes work.
- [ ] Role-based navigation works.
- [ ] Logout invalidates the session.
- [ ] CSRF protection remains enforced.
- [ ] Members cannot access admin APIs.

## B. API-key UI

- [ ] Members can view their own keys.
- [ ] Members can generate keys.
- [ ] Raw keys display only once.
- [ ] Copy API Key button works.
- [ ] Existing raw keys cannot be retrieved.
- [ ] Keys show prefix, creation, last-used, and revocation status.
- [ ] Members can revoke their own keys.
- [ ] Admins can issue member keys.
- [ ] Admins can revoke member keys.
- [ ] Revoked keys fail on the next MCP request.

## C. Member Management

- [ ] Admin can list members.
- [ ] Admin can create members.
- [ ] Admin can view member details.
- [ ] Admin can manage supported account fields.
- [ ] Member role restrictions are enforced.
- [ ] Disabled accounts lose access.
- [ ] Last-active-admin protection remains enforced.

## D. Server Management UI

- [ ] Server list works.
- [ ] Connection statuses display correctly.
- [ ] Server details work.
- [ ] Tools are displayed.
- [ ] Input schemas are displayed.
- [ ] Add server works.
- [ ] Edit server works.
- [ ] Enable server works.
- [ ] Disable server works.
- [ ] Remove server works with confirmation.
- [ ] Manual reconnect works.
- [ ] Sanitized errors display.
- [ ] Loading, empty, success, and error states exist.
- [ ] Members cannot access server management.

## E. Dynamic Gateway Integration

- [ ] New upstream tools appear without gateway restart.
- [ ] Disabled tools disappear from `tools/list`.
- [ ] Removed tools disappear from `tools/list`.
- [ ] Existing clients cannot invoke disabled tools.
- [ ] Existing clients cannot invoke removed tools.
- [ ] Failed discovery does not break healthy upstreams.
- [ ] Reconnection updates the tool catalog.
- [ ] Existing authorization remains enforced.
- [ ] Existing authenticated execution pipeline remains intact.

## F. Kubernetes

- [ ] MongoDB has persistent storage.
- [ ] Gateway MongoDB connection uses Kubernetes Secrets.
- [ ] Dashboard runs in Kubernetes.
- [ ] Docker images build successfully.
- [ ] Helm templates validate.
- [ ] Local and production-like values exist.
- [ ] Ingress routes work.
- [ ] Readiness and liveness probes are configured.
- [ ] Resource requests and limits exist.
- [ ] ServiceAccount permissions are appropriate.
- [ ] Secret access is least-privilege.
- [ ] NetworkPolicies preserve isolation.
- [ ] Upstreams remain internal-only.
- [ ] MongoDB is not publicly exposed.
- [ ] Gateway restarts restore persistent state.

## G. Regression Verification

- [ ] WooCommerce MCP tools still work.
- [ ] Calculator MCP tools still work.
- [ ] Time MCP tools still work.
- [ ] API-key authentication still works.
- [ ] API-key revocation still works.
- [ ] Admin/member authorization still works.
- [ ] Tool aggregation still works.
- [ ] Tool namespace handling still works.
- [ ] Upstream timeout handling still works.
- [ ] Reconnection still works.
- [ ] Failure isolation still works.
- [ ] Existing audit hooks remain intact.

## H. Documentation

- [ ] README updated.
- [ ] Local setup documented.
- [ ] Kubernetes deployment documented.
- [ ] Production-like configuration documented.
- [ ] Initial admin setup documented.
- [ ] API-key creation documented.
- [ ] MCP client connection documented.
- [ ] Server management documented.
- [ ] Security choices documented.
- [ ] Known limitations documented.

---

# 40. Expected Codex Output

Implement this phase directly in the existing repository.

After implementation, provide the following.

### A. Files changed

List every created and modified file.

Group them by:

```text
Frontend

Backend Integration

Docker

Helm

Kubernetes Security

Tests

Documentation
```

Briefly explain the purpose of each major change.

### B. Dashboard architecture

Explain:

- React application structure.
- Authentication state.
- Protected routes.
- Role-based navigation.
- Centralized API client.
- CSRF integration.
- One-time API-key display.
- Server management flow.

### C. Integration summary

Explain how the React dashboard interacts with:

```text
MongoDB-backed Users

API Keys

Dashboard Sessions

Admin Authorization

Upstream Registry

ToolAggregator

MCP Gateway
```

### D. Kubernetes deployment summary

Explain:

- MongoDB persistence.
- Dashboard deployment.
- Gateway configuration.
- Secret references.
- RBAC.
- NetworkPolicies.
- Ingress.
- Local/production Helm values.

### E. Test results

Run the actual repository commands for:

```text
Frontend TypeScript Checks

Frontend Build

Backend Build

Backend Tests

Frontend Tests

Gateway Integration Tests

Helm Lint

Helm Template Validation
```

Where a Kubernetes cluster is available, perform deployment-level verification.

Clearly report:

```text
Passed

Failed

Not Executed

Requires Live Cluster
```

Do not invent successful test results.

### F. Manual end-to-end walkthrough

Provide exact steps to demonstrate:

1. Deploy the application.
2. Access the dashboard.
3. Log in as admin.
4. Create a member.
5. Log in as member.
6. Generate an API key.
7. Connect an external MCP client.
8. List aggregated tools.
9. Invoke WooCommerce, Calculator, and Time tools.
10. Revoke the API key.
11. Verify immediate rejection.
12. Log in as admin.
13. Add an upstream.
14. Confirm its tools appear.
15. Disable it.
16. Confirm its tools disappear.
17. Re-enable it.
18. Confirm tools return.
19. Simulate connection failure.
20. Confirm healthy upstreams remain functional.
21. Remove the upstream.
22. Restart the gateway.
23. Confirm MongoDB persistence and correct registry restoration.

### G. Final Day 4 status report

Produce a concise final checklist showing:

```text
Brief 1 — Identity and Authentication

Brief 2 — Dynamic Upstream Management

Brief 3 — Dashboard and Deployment
```

For every major capability, mark:

```text
Implemented and Verified

Implemented but Not Verified

Incomplete
```

Clearly identify any remaining implementation gaps.

Do not treat a passing frontend build as proof that the complete system works.

### H. Day 5 handoff

Provide a short summary of the existing interfaces and architecture that the next phase should reuse.

Include:

- Authenticated user context.
- Existing `executeTool()` boundary.
- `authorizeTool()`.
- Aggregated tool discovery.
- Tool invocation.
- Server metadata.
- Existing audit hooks.
- Dashboard session authentication.

Do not implement the next phase.

---

# Final Instruction to Codex

**Complete Day 4 by integrating the React dashboard with the persistent identity system from Brief 1 and the dynamic MCP upstream registry from Brief 2.**

Prioritize a fully working end-to-end implementation over unnecessary frontend complexity.

The final system must demonstrate that:

**1. Identity is persistent.** Users, roles, sessions, and API keys are backed by MongoDB.

**2. Authentication is secure.** External MCP clients use independently validated bearer API keys, while dashboard users use secure server-side sessions.

**3. Members are self-sufficient.** Members can log in, generate and revoke their own API keys, and access permitted MCP tools using one gateway URL.

**4. Administrators control the gateway.** Admins can create members, manage API keys, and dynamically register, edit, disable, remove, and reconnect MCP servers.

**5. Tool aggregation remains dynamic.** Adding or removing upstreams updates the active tool catalog without restarting the gateway.

**6. Security remains enforced.** Members cannot manage upstreams, revoked keys stop working, credentials remain protected, and Kubernetes isolation is preserved.

**7. State survives restarts.** Gateway restarts restore users, API keys, upstream registrations, and enabled/disabled configuration from persistent storage.

**8. Existing functionality remains operational.** WooCommerce, Calculator, and Time continue working through the gateway's existing authentication → authorization → resolution → invocation → audit architecture.

**9. Kubernetes deployment is reproducible.** The system runs on local Kubernetes and supports production-like k3s deployment using the same Helm charts with environment-specific values.

### Final Day 4 milestone

**A real administrator can log into the React dashboard, manage team members and upstream MCP servers, and a real member can log in, generate an API key, connect an external MCP client, invoke permitted tools from multiple upstreams, and have that access revoked immediately—all while the gateway retains persistent configuration and preserves Kubernetes security boundaries.**

**Do not consider Day 4 complete until this workflow has been verified against the running system, or any unverified portions have been explicitly identified.**