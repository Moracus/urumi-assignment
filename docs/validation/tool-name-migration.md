# Public tool-name migration validation

Implemented against starting commit `5a95f570a8458457b541511cd304dc9e3616cabb`.

Public names now share one canonical utility across MCP, chat and server inspection.
For example, `woocommerce_list_orders` retains the explicit native mapping
`upstreamName=woocommerce`, `upstreamToolName=list_orders`. Authorization and audit
metadata use the public name. No upstream tool, database schema, credential,
Kubernetes topology or networking manifest was changed.

See [naming policy, rebuild/deploy commands and Cursor/Inspector checks](../operations/tool-name-migration.md).

## Validation

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed for the full workspace, including again in the full workflow. |
| `pnpm build` | Passed for the full workspace, including again in the full workflow. |
| `pnpm --filter @urumi/gateway typecheck` | Passed during implementation and after review fixes. |
| `pnpm --filter @urumi/dashboard typecheck` | Passed after browser fixture corrections. |
| `pnpm --filter @urumi/gateway build` then `node --test apps/gateway/dist/tools/aggregator.test.js` | 11 passed. Initial migration assertions first failed against dotted behavior, then passed after implementation. |
| `node --test apps/gateway/dist/execution/execute-tool.test.js` | 2 passed. |
| `env MONGODB_TEST_URI=… node --test --test-name-pattern='chat encodes real provider calls' apps/gateway/dist/app.test.js` | Passed after a failing regression demonstrated numeric provider aliases. |
| `env MONGODB_TEST_URI=… node --test --test-name-pattern='ambiguous public names\|fresh roles filter' apps/gateway/dist/app.test.js` | 2 passed. |
| `env MONGODB_TEST_URI=… node --test --test-name-pattern='normalized and bounded public names' apps/gateway/dist/app.test.js` | Passed: native calls, distinct long names, old-name rejection and historical audit filtering. |
| `pnpm --filter @urumi/gateway test:integration --browser` | Gateway: 190 passed, 0 skipped. WooCommerce: 3 passed. Browser: 79 passed. Full command exited 0 and cleaned up its disposable containers. Runs the same gateway integration entry point with its browser flag; includes workspace typecheck/build, real disposable replica-set and standalone MongoDB, database outage tests, actual HTTP/MCP, commerce fixtures and Playwright. |
| `pnpm test:env` | 2 passed. |
| `node --test infra/helm/urumi/verify-dashboard.test.mjs infra/helm/urumi/verify-gateway-egress.test.mjs` | 5 passed. |
| `helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml` | Passed; informational icon recommendation only. |
| `helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml` | Passed; informational icon recommendation only. |
| `ruby infra/helm/urumi/test-dashboard.rb` | Passed for local and production. |
| `ruby infra/helm/urumi/test-mongodb.rb` | Passed for local/production and managed/external modes. |
| `ruby infra/helm/urumi/test-secret-rbac.rb` | Passed. |
| `ruby infra/helm/urumi/test-chat.rb` | Existing failure: “Chat must default to disabled”. Reproduced on an unmodified archive of starting commit `5a95f57`. |
| `ruby infra/helm/urumi/test-gateway-egress.rb` | Existing failure: “Defaults permit only DNS and three upstreams”. Reproduced on the same unmodified archive. |
| `node --check infra/helm/urumi/verify-milestone.mjs` | Passed. |
| `git diff --check` / `git diff --cached --check` | Passed. |

Loopback/Docker checks initially hit sandbox permission restrictions and were
rerun successfully with approved access. The full runner owns disposable test
containers and removes them on exit without touching the existing Kind cluster
or application PVCs. Logs from this run are in
`/private/tmp/toolname-full-workflow.log`; focused regression logs are adjacent.
The two failing chart scripts and their input manifests are unchanged by this
migration. Their expectations disagree with the chat-enabled starting values.

## Outstanding operator checks

No deployment, real storefront writes, paid-provider requests or live
Cursor/Inspector session was performed. Run the exact image rebuild/deployment
commands and read-only client checks in the linked migration guide. Kubernetes
readiness, live ingress and enforced connectivity must be checked after rollout;
unit/integration tests and Helm lint do not establish them. No secrets, credentials,
application data, PVCs or cluster configuration were modified. The supplied
`changing_toolname.md` remains untracked and is excluded from the implementation
commit.

## Standards

Final review: 0 remaining findings. The review found dynamic dotted names in
`verify-milestone.mjs`; those now use `makePublicToolName`, including hyphen
normalization. No remaining documented-standard violations or actionable baseline
smells were identified.

