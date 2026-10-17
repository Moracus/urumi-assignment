# Issue #46 validation and handoff

Issue: **Complete the two-user acceptance workflow and deployment handoff**.
Starting point: `8ddd22df5142cfb0720f44a4e8d84b79ae2ff170` on `main`.
Evidence recorded 2026-10-17; no live Kubernetes/provider/store actions were performed.

## Changes

- `apps/dashboard/tests/workflow.spec.ts`: integrated administrator A chat and
  session attribution, distinct browser-onboarded member B with public URL/key-only
  MCP access, exact key attribution, backend audit denial, revoked continuing-client
  tool call/discovery rejection and safe unauthenticated audit attribution.
- `apps/dashboard/tests/server.mjs`: deterministic acceptance provider exchanges
  two real MCP results with the matching call IDs and derives the final answer
  from those results. Unique default-fixture descriptions prevent extra server
  registrations from changing selection. This endpoint exists only in the browser fixture.
- `apps/gateway/tests/commerce.test.mjs`: disable/remove while the provider holds a
  stale catalog, fresh MCP/provider discovery withdrawal, stale-call rejection,
  healthy-tool isolation, enablement and transport-outage/refresh recovery across
  chat and a continuing SDK client; classified and credential-safe audit evidence.
- `docs/setup/k3s.md`: same-chart VPS prerequisites, image distribution, site/Secret
  configuration, staged installation, upgrades and rollback preserving data.
- `docs/operations/acceptance-handoff.md`: ordered live checklist, authorization,
  evidence format, commerce/checkout/timezone prompts, two-user MCP/chat, lifecycle,
  Pod failure/recovery, audit inspection and optional-feature inventory.
- `README.md`, `docs/README.md`, `docs/guides/browser-to-mcp-workflow.md`: linked
  setup, acceptance and current evidence; corrected outdated audit scope.
- `docs/architecture/systemdesign.md`, `docs/architecture/threat-model.md`:
  consolidated provider messages, identity separation, gateway enforcement,
  client-token non-forwarding, shared store authority and malicious-content risks.

No production interface, dependency, environment variable, schema, Helm manifest
or workload was changed. Existing untracked `day5_brief.md`,
`docs/planning/day5-spec.md` and `urumi-assignment.md` are excluded from the commit.

## Executed commands

Commands run from the repository root unless noted. Replica-set URI below belongs
only to the disposable test stack; it contains no credential.

| Command | Result |
| --- | --- |
| `docker compose -p urumi-identity-integration -f infra/mongodb/compose.integration.yaml up -d --wait --wait-timeout 90` | Disposable replica-set and standalone MongoDB became healthy. |
| `pnpm --filter @urumi/dashboard typecheck` | Passed repeatedly during implementation. |
| `env 'MONGODB_TEST_URI=mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true' pnpm --filter @urumi/dashboard test:browser workflow.spec.ts` | Initial red failed because the provider lacked the new acceptance exchange. Two follow-up failures revealed test login synchronization errors, corrected by waiting for the dashboard. The focused journey then passed. Final strengthened assertions are included in the full run below. |
| `env 'MONGODB_TEST_URI=mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true' node --test apps/gateway/tests/commerce.test.mjs` | 7 tests passed after lifecycle additions; final focused run with outage coverage passed all 8 tests. A sandboxed attempt failed MongoDB connection access; the permitted rerun passed. |
| `pnpm typecheck` | All workspace packages passed. |
| `pnpm test:env` | 2 tests passed. |
| `ruby infra/helm/urumi/test-chat.rb` | Passed local/production chat and scoped egress assertions. |
| `ruby infra/helm/urumi/test-dashboard.rb` | Passed local/production dashboard and runtime public URL assertions. |
| `ruby infra/helm/urumi/test-mongodb.rb` | Passed local/production, managed/external assertions. |
| `ruby infra/helm/urumi/test-gateway-egress.rb` | Passed local/production assertions. |
| `ruby infra/helm/urumi/test-secret-rbac.rb` | Passed local/production assertions. |
| `helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml` | Passed; optional chart-icon recommendation only. |
| `helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml` | Passed; optional chart-icon recommendation only. |
| `helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-local.yaml > /private/tmp/urumi-46-local.yaml` | Passed. |
| `helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-prod.yaml > /private/tmp/urumi-46-prod.yaml` | Passed. |
| `pnpm test:workflow > /private/tmp/urumi-46-workflow.log 2>&1` | Initial sandbox attempt could not access Docker. Approved rerun **passed**: workspace typecheck/build, **3 WooCommerce date tests**, **185 gateway/MongoDB tests**, and **79 Playwright tests**, with zero failures/skips. This includes the final fixture-selection fix and strengthened two-user audit/revocation assertions. No live provider required. |
| `git diff --check` | Passed during implementation and on the final staged/unstaged diff. |

