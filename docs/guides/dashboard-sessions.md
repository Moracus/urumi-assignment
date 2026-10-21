# Dashboard sessions and user administration (#4–#12)

Implemented endpoints are `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, and `POST /api/auth/change-password`. Administrator member creation, listing, and inspection are also implemented under `/api/admin/users` (see below). [Personal API-key management](api-keys.md) provides session-scoped `GET/POST /api/keys` and `DELETE /api/keys/:keyId`. These endpoints use MongoDB users established through [initial administrator setup](identity-setup.md) or administrator member creation. Administrator key management, [role changes](#promote-and-demote-administrators-10), and [disabling/re-enabling](#disable-and-re-enable-users-11) are also implemented. Administrator [password resets](#reset-a-password-12) are implemented. [Operator recovery](identity-setup.md#operator-recovery-13) is implemented through a separate CLI. The React dashboard authentication journey is implemented (see [browser dashboard](#browser-dashboard-25)); member-account and personal-key screens are implemented; access-change, administrator key-assistance and server screens and durable audits remain later tickets. Dynamic upstream management is documented in [upstream registrations](upstream-registrations.md). Normal MCP bearer authentication uses [persistent gateway API keys](mcp-authentication.md); dashboard sessions cannot authenticate MCP.

## Configuration

| Variable | Default | Behavior |
| --- | --- | --- |
| `DASHBOARD_TRUSTED_ORIGINS` | Empty | Comma-separated exact origins including scheme, host, and port. Empty denies login and dashboard mutations. No wildcards, paths, credentials, or `null` origins. |
| `DASHBOARD_ALLOW_HTTP` | `false` | Only literal `true`/`false`. `true` explicitly permits development HTTP and omits Secure. Startup rejects it when `NODE_ENV=production`. |
| `DASHBOARD_TRUSTED_PROXIES` | Empty | Comma-separated exact proxy IP addresses, not CIDRs or wildcard trust. Forwarded headers from other peers are ignored. |

Origins must use HTTPS unless development HTTP is enabled. Invalid configuration fails startup with a safe diagnostic. Secure mode requires actual HTTPS or exactly `X-Forwarded-Proto: https` from a configured proxy. Configure the actual socket peer addresses, and require that your trusted edge overwrites that header. Source IP selection walks `X-Forwarded-For` from the socket peer right to left, stopping at the first untrusted hop. Malformed forwarding chains fall back to the socket peer. Equivalent IPv6 and IPv4-mapped spellings are canonicalized so they share proxy trust and source-IP limits. `Forwarded` and other headers do not establish trust.

Dashboard and management APIs use one public origin. Use a Vite same-origin proxy for local frontend development. The MCP SDK retains its Host and Origin protections; when binding on loopback, its Origin hook also restricts origins to localhost-class hosts. Keep the external host in `MCP_ALLOWED_HOSTS` when deploying.

For direct local HTTP:

```bash
export MONGODB_URI='mongodb://127.0.0.1:27017/urumi?replicaSet=urumi&directConnection=true'
export NODE_ENV=development
export DASHBOARD_ALLOW_HTTP=true
export DASHBOARD_TRUSTED_ORIGINS=http://localhost:3000
pnpm --filter @urumi/gateway dev
```

For production, retain `DASHBOARD_ALLOW_HTTP=false`, set `NODE_ENV=production`, configure the real HTTPS origin, and explicitly configure the TLS-terminating proxy's IPs. Default settings trust no proxy. Do not enable development HTTP to work around missing TLS/proxy configuration.

## HTTP examples

Use an existing account's final password. Login accepts JSON with exactly `email` and `password`; email is trimmed/lowercased, passwords preserve whitespace and Unicode and accept 12–128 code points. Inputs are limited to 4096 bytes. Invalid input yields safe `400`/`413`/`415`, while incorrect credentials, missing users, and disabled users all yield `401 {"error":"Invalid credentials"}`. Missing/untrusted Origin yields `403 {"error":"Forbidden"}`.

The following prompts keep passwords out of shell history, command arguments, and files. The private temporary directory contains a cookie credential and safe responses; treat the cookie jar as a secret and remove the directory when finished.

```bash
umask 077
session_dir=$(mktemp -d)
python3 -c 'import getpass,json,sys; print("Email: ",file=sys.stderr,end="",flush=True); email=input(); print(json.dumps({"email":email,"password":getpass.getpass("Password: ")}))' \
  | curl --fail-with-body --silent --show-error \
      -c "$session_dir/cookies" \
      -H 'Origin: http://localhost:3000' \
      -H 'Content-Type: application/json' \
      --data-binary @- http://localhost:3000/api/auth/login \
      > "$session_dir/login.json"
