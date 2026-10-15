# Issue #16 implementation notes

Implemented the destination guard in the existing connection/registry/application path. The public MCP transport, authentication, roles, names, execution/audit pipeline, timeouts and WooCommerce OAuth behavior are preserved. Undici is added to provide a dedicated dispatcher and socket connector without replacing MCP routing.

## Changed files

- `apps/gateway/src/upstream/destination-policy.ts`: origin/CIDR policy, hard denials, Kubernetes API address denial, bounded DNS and literal-address socket connector.
- `apps/gateway/src/upstream/connection.ts`, `registry.ts`, `app.ts`: shared policy construction/validation, guarded SDK fetch, redirect rejection and dispatcher cleanup.
- `apps/gateway/src/app.test.ts`: application regressions for startup rejection, all default services/additional destination approval, mixed DNS answers, redirect denial, changing DNS through automatic recovery, API aliases and operator denials.
- `apps/gateway/src/identity/{password-reset,persistence,recovery,roles}.integration.test.ts`: explicit controlled-loopback configuration in existing real-network fixtures.
- `apps/gateway/package.json`, `pnpm-lock.yaml`: Undici dependency.
- `infra/helm/urumi/values.yaml`, `templates/gateway-deployment.yaml`: policy settings/environment wiring.
- `README.md`, `docs/systemdesign.md`, `docs/threat-model.md`, `docs/upstream-destinations.md`, this file: architecture, configuration, limits and verification notes.

## Validation

The initial startup regression was observed failing before implementation and then passing. Initial integration attempts exposed a DNS-injection TypeScript signature problem and Node BlockList IPv4/IPv6 mapping behavior; both were corrected. The Kubernetes API alias regression was observed failing (one dial) before its fix and passing (zero dials) afterward. An approved-destination test was corrected to compare unique resolved hosts rather than assume one socket per service.

Executed gateway typecheck/build, focused compiled application tests, the real MongoDB integration runner, and Helm lint/template for both local and production environments. The first complete post-fix integration run passed 86 tests. Final full integration run passed **89 tests, 0 failures, 0 skipped**, including all review fixes.

Standards review: zero hard violations; one optional test-helper duplication observation. Spec review identified the Kubernetes API IP/443 gap, now fixed and re-reviewed with no remaining blocking findings.

Workspace checks are skipped because shared packages/consumers are unchanged. Live Kubernetes rollout, Pod readiness, Services, Ingress and allowed/blocked connectivity were not checked. Helm rendering is not evidence of CNI enforcement. No data/PVC or cluster resets were performed. Integration MongoDB containers use the existing disposable runner.

Final executed commands (all passed):

- `pnpm --filter @urumi/gateway typecheck`
- `pnpm --filter @urumi/gateway build` (also executed by the integration runner)
- Focused compiled `node --test` application regressions, including observed red/green cycles described above
- `pnpm --filter @urumi/gateway test:integration` (real disposable replica-set and standalone MongoDB, full compiled gateway suite)
- `helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml`
- `helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml`
- `helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-local.yaml`
- `helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-prod.yaml`
- `git diff --check` and `git diff --cached --check`

## Operator steps and limits

Rebuild/deploy the gateway image and apply the chart settings described in `docs/upstream-destinations.md`. Configure additional exact origins and narrow CIDRs, deployment-specific denied API/admin ranges, and independent deployment egress policy. The current chart still provides ingress-only isolation; enforce/verify egress with the deployed CNI. Keep loopback disabled in deployments. No new destinations are approved by default.

The policy cannot identify workloads behind approved IPs or control NAT, service-mesh and routing changes; protect cluster DNS/Service administration. Kubernetes supplies its API Service IP automatically; include any other API VIPs/admin ranges in explicit denials. Registration/edit HTTP APIs and broader registry persistence/network-policy work remain separate tickets. Their validation must reuse the exported policy before persistence. This task does not introduce a second invocation path.
