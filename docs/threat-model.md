# Threat model

Trust boundaries include browser sessions, delegated MCP tool authority, malicious upstream metadata, destination approval, database operators, Kubernetes RBAC, and the network implementation. Sections below describe implemented controls; the [milestone evidence](issue-37-validation.md) records what was actually verified.

## Identity storage slice (#3)

Initial administrator enrollment is operator CLI-only and requires the configured bootstrap secret. Passwords and supplied secrets use hidden terminal input or mounted files, never literal command-line arguments. CLI and startup errors are fixed messages to avoid exposing driver URIs or parser inputs. Passwords use Argon2id (64 MiB, three passes, parallelism one), with at most two admitted jobs per process. Hashes are excluded from default queries, model serialization, and successful CLI output.

A permanent singleton and first administrator are committed together in a majority-write transaction. Repeated or competing enrollment cannot create another administrator, and deleting accounts or losing database connectivity cannot reopen enrollment. Recovery is a separate database-authorized CLI action; see [operator commands](identity-setup.md#operator-recovery-13). MongoDB operator access remains a trust boundary: operators able to delete identity state can invalidate these guarantees.

Startup fails without usable indexes and transaction-capable persistence. Database outages fail new MCP requests and readiness safely while liveness remains process-only. There is no database-error fallback. Normal MCP authentication now uses per-request persisted key/user checks, as described in ticket #8 below.

The Docker database is unauthenticated and bound to loopback for local development only. Full MongoDB Kubernetes isolation, credentials/TLS, backup/recovery operations, sessions, persistent MCP keys, and management endpoint security remain outside this ticket. Existing upstream authorization, tool execution, and console audit boundaries remain in place.

## Dashboard session slice (#4)

Dashboard authentication is separate from MCP bearer authentication. Random 32-byte opaque credentials are stored only as SHA-256 digests, with fixed eight-hour authentication expiry and independent device sessions. HttpOnly host-only cookies use Path=/api, SameSite=Lax, explicit expiry, and Secure except in explicit development HTTP mode; production rejects that setting. Secure mode checks actual TLS or a configured proxy's exact HTTPS assertion. Trusted Origins are exact scheme/host/port matches. Login requires trusted Origin and strict JSON, while logout additionally requires a session-bound CSRF token and revokes only that session. Auth responses are non-cacheable and omit credential/password hashes.

Persistent rolling 15-minute throttles limit five failed account attempts and 30 source-IP attempts, coordinated transactionally across replicas. Unknown users incur Argon2 verification, and credential failures remain generic. Forwarded IPs influence throttling only through explicitly trusted socket peers and right-to-left trusted proxy chains; malformed chains use the socket peer. Configured TLS edges must overwrite forwarded scheme headers. Hashing concurrency remains bounded; interrupted login reservations conservatively count until window expiry.

New dashboard requests fail safely during database outages and recover without credential fallback or session renewal. Disable/password-change transactions update the user and invalidate sessions; direct database edits are privileged and are not the account-management workflow. Durable audits and broader traffic limits remain later work. Same-origin dashboard/API ingress is provided by the chart with operator-configured TLS and exact proxy trust. See [dashboard configuration and safe examples](dashboard-sessions.md).

## Password replacement slice (#5)

Password replacement requires the current password, a different bounded new password, a live dashboard session, trusted Origin, and session-bound CSRF. The hash update, required-change clearance, and all-device session deletion commit together. The user write coordinates with concurrent login and competing replacements so stale credentials cannot survive the change. Other users and gateway API-key records are unaffected. A commit-time connection failure may yield a safe 503 after successful replacement; fresh login with the new password resolves that ambiguity.

Ordinary dashboard session authentication denies pending-password users regardless of role; only account details, password change and logout explicitly permit them. The shared eligibility predicate is used by personal key issuance and MCP authentication; retained keys are blocked while password replacement is pending. Bootstrap MCP authentication is removed by ticket #8 below. Administrator resets are documented below; member creation, listing, and inspection are described below.

## Member account administration (#6)

Creation, listing, and inspection require a dashboard session with the current database administrator role and completed password replacement. Members cannot use these endpoints, including inspection of other accounts. Creation additionally enforces trusted Origin and session-bound CSRF; strict JSON rejects elevated roles, identity claims, lifecycle flags, and unknown fields. The server assigns active member status and required password replacement, hashes the assigned password using the existing bounded Argon2id implementation, and relies on the unique normalized email index for duplicate races. Explicit safe-field serialization and no-store responses prevent password/hash or internal credential metadata disclosure. Lists are paginated with a maximum of 100 records; identifiers and queries are validated before querying. Authentication/storage failures remain safe 503 responses. This slice preserves the existing MCP and execution boundaries; MCP authentication is implemented by ticket #8 below; public API routing remains later work.

## Personal gateway API keys (#7)

Session-scoped key routes derive the owner from the current eligible user, never client identity fields. Bearer credentials cannot authorize management. Mutations require exact trusted Origin and session-bound CSRF. Strict input and bounded pagination apply; missing and inaccessible keys have the same 404 response even for administrators. Explicit metadata serialization, default hash exclusion, and no-store responses prevent later secret disclosure. Raw `ugw_` credentials contain 32 cryptographically random bytes and are returned only after successful creation; only complete-key SHA-256 digests and safe metadata are persisted. Keys have no automatic expiration. The owner and hash indexes are initialized at startup.

Issuance writes the eligible user before counting/inserting keys in a transaction, enforcing 20 active keys across replicas and conflicting with credential-invalidating user updates. Revocation preserves records and the first timestamp; repeated revocation is successful. Logout and ordinary password changes leave keys intact. A connection failure at commit can leave an undisclosed issued key; inspect and revoke its metadata before retrying. Database failures never fall back to bearer or bootstrap authentication for management. Durable audits and full Kubernetes/API exposure remain later tickets. See [requests and safe examples](api-keys.md).

## Persistent MCP authentication (#8)

Every incoming MCP request resolves an unrevoked SHA-256 key digest and current eligible user, independently of connection/session headers or dashboard cookies. Bootstrap authentication and outage fallback are removed. Authentication occurs once; an asynchronous request-local scope propagates only the verified identity into the existing SDK factory and execution boundary. Conditional last-use updates reject concurrent revocation and advance monotonically even when downstream authorization or execution fails. Invalid credentials produce safe 401 responses, infrastructure failures produce bounded safe 503 responses, and no credentials, hashes, raw database errors, or sensitive arguments appear in responses/audits. Role-filtered discovery and independent execution authorization remain enforced.

SDK/real-database tests exercise next-request revocation, invalid and ineligible credentials, current roles, concurrent identity attribution, cookie separation, logout/password independence, database outage/recovery, and ten-second upstream timeout/isolation/recovery with no write retry. Already admitted operations need not be canceled. Durable audits and Kubernetes rollout remain later work. Operator recovery is available through the separate CLI. The gateway image upgrade rejects old bootstrap clients; clients must use individually issued keys. See [MCP use and revocation](mcp-authentication.md).

## Administrator key assistance (#9)

Administrator key routes resolve the session role and eligibility server-side on every request. They reject member and bearer access; POST and DELETE require exact trusted Origin and session-bound CSRF. Issuance reuses the eligible-owner transaction and shared 20-active-key limit, including concurrent personal/admin requests across gateway instances. Listing returns safe metadata only; raw keys appear only in successful creation responses with no-store handling. Revocation checks both route user and key ID, preserving mismatched records and returning 404. Revoked records and their first revocation timestamps are retained. Eligible administrators may inspect and revoke keys of disabled or pending-password owners, but cannot issue keys to them. No upstream execution or authentication boundary changes. See [administrator examples](api-keys.md#administrator-assistance-9).

## Administrator role changes (#10)

Role/status PATCH requests reuse the administrator dashboard boundary: current eligible database role, trusted Origin, session-bound CSRF, strict JSON, bounded bodies, explicit safe serialization, and no-store responses. Creation remains member-only. No owner privilege exists. Self-demotion is permitted only while preserving an active administrator; disabled administrators do not satisfy the invariant. The shared `account_coordination` write precedes role updates and the active-administrator count in a majority-write transaction, forcing concurrent changes across processes to retry against fresh state instead of allowing write skew. A failed invariant returns 409 and rolls back the role update. Disabling reuses this transaction boundary with session/key invalidation. Database operator writes remain outside application guarantees. Existing sessions and bearer keys resolve roles on subsequent requests; role-only changes do not revoke credentials or bypass pending-password/status checks. HTTP and real SDK tests cover promotion/demotion, concurrent demotions, forbidden effects, discovery filtering, direct call denial, and unchanged user/key audit attribution. No deployment/network boundary changes are included.

## Account disabling (#11)

Status PATCH requests use the same administrator, eligibility, Origin, and CSRF boundary. One transaction changes role/status, deletes all target sessions, revokes every unrevoked key, and protects the last active administrator. Login and both key-issuance routes write the same user document, forcing conflicting operations to retry against current status. Mixed disable/demotion races cannot remove the final active administrator. Self-disabling follows the same rule. Re-enabling preserves required password replacement and does not restore prior credentials. Revoked records and their initial timestamps remain durable. Real-database HTTP/SDK tests cover concurrent login/issuance, mixed administrator races, next-request denial, a fresh gateway instance, and transaction rollback when database validation rejects revocation. Storage outages fail safely with 503; ambiguous commits require state inspection. Direct operator database edits remain outside application guarantees. Already admitted requests may finish.

## Administrator password reset (#12)

Reset requires an eligible administrator dashboard session, trusted Origin, and session-bound CSRF; bearer credentials and member sessions cannot authorize it. Strict JSON accepts only a validated temporary password. The target password hash, required-change flag, and deletion of all target sessions commit atomically. A user-record write coordinates with concurrent login and key issuance. Role/status and API keys are preserved; current eligibility blocks retained keys on subsequent MCP requests until password replacement. Replacement invalidates all sessions and requires fresh login. Already admitted requests may finish. Unexpected failures return safe 503; an uncertain commit may have completed. Operator recovery uses a separate CLI and revokes keys; no bootstrap fallback is introduced. See [reset workflow](dashboard-sessions.md#reset-a-password-12).

## Operator administrator recovery (#13)

`recover-admin` trusts the operator's MongoDB access, not dashboard credentials or the bootstrap secret. It accepts only an explicit existing canonical user ID and reads the temporary password from hidden terminal input or a mounted file. Strict argument parsing and fixed failure messages avoid exposing input values, file errors, or database exceptions. Recovery uses the shared administrator coordination transaction and writes the target user to conflict with login, password replacement and key issuance. Role/status restoration, hashed password assignment with mandatory replacement, session deletion and permanent key revocation commit together. Previously revoked timestamps are preserved; setup consumption is untouched. Old sessions and keys remain invalid after replacement, so fresh login and new key issuance are required. A commit acknowledgement failure can leave a completed recovery; inspect state before retrying. Already admitted operations may finish. Real MongoDB CLI/HTTP/SDK tests cover missing targets, member/disabled administrator restoration, old-credential rejection, fresh access, revocation failure rollback and secret-safe output. No new HTTP enrollment path, bootstrap fallback, deployment change or durable audit storage is introduced.

## Upstream destinations (#16)

Upstream URLs are untrusted configuration. The shared connection boundary enforces exact operator-approved origins, all-answer DNS address checks and IP-literal socket dialing, preserving TLS hostname verification. Redirects are denied before following them, preventing credential forwarding and redirect-based policy bypass. Recovery and new sockets reapply the policy; one rejected service cannot disable healthy services. URL credentials, unsafe schemes, metadata/link-local and known administrative destinations are denied. The Kubernetes-injected API service IP and configured `UPSTREAM_DENIED_CIDRS` override approvals, including DNS aliases on port 443. Controlled loopback requires an explicit development exception and exact origin/range, forbidden in production.

Private cluster ranges cannot identify a Kubernetes workload or defend against compromised DNS/routing/Service administration within an approved range. Egress enforcement remains deployment-dependent: Helm preserves ingress policies and now restricts gateway egress to narrow DNS/MCP peers and explicit operator MongoDB/API/additional approvals. See [egress configuration and live verification](gateway-egress.md); an enforcing CNI and site overlay remain required. Additional origins require independent application and deployment egress approval. See [configuration, limits and verification steps](upstream-destinations.md). Registration calls the exported validator before persistence; edit APIs remain separate work.


## Persistent upstream inspection (#17)

MongoDB now controls desired upstream registrations. Stored configuration is validated before registration and uses the existing destination boundary for all connections. Versioned transactional migration inserts missing defaults and completion together; storage failure cannot enable a static registry or bootstrap authentication fallback. Existing URLs, disabled state and Secret references survive migration; completed migration never resurrects deleted defaults. Observed availability and discovered tools remain runtime-only, with no observation writes capable of overwriting desired state.

Administrator inspection reuses eligible dashboard sessions and backend roles, rejects bearer-only access, and returns no-store safe projections. Only administrator details include configured URLs; clients, headers and Secret reference values are omitted. Error text is fixed, and upstream descriptions/schemas remain untrusted content. Secret-requiring registrations fail closed until credential resolution is implemented. Operators with MongoDB access remain trusted to modify desired configuration, subject to destination validation; out-of-band edits require restart. Run one gateway replica. No credential resolver, deployment isolation or durable audit capability is claimed. Manual refresh requires an eligible administrator session, trusted Origin and CSRF; disabled registrations return 409 and cannot be implicitly enabled. See [response contracts and operational limits](upstream-registrations.md).


## Live upstream registration (#18)

Administrator creation reuses server-side session eligibility/roles plus trusted Origin and CSRF. Strict input accepts only authentication mode none, rejects unknown/credential fields, and validates stable namespaces and canonical destinations before persistence or network access. Unique indexes arbitrate concurrent identifier/endpoint conflicts. Durable configuration precedes bounded discovery; offline outcomes are sanitized and retained for recovery, while storage failure cannot publish new tools. Per-server serialization, revision-associated observations and runtime generation checks protect delayed lifecycle results and stale invocation mappings; duplicate discovered names cannot disrupt healthy upstreams.

New namespaces do not expand member allowlists. The live catalog is rebuilt for each MCP request; gateway key revocation/current roles remain checked independently of dashboard sessions and every admitted execution uses `executeTool`. No new credential forwarding, Secret access, public upstream exposure or retry of writes is introduced. A lost response may follow a durable insert, so operators inspect by ID before retrying. Live changes require one gateway replica; out-of-band database changes and cross-replica synchronization remain unsupported. See [API and operator limits](upstream-registrations.md#register-without-restart-18).


## Upstream lifecycle barriers (#19)

Disable/enable/remove require eligible administrator dashboard sessions and trusted Origin/CSRF checks. Persisted disabled intent precedes the runtime invocation barrier; removal additionally waits for cleanup before deleting configuration. No Secret or persistent volume is deleted. Generation and live catalog checks prevent remembered mappings or delayed discovery from reviving withdrawn tools. Already-admitted calls drain within their existing timeout; they are not retried. Late failures cannot disable replacement connections, and unrelated upstreams remain independently available. Persistence/cleanup failure returns safe non-success; a disabled record or retained cleanup handles allow retry. Recovery and ambiguous responses are documented in [lifecycle ordering and recovery](upstream-registrations.md#disable-enable-and-remove-19). One replica remains required. Production credential resolution uses approved Secret references; gateway egress enforcement requires the chart policy, site overlay and enforcing CNI.

## Upstream Secret references (#22)

Raw upstream credentials are rejected by management APIs. Exact namespace/name/key approval is enforced independently of the injectable Kubernetes I/O adapter, before API persistence and again at resolution. The mounted ServiceAccount token/CA are used only against the fixed Kubernetes API origin with bounded GET and no redirect. RBAC permits only get on approved names in the release namespace; the application further restricts keys. RBAC cannot restrict individual keys within a Secret, so use dedicated Secrets. No provisioning/deletion API or cluster-wide permissions are introduced.

Resolved headers remain in backend transport memory, never desired documents, status or audit records. Credential edits withdraw old catalogs/generations even on replacement failure; reconnect rereads current values without anonymous fallback. Custom headers cannot override gateway/upstream protocol, proxy, cookie or routing controls. Upstream redirects are denied before credentials reach another destination. Missing/forbidden reads isolate that upstream. An intentionally malicious upstream can echo its own credentials in returned data; such data remains untrusted. See [rotation and deployment limits](upstream-credentials.md), including current-connection lifetime, single-replica scope and deployment-dependent Kubernetes API egress.

## Gateway egress (#23)

The egress policy confines gateway sockets to approved workload/host-route and port pairs. API VIP/backend host routes are appended to application upstream hard denials, preventing MCP use of the API network exception. NetworkPolicy cannot inspect HTTPS paths: the fixed TLS Secret adapter, exact key approval and named get-only ServiceAccount Role remain essential. All policies are additive; extra policies, mutable labels, DNS/Service control, node exemptions, connection tracking, proxies and CNI DNAT behavior can weaken isolation. Other workloads retain unrestricted egress. Empty external MongoDB/API peer lists fail closed and need a site overlay. Managed MongoDB has its own narrow same-namespace Pod/port rule. One gateway replica remains required. The [read-only verifier](gateway-egress.md) distinguishes rendered checks, real Pod-network Secret reads and controlled connectivity denials; no live enforcement is implied by manifests.


## Browser session journey (#25)

Browser storage contains no passwords, CSRF tokens, gateway keys or session credentials. A shared client uses same-origin cookie requests and session-bound CSRF on mutations; it never supplies bearer keys. Backend trusted-Origin and role enforcement are unchanged. Restricted sessions render only password replacement and logout. Member direct links are rejected by route handling and backend management requests remain independently authorized.

Account views unmount when authoritative revalidation detects account changes, invalidation, or expiry, and on logout, clearing transient sensitive state. Unchanged sessions preserve unfinished forms. Background checks defer to pending account actions, preventing cookie-changing responses from being discarded. Session generations prevent late responses from a previous account from repopulating data. Revalidation occurs on reload, focus/visibility and every 30 seconds while visible; changes elsewhere are therefore observed on the next revalidation/request, rather than through push notifications. A 403 refreshes session state but never replays a mutation; ambiguous logout failures are reported accurately. Safe fixed errors cover malformed JSON and invalid session response shapes without exposing response snippets. Real-browser tests exercise the running gateway and transaction-capable MongoDB, with controlled HTTP failures as supplements. Production SPA/API routing, TLS and Kubernetes isolation remain separate deployment work.

## Authenticated chart-managed MongoDB (#34)

The chart optionally deploys an authenticated MongoDB 8.0 single-node replica set with retained StatefulSet storage, internal DNS, bounded idempotent initialization, authenticated probes, resource bounds and Secret references. External transaction-capable databases remain supported through the existing gateway URI Secret. Managed database ingress and gateway egress are limited to the same-namespace gateway/database pair on TCP 27017. Existing WordPress/MariaDB storage and gateway Secret RBAC are unchanged. This is non-HA, without managed TLS or backups; NetworkPolicy enforcement requires a suitable CNI. See [credentials, storage, external mode and non-destructive verification](mongodb-deployment.md).

## Same-origin dashboard deployment (#35)

The dashboard origin routes only `/api` to session-authenticated management routes;
the separate gateway origin retains `/mcp` bearer authentication. Cookie credentials
do not authenticate MCP. Same-origin routing introduces no CORS allowance and
preserves backend roles, trusted Origin, and session-bound CSRF. SPA fallback
excludes `/api`, `/mcp`, and missing assets to avoid masking route mistakes.
Only the public MCP URL enters frontend build configuration. The static container
has no Secrets, API token, or outbound network requirement and runs unprivileged
with a read-only root filesystem. The chart preserves existing gateway egress,
Secret RBAC, and persistent volumes.

Production TLS uses pre-provisioned certificate Secrets. The HTTPS assertion is
accepted only from exact operator-configured ingress proxy IPs, with no subnet or
wildcard default. Operators must maintain trust after proxy IP replacement and
verify controller forwarded-header sanitization. Empty trust fails HTTPS login
closed over internal HTTP. Local insecure cookies require the explicit development
HTTP mode. Readiness remains database-aware but does not remove the management
repair interface when all upstreams fail. NetworkPolicy objects require an enforcing
CNI; identify its version and execute controlled allowed/blocked probes. Modern Kind includes NetworkPolicy support. See
[deployment requirements](dashboard-deployment.md).

## Milestone evidence and remaining trust assumptions (#37)

The [deployed verifier](../infra/helm/urumi/verify-milestone.mjs) is intentionally mutating and restricted to an explicitly selected disposable release/context. It creates a member, issues and revokes keys, changes registrations, and restarts gateway/MongoDB workloads without deleting claims. Secrets and sessions remain in process memory, and failures emit fixed stages. A failed run may leave verification accounts or registrations: inspect before retrying and disable/revoke remaining verification credentials. The fixture does not certify production operations.

Successful application destination rejection, RBAC authorization and rendered NetworkPolicies establish different controls. A CNI name alone cannot establish packet isolation; modern Kind includes policy support. A connection that should be blocked but succeeds is failed enforcement evidence. Obtain a policy-enforcing cluster and run the controlled matrix before marking network isolation verified. Live WooCommerce reads, publicly trusted TLS, controller forwarded-header sanitization, backups, and production readiness require separate evidence. See the [remaining operator steps and Day 5 boundaries](milestone-handoff.md).
