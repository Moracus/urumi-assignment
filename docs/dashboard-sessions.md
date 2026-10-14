# Dashboard login, sessions and password replacement (#4–#5)

Implemented endpoints are `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, and `POST /api/auth/change-password`. They use MongoDB users established through [initial administrator setup](identity-setup.md). The React dashboard, administrator password resets, user/key management, operator recovery, dynamic upstream management, and durable audits remain later tickets. Normal MCP bearer authentication still uses the previous bootstrap mechanism; this slice does not make dashboard sessions usable as MCP credentials.

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

`GET /api/auth/me` returns the same safe user/CSRF shape, resolving role, status, and password-change state from MongoDB on each request. It does not renew the session or cookie. Missing, invalid, expired, orphaned, or disabled-account sessions receive `401 Unauthorized`. Users requiring password replacement may access only account details, password change, and logout. Ordinary session authentication denies them with `403 Password change required`, regardless of role; later management/key routes must use that default enforcement. These three recovery endpoints explicitly permit pending replacement. Management/key endpoints themselves are not implemented yet.

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

Success returns `204`, expires the current cookie, atomically replaces the Argon2id hash, clears `requiredPasswordChange`, and deletes **all** of this user's dashboard sessions. Log in again with the new password to obtain a fresh cookie and CSRF token. Other users' sessions are unaffected. Ordinary password changes do not revoke or alter gateway API keys. Persistent key issuance/authentication remain later tickets; they must reuse `isUserEligibleForOrdinaryAccess()` to block pending-password accounts and allow existing unrevoked keys after replacement.

Invalid or unknown JSON fields and password bounds return `400 Invalid request`; an incorrect current password returns `400 Current password is incorrect`; an unchanged password returns `400 New password must be different`. Missing/invalid/expired sessions return `401 Unauthorized`. Origin/CSRF failures return `403 Forbidden`; storage or hashing failures return `503 Authentication unavailable`. Responses are non-cacheable and never include passwords, hashes, or raw exceptions. Failed validation leaves account and sessions intact. If another password change wins concurrently, the stale request is rejected. Login's transactional user write prevents an old-password login from creating a session that escapes invalidation.

A connection failure during transaction commit can leave the password changed even if the client receives `503`; attempt fresh login with the new password before retrying. Already admitted requests need not be canceled. Administrator resets and assigned member creation belong to later tickets, but the pending-password state and enforcement are implemented here.

## Persistence, throttling, and failure behavior

Fresh login creates an independent 32-byte cryptographically random opaque credential. Only its SHA-256 digest is persisted in `dashboard_sessions`, indexed uniquely and by user. Eight-hour expiry is fixed at login and checked during authentication; MongoDB TTL cleanup is only housekeeping. CSRF tokens are domain-separated SHA-256 derivations of the opaque credential, so they survive restarts without storing a raw credential or CSRF secret. They cannot be reconstructed from the stored session digest.

`login_throttles` persists rolling 15-minute windows: five failed attempts per normalized account identifier, and 30 total attempts per source IP. Identifiers/IPs are stored as domain-labelled digests. Transactions coordinate reservations across replicas and restarts; successful login removes only its own account reservation, while all attempts still consume IP budget. Blocked account attempts count against the IP budget. In-flight or interrupted attempts conservatively occupy an account failure slot until completion or window expiry. Limits produce generic `429 {"error":"Too many attempts"}` and no permanent lockout. TTL expiration does not determine whether a window is active.

Argon2 retains its two-job per-process bound. Unknown users incur dummy Argon2 verification to avoid an account-existence timing shortcut. Hashing overload and unexpected authentication/storage failures return safe `503 Authentication unavailable`, with no credential fallback. Storage operations use the existing bounded connection/operation/transaction deadlines. Database outage/recovery tests pause and resume only the disposable test database, verifying safe bounded failures, process liveness, and restoration of the same session.

Session creation transactionally checks current status/password and increments the user's `credentialRevision`. Password replacement updates that same user and invalidates all its sessions in one transaction. Future disable/reset operations must do likewise, as required by the identity ADRs. Account lifecycle endpoints are outside this slice; merely flipping database status back and forth is not the credential-invalidation workflow. Database operator access remains privileged. A lost connection during commit can leave a persisted session even if the client receives 503; it expires after eight hours, and retrying login creates a separate session.

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
