# Dashboard deployment (#35)

The chart now runs the production dashboard image at `dashboard.localhost` and
routes `/api` on that origin directly to the gateway through Traefik. `/` serves
the SPA with deep-link fallback. Missing assets return 404. `/mcp` on the dashboard
host returns 404; the existing gateway host exposes only `/mcp`. The storefront
keeps its own Ingress. No upstream or database receives a public route.

The static server uses UID/GID 101, port 8080, a read-only root filesystem, dropped
capabilities, no service-account token, and a bounded `/tmp` emptyDir. Its probes
check `/health/live`. It needs no outbound connections; its NetworkPolicy denies
all egress and permits ingress only from `networkPolicy.ingressNamespace`.
The browser connects to `/api` through ingress, so dashboard Pods need no gateway
egress. Gateway ingress, upstream isolation, restricted egress, named-Secret
get-only RBAC, and WordPress/MariaDB PVCs keep their existing boundaries.

Gateway startup validates dashboard authentication configuration, database indexes
and actual transaction support, completes the required registration migration, and
restores registrations before listening. `/health/ready` requires usable MongoDB;
it reports the connected upstream count but permits zero. This lets operators log
in to repair failed upstreams. `/health/live` measures process health. One gateway
replica remains required for live registry consistency. Recreate updates avoid
concurrent runtime registries and briefly interrupt service during upgrades. An empty trusted-Origin
list intentionally denies dashboard login; it does not invalidate MCP-only use.

## Build and configure

Run from the repository root with the pinned pnpm version. Build for the deployment
architecture (for example add `--platform linux/amd64` for an amd64 cluster):

```sh
docker build -f apps/dashboard/Dockerfile \
  --build-arg VITE_PUBLIC_MCP_URL=http://gateway.localhost/mcp \
  -t urumi/dashboard:dev .
docker build -f apps/gateway/Dockerfile -t urumi/gateway:dev .
kind load docker-image urumi/dashboard:dev urumi/gateway:dev --name urumi
```

Only `VITE_PUBLIC_MCP_URL` is passed to the frontend build. It is public connection
information, embedded in the bundle; build a new image for a different environment.
Use `https://gateway.example.com/mcp` with real production hosts. Never pass
credentials or database URIs as frontend build arguments. Runtime image contents
are compiled public assets and nginx configuration, without build tools or source.
`images.dashboard` is a legacy unused value; use `dashboard.image` for deployment.

Before deploying, follow [MongoDB setup](mongodb-deployment.md) and
[identity setup/recovery](identity-setup.md). Pre-provision `urumi-identity-storage`
(`uri`), `urumi-gateway-auth` (`bootstrap-key`, for CLI setup only), and the
existing commerce Secrets. For managed MongoDB also provision `urumi-mongodb-auth`
as described in its setup guide. No credential goes in Helm values. The chart
never generates or returns Secret values. Set `mongodb.enabled=true` to use the
chart-managed single-node replica set, or retain the default external mode and
approve **all** external replica-set destinations in gateway egress.

The checked-in local overlay explicitly uses HTTP and `NODE_ENV=development`:

| Setting | Local value |
| --- | --- |
| `global.dashboardHost` | `dashboard.localhost` |
| `global.gatewayHost` | `gateway.localhost` |
| `global.storeHost` | `store.localhost` |
| `gateway.dashboard.trustedOrigins` | `["http://dashboard.localhost"]` |
| `gateway.dashboard.allowHttp` | `true` |
| `gateway.dashboard.trustedProxies` | `[]` |
| `gateway.allowedHosts` | includes dashboard, gateway and probe Service hosts |

For a non-default public port, put the exact scheme/host/port in trustedOrigins.
For custom hosts also update `gateway.allowedHosts`. Hostnames must be distinct:
the chart rejects a dashboard host equal to the gateway or storefront host.

```sh
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm template urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml -f /secure/operator-values.yaml
# Existing installations only: clear the old default RollingUpdate strategy.
# This changes update policy, not the Pod template; new installs skip this step.
kubectl patch deployment urumi-gateway -n urumi --type=merge \
  -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
helm upgrade --install urumi infra/helm/urumi -n urumi --create-namespace \
  -f infra/helm/urumi/values-local.yaml -f /secure/operator-values.yaml
kubectl get pods,svc,ingress,networkpolicy -n urumi
```

Helm 4 server-side apply may retain the default `rollingUpdate` field when changing
strategy types; the one-time patch above clears it for an existing release. Future
Recreate upgrades briefly interrupt gateway service.

