# Issue #34 validation — 2026-10-16

Scope: optional authenticated MongoDB Helm deployment. No application API, authentication policy, tool names, execution pipeline, frontend behavior, or WordPress/MariaDB templates changed.

## Executed checks

- `pnpm typecheck` — passed across the workspace.
- `pnpm build` — passed across the workspace, including dashboard production bundle.
- `ruby infra/helm/urumi/test-mongodb.rb` — passed. The initial test failed before implementation because no managed StatefulSet existed. Final checks cover local/production-like values, managed/external modes, retained storage, probes/resources, authentication and keyfile Secret references, private Service, narrow network rules, URI compatibility, unchanged commerce resources, and schema rejection of raw password/invalid settings.
- `ruby infra/helm/urumi/test-secret-rbac.rb` — passed for local and production-like values.
- `ruby infra/helm/urumi/test-gateway-egress.rb` — passed for local and production-like values.
- `node --test infra/helm/urumi/verify-gateway-egress.test.mjs` — 4 tests passed.
- `helm lint` with each of `values-local.yaml` and `values-prod.yaml`, with managed MongoDB enabled and disabled — all four passed (only the existing optional chart icon recommendation).
- `helm template` with each environment and managed/external mode — passed, including renders consumed by the regression checks.
- `pnpm --filter @urumi/gateway test:integration` — full gateway suite passed: **132 tests**, zero failures/skips, using disposable replica-set and standalone Docker fixtures.
- `pnpm --filter @urumi/dashboard test:browser` — full browser suite passed: **54 tests**, using the isolated authenticated chart-managed MongoDB over a loopback-only port-forward, real gateway, and controlled MCP upstreams. The existing Mongoose deprecation and color-environment warnings did not fail the suite.
- `git diff --check` — passed.

## Live local evidence

Target context: `kind-urumi`. Only new MongoDB resources were applied in isolated namespace `urumi-mongodb-34`; the application release in namespace `urumi` was not upgraded.

- Chart-rendered MongoDB 8.0 StatefulSet reached `1/1 Running` with authenticated primary readiness. The initial 60-second rollout wait timed out during the first image download; the image took about 66 seconds to pull. Subsequent inspection confirmed readiness.
- `infra/mongodb/verify-persistence.js` seed phase authenticated and committed a majority-write transaction.
- Deleted only `urumi-mongodb-0`, keeping its PVC. Replacement Pod reached readiness, with zero container restarts.
- Restore phase found the pre-restart marker and committed a new majority-write transaction.
- PVC UID before and after: `2efee4b7-ad72-4c48-a4df-88a1f73cd44b`; claim remained Bound, 5Gi, ReadWriteOnce, storage class `standard`.
- Unauthenticated `listDatabases` was rejected with MongoDB authorization code 13. The first assertion needed correction because mongosh throws on this error; a subsequent explicit catch asserted code 13 and passed.
- Through a loopback-only port-forward, the existing compiled `connectIdentityStorage()` connected with authentication and passed actual startup index and transaction checks. The sandbox initially blocked this socket; the escalated rerun passed. Operator credentials were read from a protected generated Secret file, never printed.
- Final inspection showed an internal headless MongoDB Service, no database Ingress, and all six pre-existing application Pods in namespace `urumi` still `1/1 Running` with zero restarts. Existing WordPress/MariaDB claims and data were not modified.

## Limits and operator follow-up

This cluster uses `kindnet`, which does not establish NetworkPolicy enforcement. Allowed/blocked Pod-to-Pod database traffic under an enforcing CNI remains **not verified**. The rendered selector/port and existing egress/RBAC regressions passed; those results do not prove live isolation.

No production deployment, TLS, backup/restore, HA failover, complete application Helm rollout, or external operator-database connection was tested. External mode's existing URI Secret contract and absence of managed database resources were verified through rendering. Browser tests use controlled MCP upstreams, not live WooCommerce mutations.

The isolated test namespace, authenticated MongoDB and retained test PVC are left available for inspection. Do not delete application PVCs. Generated credential files are outside the repository in a protected temporary directory; no credentials are committed. See [deployment and exact verification commands](mongodb-deployment.md) before rollout. A production/application rollout requires pre-provisioned database auth and gateway URI Secrets, a least-privilege application database user, and reviewed site network settings.

## Review

The code-review skill ran separate standards and spec agents against the staged change from baseline `6232de9282c3ee824bcad34bd29b0fe3ca0a4104`. Standards: no findings. Spec: one pending evidence-document link, resolved by this file. No implementation defects or scope expansion were identified.
