# AGENTS.md — Urumi MCP Gateway

## 1. Project Overview

Urumi is a Kubernetes-native Model Context Protocol (MCP)
gateway that aggregates multiple upstream MCP servers behind
a single authenticated Streamable HTTP endpoint.

Repository: Moracus/urumi-assignment

The project includes:

- MCP Gateway built with TypeScript and Fastify
- WooCommerce MCP server
- Calculator MCP server
- Time MCP server
- WordPress with WooCommerce
- MariaDB for WordPress persistence
- React/Vite dashboard scaffold
- Docker containerization
- Kubernetes deployment using Helm
- Local Kubernetes development using Kind
- Traefik Ingress
- Kubernetes NetworkPolicies

The gateway acts as:

1. An MCP server for external clients.
2. An MCP client for upstream MCP servers.

The architecture prioritizes authentication, authorization,
tool discovery, routing, failure isolation, and Kubernetes
network security.

## 2. Important Instructions for Coding Agents

Before making changes:

1. Inspect the relevant existing files.
2. Understand the current implementation.
3. Read the relevant documentation.
4. Identify the smallest safe change.
5. Preserve existing architecture and interfaces.
6. Implement the requested functionality.
7. Add or update tests.
8. Run relevant validation commands.
9. Summarize changes and remaining limitations.

Do not rewrite existing components unnecessarily.

Do not introduce alternative frameworks or replace working
infrastructure without a clear technical justification.

Prefer incremental changes over large refactors.

Do not claim tests have passed unless they were executed.

Do not claim Kubernetes workloads are healthy unless their
status was actually checked.

Do not silently change public interfaces, deployment names,
environment variables, or tool names.

Never commit secrets.

## 3. Technology Stack

### Backend

- Node.js 24
- TypeScript
- Fastify 5
- MCP TypeScript SDK v2
- Zod 4
- Mongoose 9
- pnpm workspace

### Frontend

- React
- Vite
- TypeScript

### Infrastructure

- Docker
- Kubernetes
- Kind for local development
- Helm
- Traefik Ingress
- Kubernetes NetworkPolicies
- Kubernetes Secrets

### Databases

MariaDB:
- WordPress data
- WooCommerce products
- WooCommerce orders

MongoDB:
- Planned application identity and management persistence
- Users
- API keys
- Upstream registry metadata
- Audit records

MongoDB models and persistence must not be assumed to exist
merely because Mongoose is installed.

## 4. Repository Structure

```text
apps/
  gateway/
    src/
      index.ts
      mcp-server.ts

      security/
        authentication.ts
        authorization.ts
        identity.ts

      execution/
        execute-tool.ts
        types.ts

      upstream/
        connection.ts
        registry.ts
        defaults.ts
        types.ts

      tools/
        aggregator.ts
        resolver.ts
        invoker.ts
        errors.ts
        types.ts

      audit/
        logger.ts

  woocommerce-mcp/
  calculator-mcp/
  time-mcp/
  dashboard/

packages/
  shared/

infra/
  kind/
    cluster.yaml

  helm/
    urumi/
      Chart.yaml
      values.yaml
      values-local.yaml
      values-prod.yaml
      templates/

docs/
  systemdesign.md
  threat-model.md

README.md
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
```

Always inspect the actual repository tree before assuming a
file or directory exists.

## 5. Existing Architecture

```text
                  External MCP Client
                          |
                          v
                    Traefik Ingress
                          |
                          v
                      MCP Gateway
                          |
                   Authentication
                          |
                    Authorization
                          |
                     Tool Registry
                          |
                    Tool Aggregator
                          |
                     Tool Resolver
                          |
                  Execution Boundary
                          |
                    Upstream Invoker
                          |
              +-----------+-----------+
              |           |           |
              v           v           v
         WooCommerce  Calculator     Time
            MCP          MCP         MCP
              |
              v
          WordPress
              |
              v
            MariaDB
```

