# DAY 4 — CODEX BRIEF 2/3
## Persistent MCP Server Registry, Dynamic Upstream Management & Kubernetes Security

### Objective

Implement **database-backed MCP upstream server management**, replacing the Day 3 static upstream configuration with a persistent, dynamically manageable registry.

Build on the MongoDB, identity, authentication, API-key, session, and role-based authorization foundations implemented in **Brief 1**.

After this phase, administrators must be able to register, edit, enable, disable, remove, reconnect, and inspect upstream MCP servers through backend APIs **without restarting the gateway**.

The gateway must dynamically update its aggregated tool catalog while preserving its existing routing, authorization, failure isolation, reconnection, and Kubernetes network security.

This is **Phase 2 of 3** for Day 4.

### Scope boundaries

| Brief | Responsibility | Status |
|---|---|---|
| **Brief 1** | MongoDB, users, roles, authentication, API keys, dashboard sessions, RBAC | Previously assigned — inspect actual implementation |
| **Brief 2** | Persistent upstream registry, server CRUD, dynamic connections, tool discovery, Secret references, Kubernetes security | **Implement now** |
| **Brief 3** | React dashboard, complete integration, Helm deployment, end-to-end testing and demonstration | Later |

**Important:** Do not assume Brief 1 was implemented exactly as specified. Inspect the actual repository, reuse what exists, and make only the compatibility changes necessary.

The original assignment requires administrators to add, edit, disable, and remove Streamable HTTP MCP servers, aggregate enabled-server tools through one endpoint, protect upstream credentials, and isolate failures. It also requires WooCommerce plus two additional upstreams. Urumi AI Internship Round 1 MCP…

---

# 0. First Inspect the Existing Repository

Before modifying anything, inspect the implementation created during Days 1–3 and Brief 1.

Locate and understand:

### Existing gateway architecture

- Gateway entry point and startup sequence.
- Current `UpstreamRegistry`.
- `ToolAggregator`.
- `AggregatedToolResolver`.
- `McpUpstreamInvoker`.
- Shared `executeTool()` execution boundary.
- `authenticateRequest()`.
- `authorizeTool()`.
- Existing MCP Streamable HTTP transport/session handling.
- Upstream connection establishment.
- Existing tool discovery.
- Existing connection retry/recovery mechanisms.
- Upstream timeout and failure handling.
- Current tool namespace/collision strategy.
- Existing request context and audit hooks.

### Brief 1 implementation

Inspect:

- MongoDB connection module.
- Mongoose models and schemas.
- Persistent `User` model.
- Persistent `ApiKey` model.
- Dashboard session middleware.
- Admin authorization middleware.
- CSRF middleware.
- API route conventions.
- Error handling patterns.
- Existing tests.

### Existing upstream configuration

Locate:

```typescript
getDefaultUpstreams()
```

Identify how the three existing upstream MCP servers are configured:

```text
WooCommerce
Calculator
Time
```

Determine:

- Their current names and IDs.
- Their internal Kubernetes URLs.
- Their transport configuration.
- Their authentication configuration.
- Their tool discovery behavior.
- Their reconnection behavior.
- Their current registration lifecycle.

### Kubernetes configuration

Inspect:

- Helm chart structure.
- Existing namespaces.
- Deployments.
- Services.
- ServiceAccounts.
- RBAC configuration.
- NetworkPolicies.
- Kubernetes Secrets.
- Gateway environment variables.
- WooCommerce MCP server credentials.
- Existing ingress and service exposure.

**Do not assume any file path, method signature, Kubernetes resource name, or chart structure. Adapt to the actual repository.**

Do not rebuild working components unnecessarily.

---

# 1. Persistent Upstream Server Model

Create a Mongoose model for registered MCP upstream servers.

Suggested interface:

```typescript
interface UpstreamServer {
  _id: ObjectId;

  serverId: string;

  name: string;

  url: string;

  transport: "streamable-http";

  enabled: boolean;

  credential: {
    type: "none" | "bearer" | "header";

    secretRef?: {
      name: string;
      namespace: string;
      key: string;
    };

    headerName?: string;
  };

  status: "connected" | "unreachable" | "disabled";

  lastConnectedAt: Date | null;

  lastDiscoveryAt: Date | null;

  lastError: string | null;

  createdAt: Date;

  updatedAt: Date;
}
```

Adapt this interface to existing gateway types.

### Requirements

- Persist upstream registrations in MongoDB.
- Use a unique, stable `serverId`.
- Store display names separately from internal identifiers.
- Validate required fields.
- Store whether the server is enabled.
- Store the MCP transport type.
- Store connection and discovery metadata.
- Preserve creation and update timestamps.
- Use appropriate MongoDB indexes.
- Prevent duplicate server identifiers.
- Prevent accidental duplicate registrations.

### Important distinction

**Persistent configuration and live connection state are different things.**

MongoDB stores the desired server configuration.

The existing `UpstreamRegistry` manages runtime connections and discovered tools.

Do not blindly treat MongoDB's last recorded connection status as authoritative after a gateway restart.

A persisted server marked `connected` must be checked again before the live registry reports it as connected.

Likewise, connection status updates must not accidentally overwrite administrator-controlled configuration.

Prefer keeping desired configuration and observed runtime state logically separate, even if some last-known status metadata is persisted.

---

# 2. Preserve and Extend the Existing UpstreamRegistry

Do not replace the existing `UpstreamRegistry` with an entirely new implementation.

Extend it to support dynamic operations.

The exact method signatures should match the repository's conventions, but the following capabilities must exist:

```typescript
registerUpstream()

updateUpstream()

enableUpstream()

disableUpstream()

removeUpstream()

refreshUpstream()

reconnectUpstream()

getUpstreamStatus()
```

