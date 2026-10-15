# Persistent upstream registrations (#17, #18)

MongoDB is the source of desired upstream configuration. The existing registry owns observed status, MCP clients, discovered tools, and connection/discovery timestamps in memory. These observations are never written over desired configuration and are rebuilt on every restart. Tool execution still uses `executeTool()`, existing role policies, and per-request gateway API-key authentication.

## Storage and startup

`upstream_registrations` stores unique stable `serverId`, separate `displayName`, canonical `url`, `transport: "streamable-http"`, `enabled`, `authentication`, `configurationRevision`, `createdAt`, and `updatedAt`. The stable ID uses lowercase letters, digits, underscores and hyphens, beginning with a letter (maximum 100 characters); it remains the public tool namespace. Display names have 1–200 trimmed characters. Revisions are positive safe integers. Timestamps are MongoDB dates. Unknown fields and unsupported authentication configuration fail validation.

URLs use WHATWG URL serialization: scheme/host case, default ports, and dot path segments normalize; trailing slashes and query order remain significant. HTTP(S) only, with no userinfo or fragment. Unique indexes enforce IDs and canonical URLs. Stored noncanonical URLs are rejected at startup. Destination approval remains mandatory, including for disabled registrations; every actual connection also uses the existing DNS/socket destination checks. See [destination configuration](upstream-destinations.md).

Authentication configuration is `{ "type": "none" }`, or `{ "type": "bearer", "secretRef": { "namespace": "urumi", "name": "upstream-token", "key": "token" } }`. Custom headers use type `header` and an additional `headerName`; reserved transport/authentication headers are rejected. This ticket stores references only. Secret resolution and credential-enabled connections are later work: enabled registrations requiring credentials remain **unreachable** and never connect anonymously. No raw credential field is accepted or returned. Reference validation is structural; namespace/name approval and Kubernetes resolution are not implemented here.

Startup first verifies identity storage, indexes, and transaction support. A coordination document in `upstream_migrations`, `_id: "upstream-defaults-v1"`, serializes the migration. Missing default registrations and `completedAt` commit in one majority-write transaction. A failed transaction rolls back all its inserts and completion; a subsequent startup retries. Concurrent migrations conflict on the coordination row and retry through MongoDB transaction handling. An uncompleted coordination row alone does not mean migration succeeded.

WooCommerce, calculator and time retain their current identifiers and URLs from `getDefaultUpstreams()`, including existing environment overrides. Existing registrations with those IDs are left intact, preserving edited URLs, names, disabled state and Secret references. Once completed, the migration never reseeds deleted defaults. `*_MCP_URL` and the application constructor's `upstreams` option supply migration input, not runtime truth; changing them after migration does not edit stored registrations. Only missing defaults in an incomplete migration are validated and inserted; completed migration ignores obsolete default URLs. Do not delete the completion marker during normal operation.

The gateway loads and validates all persisted desired registrations. Disabled entries are registered without any connection. Enabled entries discover independently with the existing five-second connection/discovery bounds before becoming connected. One dead upstream leaves healthy tools usable; persisted data cannot claim a live connection. MongoDB failure aborts startup with no static registry or bootstrap-auth fallback. Periodic refresh/reconnection remains every 30 seconds, serialized with connection maintenance for each server.

Readiness is unchanged: available MongoDB and at least one connected upstream are required. All-disabled, empty, or wholly unavailable registries return 503 from `/health/ready`; `/health/live` remains process liveness. Readiness does not guarantee every server or WooCommerce REST dependency works.

## Administrator API

All endpoints require an eligible administrator **dashboard cookie session** and return `Cache-Control: no-store`. Gateway bearer keys do not grant access. Pending-password users, members, disabled accounts and revoked sessions retain existing session rules. GET requests require no CSRF token. POST requires the existing exact trusted Origin and session-bound `X-CSRF-Token`.

| Endpoint | Success response |
| --- | --- |
| `POST /api/admin/servers` | `201 { "server": detail }`, including offline connection outcome |
| `GET /api/admin/servers` | `{ "servers": [summary, ...] }`, sorted by `serverId` |
| `GET /api/admin/servers/:serverId` | `{ "server": detail }` |
| `GET /api/admin/servers/:serverId/tools` | `{ "tools": [{ "name": "calculator.calculate", "description": "…", "inputSchema": {...} }] }` |

Summaries contain `serverId`, `displayName`, `enabled`, `configurationRevision`, `createdAt`, `updatedAt`, live `status`, `toolCount`, `lastConnectedAt`, `lastDiscoveredAt`, and `lastError`. Dates serialize as ISO strings; absent observations are null. Errors are null or the fixed `Upstream unavailable` message. Unavailable/disabled servers report zero public tools, even if old definitions remain internally cached.

Details add configured `url`, `transport`, and `authentication: { "type": "none" | "bearer" | "header", "referenceConfigured": boolean }`. Secret reference values, header names/values and client objects are omitted. Tool names use the stable namespace; descriptions (omitted when absent) and input schemas come from actual discovery. Treat tool metadata as untrusted content when rendering it. Tools reflect the live catalog, not database-provided schemas or status. A stored revision different from the active registry revision has no associated observations until restart. Live creation records the current revision immediately.

