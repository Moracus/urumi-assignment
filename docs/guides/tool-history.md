# Durable tool history (#39)

The application defaults to MongoDB audit storage through the existing `AuditLogger` contract and identity connection lifecycle. Startup creates `tool_audit` and its unique attempt-ID and descending `(timestamp, _id)` indexes before serving traffic. History survives gateway restarts; it is independent of console-log retention. `ConsoleAuditLogger` remains an explicit development/test option, not the application default.

Eligible administrators can open **Tool history** at `/admin/audit`. The table shows User, Server, Tool, Time, Duration and Outcome, with loading, empty, refresh, retry and previous/next states. Members do not see the link and cannot access the API. Session expiry uses the dashboard's existing session reset behavior and discards delayed responses.

`GET /api/admin/audit?page=1&limit=20` uses the existing dashboard cookie, HTTPS and backend administrator guards. Bearer-only or unauthenticated requests receive 401; eligible members receive 403. Responses use `Cache-Control: no-store`. Parameters are strict decimal integers: page defaults to 1 (maximum 2147483647); limit defaults to 20 (maximum 100). Unknown, duplicated and invalid query parameters receive 400. The dashboard uses ten rows per page.

The response is `{ records, page, limit, hasMore }`. Rows are ordered by timestamp descending, then MongoDB row ID descending for deterministic timestamp ties. A limit-plus-one query determines `hasMore` without counting all history. Offset pages are live views: concurrent new attempts can move rows between pages; this API does not promise a snapshot or cursor. Large offsets become more expensive.

Each row explicitly projects these fields:

| Field | Meaning |
| --- | --- |
| `id` | Durable MongoDB audit row ID and ordering tie-breaker |
| `attemptId` | Server-owned UUID for this execution attempt |
| `requestId` | Caller request correlation; MCP callbacks generate their own server-owned UUID |
| `userId`, `userEmail` | Verified user ID and minimal historical email snapshot (nullable for legacy internal identities) |
| `authenticationOrigin` | `gateway_api_key` or explicit `dashboard_session` |
| `keyId` | Actual gateway API-key ID for bearer execution; null for dashboard sessions |
| `upstreamId`, `upstreamName`, `upstreamDisplayName` | Registration document ID, public server ID and historical display name, when known; unresolved upstreams stay null |
| `toolName`, `timestamp`, `durationMs`, `outcome` | Public tool name, UTC execution start, duration through authorization/resolution/invocation, classified outcome |

`AuthenticatedIdentity` accepts legacy bearer identities with a real `keyId`; bearer authentication now explicitly sets origin and email from the database. A dashboard caller must construct a server-verified identity with `authenticationOrigin: "dashboard_session"` and `keyId: null`. Session identity cannot be used to authenticate `/mcp`. This slice adds the shared contract, not a chat execution endpoint. Permissions still run through `executeTool()` before resolution and invocation.

User display attribution is captured at authentication. For a resolved upstream, the registration ID/display snapshot is read before invocation, so later edits/removal do not rewrite the row. Display snapshots do not depend on mutable joins. A failed attribution lookup emits a fixed operational message and leaves unavailable metadata null; it does not repeat tool execution.

Outcomes remain `success`, `tool_error` (valid MCP `isError`), `unauthorized`, `not_found`, `upstream_error`, `upstream_unavailable`, and `upstream_timeout`. Valid MCP structured results are returned unchanged. Persisted/public audit fields exclude credentials, key hashes, session tokens, tool arguments, result bodies, internal URLs and exception stacks. Raw errors are never serialized to audit storage. Emails and tool/server display labels are retained intentionally as historical attribution; administrators can read them.

Coverage is attempts reaching the shared execution boundary. SDK dispatch/schema failures, hidden or unknown names rejected before callbacks, and unauthenticated requests do not create rows in this slice; the next audit slice covers those rejections. A request denied by execution itself is recorded with its verified identity and null unresolved upstream.

## Storage failure and rollout

An audit-write failure never replaces an already determined result/error and never triggers another upstream invocation. The server emits only `{ "event": "audit_write_failed", "attemptId": "…" }` on stderr. Monitor this event alongside the fixed MongoDB connection/attribution failure messages. A MongoDB driver write may take up to the existing bounded storage timeout; result delivery can wait for that write attempt. There is no durable queue or replay. Missing rows during rejected writes or storage outages are possible and are not backfilled. A lost acknowledgement can also leave uncertainty about whether a row committed. New requests still fail existing authentication checks during a full database outage.

Rebuild and roll out the gateway and dashboard images together using the existing deployment procedure. No new environment variables, Secrets, Helm values, Services, PVCs or network permissions are required. Existing MongoDB privileges must permit collection/index creation and audit insert/read, as they already do for identity collections. Do not reset MongoDB or application volumes. No automatic retention policy or TTL is added: operators must plan retention and backups for growing history. Console records from earlier versions are not imported.

## Verification

Run `pnpm test:workflow` for workspace checks/builds, the full gateway suite with disposable replica-set and standalone MongoDB, and Playwright. Gateway tests use real SDK clients/controlled upstreams and read rows through the administrator API: restart durability, historical snapshots, tie ordering, pagination/validation, access control, safe fields, tool error versus timeout/protocol failure, healthy upstream isolation, and actual MongoDB insert rejection without side-effect replay. Session-origin and execution-only not-found/authorization/unavailable classifications use the shared execution seam with real registry/storage because the MCP SDK filters these calls before callbacks. Browser tests cover real history pagination plus controlled loading, empty, invalid response and retry states. These tests do not establish live Kubernetes readiness, network enforcement or a real WooCommerce mutation; no deployment is performed by this change.