Existing methods should be reused whenever possible.

### Registry responsibilities

The registry must:

1. Register new upstream configurations.
2. Establish MCP client connections.
3. Discover available tools.
4. Cache discovered tools.
5. Track connection status.
6. Disable active upstreams.
7. Close upstream connections.
8. Remove upstreams.
9. Handle configuration updates.
10. Reconnect failed upstreams.
11. Notify or refresh the aggregated tool catalog.

### Critical architecture rule

The registry must remain the authoritative runtime source for enabled, callable upstreams.

Do not modify MongoDB and assume the gateway automatically updates.

Every successful configuration change must reconcile the live registry.

The intended relationship is:

```text
MongoDB
(Persistent Upstream Configuration)
        |
        v
Upstream Registry
(Runtime Server Connections)
        |
        v
ToolAggregator
(Available Tool Catalog)
        |
        v
AggregatedToolResolver
(Tool-to-Upstream Mapping)
        |
        v
McpUpstreamInvoker
(Upstream Tool Execution)
```

Maintain the existing architecture.

---

# 3. Restore Upstreams From MongoDB on Startup

Replace the current static-only startup flow.

The gateway must restore registered upstream servers from MongoDB when it starts.

### Required startup sequence

```text
Gateway Startup
       |
       v
Connect to MongoDB
       |
       v
Load UpstreamServer Documents
       |
       v
Validate Configurations
       |
       v
Initialize UpstreamRegistry
       |
       v
Register Enabled Servers
       |
       v
Connect to Upstreams
       |
       v
Run MCP tools/list
       |
       v
Populate ToolAggregator
       |
       v
Gateway Ready
```

### Requirements

- Load registered upstreams from MongoDB.
- Skip disabled servers during connection establishment.
- Register enabled servers using existing registry logic.
- Attempt connections independently.
- Discover tools from healthy upstreams.
- Populate the aggregated tool catalog.
- Restore stable server IDs.
- Preserve existing tool names and namespace behavior.
- Avoid duplicate MCP client instances.
- Avoid duplicate tool registrations.

### Failure isolation

If one upstream fails during restoration:

- Mark it unreachable.
- Store or expose a sanitized error.
- Continue restoring the remaining upstreams.
- Do not fail the entire gateway startup solely because one upstream is unreachable.
- Preserve existing retry/reconnection behavior.

Example:

```text
WooCommerce  → Connected
Calculator   → Connected
Time         → Unreachable
```

The gateway must still expose tools from WooCommerce and Calculator.

**A failed upstream must not prevent healthy upstreams from working.**

Database unavailability is different: do not silently return to static upstream configuration or insecure authentication when MongoDB cannot be reached.

---

# 4. Migrate the Existing Three Upstreams

The repository already has three working upstream MCP servers:

```text
WooCommerce
Calculator
Time
```

Migrate these existing registrations into MongoDB.

Do not create duplicates.

### Migration requirements

Implement an idempotent migration or seed operation.

It should:

1. Inspect the existing MongoDB upstream records.
2. Inspect the current static upstream definitions.
3. Register missing default upstreams.
4. Preserve stable identifiers.
5. Preserve existing internal URLs.
6. Preserve existing tool naming behavior.
7. Preserve existing credential references.
8. Avoid overwriting administrator edits.
9. Avoid re-enabling servers previously disabled by an administrator.
10. Avoid recreating servers previously removed by an administrator.

### Important deletion requirement

A simplistic startup seed such as:

```typescript
if (!serverExists) {
  await createDefaultServer();
}
```

is insufficient.

If an administrator intentionally removes the Calculator server, the next gateway restart must not recreate it.

Use one of the following approaches:

- An explicit one-time migration marker.
- A versioned migration collection.
- Another reliable idempotent migration mechanism.

Prefer a versioned migration marker persisted in MongoDB.

Example:

```text
migration:
  id: seed-default-upstreams-v1
  completedAt: ...
```

The first migration registers missing defaults.

Subsequent restarts restore only what is actually registered in MongoDB.

### Important

After migration, `getDefaultUpstreams()` must no longer be the authoritative runtime configuration source.

It may remain available for initial migration or backward-compatible tooling.

Do not use it to silently recreate deleted registrations.

---

# 5. Dynamic Server Registration

Implement the runtime flow for adding a new upstream MCP server.

### Required behavior

When an administrator adds a server:

```text
Admin API Request
       |
       v
Validate Authentication
       |
       v
Verify Admin Role
       |
       v
Validate Server Configuration
       |
       v
Validate URL / Destination
       |
       v
Persist Configuration in MongoDB
       |
       v
Register With UpstreamRegistry
       |
       v
Connect MCP Client
       |
       v
Run tools/list
       |
       v
Cache Discovered Tools
       |
       v
Refresh Aggregated Tool Catalog
       |
       v
Return Sanitized Server Status
```

### Requirements

- Support Streamable HTTP upstream MCP servers.
- Validate configuration before registration.
- Assign a stable server identifier.
- Persist configuration before attempting connection.
- Attempt to connect using existing MCP client infrastructure.
- Perform `tools/list` discovery.
- Cache discovered tool definitions.
- Expose discovered tools through the gateway.
- Return sanitized connection results.
- Avoid restarting the gateway.

### Connection failure behavior

If connection or discovery fails:

- Keep the configuration persisted.
- Mark the upstream unreachable.
- Preserve its enabled/disabled setting.
- Record sanitized failure metadata.
- Return an informative but safe API response.
- Keep healthy upstreams unaffected.

Do not roll back the entire registration solely because the upstream is temporarily offline.

This allows the administrator to reconnect it later.

---

# 6. Updating an Existing Upstream

