# Issue #35 verification — 2026-10-16

Implemented [Deploy the dashboard with same-origin management APIs](https://github.com/Moracus/urumi-assignment/issues/35).
See [operator setup and exact values](dashboard-deployment.md).

## Changes

- Docker/static serving: `apps/dashboard/Dockerfile`, `apps/dashboard/nginx.conf`.
  Multi-stage image, public MCP URL build argument, unprivileged static serving,
  read-only-root compatibility, SPA fallback, asset/API/MCP exclusions and health.
- Backend: `apps/gateway/src/app.ts`, `app.test.ts`. MongoDB-aware readiness now
  tolerates zero healthy upstreams; existing auth/migration-before-listen remains.
- Helm/security: dashboard Deployment, ClusterIP Service, probes/resources,
  ingress-only and deny-egress policy; dashboard `/api` goes to the gateway;
  TLS Secret references for dashboard, gateway and storefront; matching local/prod
  origins and allowed hosts; exact proxy trust remains an operator requirement.
  Gateway uses Recreate and one replica to avoid concurrent runtime registries.
- Tests: `test-dashboard.rb`, updated `test-gateway-egress.rb`,
  `verify-dashboard.mjs`, its secret-free failure regression,
  `verify-dashboard-browser.mjs`, and gateway health assertions.
- Documentation: README, system design, threat model, deployment guide and this
  verification record. Existing execution interfaces, RBAC, gateway egress,
  public tool names, commerce signing and PVCs are preserved.

## Executed checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed across the workspace |
| `pnpm build` | Passed across the workspace |
| Gateway targeted readiness test, red then green | Failed with 503 before correction; passed with 200 afterward |
| Full gateway test command with replica, standalone and outage-container environment | 132 passed, 0 failed, 0 skipped |
| Dashboard Playwright suite against disposable replica set and controlled upstreams | 54 passed |
| `docker build -f apps/dashboard/Dockerfile --build-arg VITE_PUBLIC_MCP_URL=http://gateway-35.localhost/mcp -t urumi/dashboard:issue35 .` | Passed (arm64 host) |
| `docker build -f apps/gateway/Dockerfile -t urumi/gateway:issue35 .` | Passed |
| Local and production `helm lint` / `helm template` | Passed |
| Dashboard chart regression, red then green | Detected missing workload and unsafe rolling updates before corrections; passed afterward |
| Existing MongoDB, named-Secret RBAC, gateway-egress Ruby regressions | Passed |
| Egress verifier's Node test suite | 4 passed |
| Dashboard verifier secret-free failure regression | Passed for missing HttpOnly, SameSite and incorrect Path |
| Existing Deployment strategy migration | Initial Helm 4 apply rejected retained rollingUpdate; explicit merge patch cleared it, then Helm upgrade passed |
| Isolated Kind dashboard workload | Ready with read-only root, non-root UID, no API token and `/tmp` emptyDir |
| Isolated MongoDB and gateway workloads | Ready after repairing the disposable fixture's membership key format |
| HTTP ingress smoke script with disposable administrator | Passed deep links/assets, API/MCP routing, cookie/session, Origin, CSRF and logout checks |
| HTTPS ingress smoke script with disposable administrator | Passed same checks including Secure cookie over real Traefik TLS termination |
| Real browser against the deployed production image over HTTPS | Passed direct-link login, Secure/HTTP-only cookie attributes, session reload, CSRF rejection and logout |

The full gateway command was `pnpm --filter @urumi/gateway test` with
`MONGODB_TEST_URI=mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true`,
`MONGODB_STANDALONE_TEST_URI=mongodb://127.0.0.1:27418/urumi_test?directConnection=true`,
and `MONGODB_TEST_CONTAINER=urumi-identity-integration-replica-1`. The database
containers came from `infra/mongodb/compose.integration.yaml`. Browser tests
finished before the gateway suite reached its database outage exercise.

The isolated release is `urumi35` in `urumi-dashboard-35`, separate from the
existing `urumi` release. Commerce workloads were disabled in the verification
release. Its image tags are `issue35`; hosts are `dashboard-35.localhost` and
`gateway-35.localhost`. HTTP testing used Traefik port-forward 18080 and exact
trusted origin `http://dashboard-35.localhost:18080`. HTTPS testing used port-forward
18443, a one-day self-signed test certificate trusted only by the verification
process, origin `https://dashboard-35.localhost:18443`, production mode, and exact
observed proxy IP `10.244.0.30`. No credential values are recorded here. The test
administrator persisted through the gateway HTTP-to-HTTPS rollout. The deployed
image's MCP display URL was built for the HTTP fixture; use an HTTPS build argument
for a real HTTPS deployment.

## Limits

- The available cluster uses kindnet. **NetworkPolicy enforcement and live
  allowed/blocked connectivity are not verified.** Render/RBAC/egress regressions
  establish configuration only. Use an enforcing CNI and the documented matrix.
- The deployed HTTP and browser smoke scripts use real Traefik TLS/ingress. The
  54 broader browser tests use the existing Vite-based integrated harness; their
  complete user/key/upstream lifecycle suite was not rerun through production ingress.
- Publicly trusted certificates, production DNS, proxy-IP lifecycle reconciliation,
  HTTP-to-HTTPS redirects and production deployment remain operator work.
- No live commerce mutation, database reset, PVC deletion, cluster recreation,
  or public upstream exposure was performed. MongoDB persistence across its own
  restart is covered by predecessor #34, not newly claimed here.
- This issue implements the deployment slice of parent #24. It does not certify
  the entire Day 4 milestone or every running-system demonstration in that parent.

## Two-axis review

Standards review initially identified a smoke-check failure path that could print
Set-Cookie in an assertion error. Boolean checks with fixed diagnostics and a
process/HTTP regression resolve it; the reviewer confirmed resolution. JSON parse
failures also suppress response bodies. Final Standards: 0 remaining findings.
Spec review: 0 findings. Reviews compare task-start commit
`aae984a23df61e373f64ca754c44dc4ac7e1ca60` with the implementation.

After verification, the isolated dashboard/gateway/MongoDB workloads were scaled
to zero and disposable Compose test containers were stopped. The verification
namespace, Secrets and MongoDB PVC are retained; no PVC was removed. The existing
`urumi` deployment was not upgraded. Roll out the actual release using the
operator guide, including the one-time update-strategy patch for existing gateways.