Configure upstream destination approvals, database/API network destinations, and
approved Secret references using the existing [egress](gateway-egress.md) and
[credential](upstream-credentials.md) guides. Do not disable isolation to make a
connection work. [Initial setup](identity-setup.md) is a CLI operation, not bearer
authentication; after it is consumed, use the separate operator recovery procedure.

## Production-like HTTPS

`values-prod.yaml` uses production mode, disallows HTTP cookies, includes the
production dashboard and gateway allowed hosts, and sets the trusted origin to
`https://dashboard.example.com`. Override all placeholder hosts and supply real
certificates in `ingress.dashboard.tlsSecretName`,
`ingress.gateway.tlsSecretName`, and `ingress.wordpress.tlsSecretName`.
These Secrets must already exist in the release namespace. TLS blocks do not
provision certificates. Configure the ingress controller to redirect public HTTP
to HTTPS; this chart does not install controller-specific redirect middleware.

Set `gateway.dashboard.trustedProxies` to the **exact observed ingress proxy IPs**
that connect to gateway Pods. Discover them from the deployed ingress/network
configuration (for example `kubectl get pods -n traefik -o wide`) and verify the
actual source addresses for your CNI. Do not trust an entire Pod/node subnet or
`*`. The default empty list fails closed for HTTPS forwarded over internal HTTP:
login returns 403 until the operator supplies exact proxy trust. Reconcile this
list after ingress Pod IP changes. Only these peers may assert
`X-Forwarded-Proto: https` and forwarded source addresses. Verify the controller
sanitizes forwarded headers. Secure cookies are always server-issued in this mode.

Use `https://store.example.com` for WooCommerce signing while retaining
`http://urumi-wordpress` as its internal destination. The production overlay does
this for its placeholders. Custom domains must preserve that relationship.

## Verification

Run the committed chart checks and existing application suites:

```sh
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway test:integration
# Keep browser tests separate from the suite's MongoDB outage exercise.
env MONGODB_TEST_URI='<disposable-replica-set-uri>' pnpm --filter @urumi/dashboard test:browser
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml
ruby infra/helm/urumi/test-dashboard.rb
ruby infra/helm/urumi/test-mongodb.rb
ruby infra/helm/urumi/test-secret-rbac.rb
ruby infra/helm/urumi/test-gateway-egress.rb
node --test infra/helm/urumi/verify-gateway-egress.test.mjs infra/helm/urumi/verify-dashboard.test.mjs
```

For the deployed routes, create an eligible **disposable verification account**
using the existing setup/member password-replacement flow. Supply its password in
a private file, never in command arguments. This check logs in, tests CSRF/Origin
rejection, logs out, and confirms the old cookie is rejected. It does not issue
keys or invoke commerce writes.

```sh
env DASHBOARD_ORIGIN=https://dashboard.example.com \
  PUBLIC_MCP_URL=https://gateway.example.com/mcp \
  DASHBOARD_EMAIL=verification@example.com \
  DASHBOARD_PASSWORD_FILE=/secure/verification-password \
  node infra/helm/urumi/verify-dashboard.mjs
```

Omit the account variables for routing-only checks; the script explicitly reports
session checks as not executed. For a temporary ingress port-forward, set
`INGRESS_TRANSPORT_URL=http://127.0.0.1:18080` and keep the public URL/Origin
configuration exact. Host headers are preserved without changing ingress rules.
The script checks SPA direct links/assets, missing asset and dashboard MCP 404s,
management 401s, HTTP-only cookie attributes, trusted Origin, CSRF, authenticated
session restoration, logout invalidation, and cookie/bearer separation.

For an additional real-browser smoke test against the deployed production image
(use the installed dashboard Playwright dependencies), run:

```sh
env DASHBOARD_ORIGIN=https://dashboard.example.com \
  DASHBOARD_EMAIL=verification@example.com \
  DASHBOARD_PASSWORD_FILE=/secure/verification-password \
  node infra/helm/urumi/verify-dashboard-browser.mjs
```

It verifies direct-link login, session restoration, cookie attributes, CSRF denial
and logout without issuing keys. A disposable self-signed TLS fixture may explicitly
set `VERIFICATION_ALLOW_SELF_SIGNED=true`; normal runs verify TLS certificates.

A policy-enforcing cluster is required for allowed/blocked connectivity tests.
Kind's default kindnet does **not** prove isolation. Run the controlled
[egress verification matrix](gateway-egress.md) and check ServiceAccount authorization
on a suitable cluster. Do not infer enforcement from successfully rendered objects.