Implement dynamic upstream updates.

Supported editable fields should include:

- Display name.
- URL.
- Credential reference.
- Optional authentication header configuration.
- Enabled state.

Stable server identifiers should not change during ordinary edits.

### URL updates

If the upstream URL changes:

1. Validate the new URL.
2. Validate destination restrictions.
3. Persist the updated configuration.
4. Prevent new executions from using the stale connection.
5. Close the old MCP connection.
6. Remove or invalidate its previous discovered tools.
7. Connect to the new URL.
8. Run fresh tool discovery.
9. Update the aggregated catalog.
10. Record the new status.

If connection fails, retain the new configuration and mark it unreachable.

Do not silently continue routing calls to the previous URL.

### Credential updates

If a credential reference changes:

- Stop using the old credential.
- Close the previous connection.
- Resolve the new reference securely.
- Reconnect.
- Rediscover tools when connected.
- Update runtime status.

### Concurrency

Prevent overlapping registry operations from corrupting state.

For example:

```text
Admin A: Update server URL
Admin B: Disable same server
```

These operations must not create duplicate connections or incorrectly reactivate a disabled upstream.

Use per-server synchronization, generations, revision checks, or another straightforward approach compatible with the current architecture.

Avoid unnecessary distributed infrastructure.

---

# 7. Enable and Disable Upstreams

Implement:

```typescript
enableUpstream(serverId)

disableUpstream(serverId)
```

### Disable behavior

When an administrator disables a server:

1. Persist `enabled = false`.
2. Immediately prevent new tool invocations.
3. Remove its tools from the active aggregated catalog.
4. Invalidate resolver mappings associated with that server.
5. Close its active MCP connection.
6. Update its runtime status to `disabled`.

Expected behavior:

```text
Before:

WooCommerce → 5 tools
Calculator  → 4 tools
Time        → 2 tools

Aggregated catalog: 11 tools
```

```text
Disable Calculator
```

```text
After:

WooCommerce → 5 tools
Calculator  → Disabled
Time        → 2 tools

Aggregated catalog: 7 tools
```

Tool counts are illustrative; use whatever the real upstreams expose.

### Critical security requirement

**Already-connected MCP clients must not be able to execute tools from disabled servers.**

Do not rely exclusively on removing tools from `tools/list`.

A client may retain an old tool definition.

The execution path must verify the upstream's current enabled/registered state before invocation.

For example:

```text
Client remembers Calculator tool
           |
           v
Client sends tools/call
           |
           v
authenticateRequest()
           |
           v
authorizeTool()
           |
           v
AggregatedToolResolver
           |
           v
Check Current Upstream State
           |
           v
Calculator Disabled
           |
           v
Reject Without Invocation
```

Do not invoke the upstream if it has been disabled.

### Enable behavior

When enabled:

1. Persist `enabled = true`.
2. Register or activate the upstream.
3. Attempt to establish a connection.
4. Perform tool discovery.
5. Cache discovered tools.
6. Publish discovered tools to the aggregated catalog.
7. Update connection status.

If the connection fails, preserve `enabled = true` but report `unreachable`.

An enabled upstream is not automatically a connected upstream.

---

# 8. Remove Upstreams Safely

Implement:

```typescript
removeUpstream(serverId)
```

Removal must affect both persistence and runtime behavior.

### Required sequence

1. Verify admin authorization.
2. Locate the registered server.
3. Immediately prevent further tool invocations.
4. Remove the server's tools from the active catalog.
5. Invalidate its resolver mappings.
6. Close its MCP connection.
7. Remove or tombstone the persistent registration.
8. Confirm the server no longer appears as active.

### Important

Removing an upstream must not:

- Affect other upstream connections.
- Delete unrelated Kubernetes Secrets.
- Expose credentials.
- Break the gateway transport.
- Restart the gateway.
- Allow cached client tools to continue executing.

If a tombstone is used, ensure the server does not reappear during startup migration.

Do not automatically delete Kubernetes Secrets merely because a server reference is removed.

Secret lifecycle ownership must be explicit.

### Error handling

If the server does not exist, return an appropriate `404`.

If cleanup partially fails, preserve enough state to retry safely.

Make removal idempotent where practical.

---

# 9. Dynamic Tool Discovery and Catalog Management

Reuse the existing:

```typescript
ToolAggregator
AggregatedToolResolver
McpUpstreamInvoker
```

Do not replace their core responsibilities.

### Tool discovery

Whenever an upstream is newly connected or successfully refreshed:

- Call MCP `tools/list`.
- Validate the returned tool definitions.
- Preserve names, descriptions, and input schemas.
- Apply the existing collision-handling scheme.
- Cache discovered tools.
- Update the aggregated tool catalog.

### Catalog requirements

Tools must be scoped to their registered upstream.

For example:

```text
woocommerce__list_products

woocommerce__create_product

calculator__add

time__get_current_time
```

These are illustrative. Preserve the existing naming scheme rather than introducing a conflicting one.

### Atomic catalog updates

Avoid partially updated catalogs.

A server's tools should be replaced as a coherent set.

Prefer a snapshot or generation-based mechanism:

```text
Old Tool Snapshot
       |
       v
Discover New Tools
       |
       v
Validate Tool Definitions
       |
       v
Atomically Replace Server Tool Set
       |
       v
Publish Updated Catalog
```

Do not append duplicate tools every time discovery runs.

### Failed discovery

If a newly added server cannot complete discovery:

- Mark it unreachable.
- Publish no callable tools for that server.
- Do not affect tools belonging to other servers.

If an existing server fails reconnection or discovery:

- Reflect its unreachable status.
- Ensure stale cached tools cannot bypass connection/availability checks.
- Preserve existing failure-recovery behavior.
- Keep healthy upstreams working.

