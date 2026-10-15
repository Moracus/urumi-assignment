# Phase 1 operator demonstration (#14)

This walkthrough runs the implemented identity backend locally: permanent initial setup, dashboard sessions, mandatory password replacement, personal keys, authenticated MCP, next-request revocation, role restrictions, and operator recovery. Run commands from the repository root in Bash. Use a fresh local database for first setup; never delete setup state or application data to repeat the demonstration.

## Start storage and services

Requirements: Node **24.7+**, the pinned pnpm, Docker Compose, Python 3, curl, and jq. No WordPress instance is needed for calculator/time smoke tests. Install and build:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
docker compose -p urumi-identity -f infra/mongodb/compose.yaml up -d --wait
export MONGODB_URI='mongodb://127.0.0.1:27017/urumi?replicaSet=urumi&directConnection=true'
export NODE_ENV=development
export HOST=127.0.0.1
export DASHBOARD_ALLOW_HTTP=true
export DASHBOARD_TRUSTED_ORIGINS=http://localhost:3000
export CALCULATOR_MCP_URL=http://localhost:3002/mcp
export TIME_MCP_URL=http://localhost:3003/mcp
export WOOCOMMERCE_MCP_URL=http://localhost:3001/mcp
```

The Compose database is unauthenticated and bound to loopback, with a persistent volume. Its healthcheck initializes a single-node replica set and waits for a writable primary. The URI's direct connection is for local container address discovery only. Do not use this database configuration for a shared deployment.

In three separate terminals, start calculator, time, and gateway respectively. Export the configuration above in the gateway terminal too. The upstream processes use their own default ports; do not export a common `PORT`.

```bash
pnpm --filter @urumi/calculator-mcp start
```

```bash
pnpm --filter @urumi/time-mcp start
```

```bash
pnpm --filter @urumi/gateway start
```

Without WooCommerce running, its unavailable status is expected; calculator and time must remain usable. Check both health responses (readiness may need one refresh interval):

```bash
curl --fail-with-body http://localhost:3000/health/live
curl --fail-with-body http://localhost:3000/health/ready
```

Startup requires `MONGODB_URI`, initialized indexes, and working transactions. Standalone MongoDB and unavailable/misconfigured storage prevent serving. Readiness requires a database ping **and** at least one connected upstream; liveness checks the process. During storage outages newly protected requests return safe `503 {"error":"Authentication unavailable"}`, readiness fails, and liveness remains healthy. No bootstrap fallback occurs. See [storage configuration, deadlines, and privileges](identity-setup.md#startup-runtime-health-and-shutdown).

## Establish the first administrator

Use an operator-provided bootstrap secret file with restrictive permissions. The setup CLI reads the configured secret from this file, then prompts invisibly for the matching secret and your final administrator password:

```bash
export GATEWAY_BOOTSTRAP_KEY_FILE=/run/secrets/configured-bootstrap
pnpm --filter @urumi/gateway setup-admin --email admin@example.com
```

Replace the file path with your existing local secret file. Noninteractive mounted-file options and safe handling are documented in [initial setup](identity-setup.md#first-administrator). Neither passwords nor secrets belong in command arguments, committed files, or pasted output. `GATEWAY_BOOTSTRAP_KEY` is the alternative configured environment value; the file takes precedence for the CLI. The runtime needs neither value for authentication.

Success prints safe user JSON with `role: "admin"`, `status: "active"`, and `requiredPasswordChange: false`. Repeating setup fails permanently, including after account changes. The bootstrap secret never authenticates MCP. Setup is not an HTTP endpoint.

Passwords accept 12–128 Unicode code points without composition rules or truncation. Argon2id uses 64 MiB, three passes, parallelism one, a random salt, and a 32-byte tag. Each process permits two concurrent password jobs; excess work is rejected. These settings are fixed by the implementation, not environment tuning knobs.

## Log in and create a member

The following helpers keep passwords out of shell history and curl arguments. Cookie jars and key responses are credentials: the temporary directory is private, and must be removed when finished. Do not enable shell tracing (`set -x`).

```bash
umask 077
demo_dir=$(mktemp -d)
base=http://localhost:3000
origin=http://localhost:3000