Local Markdown file targets in the changed docs were also checked with a Python
path-existence scan and passed. The initial unquoted test-URI invocation was
rejected by zsh glob expansion before tests started; recorded commands use quotes.

The full runner owns disposable containers and removes them on exit; it never
operates on Kubernetes application PVCs. Compiler-generated dashboard build metadata
is excluded from the change. NO_COLOR/FORCE_COLOR and Mongoose deprecation warnings
are dependency/tooling diagnostics, not live environment evidence.

## Live checks and rollout remain operator work

Every row of the [live checklist](../operations/acceptance-handoff.md#live-checklist)
remains **unexecuted** in this task: actual readiness/Services/routes/TLS/persistence,
Secret references and RBAC, allowed/blocked connectivity/CNI enforcement, real-provider
chat/product publication and storefront visibility, manual COD checkout and
WooCommerce-admin order confirmation, today's orders in the chosen timezone,
external client through real ingress, live revocation/disablement and explicitly
authorized Pod failure/recovery, with audit inspection throughout. Prerequisites
are a selected deployed environment, appropriate credentials/access, real provider
account/approved egress, configured WooCommerce test checkout and explicit commerce
mutation/failure-exercise authorization. Fixture calls do not satisfy these checks.

No deployment is required for #46's tests/docs alone. To demonstrate the completed
Day 5 features, operators must build/publish/load and roll out gateway/dashboard/
WooCommerce images containing their implementations, retaining other configured
images and the site overlay. Provision existing database/provider/upstream Secret
references and scoped connectivity, set the public runtime URL, and follow
[k3s](../setup/k3s.md) or [local setup](../setup/local-development.md). Preserve
all existing PVC/account/store data. No migration or new configuration is added
by this issue. Record release/image/overlay/CNI versions and actual results.

Audit writes have no durable queue/backfill or lossless outage guarantee: a
failed write can lose the row; a lost acknowledgement can leave uncertainty.
An audit failure never triggers replay or replaces an already determined tool
result. Already admitted calls may finish after access withdrawal; timed-out
commerce writes may have applied and require inspection before any manual retry.
Single gateway replica/shared store authority, manual store setup, no HA/backups
and unverified production/CNI/provider/commerce behavior remain explicit limitations.

## Review

Two parallel reviews inspected the staged implementation against fixed starting
commit `8ddd22d` (before the final commit); the diff included the new handoff files.

### Standards

No documented-standard violations found. One low-priority maintainability finding
identified catalog-position selection of the provider fixture clock. Default
calculator/time fixture descriptions now identify those tools uniquely, independent
of extra registered catalogs; all handlers are closed on teardown. Follow-up
Standards review found no remaining findings.

### Spec

No findings. The new integrated journey/lifecycle coverage and existing security,
timeout/recovery and audit suites match #46. Setup, rollback, threat consolidation
and the live checklist preserve the required scope; remaining live work is explicit.

Final unresolved findings: Standards **0**, Spec **0**. Full workflow validation
passed as recorded above; no live results are claimed.