### Authorization integration

Dynamic tool discovery must remain compatible with Brief 1's authorization.

Both:

```text
tools/list
```

and:

```text
tools/call
```

must continue applying `authorizeTool()`.

Adding a new upstream must not bypass role restrictions.

Never expose every newly discovered tool to every member by default if the existing policy restricts it.

---

# 10. Server Status and Health Metadata

Implement status reporting for every registered upstream.

Required states:

```typescript
type UpstreamStatus =
  | "connected"
  | "unreachable"
  | "disabled";
```

Optionally support an internal transitional state such as `connecting`, if it improves clarity.

### Metadata

Track:

```typescript
{
  status: "connected" | "unreachable" | "disabled";

  lastConnectedAt: Date | null;

  lastDiscoveryAt: Date | null;

  lastError: string | null;
}
```

### Definitions

**Connected**

The gateway successfully established an MCP connection and completed tool discovery.

**Unreachable**

The upstream is enabled but could not establish or maintain a usable connection, or discovery failed.

**Disabled**

The administrator intentionally disabled the upstream.

### Sanitized errors

Do not expose:

- Bearer tokens.
- Authorization headers.
- Kubernetes Secret values.
- Internal stack traces.
- Sensitive connection details.
- Database credentials.
- Raw upstream response headers.

Return safe messages such as:

```text
Connection timed out
```

```text
Upstream authentication failed
```

```text
MCP tool discovery failed
```

```text
Connection unavailable
```

The dashboard should receive useful troubleshooting information without revealing secrets or unnecessary network details.

---

# 11. Manual Refresh and Reconnection

Implement a manual operation for refreshing an upstream.

Suggested method:

```typescript
refreshUpstream(serverId)
```

This must:

1. Verify the upstream exists.
2. Verify it is enabled.
3. Close a stale connection if necessary.
4. Revalidate its destination.
5. Reconnect using current credentials.
6. Perform fresh `tools/list` discovery.
7. Replace its cached tools.
8. Update its connection/discovery timestamps.
9. Update the aggregated catalog.

### Requirements

- Admin-only operation.
- No gateway restart.
- Do not affect healthy upstreams.
- Prevent overlapping reconnect operations.
- Return sanitized status information.
- Respect existing connection and discovery timeouts.

Preserve the existing automatic reconnection logic from Day 3.

Manual refresh must complement it, not replace it.

---

# 12. Admin Server Management APIs

Implement the backend endpoints needed by the React dashboard in Brief 3.

Use Brief 1's existing session authentication, CSRF protection, and role middleware.

Suggested endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/admin/servers` | List registered upstreams |
| GET | `/api/admin/servers/:serverId` | Get server details |
| POST | `/api/admin/servers` | Register upstream |
| PATCH | `/api/admin/servers/:serverId` | Edit upstream |
| POST | `/api/admin/servers/:serverId/enable` | Enable upstream |
| POST | `/api/admin/servers/:serverId/disable` | Disable upstream |
| DELETE | `/api/admin/servers/:serverId` | Remove upstream |
| POST | `/api/admin/servers/:serverId/refresh` | Reconnect and rediscover |
| GET | `/api/admin/servers/:serverId/tools` | List discovered tools |

Follow existing endpoint naming conventions if they differ.

### Authorization

Every endpoint must:

- Require a valid dashboard session.
- Verify the user is an admin.
- Enforce CSRF protection on state-changing operations.
- Validate input.
- Return safe API responses.

**Do not rely on the future React dashboard to enforce permissions.**

Members must receive `403 Forbidden` when attempting these operations.

### Server list response

Example:

```json
[
  {
    "id": "woocommerce",
    "name": "WooCommerce",
    "enabled": true,
    "status": "connected",
    "toolCount": 5,
    "lastConnectedAt": "2026-10-15T10:00:00.000Z",
    "lastDiscoveryAt": "2026-10-15T10:00:01.000Z",
    "lastError": null
  },
  {
    "id": "calculator",
    "name": "Calculator",
    "enabled": false,
    "status": "disabled",
    "toolCount": 0,
    "lastConnectedAt": null,
    "lastDiscoveryAt": null,
    "lastError": null
  }
]
```

### Server details response

Include:

- ID.
- Name.
- URL where safe and appropriate for the authenticated administrator.
- Transport.
- Enabled state.
- Connection status.
- Authentication type.
- Whether a credential reference is configured.
- Last successful connection.
- Last discovery.
- Sanitized error.
- Discovered tool metadata.

Never include Secret values or resolved authorization headers.

### Tools endpoint

Return discovered tool definitions including:

```json
[
  {
    "name": "woocommerce__list_products",
    "description": "List WooCommerce products",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  }
]
```

Return the actual discovered schemas rather than hardcoded placeholders.

Ensure all responses are safely serializable.

Do not expose credentials embedded in tool metadata.

Treat descriptions and schemas from upstreams as untrusted content.

---

# 13. Kubernetes Secret Reference Management

The assignment requires upstream credentials to remain server-side and never reach the browser or MCP client. Kubernetes Secrets must be used for sensitive configuration. Urumi AI Internship Round 1 MCP…

Implement secure credential-reference handling.

### Persistent representation

MongoDB must store only references to Kubernetes Secrets.

Example:

```json
{
  "credential": {
    "type": "bearer",
    "secretRef": {
      "namespace": "gateway",
      "name": "woocommerce-mcp-credentials",
      "key": "token"
    }
  }
}
```

Do not store the resolved credential value in MongoDB.

### Supported authentication modes

Support:

```typescript
type UpstreamAuthType =
  | "none"
  | "bearer"
  | "header";