The gateway is the only intended external entry point
for accessing upstream MCP tools.

Upstream MCP servers must remain internal Kubernetes services.

WordPress is separately exposed through the storefront Ingress.

## 6. Existing MCP Servers

### WooCommerce MCP

Service:

```text
urumi-woocommerce-mcp
```

Port:

```text
3001
```

MCP endpoint:

```text
http://urumi-woocommerce-mcp:3001/mcp
```

Tools:

- list_products
- create_product
- list_orders
- get_order
- update_order_status

Public gateway names:

- woocommerce.list_products
- woocommerce.create_product
- woocommerce.list_orders
- woocommerce.get_order
- woocommerce.update_order_status

The WooCommerce MCP server communicates with WordPress
through the WooCommerce REST API.

Preserve the existing OAuth request-signing implementation.

The public WordPress URL is used for signing, while the
actual HTTP destination may use the internal Kubernetes
WordPress Service.

Changes to WordPress URLs must preserve this relationship.

### Calculator MCP

Service:

```text
urumi-calculator-mcp
```

Port:

```text
3002
```

MCP endpoint:

```text
http://urumi-calculator-mcp:3002/mcp
```

Tool:

```text
calculate
```

Public name:

```text
calculator.calculate
```

Supported operations:

- add
- subtract
- multiply
- divide

### Time MCP

Service:

```text
urumi-time-mcp
```

Port:

```text
3003
```

MCP endpoint:

```text
http://urumi-time-mcp:3003/mcp
```

Tool:

```text
current
```

Public name:

```text
time.current
```

The tool accepts an IANA timezone.

## 7. Gateway Architecture

The gateway is implemented in:

```text
apps/gateway
```

Port:

```text
3000
```

MCP endpoint:

```text
/mcp
```

Health endpoints:

```text
/health/live
/health/ready
```

The gateway uses the MCP SDK's Streamable HTTP transport.

Do not replace the MCP endpoint with a custom JSON REST
implementation.

All MCP operations must remain protocol-compliant.

### Existing modules

Authentication:

```text
security/authentication.ts
```

Authorization:

```text
security/authorization.ts
```

Authenticated identity:

```text
security/identity.ts
```

Registry:

```text
upstream/registry.ts
```

Tool aggregation:

```text
tools/aggregator.ts
```

Tool resolution:

```text
tools/resolver.ts
```

Tool invocation:

```text
tools/invoker.ts
```

Execution boundary:

```text
execution/execute-tool.ts
```

Audit logging:

```text
audit/logger.ts
```

Preserve this modular separation.

## 8. Shared Tool Execution Boundary

All tool execution must pass through:

```typescript
executeTool()
```

The required execution sequence is:

```text
Authenticated identity
         |
         v
    Authorization
         |
         v
    Tool resolution
         |
         v
   Upstream invocation
         |
         v
     Audit logging
         |
         v
       Result
```

Do not invoke upstream tools directly from dashboard controllers,
API routes, or other external request handlers if doing so bypasses
the shared execution boundary.

The execution request contains:

- Authenticated identity
- Public tool name
- Tool arguments
- Request ID

The identity contains:

```typescript
interface AuthenticatedIdentity {
  userId: string;
  role: "admin" | "member";
  keyId: string;
}
```

Preserve identity propagation through the execution path.

Never trust a client-supplied userId or role without authentication.

Audit records should retain sufficient execution context to
attribute actions to the authenticated user and API key.

## 9. Authentication and Authorization

### Current authentication

The gateway currently uses:

```text
GATEWAY_BOOTSTRAP_KEY
```

Requests authenticate through:

```http
Authorization: Bearer <api-key>
```

The current authentication implementation:

1. Extracts the bearer credential.
2. Hashes the configured and supplied keys using SHA-256.
3. Compares their hashes with timingSafeEqual.
4. Assigns a bootstrap administrator identity.

