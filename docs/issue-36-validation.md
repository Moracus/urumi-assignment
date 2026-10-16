# Issue #36 validation — 2026-10-16

Baseline: `9b0d5741232b9e1f7ef305d264bd5eec1cbe3aed` on `main`.
Scope: [Verify the complete browser-to-MCP workflow](https://github.com/Moracus/urumi-assignment/issues/36),
using parent #24's approved running-application test seam.

## Changes

- Browser tests: new `apps/dashboard/tests/workflow.spec.ts`; extended
  `server-edit.spec.ts` to keep one administrator client across the complete
  server lifecycle; added controlled order tools in `server.mjs`; updated expected
  catalogs/counts in `keys.spec.ts` and `overview.spec.ts`.
- Runner: root `package.json` adds `test:workflow`; `infra/mongodb/test.sh` adds
  optional `--browser` with workspace checks/builds and sequential gateway/browser
  suites sharing the existing disposable replica-set infrastructure.
- Operator tooling: `apps/dashboard/scripts/smoke-readonly.mjs` and the dashboard
  `smoke:readonly` command accept environment credentials and an existing order ID.
  Only success labels and fixed safe failure text are emitted.
- Documentation: README entry point and
  [workflow, coverage map, operator demonstration and handoff](browser-to-mcp-workflow.md).
- Backend production code, Docker, Helm, public APIs, tool permissions, Secret
  handling and deployment resources are unchanged. No deployment is needed for
  these test/documentation changes.

## Executed validation

| Command | Result |
| --- | --- |
| `pnpm --filter @urumi/dashboard typecheck` | Passed after test changes |
| `pnpm test:workflow` | Passed: workspace typechecks/builds; 132 gateway tests, 0 failures/skips; 55 browser tests |
| `node --test infra/helm/urumi/verify-gateway-egress.test.mjs infra/helm/urumi/verify-dashboard.test.mjs` | 5 passed, 0 failed, 0 skipped |
| `bash -n infra/mongodb/test.sh` | Passed |
| `bash infra/mongodb/test.sh --invalid` | Expected exit 2 and usage; rejected before Docker access |
| `node apps/dashboard/scripts/smoke-readonly.mjs` without configuration | Expected exit 1 with fixed diagnostic; no credential output |
| `git diff --check` | Passed |

The new primary test first failed because the controlled catalog lacked order
read tools; after adding them it passed. Earlier test-authoring errors (header
typing and a reload before login completed) were corrected. The complete runner
invokes `pnpm typecheck`, `pnpm build`, and `pnpm --filter @urumi/gateway test`
before `pnpm --filter @urumi/dashboard test:browser`. The gateway suite uses:

```text
MONGODB_TEST_URI=mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true
MONGODB_STANDALONE_TEST_URI=mongodb://127.0.0.1:27418/urumi_test?directConnection=true
MONGODB_TEST_CONTAINER=<disposable Compose replica container ID>
```

The runner exited 0 and removed its disposable containers/network. The browser
suite passed all 55 tests in 1.2 minutes, including the smoke command exercised
against controlled upstreams and the complete continuing-administrator lifecycle.
Compose uses `infra/mongodb/compose.integration.yaml` and project
`urumi-identity-integration`. No gateway suite was skipped for absent MongoDB.
Sandboxed execution of the deployment-verifier regressions initially failed
because loopback listening returned EPERM; the permitted rerun passed all five.
Existing Mongoose deprecation and terminal color warnings are non-fatal.

## Evidence limits and Day 4 status

No live WooCommerce smoke was executed for this issue: the operator must provide
a real gateway key, provision upstream WooCommerce credentials, and supply an
existing readable order ID. Automated commerce results use controlled MCP tools
and do not establish OAuth/WordPress connectivity. No write smoke was performed.

No Docker image builds, Helm changes, Kubernetes rollouts, ingress/TLS probes,
gateway/MongoDB Pod restarts, or live allowed/blocked connectivity checks were
performed for #36. Existing #34/#35 evidence remains separately attributed in
their validation records. Network isolation still requires an enforcing CNI;
the available cluster's kindnet does not prove it. Application volumes and
the existing cluster were untouched.

| Day 4 capability | Status for this issue |
| --- | --- |
| Brief 1 identity, sessions, keys, ownership, roles, revocation and permanent disable invalidation | Implemented and verified at the application boundary with real replica-set tests |
| Brief 2 persistent/live registry, catalog/schema preservation, approved references, lifecycle and failure isolation | Implemented and verified at the application boundary; Kubernetes Secret/RBAC and network enforcement are not newly verified |
| Brief 3 dashboard browser-to-MCP workflows | Implemented and verified with controlled upstreams; deployed ingress, restart persistence and real commerce are not newly verified |
| Full deployment and live-store milestone | Incomplete verification; use the operator checks linked in the workflow guide |

The [Day 5 handoff](browser-to-mcp-workflow.md#deployment-evidence-and-day-5-handoff)
documents authenticated identity, `executeTool`, authorization, discovery,
invocation, persistent server metadata, dashboard sessions, and console audit
hooks. Durable audit history and chat remain outside this issue.