```

For bearer authentication:

```http
Authorization: Bearer <resolved-secret>
```

For custom headers:

```http
X-API-Key: <resolved-secret>
```

Use the existing MCP client authentication mechanism wherever possible.

### Secret resolution

Implement a dedicated credential resolver.

Suggested responsibility:

```typescript
resolveUpstreamCredential(secretRef)
```

It should:

1. Validate the Secret reference.
2. Verify the namespace is authorized.
3. Read the specific Secret and key.
4. Resolve the value only within backend memory.
5. Apply the credential to the upstream MCP connection.
6. Never expose the value in API responses or logs.

### Security requirements

- Do not accept arbitrary Kubernetes namespaces.
- Do not allow arbitrary Secret names without policy checks.
- Do not allow the gateway to read Secrets belonging to unrelated applications.
- Do not return Secret values to dashboard users.
- Do not expose resolved credentials in error messages.
- Never forward the end user's gateway API key to upstream servers.
- Avoid persisting resolved credentials in connection status records.

### Credential input from administrators

The assignment permits an administrator to register a server with a URL and optional static credential.

Support existing Secret references as the primary mechanism.

If supporting administrator-supplied credentials:

- Accept them only through authenticated, CSRF-protected, HTTPS dashboard APIs.
- Create or update a tightly scoped, gateway-managed Kubernetes Secret.
- Persist only its reference.
- Never return the plaintext credential after creation.
- Never echo it in logs or validation errors.

Do not accidentally turn the server management API into a general-purpose Kubernetes Secret editor.

---

# 14. Kubernetes RBAC and ServiceAccount Security

Inspect the existing gateway ServiceAccount and RBAC resources.

Implement the minimum permissions required for credential resolution.

### Requirements

- Use a dedicated gateway ServiceAccount.
- Scope access to the gateway's approved Secret namespace.
- Prefer named Secret access over broad namespace-wide access.
- Grant only the operations actually needed.
- Avoid cluster-wide Secret read permissions.
- Never grant access to unrelated application namespaces.
- Do not use the default ServiceAccount for privileged Kubernetes API operations.

### Preferred RBAC

For existing Secret references, prefer:

```yaml
verbs:
  - get
```

restricted to approved Secret names wherever feasible.

Do not grant:

```yaml
verbs:
  - list
  - watch
  - delete
