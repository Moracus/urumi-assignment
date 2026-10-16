# Issue #37 — deployment verification and operator handoff

Scope: [Verify the deployed milestone and deliver the operator handoff](https://github.com/Moracus/urumi-assignment/issues/37),
parent [#24](https://github.com/Moracus/urumi-assignment/issues/24).
Baseline: `e15133194b0abcc41dca41446fec2b2af3638d98` on `main`.
The [operator walkthrough](milestone-handoff.md) contains reproducible commands,
credential prerequisites, manual demonstration steps and Day 5 contracts.

## Delivered changes

| Area | This issue's changes and verified predecessor capability |
| --- | --- |
| Frontend | No production frontend changes. Verified existing account/password/key/server workflows through the built SPA over Traefik HTTPS. |
| Backend integration | No production backend or public contract changes. Verified real session/CSRF and bearer separation, continuing-client revocation, destination denials, live registry changes and restart restoration. |
| Docker | No Dockerfile changes. Built gateway, dashboard, calculator, time and WooCommerce images tagged `issue37`; deployed all five with existing authenticated `mongo:8.0`. |
| Helm/security | No template changes. Linted/rendered local and production-like managed-MongoDB values; upgraded only isolated release `urumi35` in `urumi-dashboard-35`. Preserved one-replica Recreate, ingress/egress policies and named-Secret get-only RBAC. |
| Verification tooling | Added `infra/helm/urumi/verify-milestone.mjs`: real browser/MCP demonstration, application destination rejection, schema preservation, separate gateway/MongoDB restarts, transaction/PVC checks and cleanup. |
| Documentation | Added this evidence and `milestone-handoff.md`; updated README, system design, threat model, dashboard deployment, identity setup, Phase 1 demo, browser workflow and egress guidance. Corrected stale scaffold/routing/readiness statements and the assumption that modern Kind lacks policy support. |

Pre-existing uncommitted `.gitignore`, AGENTS/glossary/brief/spec/ADR/skill files
were preserved and excluded. Generated dashboard build metadata was restored to
its pre-task state. No secrets or credential-bearing manifests are committed.

## Executed commands and results

| Check | Result |
| --- | --- |
| `pnpm test:workflow` | Passed initially: workspace typechecks/builds; 132 gateway tests, zero failures/skips; 55 browser tests. Final repeat recorded below. |
| `helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml --set mongodb.enabled=true` | Passed |
| Same lint with `values-prod.yaml` | Passed |
| `helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-{local,prod}.yaml --set mongodb.enabled=true` (two separate commands) | Both passed; outputs saved outside repository |
| `ruby infra/helm/urumi/test-dashboard.rb` | Passed local and production assertions |
| `ruby infra/helm/urumi/test-mongodb.rb` | Passed managed/external and local/production assertions |
| `ruby infra/helm/urumi/test-secret-rbac.rb` | Passed |
| `ruby infra/helm/urumi/test-gateway-egress.rb` | Passed |
| `node --test infra/helm/urumi/verify-gateway-egress.test.mjs infra/helm/urumi/verify-dashboard.test.mjs` | 5 passed; initial sandbox EPERM on loopback listening was resolved by permitted rerun |
| Five `docker build -f apps/<app>/Dockerfile -t urumi/<app>:issue37 .` commands | Passed for gateway, dashboard, calculator-mcp, time-mcp and woocommerce-mcp. Dashboard additionally used `--build-arg VITE_PUBLIC_MCP_URL=https://gateway-35.localhost:18443/mcp`. |
| `kind load docker-image ... --name urumi` for those tags | Passed |
| `helm upgrade --install urumi35 infra/helm/urumi -n urumi-dashboard-35 -f infra/helm/urumi/values-local.yaml -f /private/tmp/urumi-35/values.yaml -f /private/tmp/urumi-35/https.yaml -f /private/tmp/urumi-37/values.json` | Passed non-destructively; rollout checks passed |
| `node infra/helm/urumi/verify-dashboard.mjs` with HTTPS environment below | Passed SPA deep links/assets, missing asset, API/MCP route separation, trusted Origin, CSRF, session restoration, cookie attributes and logout invalidation |
| `node infra/helm/urumi/verify-dashboard-browser.mjs` against production SPA HTTPS | Passed direct-link login, Secure/HTTP-only cookies, reload, CSRF and logout |
| `node infra/helm/urumi/verify-milestone.mjs` with disposable environment below | Full initial run passed onboarding/MCP/lifecycle and both restarts; final repeat recorded below |
| `node infra/helm/urumi/verify-gateway-egress.mjs /private/tmp/urumi-37/probes.json` | All 11 controlled checks passed; details below |
| `kubectl auth can-i ... --as=system:serviceaccount:urumi-dashboard-35:urumi-gateway` | Approved named get yes; unapproved/cross-namespace get and list/watch/create/update/delete no |
| Node TCP probes from unlabelled `urumi-network-control` | WooCommerce 3001, calculator 3002, time 3003 and MongoDB 27017 all timed out; the same services were reachable from gateway |
| Unauthenticated MongoDB `users.findOne` from gateway Pod | Rejected with authorization code 13; no data returned |
| `node --check infra/helm/urumi/verify-milestone.mjs`, `git diff --check` | Passed |

Final repeat: **passed**. `pnpm test:workflow` again passed workspace typechecking/builds, 132 gateway tests (zero failures/skips) and 55 browser tests. The deployment verifier regressions again passed all five tests. The final deployed milestone run passed all six output stages, including explicit destination-policy denials and separate gateway/MongoDB restoration after bounded ingress convergence.

The workflow runner provisions only disposable Compose replica/standalone databases
on 27417/27418 and runs the gateway outage exercise before browser tests. Its
project is `urumi-identity-integration`; no deployed data is used by these tests.
Logs and nonsecret inspection artifacts are under `/private/tmp/urumi-37*` on the
verification host, not durable repository artifacts; the results and exact fixture
configuration are recorded here for handoff.

## Actual deployed configuration and evidence

- Context `kind-urumi`: one Ready arm64 node, Kubernetes `v1.37.0`.
  CNI image `docker.io/kindest/kindnetd:v20260820-69b56db7`.
  Modern Kind includes [policy support](https://github.com/kubernetes-sigs/kind/releases/tag/v0.24.0).
  Earlier records saying kindnet could not establish enforcement were based on an
  outdated assumption; their checks remain historical, and this issue adds actual controls.
- Isolated release `urumi35`, namespace `urumi-dashboard-35`. Production-mode gateway;
  `DASHBOARD_ALLOW_HTTP=false`, exact trusted Origin
  `https://dashboard-35.localhost:18443`, observed trusted Traefik peer `10.244.0.30`.
  Dashboard/gateway hosts are `dashboard-35.localhost` and `gateway-35.localhost`.
  Existing self-signed fixture Secret `urumi-verification-tls` terminates real TLS at Traefik.
  Temporary port-forward: `kubectl port-forward -n traefik service/traefik 18443:443 18080:80`.
- All five application images built and became Ready; MongoDB is the chart-managed
  authenticated single-node replica set. WordPress and MariaDB are disabled only
  in this isolated release. WooCommerce MCP uses **synthetic verification credentials**
  and no configured store; its readiness/discovery/TCP success is not a commerce read claim.
- Dashboard/gateway/calculator/time/WooCommerce Services are ClusterIP; MongoDB
  Service is headless and internal. Only dashboard `/` plus `/api`, and gateway
  `/mcp`, have verification Ingress routes. No upstream/database Ingress or host port.
- Gateway startup/liveness `/health/live`, readiness `/health/ready`; dashboard
  startup/readiness/liveness `/health/live`; MongoDB authenticated exec probes.
  Gateway uses ServiceAccount `urumi-gateway`. Its URI comes from
  `urumi-identity-storage:uri`, bootstrap CLI configuration from
  `urumi-gateway-auth:bootstrap-key`. MongoDB uses username/password/keyfile references
  in `urumi-mongodb-auth`; no values were printed. Dashboard has no Secret refs or API token.
- MongoDB PVC `data-urumi-mongodb-0` remains Bound, 5Gi, `standard`, backed by volume
  `pvc-edf03e29-6ef0-47e6-9601-e285764bcb25`. The verifier compares the actual UID before/after
  restart and commits transactions in separate database `urumi_deployment_verification`.
  Gateway restart preserves browser session, active/revoked keys, member password-change
  state, durable disabled registration and removed registrations/default `woocommerce`.
  MongoDB restart repeats application checks and verifies its transaction marker.
- Main namespace `urumi` was not upgraded. Its six workloads remained Ready;
  WordPress and MariaDB remained bound to volumes
  `pvc-13696b2c-2d9a-438f-be6e-0b9ad960860c` and
  `pvc-2f26b5d2-b699-40ad-a9f3-2a770bc0129b`, respectively. No store signing URLs or credentials changed.

The HTTPS routing verifier environment was:

```sh
env DASHBOARD_ORIGIN=https://dashboard-35.localhost:18443 \
  PUBLIC_MCP_URL=https://gateway-35.localhost:18443/mcp \
  INGRESS_TRANSPORT_URL=https://127.0.0.1:18443 \
  DASHBOARD_EMAIL=verification@example.com \
  DASHBOARD_PASSWORD_FILE=/private/tmp/urumi-35/admin-password \
  NODE_EXTRA_CA_CERTS=/private/tmp/urumi-35/tls.crt \
  node infra/helm/urumi/verify-dashboard.mjs
```

The deployed milestone verifier used the same public origin/URL/account/password
file/CA, without `INGRESS_TRANSPORT_URL`, and these additional variables:

```sh
VERIFICATION_DISPOSABLE=true
VERIFICATION_CONTEXT=kind-urumi
VERIFICATION_NAMESPACE=urumi-dashboard-35
VERIFICATION_CALCULATOR_URL=http://urumi-calculator-mcp.urumi-dashboard-35.svc.cluster.local:3002/mcp
VERIFICATION_TIME_URL=http://urumi-time-mcp.urumi-dashboard-35.svc.cluster.local:3003/mcp
VERIFICATION_REMOVE_SERVER=woocommerce
VERIFICATION_ALLOW_SELF_SIGNED=true
VERIFICATION_MCP_ADDRESS=127.0.0.1
```

The alternate calculator/time origins were explicitly approved with the cluster's
`10.96.0.0/12` Service range for this disposable fixture and added to upstream
allowed hosts. Default short Service names use the existing bundled approvals.
Network API exceptions were exact `10.96.0.1/32:443` and `172.19.0.2/32:6443`, also
hard-denied as upstream targets. Exact Secret approval was
`urumi-dashboard-35/urumi-verification-upstream:token`. The chart's Role granted
only `get` on that name. Synthetic credentials were pre-provisioned from private
files, never Helm values. These addresses are observed fixture configuration, not portable defaults.

## Controlled network matrix

Two temporary Node HTTP listeners on TCP 9090 were created with the built time
image, no API token and label `app=urumi-verification-control`: one in
`urumi-dashboard-35`, the other in `urumi-verification-controls`.
Neither matched the gateway egress selectors. The existing verifier first connected
to **both** from the control Pod, then required timeouts from the actual gateway.
It additionally verified:

1. Gateway to real WooCommerce/calculator/time Service ports: connected.
2. DNS UDP resolution and TCP resolver reachability: passed.
3. MongoDB driver using the actual injected URI: ping passed.
4. In-Pod HTTPS GET with mounted gateway ServiceAccount token/CA: approved Secret
   200, unapproved Secret 403, cross-namespace Secret 403. Bodies were discarded.
5. Unlabelled control to upstreams/MongoDB: timed out, while gateway access worked.
6. Application API rejected metadata, database and unapproved origins with 400
   and did not persist registrations; separate from packet enforcement.

Initial probes against the main namespace's MariaDB timed out from **both** gateway
and control. They were inconclusive and were not counted as denial evidence.
Reachable dedicated listeners replaced them. No policy was weakened or CNI replaced. Both temporary control Pods were removed
after collecting evidence; the isolated application release remains Ready and its
PVC is retained. The empty control namespace remains available for repeating probes.

## Corrected attempts and remaining limitations

- Initial Node MCP connection could not resolve `*.localhost`; the verifier's
  explicit single-host address override fixes the local tunnel while retaining
  certificate verification and SNI. Production DNS must resolve normally.
- The controlled calculator fixture returns plain text, but the production tool
  returns JSON. The new verifier now checks `{operation: "multiply", a: 6, b: 7, result: 42}`.
- A repeated restart check reached the SPA before ingress endpoint convergence.
  The verifier now polls only the original-cookie `/api/auth/me` read for at most
  30 seconds before reloading. It never logs in to hide session loss or retries mutations.
- An HTTP routing-only attempt expected 401 at `/api/auth/me` but received 403
  because this fixture enforces HTTPS. The correct HTTPS routing/session verifier passed.
- Failed attempts left disposable members/keys/registrations. They were cleaned
  through authenticated management APIs; successful runs disable their member,
  revoke verification keys and remove temporary registrations. Setup remains consumed.
- **Not executed:** real WooCommerce product/order/order-detail reads, including
  `smoke:readonly` against a credentialed live store with an existing order. Those
  reads passed only against controlled upstreams in the automated workflow. Do not
  substitute synthetic credentials/network readiness for store evidence.
- **Implemented but not verified on a real credential-authenticated upstream:**
  bearer/header credential replacement. Controlled browser/backend coverage and
  actual Kubernetes named-Secret GET authorization passed separately.
- **Operator prerequisites:** real DNS/certificates, ingress forwarded-header
  sanitization and redirect verification, proxy-IP lifecycle maintenance, store
  credentials/order fixture, backups and production operations. These are not
  provisioned by this issue. No production deployment or readiness claim.
- Durable MongoDB audit history, audit browsing, Day 5 chat and multi-replica live
  registry synchronization remain incomplete/outside scope. Single-node MongoDB is non-HA.
- No cluster recreation, database reset, PVC deletion, commerce write smoke test,
  broad Secret permission or public upstream exposure occurred.

## Two-axis review

Reviewed commit `4f278b5` with `git diff e15133194b0abcc41dca41446fec2b2af3638d98...HEAD`
by independent Standards and Spec agents. No expensive suites were rerun by reviewers.

### Standards

No findings. The verifier follows existing infrastructure-script conventions,
requires explicit disposable context/namespace selection, avoids credential output,
preserves PVCs and makes no commerce writes. Documentation distinguishes executed
checks from prerequisites. No CODING_STANDARDS.md or CONTRIBUTING.md was found;
AGENTS.md and existing repository conventions were applied. No actionable baseline
smells were identified.

### Spec

Two acknowledged partial validations remain: the member's real-store WooCommerce
read journey and credential-reference replacement against a credential-enforcing
deployed upstream. The parent requires permitted WooCommerce read calls and explicit
credential replacement. Controlled tests and real Kubernetes Secret authorization
support implementation evidence but do not complete those live seams. Supply the
operator prerequisites above before marking them verified. No scope creep or wrongly
implemented requirement was found. Recorded production-image browser/MCP, persistence,
RBAC and controlled network results support the claimed isolated deployment scope.

Review totals: Standards **0** findings; Spec **2 partial validations**, with real-store
reads the principal remaining demonstration prerequisite on that axis.

## Capability-level Day 4 status

| Brief | Capability | Status and evidence boundary |
| --- | --- | --- |
| 1 | Transaction-capable storage, users/passwords, consumed setup/recovery, equal admin authority and last-admin protection | **Implemented and verified** — real-database gateway suite; deployed onboarding and restart persistence. Recovery/concurrency were verified in tests, not exercised on the deployed administrator. |
| 1 | Dashboard sessions, Origin/CSRF, password replacement, roles, one-time hashed keys, ownership and next-request revocation | **Implemented and verified** — gateway/browser suites and real HTTPS browser/MCP walkthrough; durable active/revoked state survives restarts. |
| 2 | Durable registrations, live CRUD/lifecycle/discovery, schema forwarding, disabled/deleted restoration, failure isolation and destination rejection | **Implemented and verified** — controlled suites plus production-image browser/MCP lifecycle/restarts and application denials. |
| 2 | Named-Secret authorization, network ingress/egress isolation and allowed destinations | **Implemented and verified** — rendered regressions, explicit authorization checks and controlled live Pod-network matrix. |
| 2 | Bearer/custom-header upstream credential replacement against a real credential-enforcing deployed target | **Implemented but not verified** at that live seam; controlled tests and real Secret access pass independently. |
| 3 | Dashboard account/key/server workflows, production images, SPA/API/MCP routing, configured TLS/Secure cookies, managed MongoDB and restart persistence | **Implemented and verified** for the isolated local deployment, with broader UI coverage in the integrated harness. |
| 3 | Real-store WooCommerce read-only demonstration | **Implemented but not verified** — requires a credentialed live target and existing readable order; controlled workflow passes. |

The deployed milestone has substantial running-system evidence, but the complete
real-store/credential-upstream demonstration remains unverified. It is not a
production-readiness certification.

Day 5 must reuse server-resolved `AuthenticatedIdentity`, the shared `executeTool`
authorization/resolution/invocation/audit pipeline, live catalog aggregation,
persistent server metadata and independent dashboard sessions. Keep attribution
and console audit hooks; durable audits/chat remain new work. Exact files,
interfaces, timeouts and constraints are in [the Day 5 contract table](milestone-handoff.md#day-5-integration-contracts).
