# Issue #21 implementation notes

Issue: Refresh upstream tools and recover connections.

## Changes

- `apps/gateway/src/upstream/inspection-routes.ts`: POST refresh reuses eligible administrator dashboard sessions, backend role checks, trusted Origin, CSRF and no-store safe projections. Unknown servers return 404; disabled registrations return 409 without enabling them.
- `apps/gateway/src/upstream/management.ts`: per-server refresh serializes with desired-state mutations, reads current persisted configuration, rejects unreconciled runtime revisions, and leaves desired configuration/revisions/timestamps unchanged.
- `apps/gateway/src/upstream/registry.ts`: single-server refresh exposes existing serialized discovery/recovery; periodic refresh delegates to the same path. Existing generations, connection identity checks, destination policy, five-second connection/discovery limits, ten-second call timeout, cleanup and shared execution boundary are preserved.
- `apps/gateway/src/app.test.ts`: authenticated HTTP and same-client MCP catalog/schema replacement, safe upstream failures, disabled/session/role/Origin/CSRF rejection, deterministic discovery/initialization delays, healthy-call/authentication/key/registration isolation, manual/periodic/replacement serialization, stale connection failure handling, disabled/removed barriers and current DNS policy during manual recovery. Tests use controlled real MCP servers and isolated real replica-set MongoDB storage; registry tests use its public interface.
- `README.md`, `docs/systemdesign.md`, `docs/threat-model.md`, `docs/upstream-registrations.md`: refresh response contracts, timestamps, recovery, concurrency and operator guidance.

## Verification

Gateway typecheck/build and focused compiled refresh tests passed. The first catalog-change test failed with missing POST route (404), then passed after implementation. An initial test schema typing error was corrected before the passing typecheck/build. Sandbox loopback listening initially failed with EPERM; authorized reruns passed. Focused checks cover all four new refresh tests, all three stale-discovery phases, and current DNS manual recovery. Existing collision and current-client failure tests also passed.

The full real-MongoDB integration runner passed **127/127 tests**, with zero failures, cancellations or skips, and removed its disposable containers. It executed all configured gateway application, execution, aggregation and identity suites, including the concurrent issue #20 tests present in the shared working tree. Full-run log: `/private/tmp/urumi-21-integration.log`.

Commands executed:

- `pnpm --filter @urumi/gateway typecheck`
- `pnpm --filter @urumi/gateway build`
- `env MONGODB_TEST_URI=… node --test --test-name-pattern=… apps/gateway/dist/app.test.js`
- `pnpm --filter @urumi/gateway test:integration`
- `git diff --check`

No shared consumer or Helm configuration changed, so workspace and Helm checks are not applicable. No Kubernetes rollout, readiness/connectivity/Ingress/RBAC/NetworkPolicy enforcement tests or WooCommerce operations were performed.

## Standards

No actionable findings. The independent review checked repository standards, identity ADRs and the code-review skill's baseline smells. Concurrent issue #20 edits were excluded from the reviewed task patch.

## Spec

No actionable findings. The independent review checked issue #21 against the task patch and existing lifecycle/timeout tests. Review fixed point: `fc28c3f0f9d52ab0db2b10f892161f50afa09795`; the patch was reviewed before committing. Standards: 0 findings; Spec: 0 findings.

## Operator steps and limitations

Deploy the rebuilt gateway image with one replica. No migration, chart, environment-variable, Secret or PVC changes are required. Use an eligible administrator dashboard cookie, trusted Origin and CSRF token to POST refresh; inspect the returned observed status. Verify next uncached discovery and a read-only tool call using an already connected MCP client. See [API examples and recovery](upstream-registrations.md#refresh-tools-and-recover-connections-21).

A completed attempt can return 200/unreachable. Disabled registrations return 409 and require a separate explicit enable. Cleanup/storage failures return safe 503; inspect and retry or restart. Out-of-band storage revisions require restart; refresh refuses an obsolete runtime revision. Successful discovery updates only runtime observations. Credential-dependent registrations remain fail-closed until Secret resolution is implemented. Automatic recovery continues every 30 seconds; writes are never automatically retried. Multi-replica live synchronization, dashboard UI, durable audit/observation storage and Kubernetes enforcement verification remain outside this issue.

Pre-existing and concurrent user changes are excluded from this issue's commit.