```

unless there is a specific demonstrated requirement.

### Dynamic credential creation

If the implementation supports dynamically creating gateway-managed Secrets, Kubernetes RBAC must account for this carefully.

Kubernetes RBAC cannot generally restrict `create` to particular Secret names using `resourceNames`.

Do not introduce broad Secret-creation privileges into the gateway without an explicit design.

Prefer one of these approaches:

1. Reference pre-provisioned Secrets for the minimal Day 4 implementation.
2. Use a narrowly scoped credential-management component or ServiceAccount for managed Secret creation.
3. Implement tightly validated gateway-managed Secret operations only if needed to satisfy the existing architecture.

Choose the simplest secure approach compatible with the assignment.

Document the tradeoff.

**Do not claim name-scoped RBAC protects Secret creation if the actual permission is namespace-wide.**

---

# 15. Upstream URL Validation and SSRF Protection

An administrator can register upstream URLs, which creates a potential SSRF risk.

The gateway must validate destinations before connecting.

### Supported transport

Accept Streamable HTTP endpoints using:

```text
http://
https://
```

Reject unsupported schemes such as:

```text
file://
ftp://
gopher://
javascript:
```

### URL validation

Reject:

- Malformed URLs.
- URLs containing embedded usernames/passwords.
- URLs with disallowed ports.
- Loopback addresses unless explicitly permitted for a controlled local-development configuration.
- Cloud metadata endpoints.
- Unauthorized private-network destinations.
- Link-local addresses.
- Kubernetes API endpoints.
- Internal administrative services.
- Unauthorized cross-namespace destinations.

### Important Kubernetes consideration

The existing WooCommerce, Calculator, and Time servers may use internal Kubernetes service addresses.

Therefore, **do not simply block every private IP or `.svc.cluster.local` destination**.

Instead, implement an explicit allowlist for approved internal upstream destinations.

For example:

```text
Approved MCP service namespaces
Approved service DNS patterns
Approved endpoint ports
Approved external domains, if configured
```

The actual allowlist must match the existing Kubernetes deployment.

Do not assume arbitrary internal addresses are safe.

### DNS rebinding and redirects

Where practical:

- Validate resolved IP addresses.
- Restrict redirect behavior.
- Revalidate destinations on reconnect.
- Avoid blindly following redirects to unauthorized addresses.
- Ensure the actual connection destination follows the configured destination policy.

Be explicit about any SSRF protection that cannot be fully enforced at the application layer.

### Important

NetworkPolicies must remain the final network-level boundary.

Application-level URL validation is an additional defense, not a replacement.

---

# 16. Preserve Kubernetes Network Isolation

Inspect existing NetworkPolicies.

Ensure dynamically registered upstreams do not bypass existing Kubernetes isolation.

The gateway must not gain unrestricted access to the cluster simply because server URLs are now database-controlled.

### Requirements

Preserve:

- WooCommerce MCP server internal-only exposure.
- Gateway-to-upstream communication.
- Existing namespace isolation.
- Existing ingress restrictions.
- Existing egress restrictions.

Allow:

- Gateway → MongoDB.
- Gateway → approved upstream MCP services.
- Gateway → Kubernetes API, only if required for Secret resolution.

Deny:

- Arbitrary access to other application databases.
- Arbitrary access to internal services.
- Unauthorized cross-namespace connections.
- Direct external access to internal MCP upstreams.

### Dynamic registration constraints

A newly registered upstream should be usable only if its destination is permitted by the deployment's network policy.

Do not automatically weaken cluster-wide NetworkPolicies to make arbitrary new URLs work.

If a new server requires an additional allowed destination, document the policy change required.

### MongoDB NetworkPolicy

Ensure the gateway can communicate with MongoDB while maintaining existing isolation.

Do not expose MongoDB through public ingress.

Full MongoDB persistent Helm deployment will be completed in Brief 3.

---

# 17. Dynamic Registry and Existing MCP Sessions

This section is critical.

Existing MCP clients may remain connected while administrators modify upstream registrations.

The system must behave correctly without requiring the clients to reconnect.

### Scenario A — Add upstream

1. Admin registers a new MCP server.
2. Gateway connects.
3. Tool discovery succeeds.
4. Aggregated catalog updates.
5. Existing clients receive the new tools on their next `tools/list`.

If the SDK supports tool-list-change notifications and they can be integrated safely, use them.

Do not make notifications a prerequisite for correctness.

### Scenario B — Disable upstream

1. Admin disables an upstream.
2. Registry blocks further invocation.
3. Tools disappear from the next `tools/list`.
4. Existing clients attempting old tools receive a clear rejection.
5. The disabled upstream receives no new calls.

### Scenario C — Remove upstream

1. Admin removes an upstream.
2. Registry invalidates its runtime state.
3. Its tools disappear.
4. Old tool names become unresolvable or unavailable.
5. Other upstreams continue functioning.

### Scenario D — Update URL

1. Admin edits upstream URL.
2. Previous connection is retired.
3. Stale tools are invalidated.
4. New connection is established.
5. Fresh discovery updates the catalog.

### Scenario E — Revoked MCP key

Brief 1 already implemented database-backed authentication.

Ensure dynamic registry changes do not interfere with it.

A revoked key must still fail on its next request, including on existing MCP sessions.

### Critical execution rule

Runtime availability must be checked at invocation time.

A previously resolved tool mapping must not remain executable after its upstream is disabled or removed.

If the implementation has a race between resolution and invocation, ensure a disable/remove operation creates a clear barrier preventing new invocations from starting after the operation is committed.

Already-running upstream calls may be allowed to complete, but new invocations must be rejected.

---

# 18. Failure Handling and Reconnection

Preserve the Day 3 gateway's failure isolation.

### Requirements

A slow or dead upstream must not block:

- `tools/list` for healthy servers.
- Tool execution on healthy servers.
- Dashboard server listing.
- Server CRUD for unrelated servers.
- Authentication.
- User and API-key management.

### Timeouts

Use existing timeout configuration where available.

Apply bounded timeouts for:

- Initial connection.
- MCP initialization.
- Tool discovery.
- Tool invocation.
- Reconnection attempts.

Do not use unbounded waits.

### Failure recovery

When an upstream becomes unreachable:

1. Update runtime status.
2. Record sanitized failure information.
3. Keep unrelated upstreams healthy.
4. Retry according to existing recovery policy.
5. Rediscover tools on successful reconnection.
6. Atomically refresh the catalog.

Avoid uncontrolled retry loops.

Use bounded exponential backoff where appropriate.

### Restart recovery

After the gateway restarts:

- MongoDB registrations must be restored.
- Disabled servers must remain disabled.
- Removed servers must remain removed.
- Enabled servers must reconnect.
- Discovered tools must be rebuilt.
- Credentials must be re-resolved securely.
- Temporary connection failures must not corrupt persistent configuration.

---

# 19. Concurrency and Consistency

Introduce a straightforward lifecycle coordination mechanism.

Avoid overengineering, but handle concurrent changes correctly.

### Problems to prevent

- Duplicate MCP connections.
- Duplicate discovered tools.
- A disabled server being re-enabled by a delayed reconnect.
- A removed server reappearing after a pending discovery completes.
- A stale URL remaining active after an update.
- A connection failure overwriting a newer healthy status.
- An older operation overwriting a newer configuration.

### Recommended approach

Use:

- Stable server IDs.
- Per-server operation serialization.
- Configuration revision numbers or generation tokens.
- Atomic catalog replacement.
- Reconciliation between MongoDB desired state and runtime registry.

For example:

```text
Server Revision 7
       |
       v
Reconnect begins
       |
       v
Admin updates server
       |
       v
Server Revision 8
       |
       v
Old reconnect completes
       |
       v
Revision mismatch
       |
       v