```

Login returns `200` with `{ "user": { "id", "email", "role", "status", "requiredPasswordChange", "createdAt", "updatedAt" }, "csrfToken": "<session-bound-token>" }`. Password/session hashes and the opaque cookie are never included in the JSON. The response sets a host-only `urumi_dashboard` cookie with `Path=/api`, `HttpOnly`, `SameSite=Lax`, explicit Expires, and Max-Age 28800; Secure is present outside explicit development HTTP mode. Every auth response has `Cache-Control: no-store`.

```bash
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" http://localhost:3000/api/auth/me \
  > "$session_dir/me.json"
```

`GET /api/auth/me` returns the same safe user/CSRF shape, resolving role, status, and password-change state from MongoDB on each request. It does not renew the session or cookie. Missing, invalid, expired, orphaned, or disabled-account sessions receive `401 Unauthorized`. Users requiring password replacement may access only account details, password change, and logout. Ordinary session authentication denies them with `403 Password change required`, regardless of role; later management/key routes must use that default enforcement. These three recovery endpoints explicitly permit pending replacement. Administrator creation/list/inspection routes are described below; personal key requests are documented in [API-key management](api-keys.md).

Logout requires both the trusted Origin and this session's token. A token from a different device is rejected. This example uses `jq` to read the token from the safe response:

```bash
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" -c "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -X POST http://localhost:3000/api/auth/logout
unset csrf_token
```

Successful logout returns `204`, deletes only the current session, and expires its cookie with the same scope/security attributes. Reuse returns `401`; other device sessions continue working. Logout never changes MCP credentials. A gateway bearer credential alone cannot authenticate any dashboard endpoint; a dashboard cookie alone cannot authenticate `/mcp`. Use the production HTTPS origin consistently in all URLs and Origin headers when deployed.

## Replace a password

`POST /api/auth/change-password` accepts JSON containing exactly `currentPassword` and `newPassword`. Both preserve whitespace and Unicode and must contain 12–128 code points. The new password must differ from the current password. The route requires a dashboard cookie, an exact trusted Origin, and that session's `X-CSRF-Token`, including for users awaiting required replacement. Bearer credentials cannot authorize it.

Run the login and current-user examples above to obtain a live session and write `me.json`. If you already ran logout, log in again and refresh `me.json`. Then use hidden prompts to avoid exposing either password in shell history or command arguments:

```bash
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
python3 -c 'import getpass,json; print(json.dumps({"currentPassword":getpass.getpass("Current password: "),"newPassword":getpass.getpass("New password: ")}))' \
  | curl --fail-with-body --silent --show-error \
      -b "$session_dir/cookies" -c "$session_dir/cookies" \
      -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
      -H 'Content-Type: application/json' \
      --data-binary @- http://localhost:3000/api/auth/change-password