login() {
  python3 -c 'import getpass,json,sys; print("Email: ",file=sys.stderr,end="",flush=True); email=input(); print(json.dumps({"email":email,"password":getpass.getpass("Password: ")}))' \
    | curl --fail-with-body --silent --show-error -c "$demo_dir/$1.cookies" \
        -H "Origin: $origin" -H 'Content-Type: application/json' \
        --data-binary @- "$base/api/auth/login" > "$demo_dir/$1.json"
}

mutate() {
  local csrf
  local -a content_type=()
  csrf=$(jq -er '.csrfToken' "$demo_dir/$1.json") || return
  if (( $# > 3 )); then content_type=(-H 'Content-Type: application/json'); fi
  curl --fail-with-body --silent --show-error -b "$demo_dir/$1.cookies" \
    -H "Origin: $origin" -H "X-CSRF-Token: $csrf" \
    "${content_type[@]}" -X "$2" "${@:3}"
}

login admin
curl --fail-with-body --silent --show-error -b "$demo_dir/admin.cookies" \
  "$base/api/auth/me" > "$demo_dir/admin.json"
python3 -c 'import getpass,json; print(json.dumps({"email":"member@example.com","password":getpass.getpass("Assigned member password: ")}))' \
  | mutate admin POST --data-binary @- "$base/api/admin/users" > "$demo_dir/member-created.json"
member_id=$(jq -er '.user.id' "$demo_dir/member-created.json")
```

Login/me return `200 {"user":{"id":"<id>","email":"admin@example.com","role":"admin",...},"csrfToken":"<session-bound-token>"}`. Member creation returns `201 {"user":{...,"role":"member","requiredPasswordChange":true}}`. Responses omit hashes and secrets. Login sets the HTTP-only `urumi_dashboard` cookie scoped to `/api`, SameSite=Lax, with a fixed eight-hour expiry; HTTPS mode adds Secure. Sessions do not slide or renew on me requests.

Every mutation uses the trusted Origin and that session's CSRF token. Missing/untrusted Origin or missing/wrong CSRF returns `403`. Unknown fields are rejected. Invalid login is generic `401`; persistent account/IP throttles return generic `429` (five failures per normalized email and 30 source-IP attempts within 15 minutes). [Session configuration](dashboard-sessions.md#configuration) explains exact proxy trust and cookie behavior.

## Replace the assigned password and issue a key

Log in as `member@example.com` with its assigned password. Before replacement, me, change-password, and logout are allowed; key management returns `403 Password change required`.

```bash
login member
curl --silent --show-error -b "$demo_dir/member.cookies" "$base/api/keys"
python3 -c 'import getpass,json; print(json.dumps({"currentPassword":getpass.getpass("Assigned password: "),"newPassword":getpass.getpass("Different final password: ")}))' \
  | mutate member POST --data-binary @- "$base/api/auth/change-password"
login member
mutate member POST --data '{"name":"operator demonstration"}' "$base/api/keys" \
  > "$demo_dir/member-key.json"
curl --fail-with-body --silent --show-error -b "$demo_dir/member.cookies" "$base/api/keys"
```

Password replacement returns `204`, invalidates **all** the member's dashboard sessions, and requires fresh login. Issuance returns `201 {"rawKey":"<shown-only-once>","key":{"id":"<key-id>",...}}`. Do not print the creation file. Listings contain only safe metadata, including prefix, timestamps, and revocation. Keys use 32 random bytes in `ugw_` format; storage contains only SHA-256 digests. Names are at most 100 characters; each user may hold at most 20 active keys. There is no automatic expiry.

## Connect MCP, call read-only tools, and revoke on the same client

Run this SDK example in the operator shell. It keeps the raw key in memory, lists permitted tools, calls calculator/time, and revokes through the independent dashboard boundary while the MCP client remains open. Discovery bypasses the SDK cache so the final request actually reaches the gateway.

```bash
export URUMI_DEMO_DIR="$demo_dir"
pnpm --filter @urumi/gateway exec node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const dir = process.env.URUMI_DEMO_DIR;
const { rawKey, key } = JSON.parse(await readFile(`${dir}/member-key.json`, 'utf8'));
const { csrfToken } = JSON.parse(await readFile(`${dir}/member.json`, 'utf8'));
const jar = await readFile(`${dir}/member.cookies`, 'utf8');
const cookie = jar.split('\n').find(line => line.split('\t')[5] === 'urumi_dashboard')?.split('\t')[6];
assert.ok(cookie, 'Dashboard cookie required');
const client = new Client({ name: 'phase1-demo', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  const catalog = (await client.listTools(undefined, { cacheMode: 'bypass' })).tools;
  console.log(catalog.map(tool => tool.name));
  assert.ok(!catalog.some(tool => tool.name === 'woocommerce.create_product'));
  console.log(await client.callTool({ name: 'calculator.calculate', arguments: { operation: 'multiply', a: 6, b: 7 } }));
  console.log(await client.callTool({ name: 'time.current', arguments: { timezone: 'UTC' } }));
  const revoke = await fetch(`http://localhost:3000/api/keys/${key.id}`, {
    method: 'DELETE', headers: {
      Cookie: `urumi_dashboard=${cookie}`, Origin: 'http://localhost:3000', 'X-CSRF-Token': csrfToken,
    },
  });
  assert.equal(revoke.status, 204);
  await assert.rejects(client.listTools(undefined, { cacheMode: 'bypass' }),
    error => error.data?.status === 401);
  console.log('Same-client next-request revocation verified (401)');
} finally { await client.close(); }
JS
```

Expected results: calculator contains `42`, time reflects the current clock, then the same client receives HTTP `401`. No WooCommerce mutation is attempted. Authentication runs on every incoming request, with the current database role and eligibility; neither a session identifier nor a dashboard cookie bypasses it. Already admitted operations may finish. Execution uses the shared `executeTool()` boundary and console audits carry real user/key IDs without tool arguments.

## Check restrictions and recovery

```bash
# Member cannot administer users: 403.
curl --silent --show-error -b "$demo_dir/member.cookies" "$base/api/admin/users"
# Administrator can inspect this member: 200, safe user metadata.
curl --fail-with-body --silent --show-error -b "$demo_dir/admin.cookies" \
  "$base/api/admin/users/$member_id"
# Revocation is idempotent: 204 again, metadata retains revokedAt.
key_id=$(jq -er '.key.id' "$demo_dir/member-key.json")
mutate member DELETE "$base/api/keys/$key_id"
curl --fail-with-body --silent --show-error -b "$demo_dir/member.cookies" "$base/api/keys"
```

Members cannot discover or invoke WooCommerce writes; administrators can use all registered tools. The automated suite verifies direct forbidden calls against controlled upstreams without touching a real store. Member self-service routes are owner-scoped, including `404` for another user's key. Administrator assistance uses `/api/admin/users/:userId/keys` and verifies the key belongs to that route's user. User/key lists use `page` and `limit` (maximum 100). Creation always creates a member; promotion is a separate PATCH. [Role/status administration](dashboard-sessions.md#promote-and-demote-administrators-10) preserves at least one active administrator under concurrent changes. Disabling permanently invalidates sessions and keys; re-enabling requires fresh credentials.

To demonstrate operator recovery on this local administrator, select its **existing** canonical ID, then use database operator access and a hidden temporary-password prompt:

```bash
admin_id=$(jq -er '.user.id' "$demo_dir/admin.json")
pnpm --filter @urumi/gateway recover-admin --user-id "$admin_id"
login admin
python3 -c 'import getpass,json; print(json.dumps({"currentPassword":getpass.getpass("Recovery temporary password: "),"newPassword":getpass.getpass("Different final password: ")}))' \
  | mutate admin POST --data-binary @- "$base/api/auth/change-password"
login admin
```

Recovery restores the selected existing user as active administrator, requires replacement, and permanently invalidates all their sessions/keys. It does not create missing users or reopen setup. After replacement, issue fresh keys. Ordinary [administrator password reset](dashboard-sessions.md#reset-a-password-12) differs: it invalidates sessions and blocks retained keys only until replacement. A connection failure at commit may follow successful mutation; inspect state before retrying recovery. See [recovery operational details](identity-setup.md#operator-recovery-13).

Logout with `mutate admin POST "$base/api/auth/logout"` returns `204` and ends only that dashboard session; it does not revoke API keys. Other ordinary device sessions remain independent.

## Shutdown and validation

Stop each service with Ctrl-C (SIGINT; SIGTERM is also handled). Gateway shutdown closes HTTP/MCP, registry connections, and identity storage. Remove only the private demonstration files and stop Compose while preserving the database volume:

```bash
rm -r -- "$demo_dir"
unset URUMI_DEMO_DIR demo_dir member_id admin_id key_id
docker compose -p urumi-identity -f infra/mongodb/compose.yaml down
```

Run the complete automated validation separately:

```bash
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway test:integration
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-local.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-prod.yaml
```

The integration runner executes all compiled gateway Node tests against isolated real replica-set/standalone containers, including cross-workflow concurrency, CLI setup/recovery, security restrictions, MCP revocation, upstream isolation, and database outage/recovery. It uses reserved project `urumi-identity-integration`, tmpfs storage, and ports 27417/27418; never point its outage test at application storage. It cleans up test containers without deleting application volumes. Automated fake upstream checks and local operator demonstrations are separate from Kubernetes deployment verification.

## Deployment configuration and deferred work

The existing Helm chart already provides the minimum Phase 1 wiring; no extra service, public route, or NetworkPolicy exception is needed here:

| Helm value | Gateway environment / source |
| --- | --- |
| `gateway.mongodbSecretName` | Required `MONGODB_URI` from Secret key `uri`; default Secret name `urumi-identity-storage` |
| `gateway.secretName` | Legacy `GATEWAY_BOOTSTRAP_KEY` from Secret key `bootstrap-key`; runtime ignores it |
| `gateway.nodeEnv` | `NODE_ENV`; base/production default `production` |
| `gateway.dashboard.trustedOrigins` | `DASHBOARD_TRUSTED_ORIGINS`, exact origins joined by commas |
| `gateway.dashboard.allowHttp` | `DASHBOARD_ALLOW_HTTP`, default false; true is rejected in production |
| `gateway.dashboard.trustedProxies` | `DASHBOARD_TRUSTED_PROXIES`, exact IP addresses; empty trusts no proxies |
| `gateway.allowedHosts` | `MCP_ALLOWED_HOSTS`; update for the actual external hostname |
| `gateway.upstreams.*` | Existing WooCommerce/calculator/time endpoint environment values |

Never put URI credentials or bootstrap values into Helm values. Supply Secrets through your secret-management workflow. Local values select explicit development HTTP with `http://gateway.localhost`; this walkthrough's direct port uses `http://localhost:3000` instead. Production values contain placeholder HTTPS origins. Configure the real origin and actual trusted TLS proxy socket addresses; the proxy must overwrite forwarded headers. Secure mode requires HTTPS or trusted `X-Forwarded-Proto: https`. Empty origins deny login/mutations. No session-signing or API-key HMAC secret is required for these hashed opaque credentials.

**The current chart requires external persistence configuration to run the new gateway.** Before an upgrade, provision an authenticated, reachable, transaction-capable MongoDB replica set, its URI Secret, and required database privileges/indexes. Supply real hosts, TLS/proxy/origin settings, and compatible allowed hosts. Existing gateway Ingress exposes only `/mcp`; `/api/*` and the dashboard have no public routing. Public upstream routes remain absent and NetworkPolicies remain unchanged.

Full Kubernetes MongoDB workloads/PVCs/networking, dashboard/API public routing, deployment and allowed/blocked connectivity verification, dynamic upstream management, and durable audit storage remain deferred. The dashboard is a scaffold and audits remain console-only. Helm lint/render results do not establish Pod readiness, Secret availability, database reachability, ingress routing, or policy enforcement. No Kubernetes deployment is performed by this walkthrough.
