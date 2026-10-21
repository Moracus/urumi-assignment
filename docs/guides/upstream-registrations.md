# Persistent upstream registrations (#17, #18, #19, #20)

MongoDB is the source of desired upstream configuration. The existing registry owns observed status, MCP clients, discovered tools, and connection/discovery timestamps in memory. These observations are never written over desired configuration and are rebuilt on every restart. Tool execution still uses `executeTool()`, existing role policies, and per-request gateway API-key authentication.

## Dashboard inspection (#30)

Log in to the dashboard as an eligible administrator and open **Servers** (`/admin/servers`). The list shows every persisted registration, with configured enabled state separate from the backend's observed disconnected, connecting, connected, unreachable, or disabled status. Available tool counts describe the current connected catalog, not cached definitions from a previous connection. **Refresh servers** reloads the list; it does not reconnect upstreams.

Choose **Inspect** to view the endpoint, transport, connection/discovery timestamps (or Never), sanitized failure, and available namespaced tools. Descriptions render as plain text and input schemas as formatted, scrollable JSON. Authentication shows only its type and whether a reference is configured. Stored references and credential values are not returned or displayed.

**Refresh details** reloads observations and tools. **Refresh discovery** explicitly invokes the existing backend refresh action, then reloads authoritative details, catalog and list. It is unavailable for disabled registrations and never enables them. An unreachable result remains an observed failure even if the refresh HTTP request succeeds. Loading, empty, safe error and explicit retry states cover both list and detail reads; failed discovery actions allow deliberate resubmission. Members cannot use these pages or the administrator APIs.

Run `pnpm --filter @urumi/gateway build`, then `MONGODB_TEST_URI='<disposable replica-set URI>' pnpm --filter @urumi/dashboard test:browser servers.spec.ts` for browser coverage against real MongoDB and controlled MCP upstreams. The fixture creates and drops its own uniquely named database. It covers real catalogs and schema preservation, hostile descriptions, unreachable and disabled registrations, safe authentication metadata, member denial, and supplementary controlled failure/loading responses. This validates the local application boundary; it does not verify Kubernetes routing or NetworkPolicy enforcement. No deployment or Helm changes are required for this dashboard-only addition; run the existing gateway and dashboard development servers to inspect it locally.

## Dashboard registration and editing (#31)

On **Servers**, choose **Register server**. Enter an immutable identifier/public namespace (lowercase letter followed by lowercase letters, digits, underscores or hyphens, up to 100 characters), a display name, and an approved HTTP(S) endpoint. The dashboard registers an enabled Streamable HTTP server. Choose None, Bearer, or Custom header authentication. Bearer/custom-header forms accept only the namespace, name and key of an operator-approved, pre-provisioned Kubernetes Secret; custom-header mode also requires a permitted HTTP header name. The form never accepts a credential value, creates a Secret, or reads back an existing reference. Exact destination/reference approvals and all administrator permissions remain enforced by the backend.

Choose **Inspect**, then **Edit server** to change the display name or endpoint. The identifier is fixed. Existing authentication is preserved by omitting it from the PATCH payload unless **Replace authentication** is selected. Replacement is complete: provide the approved reference and header name where applicable, or explicitly select None to remove authentication. Editing a disabled registration preserves its disabled state.

Save feedback reports the backend's actual runtime status. Failed discovery is still a saved registration, shown as unreachable with no available tools; inspect/correct the endpoint or authentication and save again, or use **Refresh discovery** after fixing the external dependency. Persistence and live reconciliation reuse the existing backend contracts and generation barriers. A continuing MCP client obtains the current catalog with uncached `tools/list`; retired tool names cannot execute. Member tool permissions are unchanged. Save errors retain the form for correction and deliberate resubmission. If a response is lost or ambiguous, inspect the saved registration before retrying. Pending saves disable the fields, submit and cancel actions; navigation/session changes discard the editor and late responses.

Run `MONGODB_TEST_URI='<disposable replica-set URI>' pnpm --filter @urumi/dashboard test:browser server-edit.spec.ts` after building the gateway. Coverage includes browser add/edit and failure recovery, bearer-reference preservation across reconnection, explicit custom-header replacement, live MCP catalogs/schema/calls, obsolete-tool rejection and healthy-server isolation, validation/destination/reference denial, pending state and logout cleanup. The fixture substitutes only the external Kubernetes Secret reader with synthetic values; it does not verify live Kubernetes Secret access. Rebuild the dashboard and serve it with the existing same-origin API routing. There are no new dependencies, backend contracts, environment variables, Helm changes or data migrations; existing operator destination/network approvals and Secret provisioning remain prerequisites.