Errors use the existing dashboard envelope: missing/invalid dashboard session or bearer-only access returns `401 { "error": "Unauthorized" }`; members return `403 { "error": "Forbidden" }`; pending replacement returns the existing 403 requirement; unknown IDs return `404 { "error": "Server not found" }`. Database failures use `503 { "error": "Authentication unavailable" }`, without database errors, URIs or stack traces.

For an authenticated session cookie held in a protected cookie jar:

```bash
curl --cookie "$COOKIE_JAR" "$GATEWAY_URL/api/admin/servers"
curl --cookie "$COOKIE_JAR" "$GATEWAY_URL/api/admin/servers/calculator"
curl --cookie "$COOKIE_JAR" "$GATEWAY_URL/api/admin/servers/calculator/tools"
```

## Operator rollout and limits

Run **one gateway replica**. Concurrent migration is safe, but runtime configuration/catalog synchronization between replicas is absent. Future lifecycle management needs additional coordination before multiple replicas are supported. Out-of-band database edits require a restart; they are not a supported live-management API. Inspection rereads desired state but cannot reconcile external edits with existing connections.

Back up MongoDB, confirm replica-set transaction support, approve the intended default destinations, and deploy the rebuilt gateway image. First startup automatically migrates; no new environment variables, Helm values, Secret, Service, Ingress or PVC changes are required. Inspect the three GET APIs with an administrator dashboard session, compare names/schemas with MCP `tools/list`, perform a read-only calculator/time call, and restart to confirm restored registrations and fresh timestamps. Existing default URL overrides only affect first migration. Do not manually set persisted connection status or tool definitions.

Regression tests cover first/repeat/concurrent migration, rollback after a duplicate canonical URL, preserving desired edits/deletions/references, disabled restoration without connection, independent startup with a dead server, fresh discovery, SDK result compatibility, eligibility/role/bearer separation, malformed stored configuration and storage outage responses. The full MongoDB runner provisions disposable replica-set and standalone databases. It does not prove live Kubernetes health, RBAC, egress enforcement or WooCommerce connectivity. No cluster rollout was performed. Credential resolution, edit/enable/disable/remove/manual-refresh APIs, frontend screens, durable observations/audits, and multi-replica coordination remain later work.


## Register without restart (#18)

Approve the new origin/CIDRs in `UPSTREAM_DESTINATION_RULES` and the deployment network policy before registering; application approval alone does not prove connectivity. Only unauthenticated Streamable HTTP registration is currently accepted by POST. All six fields below are required, and unknown fields (including headers, raw credentials, Secret references, revisions and timestamps) are rejected. `enabled: false` registers without connecting. Secret-authenticated existing records still fail closed until the credential resolver is delivered.

```bash
curl --cookie "$COOKIE_JAR" \
  -H "Origin: $DASHBOARD_ORIGIN" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"serverId":"inventory","displayName":"Inventory tools","url":"https://approved-tools.example/mcp","transport":"streamable-http","enabled":true,"authentication":{"type":"none"}}' \
  "$GATEWAY_URL/api/admin/servers"
```

POST returns `400 { "error": "Invalid server configuration" }` for invalid/unsupported input or destinations. `409 { "error": "Server already registered" }` means the stable identifier or canonical endpoint already exists, including racing requests. Canonicalization is the WHATWG serialization described above: `http://EXAMPLE.com:80/a/../mcp` equals `http://example.com/mcp`. Path case, trailing slash and query order remain significant; this does not attempt to detect different URLs that happen to serve the same application. Unique indexes enforce the serialized URL and stable ID before any connection attempt. Non-JSON input returns 415; oversized bodies return 413. Authentication, authorization, CSRF and database failures retain the existing dashboard error envelope.

The management service persists desired configuration first, then registers and connects through the existing registry. Successful persistence with connection or discovery failure returns **201**, with `enabled: true`, `status: "unreachable"`, zero public tools and sanitized `lastError`. It remains durably registered and periodic maintenance retries every 30 seconds; do not retry POST to reconnect (it will return 409). Persistence failure returns 503 and cannot publish/connect the requested server. If the response is lost or the process stops between persistence and reconciliation, inspect GET by stable ID; a restart restores persisted registrations. A failed response does not prove no durable write occurred.

Connection, refresh and failure work is serialized per server. Runtime generations protect delayed discovery, failures and invocation mappings; shutdown prevents late maintenance from publishing new clients. Each discovered tool set is published coherently, and duplicate discovered names leave only that server unavailable. The resolver carries the observed generation into the shared `executeTool` invoker, which verifies current enabled/connected state, generation and actual tool membership. Already started calls may finish. Authorization and audit attribution still run through `executeTool`; valid `isError`/`structuredContent` results are preserved without write retries.

The current MCP handler constructs its server from the current permitted catalog per request. An already connected client sees additions on its next uncached `tools/list` (SDK clients can use `cacheMode: "bypass"`); no reconnect or notification is required. New namespaces grant no additional member permissions. Roles and API-key eligibility/revocation remain checked on every MCP HTTP request. Administrator cookies alone cannot invoke MCP.

For verification without commerce mutations, register a controlled approved server, inspect its detail/tools, list and call from an MCP client connected before creation, and restart the gateway to verify restoration. Stop that upstream to verify unavailable isolation and restart it to observe periodic recovery. No Helm changes or cluster reset are required by this ticket. Run one gateway replica; other replicas do not observe live registrations until restart.
