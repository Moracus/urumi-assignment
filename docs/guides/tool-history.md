# Durable tool history (#39, #40)

The application defaults to MongoDB audit storage through the existing `AuditLogger` contract and identity connection lifecycle. Startup creates `tool_audit` and its unique attempt-ID and descending `(timestamp, _id)` indexes before serving traffic. History survives gateway restarts; it is independent of console-log retention. `ConsoleAuditLogger` remains an explicit development/test option, not the application default.

Eligible administrators can open **Tool history** at `/admin/audit`. The table shows User, Server, Tool, Time, Duration and Outcome, with loading, empty, refresh, retry and previous/next states. Members do not see the link and cannot access the API. Session expiry uses the dashboard's existing session reset behavior and discards delayed responses.

`GET /api/admin/audit?page=1&limit=20` uses the existing dashboard cookie, HTTPS and backend administrator guards. Bearer-only or unauthenticated requests receive 401; eligible members receive 403. Responses use `Cache-Control: no-store`. Parameters are strict decimal integers: page defaults to 1 (maximum 2147483647); limit defaults to 20 (maximum 100). Unknown, duplicated and invalid query parameters receive 400. The dashboard uses ten rows per page. Optional API filters are `userId` (canonical 24-character ID), `toolName` (exact public name, 1–512 characters), `outcome` (one classified outcome), `from` (inclusive) and `to` (exclusive). Times must be ISO datetimes with a timezone; offsets normalize to UTC. Reversed/empty time ranges and invalid filters receive 400. Filters combine with AND and retain the same pagination/order. The table currently browses all history; filters are API-only.

The response is `{ records, page, limit, hasMore }`. Rows are ordered by timestamp descending, then MongoDB row ID descending for deterministic timestamp ties. A limit-plus-one query determines `hasMore` without counting all history. Offset pages are live views: concurrent new attempts can move rows between pages; this API does not promise a snapshot or cursor. Large offsets become more expensive.

Each row explicitly projects these fields:

| Field | Meaning |
| --- | --- |
| `id` | Durable MongoDB audit row ID and ordering tie-breaker |
| `attemptId` | Server-owned UUID for this attempt, shared by ingress and execution |
| `requestId` | Caller request correlation for internal execution; identifiable MCP calls use the server-owned attempt UUID, never the client RPC ID |
| `userId`, `userEmail` | Verified user ID and minimal historical email snapshot; both null for unauthenticated calls (email may also be null for legacy internal identities) |
| `authenticationOrigin` | `gateway_api_key`, explicit `dashboard_session`, or null when authentication did not establish an identity |
| `keyId` | Actual gateway API-key ID for verified bearer execution; null for dashboard sessions and unauthenticated attempts |
| `upstreamId`, `upstreamName`, `upstreamDisplayName` | Registration document ID, public server ID and historical display name, when known; unresolved upstreams stay null |
| `toolName`, `timestamp`, `durationMs`, `outcome` | Public tool name, UTC attempt start, elapsed duration, classified outcome |

`AuthenticatedIdentity` accepts legacy bearer identities with a real `keyId`; bearer authentication now explicitly sets origin and email from the database. A dashboard caller must construct a server-verified identity with `authenticationOrigin: "dashboard_session"` and `keyId: null`. Session identity cannot be used to authenticate `/mcp`. This slice adds the shared contract, not a chat execution endpoint. Permissions still run through `executeTool()` before resolution and invocation.

User display attribution is captured at authentication. For a resolved upstream, the registration ID/display snapshot is read before invocation, so later edits/removal do not rewrite the row. Display snapshots do not depend on mutable joins. A failed attribution lookup emits a fixed operational message and leaves unavailable metadata null; it does not repeat tool execution.

Execution outcomes are `success`, `tool_error` (valid MCP `isError`), `unauthorized`, `not_found`, `upstream_error`, `upstream_unavailable`, and `upstream_timeout`. Valid MCP structured results are returned unchanged. Persisted/public audit fields exclude credentials, key hashes, session tokens, tool arguments, result bodies, internal URLs and exception stacks. Raw errors are never serialized to audit storage. Emails and tool/server display labels are retained intentionally as historical attribution; administrators can read them.

## Rejected MCP attempts

