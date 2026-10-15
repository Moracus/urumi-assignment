# Issue #23 implementation notes

Issue: Enforce and verify gateway egress restrictions.

## Changes

- `infra/helm/urumi/templates/gateway-egress-networkpolicy.yaml`, `values.yaml`, `values.schema.json`: gateway-only egress isolation; namespace/Pod-scoped DNS, same-namespace enabled MCP peers, explicit MongoDB/API/additional approvals, exact host routes and TCP ports, schema validation rejecting broad or malformed peers. No MongoDB workload is introduced.
- `templates/gateway-deployment.yaml`: API Service/backend approvals become application upstream CIDR denials as well, preserving the fixed Secret reader's separate network path.
- `test-gateway-egress.rb`: renders local/production defaults and configured overlays; checks policy selector/protocols/ports/peers, hard denials, unchanged non-egress resources, single replica, internal exposure, existing Ingress/PVC names, opt-outs and rejected malformed/broad rules. Existing `test-secret-rbac.rb` checks dedicated ServiceAccount binding and exact namespaced named get-only permissions.
- `verify-gateway-egress.mjs` and its CLI regression tests: read-only probes through existing gateway/control Pods, real DNS and MongoDB ping, TLS API Secret GETs with mounted credentials, controlled denied destinations, status-only output. External kubectl responses are substituted only in CLI regression tests; those tests are not live enforcement evidence.
- `docs/gateway-egress.md`, README, system design, threat model, destination and credential procedures: required site overlay, Secret provisioning, policy extension, CNI/DNAT/API/mesh/node/IPv6 constraints, single replica, read-only live matrix, separate skipped results.

## Executed checks

- Gateway typecheck and build passed: `pnpm --filter @urumi/gateway typecheck`, `pnpm --filter @urumi/gateway build`.
- Local and production `helm lint` passed.
- `ruby infra/helm/urumi/test-gateway-egress.rb` passed; it executes Helm template for both environments, configured destinations and invalid configurations. Running the same regression against an isolated archive of starting commit `2ecfd69` failed with `Gateway egress isolation required`. This baseline check was performed after implementation; it was not a test-first cycle.
- `ruby infra/helm/urumi/test-secret-rbac.rb` passed for both environments and default/configured Secret approvals.
- `node --check infra/helm/urumi/verify-gateway-egress.mjs` and `--help` passed.
- `node --test infra/helm/urumi/verify-gateway-egress.test.mjs`: 4/4 passed. Cases cover complete matrix, failed controls/refused sockets, missing/forbidden Secrets, dependency failure, incomplete matrix and remote-payload suppression.
- Full real-MongoDB integration runner started with `pnpm --filter @urumi/gateway test:integration`; final result will be recorded after completion.
- No shared package/consumer changed, so workspace-wide checks are not applicable.

## Live inspection and skipped checks

Read-only `kubectl get pods -n urumi` showed all six existing workloads 1/1 Running. `kubectl get svc,ingress,pvc,networkpolicy -n urumi` showed six ClusterIP Services, only gateway/storefront Ingress, both existing PVCs Bound, and the six existing ingress policies. Cluster-wide policy inspection found only those policies. `kubectl get daemonsets,pods -n kube-system -o wide` showed kindnet and kube-proxy, CoreDNS and control-plane Pods. Node inspection showed one Ready Kind node. These checks describe the existing installation, not a deployment of this change.

The current cluster does not supply an enforcing CNI through this repository's configuration, has no deployed new egress policy and has no configured persistent MongoDB workload in the namespace. New policy rollout, enforcing-CNI allowed/denied connectivity, gateway Pod-network approved/denied Secret reads, fresh rollout readiness and end-to-end Ingress smoke checks were **not executed**. Rendered tests and substituted CLI responses are explicitly not live enforcement. No cluster, CNI, deployment, Secret, PVC or application data was changed by this task. No commerce writes were performed.

## Operator steps and limitations

Follow [gateway egress configuration and verification](gateway-egress.md). Supply a reviewed overlay for real DNS/CNI behavior, all MongoDB members and exact API Service/backend addresses/ports. Provision the existing URI Secret and dedicated approved upstream Secrets separately. Configure both application and network approvals for additional upstreams; apply destination ingress policies too. Lint/render local/production plus the overlay, then use the existing Helm rollout procedure with one gateway replica and verify fresh connections.

Default empty MongoDB/API approvals intentionally fail closed; values files are renderable examples, not complete deployments. Policies cannot restrict API HTTPS paths; the fixed TLS reader, application Secret allowlist and named get-only RBAC enforce that boundary. Additive policies, node exemptions, DNAT, mesh proxies, mutable DNS/labels/Services and connection tracking remain environment-specific limits. Preserve PVCs and data. The full MongoDB workload and final Brief 3 integration remain outside this issue.