## Spec

Final review: 0 remaining findings. The review found missed dotted names for
custom registrations in two browser suites. Those are now canonical names in
positive calls, discovery checks and withdrawal/recovery checks. No other missing
behavior, incorrect implementation or scope creep was identified.

Review summary: Standards 0 outstanding findings; Spec 0 outstanding findings.

## Modified files

| File | Reason |
| --- | --- |
| `AGENTS.md` | Update agent-facing public names and reference the canonical naming policy. |
| `README.md` | Update the tool table and explain the migration and native routing. |
| `apps/dashboard/scripts/smoke-readonly.mjs` | Invoke canonical names in deployed read-only smoke checks. |
| `apps/dashboard/src/keys.tsx` | Update the member tool-name help text. |
| `apps/dashboard/tests/access.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/audit.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/chat.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/keys.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/server-edit.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/server-lifecycle.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/servers.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/dashboard/tests/workflow.spec.ts` | Migrate browser discovery, invocation, history and lifecycle assertions to canonical names. |
| `apps/gateway/src/app.test.ts` | Migrate HTTP/MCP/chat fixtures and add collision, native-routing, old-name rejection and audit-history regressions. |
| `apps/gateway/src/chat/run.ts` | Share MCP names with provider definitions; preserve offered native mappings and write guards. |
| `apps/gateway/src/execution/execute-tool.test.ts` | Migrate execution-boundary authorization and audit expectations. |
| `apps/gateway/src/identity/password-reset.integration.test.ts` | Migrate identity/authentication integration fixtures and tool assertions. |
| `apps/gateway/src/identity/persistence.integration.test.ts` | Migrate identity/authentication integration fixtures and tool assertions. |
| `apps/gateway/src/identity/recovery.integration.test.ts` | Migrate identity/authentication integration fixtures and tool assertions. |
| `apps/gateway/src/identity/roles.integration.test.ts` | Migrate identity/authentication integration fixtures and tool assertions. |
| `apps/gateway/src/security/authorization.ts` | Migrate the existing member allowlist without changing permissions. |
| `apps/gateway/src/tools/aggregator.test.ts` | Cover new names, native mappings, collisions, normalization and long names. |
| `apps/gateway/src/tools/aggregator.ts` | Generate names once and omit every ambiguous mapping, preserving healthy tools. |
| `apps/gateway/src/tools/invoker.ts` | Validate canonical/current mappings while invoking native names. |
| `apps/gateway/src/tools/public-name.ts` | Define canonical lowercase underscore names and bounded hash suffixes. |
| `apps/gateway/src/tools/resolver.ts` | Resolve explicit collision-checked mappings, including cached unavailable tools. |
| `apps/gateway/src/tools/test-aggregation.ts` | Migrate the manual aggregation/routing/failure-isolation verifier. |
| `apps/gateway/src/tools/test-failure-isolation.ts` | Migrate the manual aggregation/routing/failure-isolation verifier. |
| `apps/gateway/src/tools/test-routing.ts` | Migrate the manual aggregation/routing/failure-isolation verifier. |
| `apps/gateway/src/upstream/inspection-routes.ts` | Expose canonical collision-checked tool lists and matching counts. |
| `apps/gateway/tests/commerce.test.mjs` | Migrate commerce chat/MCP calls, audit checks and failure-isolation fixtures. |
| `docs/architecture/systemdesign.md` | Describe canonical names, collision isolation, routing, roles and shared provider names. |
| `docs/architecture/threat-model.md` | Replace obsolete provider-alias terminology with offered public names. |
| `docs/guides/api-keys.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/guides/browser-to-mcp-workflow.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/guides/dashboard-chat.md` | Document canonical provider names, collision policy and unchanged result/audit boundaries. |
| `docs/guides/mcp-authentication.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/guides/upstream-registrations.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/operations/acceptance-handoff.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/operations/commerce-chat-walkthrough.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/operations/phase1-operator-demo.md` | Update current public tool names in usage, API, workflow or operational examples. |
| `docs/operations/tool-name-migration.md` | Document naming/collision policy, exact Docker/Kind/Helm commands and client verification. |
| `docs/planning/milestone-handoff.md` | Mark historical dotted examples and link current operational instructions. |
| `infra/helm/urumi/verify-milestone.mjs` | Migrate bundled names and use the canonical utility for dynamic registration names. |
| `docs/validation/tool-name-migration.md` | Record executed checks, limitations, review results and this complete file manifest. |