The bootstrap identity is:

```typescript
{
  userId: "bootstrap-admin",
  role: "admin",
  keyId: "bootstrap-key"
}
```

This is a temporary bootstrap mechanism.

It is NOT persistent user authentication.

Do not mistake in-memory hashing during comparison for
database-backed API-key hashing.

### Required authentication evolution

When implementing persistent authentication:

- Store users in MongoDB.
- Store API-key hashes, never raw keys.
- Associate keys with real users.
- Support key revocation.
- Reject revoked keys immediately.
- Resolve roles server-side.
- Preserve the existing AuthenticatedIdentity interface.
- Preserve the shared execution boundary.
- Avoid disrupting existing MCP transport behavior.

The bootstrap key should only remain available for explicitly
defined initial setup or recovery.

Do not allow an unrestricted permanent bootstrap admin key
to bypass normal account controls.

### Roles

Existing roles:

```text
admin
member
```

Admin capabilities currently permit all registered tools.

Member tool execution currently permits:

- woocommerce.list_products
- woocommerce.list_orders
- woocommerce.get_order
- calculator.calculate
- time.current

Members cannot currently invoke:

- woocommerce.create_product
- woocommerce.update_order_status

Preserve this policy unless requirements explicitly change.

Do not rely on frontend-only authorization.

All admin/member permissions must be enforced by the backend.

### Tool discovery authorization

The gateway filters tools according to user permissions.

Unauthorized tools must not appear in an identity's tool catalog.

Every actual tool invocation must still be authorized independently.

Do not assume visibility filtering is sufficient security.

## 10. Upstream Registry

Implemented in:

```text
apps/gateway/src/upstream/registry.ts
```

The registry currently supports:

- Upstream registration
- MCP client connections
- Tool discovery
- Cached tool definitions
- Connection status
- Periodic refresh
- Failure tracking
- Reconnection
- Connection cleanup

Upstream statuses include:

```text
disconnected
connecting
connected
unreachable
disabled
```

The gateway discovers upstream tools using MCP:

```text
tools/list
```

The default refresh interval is approximately 30 seconds.

Connection setup and discovery use bounded timeouts.

The registry maintains runtime state in memory.

### Important invariants

- One unhealthy upstream must not disable healthy upstreams.
- Previously discovered definitions may remain cached internally.
- Unreachable upstreams must be excluded from public discovery.
- Disabled upstreams must not be invoked.
- Removed upstreams must no longer be executable.
- Connection replacement must not be invalidated by stale failures.
- Avoid overlapping maintenance operations for the same upstream.
- Close unused connections and clean up resources.

### Planned dynamic registry management

The initial upstream definitions come from:

```text
upstream/defaults.ts
```

Future management features must persist upstream registrations
in MongoDB and synchronize changes with the live registry.

When adding dynamic server management:

- Add server
- Edit server
- Enable server
- Disable server
- Remove server
- Inspect status
- Inspect discovered tools
- Refresh/reconnect server

Do not implement MongoDB CRUD without updating the live registry.

Likewise, do not update only the in-memory registry while ignoring
persistent configuration.

Keep the database and active runtime registry consistent.

## 11. Tool Aggregation and Routing

Public names use:

```text
<upstream-name>.<tool-name>
```

Examples:

```text
calculator.calculate
time.current
woocommerce.list_products
```

The original upstream tool names must remain unchanged.

The gateway must preserve upstream tool descriptions and
input schemas.

Tool resolution must use the actual discovered catalog.

Never route arbitrary tool names solely by splitting a string.

Unknown tools must not be executed.

### Tool invocation

The upstream invoker calls MCP:

```text
tools/call
```

The public gateway name must resolve to:

- Upstream name
- Original upstream tool name

The existing invoker applies a ten-second tool-call timeout.

Do not silently remove or increase timeouts.

A valid MCP tool result may contain:

```typescript
isError: true
```

