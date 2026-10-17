# Day 4 operator walkthrough and Day 5 handoff (#37)

Use the execution record (historical evidence file is not included in this checkout) for actual results and capability
status. This walkthrough is reproducible guidance, not a claim that all its steps
passed. Kind v0.24+ includes NetworkPolicy support; identify the installed image
and run actual controls rather than inferring enforcement from the CNI name. See
[the upstream release](https://github.com/kubernetes-sigs/kind/releases/tag/v0.24.0).
No production-readiness claim is made.

## Prerequisites and deployment

Use Node 24.7+, the pinned pnpm, Docker, Helm, kubectl, Kind for local image loading,
and the installed Playwright Chromium browser. Inspect `kubectl config current-context`
and `git status --short` first. Select an existing **policy-enforcing** test cluster;
do not recreate it or replace its CNI as a verification shortcut. Keep the gateway
at one replica. Preserve all WordPress, MariaDB and MongoDB claims.

Follow [MongoDB provisioning](../operations/mongodb-deployment.md#credentials-and-initialization)
for protected credential files, authenticated single-node replica-set initialization,
a separate gateway database user and the `urumi-identity-storage` URI Secret.
Alternatively supply an external transaction-capable database and approve all its
replica-set destinations. Managed mode does not migrate an existing external database.
Provision commerce Secrets through the existing operator workflow; never print
their values, copy them into values files, or pass them as build arguments.

Build the five application images from the repository root, using a unique release
tag. Match the cluster architecture. The following uses the standard local hosts:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
docker build -f apps/gateway/Dockerfile -t urumi/gateway:day4 .
docker build -f apps/dashboard/Dockerfile \
  --build-arg VITE_PUBLIC_MCP_URL=http://gateway.localhost/mcp \
  -t urumi/dashboard:day4 .
docker build -f apps/calculator-mcp/Dockerfile -t urumi/calculator-mcp:day4 .
docker build -f apps/time-mcp/Dockerfile -t urumi/time-mcp:day4 .
docker build -f apps/woocommerce-mcp/Dockerfile -t urumi/woocommerce-mcp:day4 .
kind load docker-image urumi/gateway:day4 urumi/dashboard:day4 \
  urumi/calculator-mcp:day4 urumi/time-mcp:day4 urumi/woocommerce-mcp:day4 --name urumi
```

Set all five image tags to `day4` in a nonsecret site overlay; set
`mongodb.enabled=true` only when choosing managed storage. Configure exact public
hosts/origins, storage class, resources, ingress namespace, and approved destinations.
Different namespaces need explicit destination rules for their full upstream DNS
origins and corresponding upstream allowed hosts. Destination approval in the
application and network permission are independent requirements. Approve narrow
Service/address ranges, not arbitrary private networks. See
[destinations](../operations/upstream-destinations.md), [egress](../operations/gateway-egress.md), and
[named Secret references](../operations/upstream-credentials.md). Secret references must be
pre-provisioned, key-approved and in the release namespace; RBAC grants only named
`get`, never list/watch/create. Empty approvals grant no Secret reads.

```sh
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml -f /secure/site-values.yaml
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml
helm template urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml -f /secure/site-values.yaml > /tmp/urumi-local.yaml
helm template urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-prod.yaml > /tmp/urumi-prod.yaml
# Existing RollingUpdate releases need the documented one-time strategy patch:
# docs/operations/dashboard-deployment.md#build-and-configure
helm upgrade --install urumi infra/helm/urumi -n urumi --create-namespace \
  -f infra/helm/urumi/values-local.yaml -f /secure/site-values.yaml
kubectl get pods,deployments,statefulsets,svc,ingress,pvc,networkpolicy -n urumi
kubectl rollout status deployment/urumi-gateway -n urumi --timeout=300s
kubectl rollout status deployment/urumi-dashboard -n urumi --timeout=300s
kubectl rollout status statefulset/urumi-mongodb -n urumi --timeout=300s
```

Check readiness/startup/liveness probe configuration, mounted Secret **references**,
ServiceAccount and image IDs in workload specs without dumping Secret contents.
Compare PVC UIDs before/after the work. Only dashboard, gateway `/mcp`, and storefront
have public routing; upstreams/databases must remain ClusterIP/headless internal Services.
Readiness requires initialized identity/registration storage and usable MongoDB,
and permits zero healthy upstreams. Liveness checks process health.

For HTTPS, rebuild the dashboard with the actual HTTPS MCP URL. Override production
placeholder domains, supply certificate Secrets, exact trusted proxy socket IPs and
trusted Origin, and configure controller HTTP-to-HTTPS redirection. Verify forwarded
headers are sanitized. `Secure` cookies require actual TLS or an explicitly trusted
TLS edge. Neither placeholder values nor a self-signed test certificate prove public
production TLS. Preserve WooCommerce's public signing URL/internal destination pair.
See [TLS and proxy configuration](../operations/dashboard-deployment.md#production-like-https).

## Establish access and demonstrate the browser workflow

On a new database, run the [initial administrator CLI](../guides/identity-setup.md#first-administrator)
with protected bootstrap/password files. On Kubernetes use the gateway container's
compiled `apps/gateway/dist/identity/setup-cli.js` and operator-mounted files; do not
pass literal secrets in command arguments. The gateway's configured bootstrap value
is for setup only and never authenticates MCP. Initial setup is permanently consumed.
For existing accounts use normal login; lost administrator access requires the
separate [operator recovery CLI](../guides/identity-setup.md#operator-recovery-13), database
operator authorization, and an explicit existing user ID. Never remove the setup marker.

1. Open `/admin/users` directly; log in as an eligible administrator. Reload and
   confirm the email/role/session are restored. Inspect HTTP-only, SameSite=Lax,
   `/api`-scoped cookies and Secure under HTTPS. Confirm untrusted Origin and missing
   CSRF are rejected. Dashboard cookies cannot authenticate `/mcp`; a bearer key
   alone cannot authenticate management APIs.
2. Create a member with an assigned password. Log out; log in as the member.
   Replace the password and log in afresh. The restricted session must not issue
   keys. Confirm administrator API access is 403 independently of hidden navigation.
3. At `/keys`, issue a named key and copy its one-time value. Dismiss/navigate/reload:
   raw key readback must be impossible. Browser storage must contain no credentials.
   Use the dashboard's TypeScript SDK Streamable HTTP example with the configured
   public `/mcp` URL and the member's bearer key. Fresh discovery uses
   `client.listTools(undefined, { cacheMode: 'bypass' })`.
4. Call `calculator.calculate` and `time.current`. With operator-provisioned store
   credentials and an existing readable order, run the [read-only smoke command](../guides/browser-to-mcp-workflow.md#live-read-only-smoke-with-operator-credentials):
   `pnpm --filter @urumi/dashboard smoke:readonly`. Supply `URUMI_MCP_URL`,
   `URUMI_API_KEY`, and `URUMI_ORDER_ID` privately. This checks products, orders and
   order detail without writes. No order fixture means order-detail verification
   remains not executed; do not create one as a shortcut.
5. Keep the MCP client open. Dashboard logout must preserve key access. Log in
   again and revoke the key after cancelling confirmation once. A fresh request
   on that same MCP client must return 401. Member WooCommerce write discovery and
   direct invocation remain forbidden by the backend.
6. Use a separate administrator client while adding an approved upstream through
   `/admin/servers`. Inspect real status, descriptions and schemas. Cancel disable
   once, then confirm it; refresh must not enable a disabled registration. Enable,
   edit to an approved failing endpoint, confirm healthy tools remain callable,
   repair the endpoint and refresh. Fresh discovery must reflect changed namespaces
   and schemas; stale tool names must not execute. Confirm removal and verify
   disappearance without deleting any Kubernetes Secret.

## Automated deployed demonstration and restarts

The opt-in verifier below creates a uniquely named member, issues keys, registers,
edits and removes upstreams, then restarts gateway and MongoDB separately. Run it
only against a disposable release with fewer than 100 existing users and at most 100 personal keys. It preserves
PVCs, retains credentials in process memory, and never makes commerce writes. It
uses actual calculator/time deployments and approved alternate DNS spellings so
the demonstration URLs do not duplicate the defaults. The failed-discovery path
is `/offline` on the calculator origin. That path must return a non-MCP response.

The optional `VERIFICATION_REMOVE_SERVER` deletes an existing default **only in the
disposable release** to prove migration never reseeds it. Omit it elsewhere. On
success verification keys are revoked, the member is disabled, and the retained
registration is removed. Failure leaves state for inspection; revoke keys and
disable verification members before retrying. Restarting gateway briefly interrupts
requests; MongoDB restart requires retained StatefulSet storage and administrator
credentials already injected by the chart for the separate transaction marker probe.

```sh
env DASHBOARD_ORIGIN=https://dashboard.example.test \
  PUBLIC_MCP_URL=https://gateway.example.test/mcp \
  DASHBOARD_EMAIL=verification@example.com \
  DASHBOARD_PASSWORD_FILE=/secure/verification-password \
  VERIFICATION_DISPOSABLE=true VERIFICATION_CONTEXT=kind-urumi \
  VERIFICATION_NAMESPACE=urumi-verification \
  VERIFICATION_CALCULATOR_URL=http://urumi-calculator-mcp.urumi-verification.svc.cluster.local:3002/mcp \
  VERIFICATION_TIME_URL=http://urumi-time-mcp.urumi-verification.svc.cluster.local:3003/mcp \
  node infra/helm/urumi/verify-milestone.mjs
```

For an explicitly self-signed local fixture, set
`VERIFICATION_ALLOW_SELF_SIGNED=true` for the browser and provide its certificate
to the Node client with `NODE_EXTRA_CA_CERTS=/secure/test-ca.crt`. If the MCP
hostname is absent from local DNS, explicitly set `VERIFICATION_MCP_ADDRESS=127.0.0.1`
for the local ingress tunnel; only that hostname is overridden and TLS Host/SNI
and certificate validation are preserved. Normal runs must
validate certificates. A temporary Traefik port-forward can expose 443 at 18443;
use hosts resolving locally and include the exact port in Origin and MCP URLs.

The verifier checks the continuing administrator session and active key, revoked
member key, persisted password-replacement state, registration deletion and disabled
intent after each restart. It separately checks the MongoDB PVC UID and an actual
majority-committed transaction before and after MongoDB restart. It never deletes
a PVC, reseeds the database or resets setup. The [storage guide](../operations/mongodb-deployment.md#non-destructive-live-verification)
contains the manual equivalent. This managed-storage verifier does not certify an
external database operator's restart procedure.

## Network and authorization evidence

Run [the controlled egress matrix](../operations/gateway-egress.md#read-only-live-checks) from the
actual gateway Pod and a reachable control Pod. Both same-namespace and cross-namespace
denied destinations must first be demonstrably reachable from the control. A refused
connection or missing listener does not prove policy. Also probe upstream/database
ingress from an unlabelled Pod, permitted gateway traffic, DNS UDP/TCP, MongoDB
authentication, and real named-Secret GETs from the gateway's ServiceAccount.

Use `kubectl auth can-i --as=system:serviceaccount:<namespace>:urumi-gateway`
to verify approved named get succeeds; unapproved/cross-namespace get, list, watch,
create, update and delete must fail. Authorization checks alone do not prove API
network reachability. Conversely an allowed TCP socket does not prove authorization.
Record each outcome independently. Never weaken NetworkPolicies to obtain a pass.

## Automated validation

```sh
pnpm test:workflow
ruby infra/helm/urumi/test-dashboard.rb
ruby infra/helm/urumi/test-mongodb.rb
ruby infra/helm/urumi/test-secret-rbac.rb
ruby infra/helm/urumi/test-gateway-egress.rb
node --test infra/helm/urumi/verify-gateway-egress.test.mjs infra/helm/urumi/verify-dashboard.test.mjs
```

`test:workflow` includes workspace typechecks/builds, the real replica-set gateway
suite, and browser tests in order. It owns only disposable test database containers;
never point its outage test at deployed storage. The broader browser suite uses
controlled upstreams and Vite. Report it separately from deployed-image checks.

## Day 5 integration contracts

| Boundary | Reuse and constraints |
| --- | --- |
| `security/identity.ts` | `AuthenticatedIdentity { userId, role: "admin" \| "member", keyId }`; resolve server-side, never accept client role/user ID as authority. |
| `execution/execute-tool.ts` | `executeTool({ identity, toolName, arguments, requestId }, dependencies)` is the shared boundary. Future chat controllers must call it rather than upstream clients. Choose and document chat authentication/attribution explicitly; do not synthesize a key ID from a browser session. |
| `security/authorization.ts` | Enforce authorization before resolution on every invocation; member allowlist remains the existing five read/calculator/time tools. Discovery filtering is additional protection. |
| `tools/aggregator.ts`, `resolver.ts` | Use the actual discovered, currently available catalog, public `<serverId>.<toolName>` names and preserved schemas. Never route arbitrary split names or reuse withdrawn mappings. |
| `tools/invoker.ts`, `upstream/connection.ts` | Use MCP tools/call, bounded discovery/connect and ten-second calls, preserve `isError` and structured content, isolate failures and never retry WooCommerce writes automatically. |
| `upstream/registrations.ts`, `management.ts`, `registry.ts` | MongoDB owns desired metadata; management coordinates persistent intent and the live registry. Respect revision/generation barriers, disabled/deleted state and completed default migration. Keep one gateway replica until runtime synchronization exists. |
| `identity/dashboard-routes.ts`, `dashboard-sessions.ts` | Same-origin HTTP-only session cookies and Origin/CSRF for browser APIs. Password replacement requires fresh login. Logout leaves bearer keys independent; key revocation is checked on each MCP request. |
| `audit/logger.ts`, execution audit hook | Preserve request ID, user ID, key ID, tool/upstream, duration and classified outcome. Logs are structured console records; persistent audit history/query UI is incomplete. Do not record raw keys, credentials or sensitive arguments. |

Day 5 chat orchestration, model/provider credentials and durable audit storage are
new work. Retain these boundaries and the operator prerequisites above.