The `/mcp` ingress recognizes a single POST JSON-RPC 2.0 `tools/call` request with a string or finite numeric ID and an object `params` containing a name of 1–512 ASCII letters, digits, underscores, hyphens or dots. It creates a UUID before authentication. Client RPC IDs, `_meta`, user/role/key claims and supplied attempt IDs cannot set audit identity or deduplication. Reusing the same RPC ID produces separate attempts, including concurrent calls.

| Rejection outcome | Meaning |
| --- | --- |
| `unauthenticated` | No verified identity: missing, invalid or revoked bearer credential, or authentication could not establish identity. User/email/key/origin and all upstream fields are null. |
| `not_found` | Authenticated call names no tool in the current available catalog. No upstream is inferred from the name. |
| `unauthorized` | Authenticated identity cannot invoke a known catalog tool under the existing backend role policy. |
| `rejected` | Known, permitted tool never reached its execution callback: includes SDK argument/schema validation and protocol/dispatch rejection. This deliberately does not classify such failures as upstream failures or valid MCP tool errors. |

The SDK retains ownership of validation, dispatch and Streamable HTTP responses, including legacy SSE and current protocol clients. Authorization filtering still hides forbidden tools; actual execution still authorizes independently. Ingress passes the server-owned UUID into execution and relinquishes recording as soon as the callback starts. Execution records the determined outcome once; otherwise ingress attempts one fallback insert after HTTP handling. The unique MongoDB attempt-ID index also prevents duplicate durable rows. No failed audit insert is retried by the other layer.

Rejected rows retain verified user/key attribution only after successful authentication and leave upstream metadata null because resolution/invocation was never reached. SDK error text, raw arguments, malformed payloads, headers and credentials are never copied to history. A denial can reach its HTTP client before the fallback audit write completes; history is observable after that bounded write completes. Graceful shutdown drains pending fallback audit writes before closing MongoDB.

Malformed JSON, oversized bodies rejected by Fastify (the existing 1 MiB limit), missing/null IDs, notifications, non-tool methods, batches rejected before callbacks, missing names, and names outside the bounded format do not produce synthetic rejection rows. Host/content-type/parser rejections before the route likewise create no rows. Valid calls reaching execution still record there, including supported batch calls. This is bounded tool-attempt coverage, not a log of all HTTP traffic. Authentication outages can also prevent audit persistence; no verified attribution is guessed.

## Storage failure and rollout

An audit-write failure never replaces an already determined result/error and never triggers another upstream invocation. The server emits only `{ "event": "audit_write_failed", "attemptId": "…" }` on stderr. Monitor this event alongside the fixed MongoDB connection/attribution failure messages. A MongoDB driver write may take up to the existing bounded storage timeout; result delivery can wait for that write attempt. There is no durable queue or replay. Missing rows during rejected writes or storage outages are possible and are not backfilled. A lost acknowledgement can also leave uncertainty about whether a row committed. New requests still fail existing authentication checks during a full database outage.

Rebuild and roll out the gateway and dashboard images together using the existing deployment procedure. No new environment variables, Secrets, Helm values, Services, PVCs or network permissions are required. Existing MongoDB privileges must permit collection/index creation and audit insert/read, as they already do for identity collections. Do not reset MongoDB or application volumes. No automatic retention policy or TTL is added: operators must plan retention and backups for growing history. Console records from earlier versions are not imported.

## Verification

Run `pnpm test:workflow` for workspace checks/builds, the full gateway suite with disposable replica-set and standalone MongoDB, and Playwright. Gateway tests use real SDK clients/controlled upstreams and read rows through the administrator API: restart durability, historical snapshots, tie ordering, pagination/validation, access control, safe fields, tool error versus timeout/protocol failure, healthy upstream isolation, and actual MongoDB insert rejection without side-effect replay. Session-origin and execution-only classifications also use the shared execution seam with real registry/storage. Rejected-attempt tests use real current SDK clients and legacy HTTP requests for missing/invalid/revoked keys, hidden and unknown tools, invalid arguments, concurrent repeated RPC IDs, safe nullable attribution, bounded malformed traffic, and real MongoDB insert rejection. Browser tests cover real history pagination plus controlled loading, empty, invalid response and retry states. These tests do not establish live Kubernetes readiness, network enforcement or a real WooCommerce mutation; no deployment is performed by this change.