That does not necessarily indicate an unhealthy server.

Preserve valid MCP tool results, including structured content.

Do not automatically retry state-changing WooCommerce operations.

A timed-out product creation or order update may have already
been applied.

## 12. Failure Handling

The gateway includes upstream-specific errors:

- UpstreamUnavailableError
- UpstreamTimeoutError
- UpstreamCallError

Expected behavior:

- Unavailable upstream: clear unavailable error.
- Timeout: bounded failure.
- Invalid response: reject malformed result.
- Tool-level MCP error: preserve isError.
- Connection failure: mark relevant upstream unhealthy.
- Upstream recovery: reconnect and rediscover tools.
- Healthy upstreams: remain operational.

Do not expose:

- Internal Kubernetes URLs
- API keys
- Connection credentials
- Stack traces
- Secret values

in client-facing error messages.

Log sufficient diagnostic information without logging secrets.

Do not conflate transport failures with application-level
tool errors.

## 13. Audit Logging

Current implementation:

```text
apps/gateway/src/audit/logger.ts
```

The existing audit layer emits structured console records.

Audit metadata includes:

- Request ID
- User ID
- API-key ID
- Tool name
- Upstream name
- Timestamp
- Duration
- Outcome

Potential outcomes include:

- success
- tool_error
- unauthorized
- not_found
- upstream_error
- upstream_unavailable
- upstream_timeout

Audit persistence in MongoDB is planned.

Do not claim audit records are already durably persisted.

When implementing persistence:

- Reuse the existing audit interface.
- Keep the execution boundary responsible for recording outcomes.
- Never store raw gateway API keys.
- Avoid recording sensitive tool arguments by default.
- Preserve user and key attribution.
- Support querying by user, tool, outcome, and time.

## 14. Kubernetes Architecture

Namespace:

```text
urumi
```

Kind cluster:

```text
urumi
```

Helm chart:

```text
infra/helm/urumi
```

Environment values:

```text
values.yaml
values-local.yaml
values-prod.yaml
```

Local storage class:

```text
standard
```

Production-oriented storage class:

```text
local-path
```

Local Ingress class:

```text
traefik
```

The production values file contains placeholder hostnames and
must not be treated as proof of a verified production deployment.

### Kubernetes Services

Gateway:

```text
urumi-gateway:3000
```

WooCommerce MCP:

```text
urumi-woocommerce-mcp:3001
```

Calculator MCP:

```text
urumi-calculator-mcp:3002
```

Time MCP:

```text
urumi-time-mcp:3003
```

WordPress:

```text
urumi-wordpress:80
```

MariaDB:

```text
urumi-mariadb:3306
```

Do not rename Services without updating all dependent
configuration and tests.

### Ingress

Gateway:

```text
gateway.localhost/mcp
```

Storefront:

```text
store.localhost
```

The gateway Ingress exposes `/mcp`.

WordPress exposes `/` and its subpaths.

Do not create public Ingress routes for upstream MCP servers.

## 15. Kubernetes Network Security

The Helm chart contains NetworkPolicies for:

- Gateway
- WooCommerce MCP
- Calculator MCP
- Time MCP
- WordPress
- MariaDB

Expected traffic:

```text
Traefik -> Gateway
Traefik -> WordPress

Gateway -> WooCommerce MCP
Gateway -> Calculator MCP
Gateway -> Time MCP

WooCommerce MCP -> WordPress

WordPress -> MariaDB
```

NetworkPolicies currently focus on ingress isolation.

Do not assume comprehensive egress isolation already exists.

Do not assume NetworkPolicies are enforced solely because
the API objects exist.

Enforcement requires a compatible Kubernetes networking
implementation and actual connectivity tests.

### When changing labels

NetworkPolicy selectors depend on Deployment Pod labels.

If Deployment labels change, inspect and update the affected
NetworkPolicies.

### When adding new services

For each new service:

1. Determine required inbound connections.
2. Determine required outbound connections.
3. Add a ClusterIP Service when appropriate.
4. Update NetworkPolicies.
5. Avoid public Ingress unless explicitly required.
6. Test allowed and blocked connectivity.

Never weaken the entire namespace's network isolation just
to make a new feature work.

## 16. Kubernetes Secrets

Credentials must not be committed.

Existing secrets include:

```text
urumi-db-secret
urumi-woocommerce-api
urumi-gateway-auth
```

The gateway bootstrap credential comes from a Kubernetes Secret.

WooCommerce REST credentials also come from a Secret.

When implementing dynamic upstream credentials:

- Store Secret references in MongoDB.
- Never store raw upstream credentials in MongoDB.
- Do not return Secret values to the dashboard.
- Use a dedicated Kubernetes ServiceAccount.
- Grant narrowly scoped Secret access using RBAC.
- Avoid broad cluster-wide permissions.

Do not introduce wildcard Secret-management permissions.

Do not print Secret values in logs or tests.

## 17. WordPress and WooCommerce Constraints

WordPress stores its data in MariaDB.

WordPress also uses a persistent volume for its filesystem.

Do not delete PVCs, reset MariaDB, or recreate the Kind
cluster without explicit user authorization.

Do not replace persistent storage with ephemeral volumes.

The WooCommerce MCP REST client signs requests against
the configured public WordPress URL.

The actual network destination may be the internal
WordPress Kubernetes Service.

Preserve the correct:

- Protocol
- Hostname
- Port
- OAuth signature base URL
- Host header

when modifying storefront routing.

Do not automatically retry write operations.

Use read-only WooCommerce operations for smoke tests unless
the user explicitly requests a mutation test.

## 18. Dashboard Development

Current dashboard:

```text
apps/dashboard
```

The frontend is a React/Vite scaffold.

Do not assume the complete admin dashboard already exists.

### Planned capabilities

Authentication:

- Login
- Logout
- Server-side sessions
- Secure HTTP-only cookies
- CSRF protection
- Server-side role checks

Admin:

- View registered MCP servers
- Inspect status and tools
- Add servers
- Edit servers
- Enable/disable servers
- Remove servers
- Create/invite members
- Manage API keys

Members:

- Log in
- Generate their own API keys
- Revoke their own API keys
- View permitted information

API keys must be shown in raw form only once at creation.

Never store raw keys in browser localStorage.

Never expose upstream secrets in the UI.

Keep dashboard session authentication separate from MCP
bearer-token authentication.

### UI guidance

Prioritize functionality over appearance.

Use clear tables, forms, loading indicators, and error states.

Do not introduce large UI libraries unless necessary.

Ensure protected backend endpoints enforce roles regardless
of frontend visibility.

## 19. Development Commands

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Typecheck entire workspace:

```bash
pnpm typecheck
```

Build entire workspace:

```bash
pnpm build
```

Typecheck gateway:

```bash
pnpm --filter @urumi/gateway typecheck
```

Build gateway:

```bash
pnpm --filter @urumi/gateway build
```

Run gateway development server:

```bash
pnpm --filter @urumi/gateway dev
```

Run compiled gateway unit tests:

```bash
node --test \
  apps/gateway/dist/execution/execute-tool.test.js \
  apps/gateway/dist/tools/aggregator.test.js
```

Before adding new npm dependencies:

1. Check existing workspace dependencies.
2. Prefer installed packages.
3. Keep dependency versions compatible with the project.
4. Use pnpm, not npm or yarn.
5. Update pnpm-lock.yaml when dependencies change.

The root package.json pins pnpm.

Do not independently alter the package-manager version.

## 20. Helm and Kind Commands

Lint local configuration:

```bash
helm lint infra/helm/urumi \
  -f infra/helm/urumi/values-local.yaml
```

Lint production configuration:

