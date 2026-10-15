# Issue #19 implementation notes

Issue: Disable, re-enable, and remove upstreams safely.

## Changes

- `apps/gateway/src/upstream/inspection-routes.ts`, `management.ts`, `registrations.ts`: administrator enable/disable/delete routes reuse dashboard session, role, Origin and CSRF enforcement. Desired state updates increment revisions. Per-ID management serialization includes creation. Removal persists disabled state, establishes the barrier, completes cleanup, then deletes desired and runtime registration.
- `apps/gateway/src/upstream/registry.ts`, `connection.ts`, `apps/gateway/src/tools/invoker.ts`: synchronous generation barrier withdraws client/tools; stale discovery and failures cannot restore withdrawn configurations. Cleanup drains already-admitted calls within the existing ten-second timeout, propagates cleanup failures and retains handles for retry. Delayed, obsolete connections that fail cleanup are retained too. Enable performs fresh connection/discovery with the existing destination policy.
- `apps/gateway/src/app.test.ts`: same-client real MCP/HTTP/MongoDB lifecycle, restart/default removal, current destination enforcement, offline isolation, role/session/Origin/CSRF, revocation, persistence failures, concurrent enable/removal and in-flight audit attribution. Supplementary registry tests use controlled discovery barriers for automatic refresh/connect races and stale resolved mappings, plus external MCP SDK close failure injection for cleanup retry.
- `infra/mongodb/compose.integration.yaml`: enables MongoDB test commands only in the disposable replica-set service, allowing a real delete-command failure after durable disable. Production manifests are unchanged.
- `README.md`, `docs/systemdesign.md`, `docs/threat-model.md`, `docs/upstream-registrations.md`: implemented lifecycle APIs, transitions, ordering, partial failures and operator recovery.

## Verification

Gateway typecheck/build and focused compiled lifecycle tests passed. The initial lifecycle API test failed with missing route (404); the in-flight drain test failed before call draining was implemented. Both passed after implementation. Real MongoDB validators exercise failed desired-state writes; a test-only MongoDB failpoint exercises failed final deletion with durable disabled restoration and retry. The external SDK cleanup rejection test verifies non-success, the invocation barrier, retained cleanup state and successful retry.

The real MongoDB full integration runner passed **113/113 tests, zero failures, cancellations or skips**, and removed its disposable containers. The cleanup-failure regression added while that run was executing passed separately (1/1), including a final run after typecheck/build. Thus all 114 tests in the final tree were executed successfully; the 113-test run did not include that last regression. Full-run log: `/private/tmp/urumi-19-integration.log`. Final gateway typecheck, build and diff whitespace checks passed. Two-axis review results appear below.

Commands executed:

- `pnpm --filter @urumi/gateway typecheck`
- `pnpm --filter @urumi/gateway build`
- `env MONGODB_TEST_URI=… node --test --test-name-pattern=… apps/gateway/dist/app.test.js` for lifecycle, concurrency, stale generation/automatic refresh, offline destination checks, call draining, persistence and cleanup failures.
- `pnpm --filter @urumi/gateway test:integration` (real disposable replica-set and standalone MongoDB, build and all configured gateway tests).
- `git diff --check`

Initial sandbox Docker attempts were denied; authorized executions started the disposable databases. A final sandbox-only cleanup-test attempt was denied permission to listen on loopback; its authorized rerun passed. The deletion-failure test requires the updated test compose service with `enableTestCommands=1`; early attempts against the old service could not finish successfully and were stopped. No production MongoDB setting changed.

No shared consumers or Helm templates/values changed, so workspace and Helm checks are not applicable. Kubernetes Pod readiness, connectivity, Ingress, RBAC, NetworkPolicy enforcement and WooCommerce operations were not tested or deployed.

## Operator steps and limitations

Rebuild/deploy the gateway image with one replica; no migration, configuration variable or chart changes are required. Use an eligible administrator dashboard cookie plus trusted Origin and CSRF token for lifecycle mutations. See [API examples, ordering and recovery](upstream-registrations.md#disable-enable-and-remove-19).

An ambiguous or failed response requires inspection by stable ID and retry of the intended operation, or restart to reconcile durable intent. Cleanup/final-delete failure after durable disable leaves the server non-callable and recoverable. A successful removal stays removed across restart, including a migrated default. Existing in-flight operations may finish, so acknowledgement can wait for the normal call/discovery timeouts. No automatic write retry is introduced.

Only one gateway replica is supported; multiple replicas and out-of-band MongoDB changes lack live synchronization. Upstream credential resolution, editing/manual refresh APIs, dashboard screens and durable audit persistence remain separate work. This task changes no Kubernetes Secret, PVC, upstream exposure, NetworkPolicy or commerce data. User changes present before the task are excluded from its commit.


## Standards

No material Standards findings. The changes preserve the documented execution boundary, role/session separation, destination checks, tool names, invocation timeout, and per-server failure isolation. Disable/remove establish generation barriers before cleanup, and retained connection handles support retry after cleanup failure. Documentation describes durable ordering, ambiguous persistence outcomes, and the single-replica limitation. No material baseline code-smell findings.

## Spec

No spec findings. The implementation covers issue #19’s lifecycle APIs, durable state, invocation barriers, stale-result rejection, per-server serialization, recovery behavior, authentication boundaries, regression tests and operator documentation. No scope creep identified. The reviewer noted stale earlier wording saying lifecycle APIs were separate work; those statements were corrected.

Review used starting commit `ba35b595f8808ab71b9a191bd23ff565328d43ec` against the task diff (before committing), with issue #19 as the spec. Standards: 0 findings; Spec: 0 findings, one documentation correction applied.