## Storage and startup

`upstream_registrations` stores unique stable `serverId`, separate `displayName`, canonical `url`, `transport: "streamable-http"`, `enabled`, `authentication`, `configurationRevision`, `createdAt`, and `updatedAt`. The stable ID uses lowercase letters, digits, underscores and hyphens, beginning with a letter (maximum 100 characters); it remains the public tool namespace. Display names have 1–200 trimmed characters. Revisions are positive safe integers. Timestamps are MongoDB dates. Unknown fields and unsupported authentication configuration fail validation.

URLs use WHATWG URL serialization: scheme/host case, default ports, and dot path segments normalize; trailing slashes and query order remain significant. HTTP(S) only, with no userinfo or fragment. Unique indexes enforce IDs and canonical URLs. Stored noncanonical URLs are rejected at startup. Destination approval remains mandatory, including for disabled registrations; every actual connection also uses the existing DNS/socket destination checks. See [destination configuration](../operations/upstream-destinations.md).

Authentication configuration is `{ "type": "none" }`, or `{ "type": "bearer", "secretRef": { "namespace": "urumi", "name": "upstream-token", "key": "token" } }`. Custom headers use type `header` and an additional `headerName`; reserved transport/authentication headers are rejected. References are approved by namespace, name and key before API persistence. The backend resolves values into the associated transport only; missing/forbidden reads leave that server unreachable. No raw credential field is accepted or returned. See [Secret configuration and rotation (#22)](../operations/upstream-credentials.md).

Startup first verifies identity storage, indexes, and transaction support. A coordination document in `upstream_migrations`, `_id: "upstream-defaults-v1"`, serializes the migration. Missing default registrations and `completedAt` commit in one majority-write transaction. A failed transaction rolls back all its inserts and completion; a subsequent startup retries. Concurrent migrations conflict on the coordination row and retry through MongoDB transaction handling. An uncompleted coordination row alone does not mean migration succeeded.

WooCommerce, calculator and time retain their current identifiers and URLs from `getDefaultUpstreams()`, including existing environment overrides. Existing registrations with those IDs are left intact, preserving edited URLs, names, disabled state and Secret references. Once completed, the migration never reseeds deleted defaults. `*_MCP_URL` and the application constructor's `upstreams` option supply migration input, not runtime truth; changing them after migration does not edit stored registrations. Only missing defaults in an incomplete migration are validated and inserted; completed migration ignores obsolete default URLs. Do not delete the completion marker during normal operation.

The gateway loads and validates all persisted desired registrations. Disabled entries are registered without any connection. Enabled entries discover independently with the existing five-second connection/discovery bounds before becoming connected. One dead upstream leaves healthy tools usable; persisted data cannot claim a live connection. MongoDB failure aborts startup with no static registry or bootstrap-auth fallback. Periodic refresh/reconnection remains every 30 seconds, serialized with connection maintenance for each server.

Readiness is unchanged: available MongoDB and at least one connected upstream are required. All-disabled, empty, or wholly unavailable registries return 503 from `/health/ready`; `/health/live` remains process liveness. Readiness does not guarantee every server or WooCommerce REST dependency works.

## Administrator API

All endpoints require an eligible administrator **dashboard cookie session** and return `Cache-Control: no-store`. Gateway bearer keys do not grant access. Pending-password users, members, disabled accounts and revoked sessions retain existing session rules. GET requests require no CSRF token. Mutations require the existing exact trusted Origin and session-bound `X-CSRF-Token`.

| Endpoint | Success response |
| --- | --- |
| `POST /api/admin/servers` | `201 { "server": detail }`, including offline connection outcome |
| `GET /api/admin/servers` | `{ "servers": [summary, ...] }`, sorted by `serverId` |
| `GET /api/admin/servers/:serverId` | `{ "server": detail }` |
| `GET /api/admin/servers/:serverId/tools` | `{ "tools": [{ "name": "calculator_calculate", "description": "…", "inputSchema": {...} }] }` |

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

Run **one gateway replica**. Concurrent migration is safe, but runtime configuration/catalog synchronization between replicas is absent. Live lifecycle management needs additional coordination before multiple replicas are supported. Out-of-band database edits require a restart; they are not a supported live-management API. Inspection rereads desired state but cannot reconcile external edits with existing connections.

Back up MongoDB, confirm replica-set transaction support, approve the intended default destinations, and deploy the rebuilt gateway image. First startup automatically migrates; no new environment variables, Helm values, Secret, Service, Ingress or PVC changes are required. Inspect the three GET APIs with an administrator dashboard session, compare names/schemas with MCP `tools/list`, perform a read-only calculator/time call, and restart to confirm restored registrations and fresh timestamps. Existing default URL overrides only affect first migration. Do not manually set persisted connection status or tool definitions.

Regression tests cover first/repeat/concurrent migration, rollback after a duplicate canonical URL, preserving desired edits/deletions/references, disabled restoration without connection, independent startup with a dead server, fresh discovery, SDK result compatibility, eligibility/role/bearer separation, malformed stored configuration and storage outage responses. The full MongoDB runner provisions disposable replica-set and standalone databases. It does not prove live Kubernetes health, RBAC, egress enforcement or WooCommerce connectivity. No cluster rollout was performed. Frontend screens, durable observations/audits, and multi-replica coordination remain later work. Credential resolution is documented separately in [#22](../operations/upstream-credentials.md).


## Register without restart (#18)

Approve the new origin/CIDRs in `UPSTREAM_DESTINATION_RULES` and the deployment network policy before registering; application approval alone does not prove connectivity. POST accepts unauthenticated and approved Secret-authenticated Streamable HTTP registrations. All six fields below are required, and unknown fields (including raw headers, raw credentials, revisions and timestamps) are rejected. `enabled: false` registers without connecting. Secret references must match the operator allowlist; see [authentication examples](../operations/upstream-credentials.md).

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


## Disable, enable and remove (#19)

These endpoints use the same eligible administrator dashboard session, trusted Origin and session-bound CSRF checks as creation. Bearer credentials cannot manage servers. No body is required.

| Endpoint | Success response |
| --- | --- |
| `POST /api/admin/servers/:serverId/disable` | `200 { "server": detail }`, disabled with no public tools |
| `POST /api/admin/servers/:serverId/enable` | `200 { "server": detail }`, enabled and freshly discovered or unreachable |
| `DELETE /api/admin/servers/:serverId` | `204`, after durable disable, connection cleanup and deletion |

Unknown identifiers return 404, including repeated deletion. Repeated disable is safe; repeated enable deliberately reconnects and rediscovers. Each change increments the configuration revision. Enable retains the stable namespace, URL and authentication reference. It checks the current destination policy on every connection, including DNS/socket checks; failed connections leave the registration enabled/unreachable with zero public tools and a sanitized error. Healthy upstreams remain available and periodic maintenance retries enabled unavailable servers.

```bash
curl --cookie "$COOKIE_JAR" -X POST \
  -H "Origin: $DASHBOARD_ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN" \
  "$GATEWAY_URL/api/admin/servers/calculator/disable"
curl --cookie "$COOKIE_JAR" -X POST \
  -H "Origin: $DASHBOARD_ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN" \
  "$GATEWAY_URL/api/admin/servers/calculator/enable"
curl --cookie "$COOKIE_JAR" -X DELETE \
  -H "Origin: $DASHBOARD_ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN" \
  "$GATEWAY_URL/api/admin/servers/inventory"
```

### Ordering and in-flight calls

Management serializes creation, enable, disable and removal for each stable ID; unrelated servers remain independent. Enable persists enabled configuration before reconnecting. Disable persists disabled configuration, then synchronously advances the runtime generation, withdraws the client/tools and establishes the invocation barrier. It waits for per-server maintenance and connection cleanup before acknowledging success. Remove uses the same durable disable and barrier, waits for cleanup, deletes the record, then drops runtime state. It never deletes Kubernetes Secrets, PVCs or other resources. Completed default migration prevents removed defaults from being recreated on restart.

The registry serializes connection, periodic refresh, cleanup and failure handling per server. Delayed connection/discovery results cannot publish after the barrier; late failures from a replaced client cannot mark its replacement unhealthy. The existing invoker checks live enabled state, current generation and discovered membership immediately before starting a call. A mapping resolved before disable/remove cannot bypass these checks. An already-started call may complete, retaining its normal ten-second timeout, result and execution audit attribution. Cleanup drains these calls before closing the connection; disable/remove responses can consequently wait for in-flight calls and bounded five-second discovery/connection work. No tool call is automatically retried.

An existing MCP client sees withdrawn or restored tools on its next uncached discovery request; remembered names/schemas do not confer permission. Role checks and gateway API-key revocation still run independently on every MCP request. Disabled state and removal survive restart; enabled state is freshly discovered on startup.

### Partial failures and recovery

A persistence or cleanup error returns the existing safe 503 envelope, never a successful removal acknowledgement. A failed initial state write leaves the existing runtime untouched; the result may be ambiguous if MongoDB committed before a connection failure. Inspect GET and retry the intended action, or restart to reconcile durable state. If disable persisted before cleanup failed, it remains disabled and non-callable; failed cleanup retains connection handles for a later cleanup attempt. Retry disable or removal after correcting the failure. If final deletion fails, the durable disabled record remains available for inspection and retry, including after restart. If deletion committed but the response was lost, GET/DELETE returns 404; that is a completed removal. If enable persisted but cleanup failed, it remains non-callable in this process; retry enable or restart to reconcile the enabled intent. An unreachable connection after otherwise successful enable is a 200 observed outcome, not a persistence failure.

Use one gateway replica. Live changes are process-local and out-of-band database edits are unsupported without restart. Inspect desired enabled state and live status/tools after an ambiguous response. Do not delete the defaults migration marker. Rebuild/deploy the gateway image; no new production environment variables, Helm values or cluster resource changes are required. Test-only MongoDB failure injection is enabled solely in the disposable integration compose service, never production deployment configuration.

## Edit display names and endpoints (#20)

`PATCH /api/admin/servers/:serverId` requires the same eligible administrator dashboard session, exact trusted Origin and session-bound CSRF token as creation. Send JSON containing `displayName`, `url`, `authentication`, or a combination. At least one field is required. Identifier renames, enabled/transport changes, raw credentials, revision fields and all other fields are rejected. Display names and endpoints use the existing creation validation, destination approval, canonicalization and unique endpoint index. Invalid input returns 400, duplicate canonical endpoints return 409, and unknown IDs return 404. Non-JSON input returns 415; the body limit is 8192 bytes. Existing session, role and safe database error responses apply.

```bash
curl --cookie "$COOKIE_JAR" -X PATCH \
  -H "Origin: $DASHBOARD_ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Arithmetic tools","url":"https://approved-tools.example/mcp"}' \
  "$GATEWAY_URL/api/admin/servers/calculator"
```

Success returns `200 { "server": detail }`. The stable `serverId` and public namespace remain unchanged: editing calculator's display name or URL still exposes `calculator_calculate` when that tool is discovered. Each successful edit advances the desired configuration revision. A display-only edit (or a URL that canonicalizes to the current URL) preserves the connection, callable generation, catalog and observation timestamps. Disabled registrations can be edited without connecting.

Endpoint edits persist desired configuration first. Immediately after persistence, the registry advances the callable generation, withdraws the previous client and tools, clears previous observation timestamps and records the new desired endpoint. It then waits for older maintenance and already-started bounded calls, retires the old connection, and connects/discovers through the current destination policy. No new call may enter the old connection after that barrier; already-sent operations may finish and are never retried automatically. Delayed discovery cannot publish an obsolete catalog, stale resolved mappings cannot invoke the replacement or old client, and late failures from an old client cannot mark the replacement unhealthy. Per-server management serialization includes edits, creation, enable, disable and removal; unrelated servers remain independent. Observations are associated with the current configuration revision.

A failed replacement connection returns **200** with the new URL durably stored, enabled/unreachable status, zero public tools and a sanitized error. There is no fallback to the old endpoint. Periodic maintenance retries the new endpoint; administrators can also use the enable action to reconnect. A disabled server stays disabled. A duplicate or rejected database write returns non-success without changing the live endpoint or partially applying the display name.

Cleanup failure after persistence returns the existing safe **503** envelope. The desired edit may already be durable, but the old callable generation remains withdrawn. GET by stable ID shows desired state; periodic maintenance or the enable action retries cleanup and connection to the desired endpoint. A restart also restores the persisted configuration. A lost response, process interruption between persistence and reconciliation, or ambiguous database write acknowledgement may leave desired and runtime state different: inspect GET and restart the single gateway replica to reconcile. A 503 does not establish that no database write occurred. Do not retry a non-idempotent tool call to recover an edit.

Run one gateway replica; there is no live cross-replica synchronization or supported out-of-band database editing. Credential-reference edits use the same generation barrier; see [#22](../operations/upstream-credentials.md). Deploy the rebuilt gateway image with the existing MongoDB replica set and destination rules; no new environment variables, Helm values, Services, Secrets or PVC changes are required. Approve destination network access before editing an endpoint. This implementation does not verify cluster connectivity or deploy workloads.


## Refresh tools and recover connections (#21)

`POST /api/admin/servers/:serverId/refresh` requires an eligible administrator dashboard session, trusted Origin and session-bound CSRF. No body is required. Bearer keys cannot manage servers. Responses use `Cache-Control: no-store`.

```bash
curl --cookie "$COOKIE_JAR" -X POST \
  -H "Origin: $DASHBOARD_ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN" \
  "$GATEWAY_URL/api/admin/servers/calculator/refresh"
```

Success returns `200 { "server": detail }` after discovery or the bounded connection attempt. An upstream failure also returns 200 with the observed `status: "unreachable"`, `toolCount: 0` and fixed `lastError: "Upstream unavailable"`; this acknowledges the completed attempt, not a healthy connection. Unknown IDs return `404 { "error": "Server not found" }`. Disabled registrations return `409 { "error": "Server is disabled" }`, without enabling, connecting or changing their desired revision. Authentication, role, Origin/CSRF and storage failures retain existing 401/403/503 envelopes. Cleanup failure returns the safe 503 envelope; inspect status and retry or restart.

Refresh does not change `configurationRevision`, `updatedAt`, URL, enabled state or authentication references. A connected server rediscovers tools on its current connection; a disconnected or unreachable server reconnects using current configuration and destination checks. Reconnect resolves current approved Secret references; resolution failure leaves only that server unavailable. Out-of-band storage edits remain unsupported: a desired/runtime revision mismatch returns safe 503 and requires restart to reconcile before refresh.

`lastConnectedAt` changes only after successful reconnection and discovery. `lastDiscoveredAt` advances only when a complete valid catalog is published. Failed attempts retain the previous successful timestamps and sanitized error metadata. Duplicate names or malformed discovery invalidate only that server; cached unavailable tools cannot be listed or invoked. Changed names, descriptions and schemas replace the old catalog coherently and appear on the same MCP client's next uncached `tools/list` (`cacheMode: "bypass"` for SDK caches). Remembered names do not bypass catalog membership, role or API-key revocation checks.

Manual and periodic maintenance share the per-server queue with connection replacement, failure reports and cleanup. Management refresh also serializes with create/edit/enable/disable/remove for that ID. Generation barriers discard obsolete discovery and late failures from replaced clients; shutdown prevents late publication. Unrelated servers, authentication and key management remain available during bounded upstream work. Connection and discovery retain separate five-second limits and calls retain ten seconds. No write is automatically retried. Automatic refresh/recovery continues every 30 seconds; manual refresh can recover sooner.

Deploy the rebuilt gateway image with one replica. No migration, new environment variable, chart, Secret or PVC operation is required. Verify with an administrator refresh, detail inspection, and uncached discovery plus a read-only call on a previously connected MCP client. This does not verify Kubernetes network enforcement or commerce connectivity.

## Dashboard availability and recovery (#32)

At `/admin/servers`, an eligible administrator can inspect a registration and use **Disable server**, **Enable server**, **Remove server**, or **Refresh discovery**. Disable and removal open a confirmation explaining that MCP tools will become unavailable; Cancel sends no mutation. Removal unregisters the persistent configuration and runtime connections without deleting Kubernetes Secrets. While a lifecycle request is pending, its confirmation, competing detail actions, server selection, registration, and list refresh are disabled. Logout remains available; results from a previous session are discarded by the shared API client.

Enable and discovery refresh report the backend's observed runtime status, then reload the list, details and catalog. An HTTP success with `unreachable` means the attempt completed but tools are unavailable; the UI explicitly reports discovery failure. Configured enabled state remains separate from runtime status. Refresh discovery is unavailable while disabled, and the backend independently rejects it with 409 without enabling. A failed or lost mutation response may follow a durable state change: cancel an open confirmation, refresh details to inspect actual state, then retry deliberately. The UI never automatically resubmits mutations.

To demonstrate with an approved controlled upstream and a continuing authenticated administrator MCP client:

1. Discover and call a tool. Open its registration, choose Disable server, then Cancel; the tool remains callable.
2. Confirm disable. Subsequent uncached discovery omits that namespace, and remembered tool calls fail; call a healthy calculator/time tool to verify isolation.
3. Enable the registration and inspect actual status and freshly discovered tools. An offline upstream stays enabled/unreachable. Correct the upstream and use Refresh discovery to reconnect without a gateway restart; changed names and schemas replace the previous catalog.
4. Cancel removal once, then confirm it. GET by identifier returns 404, tools are absent and remembered calls fail. Referenced Kubernetes Secrets remain operator-managed resources.

`apps/dashboard/tests/server-lifecycle.spec.ts` drives these public browser/HTTP/MCP boundaries against disposable MongoDB and controlled real MCP upstreams. It also covers pending disable/enable/removal, sanitized ambiguous failures and logout during a delayed enable. The test-only upstream mode endpoint lives solely in `tests/server.mjs`. Existing `apps/gateway/src/app.test.ts` covers lifecycle durability across restart, stale generations, cleanup, independent recovery, fresh discovery, valid MCP errors/structured content, bounded connection/discovery/call timeouts, and no automatic WooCommerce write retries.

No backend contract, production environment variable, dependency, Helm template, Secret or PVC change is needed. Build the updated dashboard with `pnpm --filter @urumi/dashboard build` and serve it using the existing development setup (`pnpm --filter @urumi/dashboard dev`) against the configured gateway API. Kubernetes dashboard packaging and rollout belong to the deployment milestone; these tests do not verify Kubernetes isolation or a real WooCommerce deployment. Keep the gateway at one replica until live registry synchronization is implemented.

Validation executed for #32 on 2026-10-16: `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. The complete browser suite (`MONGODB_TEST_URI=… pnpm --filter @urumi/dashboard test:browser`) passed all 48 tests after the final pending-action guard. `pnpm --filter @urumi/gateway test:integration` passed all 132 tests with no skips, using the disposable replica-set/standalone fixture, including database outage tests. Standards and specification reviews reported no findings. Helm and live Kubernetes checks were not run because this change adds no deployment resources.

## Responsive server management (#50)

The existing `/admin/servers` page separates configured enablement, observed runtime status and dashboard read errors. Text badges identify configuration and runtime state independently; a failed dashboard read does not imply an unreachable upstream. The registration table scrolls locally on narrow screens. Full discovered input schemas remain formatted in labeled, keyboard-focusable scroll regions; descriptions retain line breaks and long values wrap. Inspection displays the actual available catalog, including an explicit empty state, without truncating schemas or rendering upstream text as HTML.

**Refresh servers** reads the list. **Refresh details** reads the selected registration and available catalog. Neither starts discovery or invokes tools. **Refresh discovery** remains a deliberate protected operation on an enabled registration. Automatic backend maintenance retains its existing schedule.

List and detail refreshes retain their last successful authorized read while loading or after a failed/invalid response, with an explicit **Stale data** warning. An initial failed read shows an error and retry without inventing an empty catalog or status. Detail lifecycle/edit actions are disabled while that detail read is pending or failed; retry details successfully before acting. Refreshing the list preserves the selected inspection. Successful lifecycle changes invalidate the old detail/catalog snapshot and read the resulting state again. Session expiry, logout and permission changes clear protected data and discard delayed responses.

Register/edit forms focus the first editable field on entry. Cancel editing or Escape closes an idle editor and returns focus to its trigger; Escape cannot close a pending save. Existing authentication is preserved unless explicitly replaced with another approved reference. During saves, competing registration, list refresh and selection controls are disabled. Disable/removal confirmations initially focus Cancel, contain keyboard navigation, support Escape when idle, and prevent closing or duplicate actions while pending. If the trigger disappears or becomes disabled, focus falls back to the main landmark.

A lost mutation response may follow a durable change. Close the confirmation or cancel editing, refresh and inspect the registration before deliberately deciding whether to submit again. No save, enable, disable, removal or discovery operation is automatically replayed. Destination approval, Secret-reference restrictions, backend roles and persistence/runtime synchronization retain their existing contracts.

Reviewed screenshots, exact validation and review findings are recorded in [server-management evidence](../evidence/server-management-50/). Rebuild and publish the dashboard using the existing deployment process. No migration, infrastructure change or Helm validation is required, and fixture tests do not establish live Kubernetes health or network enforcement.