```bash
helm lint infra/helm/urumi \
  -f infra/helm/urumi/values-prod.yaml
```

Render local manifests:

```bash
helm template urumi infra/helm/urumi \
  -n urumi \
  -f infra/helm/urumi/values-local.yaml
```

Deploy to Kind:

```bash
helm upgrade --install urumi infra/helm/urumi \
  -n urumi \
  --create-namespace \
  -f infra/helm/urumi/values-local.yaml
```

Inspect workloads:

```bash
kubectl get pods -n urumi
kubectl get deployments -n urumi
kubectl get svc -n urumi
kubectl get ingress -n urumi
kubectl get networkpolicy -n urumi
```

Inspect gateway logs:

```bash
kubectl logs -n urumi deployment/urumi-gateway
```

Do not delete or recreate an existing cluster as a shortcut
for resolving deployment issues.

Do not reset application data without explicit authorization.

## 21. Testing Requirements

For every change:

1. Run the relevant TypeScript typecheck.
2. Run the relevant build.
3. Execute affected tests.
4. Add regression tests for changed behavior.
5. Validate Helm if Kubernetes manifests changed.
6. Check that security boundaries remain intact.

### Gateway tests

Test at minimum:

- Valid authentication
- Missing API key
- Invalid API key
- Unauthorized tool execution
- Unknown tool rejection
- Namespaced resolution
- Tool schema preservation
- Correct upstream invocation
- MCP tool errors
- Upstream unavailability
- Timeout behavior
- Recovery after upstream restoration
- Healthy upstream isolation

### Kubernetes tests

When modifying networking or deployments:

- Check Pod readiness.
- Check the relevant Services.
- Test allowed connections.
- Test blocked connections.
- Verify Ingress routing.
- Confirm Secrets are referenced correctly.
- Confirm PVCs are preserved.

### API-key tests

When implementing persistent API keys:

- Generated raw key works.
- Stored record contains only a key hash.
- Raw key is returned only at creation.
- Incorrect key is rejected.
- Revoked key is rejected.
- Member can manage only their own keys.
- Admin permissions are enforced.
- Existing MCP connections cannot bypass revocation.

## 22. Code Style

Use TypeScript.

Follow the repository's existing style.

Prefer:

- Explicit interfaces
- Small functions
- Descriptive names
- Dependency injection
- Async/await
- Typed errors
- Clear separation of responsibilities

Use ESM imports.

For relative TypeScript imports, follow the existing convention:

```typescript
import { example } from "./example.js";
```

Avoid:

- Unnecessary `any`
- Unchecked type assertions
- Unnecessary global state
- Duplicating existing business logic
- Swallowing errors silently
- Logging secrets
- Direct database access from unrelated modules
- Large monolithic route handlers

Keep authentication, authorization, routing, and persistence
separate.

Do not introduce breaking changes without updating consumers
and tests.

## 23. Error Handling

Errors must be:

- Predictable
- Properly classified
- Safe for clients
- Useful for debugging
- Auditable

Do not expose internal URLs, stack traces, API keys,
or database connection strings.

Use existing typed errors when possible.

Do not convert MCP tool-level errors into connection failures.

Do not leak raw exceptions through the MCP endpoint.

When an operation can partially succeed, document that risk.

## 24. Configuration Rules

Configuration should come from:

- Environment variables
- Kubernetes Secrets
- Helm values
- Persistent management configuration where implemented

Do not hardcode credentials.

Use existing environment variable names when possible.

Important gateway variables include:

```text
PORT
HOST
MCP_ALLOWED_HOSTS

GATEWAY_BOOTSTRAP_KEY

WOOCOMMERCE_MCP_URL
CALCULATOR_MCP_URL
TIME_MCP_URL
```

When introducing new environment variables:

1. Document them.
2. Update relevant Helm templates.
3. Keep local and production values compatible.
4. Ensure secrets are not embedded in Helm values.
5. Validate startup behavior when required values are absent.