Discard stale result
```

The older reconnect must not overwrite revision 8.

### Deployment scope

The minimum target is one gateway replica.

Do not build a distributed registry or introduce Redis solely for multi-replica coordination.

However, document that in-memory registry updates require additional coordination if multiple gateway replicas are deployed.

---

# 20. Tests

Add automated tests using the existing test framework.

Test the database model, management APIs, registry lifecycle, tool catalog, and integration with authorization.

## A. Persistence tests

Verify:

1. Upstream configurations persist in MongoDB.
2. Stable server IDs remain unique.
3. Enabled state persists.
4. Connection metadata persists appropriately.
5. Credentials are stored only as Secret references.
6. Invalid configurations are rejected.
7. Duplicate registrations are rejected.
8. Restart restores registered upstreams.
9. Disabled upstreams remain disabled after restart.
10. Removed upstreams remain removed after restart.

## B. Migration tests

Verify:

1. WooCommerce is seeded.
2. Calculator is seeded.
3. Time is seeded.
4. Re-running migration does not create duplicates.
5. Administrator modifications are preserved.
6. Disabled defaults are not re-enabled.
7. Removed defaults are not recreated.
8. Existing tool naming behavior is preserved.

## C. Dynamic registry tests

Verify:

1. New upstream registration creates a runtime entry.
2. Successful connection performs discovery.
3. Discovered tools enter the aggregated catalog.
4. Updating a URL closes the old connection.
5. Updating credentials reconnects correctly.
6. Disabling closes the connection.
7. Disabling removes tools from the catalog.
8. Enabling reconnects.
9. Removing deletes runtime mappings.
10. Removing does not affect unrelated upstreams.
11. Manual refresh performs fresh discovery.
12. Repeated discovery does not create duplicate tools.
13. Concurrent updates do not corrupt runtime state.

## D. MCP behavior tests

Verify:

1. `tools/list` reflects newly added servers.
2. `tools/list` excludes disabled servers.
3. `tools/list` excludes removed servers.
4. Existing clients cannot invoke disabled tools.
5. Existing clients cannot invoke removed tools.
6. Stale tool names are rejected.
7. Tool-name collisions remain handled correctly.
8. Role authorization continues to apply.
9. Tool invocations still use the existing shared execution path.
10. Revoked API keys are rejected.

## E. Failure tests

Verify:

1. An unreachable server does not break healthy servers.
2. Connection timeouts are bounded.
3. Discovery failures are isolated.
4. Failed reconnection updates status.
5. Successful reconnection restores tools.
6. Connection failures produce sanitized errors.
7. Restart with one dead upstream still restores healthy upstreams.
8. Stale reconnect operations cannot reactivate disabled servers.

## F. Security tests

Verify:

1. Members cannot access server management endpoints.
2. Admins can manage servers.
3. State-changing admin APIs require CSRF protection.
4. MongoDB stores no raw upstream credentials.
5. API responses never expose Secret values.
6. Invalid Secret references are rejected.
7. Unauthorized namespaces cannot be referenced.
8. Unsupported URL schemes are rejected.
9. Cloud metadata endpoints are blocked.
10. Unauthorized internal destinations are blocked.
11. Approved Kubernetes MCP services remain accessible.
12. Browser sessions cannot bypass MCP bearer authentication.
13. MCP bearer API keys cannot bypass dashboard admin authorization.

Use mock MCP servers to simulate connection failures, discovery failures, slow responses, and tool changes.

Where Kubernetes is unavailable during testing, use mocked Kubernetes API interactions and clearly identify what still requires cluster verification.

---

# 21. Preserve Existing Gateway Functionality

Do not regress Days 1–3 or Brief 1.

Preserve:

- MongoDB-backed users.
- Password hashing.
- Dashboard authentication.
- Session persistence.
- CSRF protection.
- Persistent API keys.
- Immediate key revocation.
- Admin/member authorization.
- Authenticated request context.
- Existing audit hooks.
- MCP Streamable HTTP behavior.
- Existing `authenticateRequest()`.
- Existing `authorizeTool()`.
- Shared `executeTool()`.
- `ToolAggregator`.
- `AggregatedToolResolver`.
- `McpUpstreamInvoker`.
- Tool collision handling.
- Upstream timeout handling.
- Failure isolation.
- Recovery/reconnection.
- Working WooCommerce tools.
- Working Calculator tools.
- Working Time tools.

**Do not rewrite the execution pipeline.**

The goal is to replace static upstream configuration with persistent dynamic management, not rebuild the gateway.

---

# 22. Implementation Constraints

Follow these rules strictly:

1. **Inspect actual Brief 1 code first.** Do not recreate users, sessions, API keys, or authentication.

2. **Build on existing registry abstractions.** Extend the existing `UpstreamRegistry` instead of replacing it.

3. **Persist desired configuration in MongoDB.** Runtime connection state belongs to the registry.

4. **Do not use static defaults as runtime truth.** `getDefaultUpstreams()` must become migration-only after initial setup.

5. **Make migration idempotent.** Removed defaults must stay removed.

6. **Update the live registry immediately after CRUD.** Do not require a gateway restart.

7. **Synchronize the aggregated catalog.** Tools must appear and disappear as upstream lifecycle changes.

8. **Enforce runtime availability during invocation.** Cached tool names must not bypass disable/remove.

9. **Preserve admin/member authorization.** Members must never access server management APIs.

10. **Keep credentials server-side.** MongoDB must store only Secret references.

11. **Apply least-privilege Kubernetes RBAC.** Do not grant cluster-wide Secret access.

12. **Validate URLs and destinations.** Prevent SSRF without blocking legitimate approved Kubernetes services.

13. **Preserve NetworkPolicies.** Dynamic registration must not create unrestricted cluster access.

14. **Isolate upstream failures.** One dead upstream must not break another.

15. **Do not build the React dashboard yet.** Brief 3 handles the frontend.

16. **Do not rebuild MongoDB deployment unnecessarily.** Complete Helm/deployment integration in Brief 3.

17. **Do not implement the complete audit dashboard yet.** Preserve the audit context and hooks.

18. **Do not attempt optional multi-store provisioning.** Focus on the mandatory assignment.

19. **Keep the implementation understandable.** Prefer practical, reviewable code over excessive abstractions.

20. **Run checks and tests.** Do not claim success without verification.

---

# 23. Definition of Done

Brief 2 is complete only when:

### Persistence

- [ ] `UpstreamServer` Mongoose model exists.
- [ ] Server configurations persist in MongoDB.
- [ ] Unique, stable server IDs are enforced.
- [ ] Existing WooCommerce, Calculator, and Time registrations are migrated.
- [ ] Migration is idempotent.
- [ ] Removed defaults do not reappear.
- [ ] Disabled state persists.
- [ ] Registered upstreams restore after a gateway restart.

### Runtime registry

- [ ] Existing `UpstreamRegistry` supports dynamic registration.
- [ ] Server update is supported.
- [ ] Server enable is supported.
- [ ] Server disable is supported.
- [ ] Server removal is supported.
- [ ] Manual refresh/reconnect is supported.
- [ ] Connections close when servers are disabled or removed.
- [ ] URL changes retire old connections.
- [ ] Failed reconnections do not affect healthy servers.
- [ ] Concurrent operations do not corrupt registry state.

### Tool aggregation

- [ ] Newly added servers run MCP `tools/list`.
- [ ] Discovered tools are cached.
- [ ] Aggregated tool catalog updates dynamically.
- [ ] Disabled upstream tools disappear.
- [ ] Removed upstream tools disappear.
- [ ] Tool definitions do not duplicate.
- [ ] Existing clients cannot invoke disabled tools.
- [ ] Existing clients cannot invoke removed tools.
- [ ] Existing namespace/collision behavior remains intact.
- [ ] Role authorization remains enforced for `tools/list` and `tools/call`.

### Administration

- [ ] Admin server CRUD endpoints exist.
- [ ] Server status endpoint exists.
- [ ] Server tool-discovery endpoint exists.
- [ ] Manual reconnect endpoint exists.
- [ ] Members are blocked from admin APIs.
- [ ] CSRF protection applies to state-changing operations.
- [ ] Server API responses contain no credentials.

### Kubernetes security

- [ ] MongoDB stores only Kubernetes Secret references.
- [ ] Upstream credentials resolve securely.
- [ ] Kubernetes RBAC is least-privilege.
- [ ] Unauthorized Secret access is prevented.
- [ ] Upstream URL validation is implemented.
- [ ] SSRF protections are implemented.
- [ ] Approved internal MCP service URLs still work.
- [ ] Existing NetworkPolicy isolation is preserved.
- [ ] Gateway-to-MongoDB communication is permitted without exposing MongoDB publicly.

### Regression verification

- [ ] Brief 1 authentication still works.
- [ ] Revoked API keys still fail.
- [ ] Dashboard sessions still work.
- [ ] Existing WooCommerce tools still work.
- [ ] Existing Calculator tools still work.
- [ ] Existing Time tools still work.
- [ ] Gateway startup and restart recovery work.
- [ ] Existing upstream failure isolation works.
- [ ] Automated tests pass.

---

# 24. Expected Codex Output

Implement this phase directly in the existing repository.

After implementation, provide the following.

### A. Files changed

List created and modified files.

Briefly explain their purpose.

### B. Architecture summary

Explain:

- Persistent upstream configuration.
- Startup migration.
- Runtime registry reconciliation.
- Dynamic connection management.
- Tool discovery and caching.
- Aggregated catalog synchronization.
- Connection failure handling.
- Secret reference resolution.
- Kubernetes security boundaries.

### C. API documentation

Document every server management endpoint.

Include sample requests and sanitized responses.

### D. Migration behavior

Explain exactly how WooCommerce, Calculator, and Time are registered in MongoDB.

Show why repeated gateway restarts do not create duplicate registrations.

Explain why deleted servers do not reappear.

### E. Verification results

Run relevant:

```bash
npm test
npm run build
npm run typecheck
```

Use the repository's actual commands.

Also perform appropriate integration checks.

Clearly distinguish:

- Passed checks.
- Failed checks.
- Tests not executed.
- Checks requiring a live Kubernetes cluster.

### F. Manual testing instructions

Provide exact commands and API requests to demonstrate:

1. Start the gateway with MongoDB.
2. Confirm all three existing upstreams appear.
3. List discovered tools.
4. Register a new MCP server.
5. Confirm its tools appear in gateway `tools/list`.
6. Disable the server.
7. Confirm its tools disappear.
8. Attempt to invoke a disabled tool using a previously connected MCP client.
9. Verify invocation is rejected.
10. Re-enable the server.
11. Confirm its tools return.
12. Update the server URL.
13. Confirm reconnection and rediscovery.
14. Simulate an unreachable server.
15. Confirm healthy upstreams still work.
16. Remove the server.
17. Restart the gateway.
18. Confirm removed servers remain removed.
19. Verify member access to admin endpoints is denied.
20. Verify credentials never appear in API responses.

### G. Remaining work

Clearly identify everything left for Brief 3.

Expected remaining responsibilities include:

- Complete React dashboard.
- Login and logout UI.
- Role-based navigation.
- Member self-service API-key screens.
- One-time raw API-key display and copy button.
- API-key metadata and revocation UI.
- Admin user/member management UI.
- Server list and details UI.
- Add/edit/enable/disable/remove server UI.
- Tool schema display.
- Server connection status and error display.
- Loading, empty, success, and error states.
- Final Docker and Helm integration.
- Persistent MongoDB Kubernetes deployment.
- Final ServiceAccount/RBAC and NetworkPolicy integration and verification.
- Complete end-to-end validation with two users.
- Documentation of final setup and deployment.

Do not implement these prematurely unless a minimal backend compatibility adjustment is required.

---

## Final Instruction to Codex

**Implement Brief 2 as a focused extension of the existing gateway, not as a rewrite.**

By the end of this phase:

- MongoDB must be the persistent source of truth for registered upstream configurations.
- Administrators must be able to dynamically manage upstream MCP servers through authenticated backend APIs.
- The existing `UpstreamRegistry` must reflect those changes without restarting the gateway.
- Tool discovery and aggregation must update correctly.
- Disabled and removed upstream tools must become inaccessible immediately.
- Kubernetes credentials must remain protected through Secret references and narrowly scoped permissions.
- Existing authentication, authorization, MCP routing, and failure recovery must continue working.

**The key milestone is that upstream server registration is no longer hardcoded or restart-dependent. The gateway can dynamically manage its MCP upstreams while preserving the security and reliability achieved in Days 1–3 and Brief 1.**