unset csrf_token
```

Success returns `204`, expires the current cookie, atomically replaces the Argon2id hash, clears `requiredPasswordChange`, and deletes **all** of this user's dashboard sessions. Log in again with the new password to obtain a fresh cookie and CSRF token. Other users' sessions are unaffected. Ordinary password changes do not revoke or alter gateway API keys. Personal key issuance and MCP authentication reuse `isUserEligibleForOrdinaryAccess()` to block pending-password accounts and allow existing unrevoked keys after replacement.

Invalid or unknown JSON fields and password bounds return `400 Invalid request`; an incorrect current password returns `400 Current password is incorrect`; an unchanged password returns `400 New password must be different`. Missing/invalid/expired sessions return `401 Unauthorized`. Origin/CSRF failures return `403 Forbidden`; storage or hashing failures return `503 Authentication unavailable`. Responses are non-cacheable and never include passwords, hashes, or raw exceptions. Failed validation leaves account and sessions intact. If another password change wins concurrently, the stale request is rejected. Login's transactional user write prevents an old-password login from creating a session that escapes invalidation.

A connection failure during transaction commit can leave the password changed even if the client receives `503`; attempt fresh login with the new password before retrying. Already admitted requests need not be canceled. Administrator resets use the workflow below. Assigned member creation uses the same pending-password state and enforcement.

## Persistence, throttling, and failure behavior

Fresh login creates an independent 32-byte cryptographically random opaque credential. Only its SHA-256 digest is persisted in `dashboard_sessions`, indexed uniquely and by user. Eight-hour expiry is fixed at login and checked during authentication; MongoDB TTL cleanup is only housekeeping. CSRF tokens are domain-separated SHA-256 derivations of the opaque credential, so they survive restarts without storing a raw credential or CSRF secret. They cannot be reconstructed from the stored session digest.

`login_throttles` persists rolling 15-minute windows: five failed attempts per normalized account identifier, and 30 total attempts per source IP. Identifiers/IPs are stored as domain-labelled digests. Transactions coordinate reservations across replicas and restarts; successful login removes only its own account reservation, while all attempts still consume IP budget. Blocked account attempts count against the IP budget. In-flight or interrupted attempts conservatively occupy an account failure slot until completion or window expiry. Limits produce generic `429 {"error":"Too many attempts"}` and no permanent lockout. TTL expiration does not determine whether a window is active.

Argon2 retains its two-job per-process bound. Unknown users incur dummy Argon2 verification to avoid an account-existence timing shortcut. Hashing overload and unexpected authentication/storage failures return safe `503 Authentication unavailable`, with no credential fallback. Storage operations use the existing bounded connection/operation/transaction deadlines. Database outage/recovery tests pause and resume only the disposable test database, verifying safe bounded failures, process liveness, and restoration of the same session.

Session creation transactionally checks current status/password and increments the user's `credentialRevision`. Password replacement updates that same user and invalidates all its sessions in one transaction. Disabling does likewise and also revokes all API keys, as required by the identity ADRs; administrator resets invalidate sessions without revoking keys. Use the status PATCH workflow below; merely flipping database status back and forth is not the credential-invalidation workflow. Database operator access remains privileged. A lost connection during commit can leave a persisted session even if the client receives 503; it expires after eight hours, and retrying login creates a separate session.

## Helm and validation

`gateway.dashboard.trustedOrigins`, `allowHttp`, and `trustedProxies` wire the corresponding environment variables. `gateway.nodeEnv` defaults to production. Local values explicitly select development HTTP and `http://gateway.localhost`; production values use a placeholder HTTPS origin, secure cookies, and no trusted proxies. Replace placeholder origins and supply real proxy addresses. The chart still exposes only `/mcp`; `/api` ingress/dashboard routing and the complete Kubernetes rollout remain later work. Use direct local access to exercise this slice. No upstream exposure, NetworkPolicy, PVC, or Secret permissions change.

Run workspace checks and the real-database suite:

```bash
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway test:integration
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml
```

The existing integration runner includes the dashboard HTTP tests automatically. MongoDB must be a replica set and must permit creation of the new session/throttling collections and indexes. Existing local account data is preserved.

## Create and inspect members (#6)

These routes require a live dashboard session for an administrator with no pending password replacement. Roles are resolved from MongoDB on every request. Members receive `403 Forbidden`; pending-password users receive `403 Password change required` regardless of role. Missing sessions and bearer-only requests receive `401 Unauthorized`. Creation additionally requires trusted Origin and the session-bound CSRF token. All responses use `Cache-Control: no-store` and contain only the safe user fields shown above.

| Endpoint | Request | Successful response |
| --- | --- | --- |
| `POST /api/admin/users` | JSON with exactly `email` and `password` | `201 { "user": { "id", "email", "role", "status", "requiredPasswordChange", "createdAt", "updatedAt" } }` |
| `GET /api/admin/users?page=1&limit=20` | Positive integer query values; default page 1, limit 20 | `200 { "users": [safe user objects], "page": 1, "limit": 20 }` |
| `GET /api/admin/users/:userId` | Canonical 24-character hexadecimal account ID | `200 { "user": safe user object }` |

Creation always assigns `role: member`, `status: active`, and `requiredPasswordChange: true`. Email is trimmed and lowercased and protected by the existing unique index. Assigned passwords preserve whitespace/Unicode, require 12–128 code points, and are stored only as Argon2id hashes. Role, status, identity claims, hashes, and other unknown body fields are rejected with `400 Invalid request`. Duplicate normalized email returns `409 Email already exists`, including competing requests from different gateway instances. Hashing/storage failures return safe `503 Authentication unavailable`; a failed connection after insertion can leave the account created, so inspect the account list before retrying.

Lists are ordered by account ID ascending. `limit` accepts 1–100 and `page` accepts 1–2147483647; unknown, repeated, non-integer, or out-of-range query fields return `400 Invalid request`. Pages beyond the list are empty. Offset pagination does not provide a snapshot across concurrent account additions. A malformed account ID returns `400`; a valid missing ID returns `404 User not found`. Passwords, hashes, and internal credential revisions never appear in these responses.

After administrator login, fetch `/api/auth/me` using the earlier example to obtain `me.json`. Create the member using hidden input:

```bash
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
python3 -c 'import getpass,json,sys; print("Member email: ",file=sys.stderr,end="",flush=True); email=input(); print(json.dumps({"email":email,"password":getpass.getpass("Assigned temporary password: ")}))' \
  | curl --fail-with-body --silent --show-error \
      -b "$session_dir/cookies" \
      -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
      -H 'Content-Type: application/json' \
      --data-binary @- http://localhost:3000/api/admin/users \
      > "$session_dir/member.json"
unset csrf_token

curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" 'http://localhost:3000/api/admin/users?page=1&limit=20'

member_id=$(jq -r '.user.id' "$session_dir/member.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" "http://localhost:3000/api/admin/users/$member_id"
unset member_id
```

Deliver the assigned password to the member through your chosen private channel. The member uses a separate cookie jar to log in with that password and obtains their own CSRF token. Until replacement, only `/api/auth/me`, `/api/auth/change-password`, and `/api/auth/logout` are permitted. Follow **Replace a password** above with the assigned password as `currentPassword` and a different final password as `newPassword`. Success invalidates all member sessions; log in again with the final password. The fresh account reports `requiredPasswordChange: false`, while administrator routes remain denied to the member. No invitation/email delivery or dashboard UI is included; explicit role promotion is documented below. MCP authentication with persistent keys is implemented; public `/api` Ingress remains later work. Bootstrap credentials do not authenticate MCP.

## Promote and demote administrators (#10)

`PATCH /api/admin/users/:userId` accepts JSON containing `role`, either `admin` or `member`, and/or `status` as described below. It requires an eligible administrator's live dashboard session, exact trusted Origin, and session-bound CSRF token. Creation still produces members; promotion is a separate explicit action. Every administrator has equal authority, including the ability to demote another administrator or themselves when another active administrator remains.

Using the cookie jar, `me.json`, and member ID from the examples above:

```bash
member_id=$(jq -r '.user.id' "$session_dir/member.json")
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -H 'Content-Type: application/json' \
  -X PATCH --data '{"role":"admin"}' \
  "http://localhost:3000/api/admin/users/$member_id"
unset csrf_token member_id
```

Use `{"role":"member"}` to demote. Success returns `200 {"user": safe user object}` with the same safe fields as inspection and `Cache-Control: no-store`. Same-role requests succeed. Role-only changes preserve passwords, required-password-change state, sessions, API keys, and key IDs. Promoting a disabled or pending-password user does not grant ordinary access until their separate eligibility requirements are met.

Missing/invalid sessions receive `401`; members, pending-password administrators, and Origin/CSRF failures receive `403`. Malformed IDs, empty patches, invalid roles/status, and unknown fields receive `400`; a valid missing user ID receives `404 User not found`. Email, password, and client identity fields are rejected. Non-JSON requests receive `415`; bodies over 4096 bytes receive `413`.

Demoting the last active administrator returns `409 {"error":"At least one active administrator must remain"}` and rolls back the entire change. Active means `status: active`; disabled administrators do not count. A transaction writes the shared `account_coordination` singleton before changing roles and counting active administrators. Concurrent demotions across gateway instances therefore serialize through MongoDB conflict retries; with two active administrators, competing self-demotions yield one success and one conflict. Status changes use the same `withActiveAdministrator()` transaction; disabling includes credential invalidation within it.

Existing dashboard sessions and connected MCP clients use the changed database role on their next request without restart or new keys. MCP discovery remains permission-filtered and direct calls independently enforce authorization through the existing execution path. Clients that cache tool catalogs should refresh discovery. Already admitted requests may complete. Storage errors remain safe `503 Authentication unavailable`; an uncertain commit can have succeeded despite a 503, so inspect current account state before retrying. Startup initializes the coordination collection automatically; no new configuration or manual database migration is required. Dashboard UI, public API Ingress, and Kubernetes rollout remain later work.

## Disable and re-enable users (#11)

`PATCH /api/admin/users/:userId` also accepts `{"status":"disabled"}` or `{"status":"active"}`, optionally together with `role`. At least one field is required; unknown fields and any other status are rejected. The same live eligible administrator session, exact trusted Origin, CSRF token, JSON/body limits, safe user response, and error handling apply. All administrators have equal authority. Disabling yourself is allowed when another active administrator remains; otherwise the request returns 409 and rolls back all changes, including credential invalidation. Mixed concurrent disabling/demotion uses the shared atomic administrator protection.

Using the administrator cookie jar and member ID from the examples above:

```bash
member_id=$(jq -r '.user.id' "$session_dir/member.json")
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -H 'Content-Type: application/json' \
  -X PATCH --data '{"status":"disabled"}' \
  "http://localhost:3000/api/admin/users/$member_id"
unset csrf_token member_id
```

Use `{"status":"active"}` to re-enable. Disabling transactionally deletes every existing dashboard session and permanently revokes every existing gateway API key, including keys issued by administrators. Revoked metadata is retained and previous revocation timestamps are preserved. Repeated disabling is safe. The user-record write serializes with concurrent login and key issuance on either management route: credentials created before disabling commits are invalidated; issuance/login after disabling cannot succeed. Newly protected requests fail immediately, including subsequent discovery/calls from a connected MCP client; already admitted requests may finish.

Re-enabling requires fresh login and new keys. It preserves the password and required-password-change flag, never restores old sessions/keys, and never bypasses password replacement. A pending-password user can log in only for account details, password change, and logout until replacement. A transaction failure rolls back account and credential changes together and returns safe 503. An uncertain commit can have succeeded despite a 503; inspect account/key state before retrying. Direct database edits are privileged operations outside this workflow. No new configuration, deployment, or manual migration is required; full Kubernetes rollout and public API routing remain pending.

## Reset a password (#12)

`POST /api/admin/users/:userId/reset-password` accepts JSON containing exactly `password`, the assigned temporary password (12–128 code points, preserving whitespace and Unicode). An eligible administrator must supply a live dashboard session, trusted Origin, and that session's CSRF token. The target's current password is not required. Success returns `204` with an empty body and `Cache-Control: no-store`.

Using the administrator cookie jar, `me.json`, and member ID from the examples above:

```bash
member_id=$(jq -r '.user.id' "$session_dir/member.json")
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
python3 -c 'import getpass,json; print(json.dumps({"password":getpass.getpass("Assigned temporary password: ")}))' \
  | curl --fail-with-body --silent --show-error \
      -b "$session_dir/cookies" \
      -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
      -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:3000/api/admin/users/$member_id/reset-password"
unset csrf_token member_id
```

The transaction stores an Argon2id hash, sets `requiredPasswordChange: true`, and deletes every target dashboard session. It preserves the target's role, active/disabled status, and all gateway API-key records. The user-record write serializes with concurrent login, key issuance, and password replacement. Login using the old password cannot leave a session that survives reset. Already admitted operations may finish.

Deliver the temporary password privately. The target logs in with it and may access only account details, password change, and logout. Personal and administrator-assisted key issuance are denied; existing unrevoked keys cannot authenticate MCP requests, including further requests by an already-connected SDK client. Follow **Replace a password** above using the temporary password as `currentPassword` and a different final password as `newPassword`. Replacement invalidates all dashboard sessions again and requires fresh login. Previously unrevoked keys then work with their existing values; revoked keys remain revoked. Resetting a disabled account does not enable it.

Missing/invalid sessions or bearer-only authentication receive `401`; members, pending-password administrators, and Origin/CSRF failures receive `403`. Malformed target IDs or invalid/unknown body fields receive `400`; a valid missing target receives `404 User not found`. Non-JSON input receives `415`; bodies over 4096 bytes receive `413`. Storage/hashing failures return safe `503 Authentication unavailable`. An uncertain transaction commit may have succeeded despite a 503; inspect the target's state and try the assigned password before retrying.