## 25. Documentation

Primary documentation:

```text
README.md
docs/systemdesign.md
docs/threat-model.md
```

Update documentation when changing:

- Architecture
- Public endpoints
- Authentication behavior
- Authorization rules
- Environment variables
- Helm values
- Kubernetes networking
- Tool names
- Setup commands
- Operational procedures

Document implemented behavior separately from planned work.

Do not claim production-readiness without verification.

## 26. Git Workflow

The primary working branch is:

```text
main
```

Before editing:

```bash
git status
```

Inspect relevant files and recent changes.

Keep commits focused.

Suggested commit prefixes:

```text
feat:
fix:
refactor:
test:
docs:
chore:
```

Do not commit:

- .env
- .env.local
- API keys
- Passwords
- Kubernetes Secret dumps
- Private keys
- Generated credentials

Do not force-push or rewrite Git history without explicit
authorization.

Do not commit unrelated changes.

Do not push automatically unless explicitly requested.

## 27. Current Development Direction

The next major development area is persistent identity,
API-key management, dynamic server management, and dashboard
integration.

Existing building blocks should be reused.

### Backend work

Implement:

- MongoDB connection
- User model
- Admin/member roles
- Secure password storage
- Authentication sessions
- Persistent hashed API keys
- Key revocation
- API-key ownership
- Server configuration model
- Server CRUD
- Registry synchronization
- Server enable/disable
- Secret reference management

### Authentication migration

Replace temporary bootstrap-only authentication with
database-backed key lookup.

Preserve:

```typescript
AuthenticatedIdentity
```

and:

```typescript
executeTool()
```

Avoid rewriting the MCP gateway.

Keep bootstrap setup restricted.

### Dynamic server management

Server management operations must update:

1. Persistent server metadata.
2. Live registry configuration.
3. MCP connections.
4. Discovered tool catalog.

Disabling a server must prevent tool execution without
requiring a full gateway restart.

### Kubernetes credential access

Dynamic credential management requires narrowly scoped
Kubernetes RBAC.

Do not grant unrestricted Secret access to the gateway.

### Dashboard

Implement functional admin/member workflows first.

Keep the interface simple.

Backend authorization is mandatory.

## 28. Definition of Done

A task is complete only when:

1. The requested behavior is implemented.
2. Existing architecture is preserved or changes are justified.
3. Relevant tests are added or updated.
4. TypeScript checks pass.
5. Builds pass.
6. Helm validation passes when applicable.
7. Security requirements remain satisfied.
8. Documentation is updated when needed.
9. Any limitations are clearly reported.

For every completed task, report:

- What changed
- Which files changed
- Tests and commands executed
- Whether validation passed
- Any known limitations
- Any manual deployment steps required

Never report unexecuted tests as passing.

## 29. Non-Negotiable Rules

1. Never bypass gateway authentication.
2. Never bypass backend authorization.
3. Never bypass the shared tool execution boundary.
4. Never expose upstream MCP servers publicly without approval.
5. Never commit raw credentials.
6. Never store raw API keys in MongoDB.
7. Never expose Kubernetes Secret values in API responses.
8. Never break existing MCP tool names unnecessarily.
9. Never automatically retry non-idempotent WooCommerce writes.
10. Never remove persistent volumes without approval.
11. Never weaken NetworkPolicies as a shortcut.
12. Never claim a feature exists without checking implementation.
13. Never make unrelated architectural changes.
14. Always preserve healthy-upstream operation during failures.
15. Always validate relevant changes before declaring completion.

## 30. Guiding Principle

Extend the existing working system.

The gateway already has a structured execution pipeline,
MCP client connections, tool aggregation, routing, failure
handling, Kubernetes deployment, and network isolation.

New functionality should build on these foundations rather
than introduce parallel systems.

Prioritize correctness, security, maintainability,
reproducibility, and clear engineering decisions over
unnecessary complexity.