Administrator reset differs from **operator recovery**, available through the [separate CLI](identity-setup.md#operator-recovery-13): recovery requires database operator access, restores an explicitly selected existing user as an active administrator, and invalidates both sessions and API keys. Reset uses existing administrator authority, preserves role/status and keys, and never reopens initial setup or bootstrap MCP authentication. No new configuration, manual migration, or deployment change is required for reset. The React dashboard exposes this workflow through **Reset password** in user details (see [responsive user management](#responsive-user-management-49)); direct API access remains available.


## Browser dashboard (#25)

The React/Vite dashboard uses the existing four authentication endpoints through one typed same-origin JSON client (`apps/dashboard/src/api.ts`). Login provides required-field feedback, safe errors, and disabled pending controls. Navigation shows the backend-provided email and role and the current page. `/dashboard` and the [personal-key page](api-keys.md#personal-key-dashboard-26) at `/keys` are protected; `/admin/users` provides the [member-account screen](#member-account-dashboard-27); `/admin/servers` remains an administrator-only placeholder. Member direct links show access denied; backend APIs independently enforce authorization.

A restricted session is routed to `/change-password` with only password replacement and logout available. Replacement invalidates sessions and requires fresh login. Password fields clear on submission. Cookies remain server-issued and HttpOnly; passwords and CSRF tokens are never written to localStorage or sessionStorage. Management requests never use gateway bearer keys.

Reload, window focus, returning to a visible tab, and a 30-second visible-tab check revalidate `/api/auth/me`. Unchanged sessions preserve an unfinished form; changed accounts, roles, expired/invalidated sessions, password replacement, and logout unmount the previous account view and clear its transient state. Background checks are deferred during login, password replacement, and logout so a check cannot discard a successful account transition. Session generations cause the shared client to reject delayed responses from previous sessions. Session JSON is validated before publishing it. Typed JSON readers supply a decoder to the shared client instead of asserting an untrusted response type. New feature modules must use this client and keep sensitive state inside the protected account view so unmount clears it.

A mutation returning 403 refreshes authoritative session/CSRF state and asks for deliberate resubmission; it is never automatically replayed. The backend intentionally uses the same safe Forbidden response for Origin, CSRF, and authorization failures, so refresh applies to any 403. Logout reports success only after server confirmation; network/service failures retain a retryable session and explicitly say logout was not confirmed. A 401 clears the local account state. Gateway API keys remain independent of logout and ordinary password replacement.

For local development, first configure transaction-capable MongoDB and perform [initial administrator setup](identity-setup.md), then start gateway and dashboard in separate terminals using the same gateway environment:

```bash
export NODE_ENV=development
export DASHBOARD_ALLOW_HTTP=true
export DASHBOARD_TRUSTED_ORIGINS=http://localhost:5173
pnpm --filter @urumi/gateway dev
# In a second terminal:
pnpm --filter @urumi/dashboard dev
```

Open `http://localhost:5173`. Vite proxies `/api` to `http://localhost:3000`. Its public origin, including the port, must exactly match the trusted origin. Production same-origin static hosting, SPA fallback, TLS and Helm dashboard deployment remain separate work; this ticket changes no Kubernetes resources.

### Browser integration tests

Install dependencies and Chromium once, build the gateway, then provision only the disposable test replica set:

```bash
pnpm install --frozen-lockfile
pnpm --filter @urumi/dashboard exec playwright install chromium
pnpm --filter @urumi/gateway build
docker compose -p urumi-identity-integration -f infra/mongodb/compose.integration.yaml up -d --wait --wait-timeout 90
export MONGODB_TEST_URI='mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true'
pnpm --filter @urumi/dashboard test:browser
docker compose -p urumi-identity-integration -f infra/mongodb/compose.integration.yaml down
```

The fixture also starts controlled calculator, time and WooCommerce MCP tools on a loopback-only server for key/client integration; these never contact a real store. The reusable fixture starts the real Fastify gateway on loopback port 3009 and Vite on port 5174. It creates a randomly named isolated database, establishes an administrator through the setup interface, and drops only that database during shutdown. It requires an explicitly supplied test replica-set URI and does not reuse running web servers. A Vite middleware installed only by the fixture can move the calling browser’s stored session expiry into the past; a second test-only route clears login-attempt budgets before each key and account test so the combined suite does not exhaust one shared source-IP budget. Neither control exists in the production application. These tests should run sequentially with the gateway integration runner, whose outage tests pause the disposable MongoDB container.

The browser suite covers login validation/failure/pending/success, HttpOnly cookies, empty browser storage, password replacement/fresh login, reload, member navigation and backend denial, role changes, disabling and server invalidation, CSRF refresh without replay, trusted-Origin rejection, accurate logout failure, preserved MCP key authentication, safe malformed JSON/session-shape errors, actual stored-session expiry, stale-response rejection, and focus checks racing account transitions. Controlled HTTP responses supplement the real gateway for otherwise difficult failure branches. Existing backend integration tests additionally cover fixed session lifetime and MongoDB outages. Browser tests do not establish Kubernetes deployment or network isolation.

## Member-account dashboard (#27)

At `/admin/users`, administrators browse accounts in bounded pages of ten, move forward and backward, refresh the list, and inspect a user's identifier, email, role, status, password-replacement requirement, and creation/update timestamps. Counts describe only the current page; no total is inferred. A full last page may lead to an empty next page because the existing API provides no total or continuation flag. Lists and details show loading, empty/not-found, unavailable and safe error states with deliberate retries. Details are fetched from the existing authenticated endpoint rather than assumed from a list snapshot.

The creation form accepts only email and assigned password. Passwords must contain 12–128 Unicode code points; email conflicts and validation failures produce useful feedback. Creation always produces an active member requiring password replacement. Promotion is a separate explicit access change (see #28 below). Pending controls prevent duplicate submission, and mutations are never automatically replayed.

Assigned passwords are cleared from the form on submission (including validation failure), retained only for the in-flight request, and never stored in browser storage or displayed in account details. Deliver the assigned password privately. Session invalidation, logout, account changes and navigation unmount the account views; delayed responses cannot restore a previous session's account data. The existing shared client supplies same-origin cookies and CSRF without any gateway bearer credential. Backend administrator checks protect list, detail and creation independently of UI guards.

To demonstrate locally, use the development setup above, log in as an administrator, open **Users**, enter a member email and assigned password, and select **Create member**. Inspect the new member details, log out, log in as that member, replace the assigned password, and log in again using the replacement. The member cannot open the Users screen or call account-management APIs. Browser coverage in `apps/dashboard/tests/users.spec.ts` exercises this journey against the real gateway and disposable MongoDB, plus real multi-page browsing, duplicate email, password validation, pending/cleanup behavior and controlled list/detail failure responses.

No backend contracts, environment variables, Helm resources, or deployment procedures change for #27. Production dashboard packaging and Kubernetes verification remain separate work. Use the existing browser test commands above; these tests do not verify a deployed cluster.

## User access changes (#28)

User details now offer **Promote to administrator**, **Demote to member**, **Disable user**, and **Re-enable user** according to the returned account state. Administrators have equal authority, including over the initial administrator. The existing atomic backend guard rejects changes leaving no active administrator; the dashboard explains that another administrator must first be promoted or re-enabled. No frontend count substitutes for that guard.

Disable requires confirmation and permanently invalidates the user's existing dashboard sessions and gateway API keys. Re-enable permits fresh login and key issuance; old credentials remain invalid. Role changes preserve credentials while backend authentication resolves the current role on every request. Self-directed changes revalidate the signed-in account immediately. Other open dashboards clear account and credential views on their next API rejection, focus/visibility check, or periodic session check (up to 30 seconds while visible).

Changes use the existing session-authenticated, Origin/CSRF-protected `PATCH /api/admin/users/:userId` contract. Pending controls prevent repeated submission. Details and visible list rows use the validated backend response; failures retain the prior displayed state and offer deliberate retry or **Refresh details**. Validation, last-administrator conflicts, unavailable services, and malformed responses produce safe feedback without echoing backend exceptions. A failed or interrupted response can leave the outcome uncertain; refresh authoritative details before submitting again. Mutations are never replayed automatically.

To demonstrate, create a member, inspect their details, promote them, complete their first-login password replacement, and log in as that administrator to change another administrator's role. Restore that administrator before demoting the promoted account. With a member logged in and an MCP client connected using their key, disable the member, verify their access ends, and re-enable them. Fresh login and a newly issued key work; the previous cookie and continuing MCP client's old key remain rejected. Attempt demotion or disable of the sole active administrator to see the guard's explanation.

`apps/dashboard/tests/access.spec.ts` exercises these workflows through real browser, gateway, disposable MongoDB and MCP SDK boundaries, plus controlled pending, validation, unavailable and malformed-response cases and logout during a delayed mutation. `users.spec.ts` covers last-administrator rejection. This change adds no backend interfaces, environment variables, dependencies, Helm changes or deployment steps. Production packaging and cluster verification remain separate work.

## Dashboard overviews (#33)

After login (and required password replacement), `/dashboard` shows an overview for the authenticated role:

- Administrators see **Registered servers**, **Available tools**, and **Users**, with links to server and user management. Registered servers includes disabled and unreachable registrations. Available tools sums the backend's live `toolCount`, so unavailable catalogs contribute zero. Users includes every returned account, regardless of role, enabled state, or pending password replacement.
- Members see **Active API keys** and the existing public MCP endpoint/Streamable HTTP instructions, with a link to personal key management. Active means `revokedAt` is null; retained revoked records do not contribute. The view reads only the authenticated owner's `/api/keys`, never administrator catalogs or another user's records. Connection information uses the public runtime `dashboard.publicMcpUrl` served by `/runtime-config.json`; missing or invalid configuration retains the existing operator configuration message without guessing an internal destination.

The overview reuses the complete `/api/admin/servers` list and existing paginated `/api/admin/users` or `/api/keys` contracts, reading ten records per page through a final short or empty page. It does not treat a first-page length as a total. Counts appear together only after the required reads finish. Loading disables Refresh summary; zero counts have explicit empty messages. Unavailable or malformed initial responses show a safe error with Retry summary and no totals. Since #48, a failed refresh retains the last complete authorized summary with an explicit stale indicator. A failure on a later page never presents partial data as complete.

**Refresh summary** rereads current data; navigation back or reload also performs fresh reads. Counts describe the completed reads, not a live push feed or a transactional snapshot across concurrent changes. Logout, expiry, account replacement, role changes, and navigation discard the previous view. Delayed responses cannot repopulate it; an obsolete pagination walk stops before further pages. The shared client still uses server-issued HTTP-only session cookies and in-memory CSRF for mutations; summary requests are read-only and never use gateway bearer credentials. Existing backend role and ownership checks remain mandatory.

To demonstrate, create more than ten users as an administrator and inspect Dashboard, then register/disable an upstream and refresh the counts. Sign in as an eligible member, create keys spanning multiple pages, revoke records on different pages, and refresh Dashboard; only unrevoked keys belonging to that member count. Member calls to administrator APIs remain forbidden. `apps/dashboard/tests/overview.spec.ts` exercises these journeys against real gateway APIs, disposable MongoDB and controlled upstreams, plus controlled HTTP failures/empty/malformed responses and delayed pages during logout. It also verifies expiry and server-side promotion/demotion replacing the overview.

Use the [existing local setup and browser test commands](#browser-dashboard-25); target this feature with `pnpm --filter @urumi/dashboard test:browser overview.spec.ts`. No new dependency, backend contract, environment variable, Helm resource, Secret or PVC change is required. Rebuild the dashboard with `pnpm --filter @urumi/dashboard build` and serve it using the existing development setup. Production dashboard packaging and Kubernetes deployment remain separate work; browser validation does not verify a live cluster.

Validation executed for #33 on 2026-10-16: `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. The final complete browser suite (`MONGODB_TEST_URI=… pnpm --filter @urumi/dashboard test:browser`) passed all 54 tests after making existing authentication locators precise for the additional overview links/status. `pnpm --filter @urumi/gateway test:integration` passed all 132 tests with no skips using the disposable replica-set/standalone fixture. Standards and specification reviews reported no findings. Helm and live Kubernetes checks were not run; this ticket changes no deployment resources.

## Responsive console (#48)

The shared sidebar/mobile navigation, accessible confirmations, UI tokens and stale-read conventions are documented in [Shared dashboard UI](dashboard-ui.md). Existing account access and session-generation rules continue to apply.

## Responsive user management (#49)

The Users screen uses shared form surfaces, textual role/status badges, responsive details, and a labeled keyboard-scrollable account table. Account lists and details retain the last successful authorized read after refresh failure with an explicit **Stale data** status. Page changes do not show a different page's cached rows. Initial failures show no account data. Refresh or Retry performs a read; stale detail controls stay disabled until a successful refresh.

**Reset password** in user details opens a keyboard-accessible confirmation. Enter a temporary password of 12–128 Unicode code points and explicitly confirm. Cancel receives initial focus; Escape cancels before submission and focus returns to the trigger. Pending confirmations prevent cancellation and repeated submission. The password field clears on submission, including validation failure; closing discards unsubmitted input. Share the temporary password privately. Reset ends all target dashboard sessions, requires replacement and fresh login, and preserves role/status and existing API-key records. Unrevoked keys resume after replacement. Self-reset ends the administrator's session too. Initial setup remains permanently consumed; this is not operator recovery.

Creation, access changes, reset and revocation are never replayed automatically. A failed or malformed mutation acknowledgement may follow a committed operation. Creation guidance directs you to refresh users and inspect the email. Access-change guidance directs you to refresh details and key metadata. For an uncertain reset, cancel the dialog, refresh details, and ask the user to try the assigned temporary password before deliberately deciding on another reset. A required-password flag alone cannot prove which password was saved.

Logout, account replacement, expiry or role/password restrictions clear protected views and one-time credentials through the existing session generation. Delayed reads cannot restore them. Backend equal-administrator authority, last-active-administrator protection, member ownership, and account-disable credential invalidation remain enforced by the existing APIs.

Regression coverage extends `users.spec.ts`, `access.spec.ts`, `keys.spec.ts` and `admin-keys.spec.ts` using real sessions and disposable MongoDB. The latter captures user details, key revocation, reset dialogs and personal key tables at 360px, 768px and 1440px, checks overflow and keyboard focus, and avoids recording raw keys in screenshots. Run `pnpm test:workflow` for workspace typechecks/builds, service tests and the complete browser suite. This change requires only rebuilding/serving the dashboard; no API migration, infrastructure change or deployment was performed.
