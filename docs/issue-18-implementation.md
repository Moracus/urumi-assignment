# Issue #18 implementation notes

Issue: Register upstreams without restarting the gateway.

## Changes

- `apps/gateway/src/upstream/management.ts`, `registrations.ts`, `inspection-routes.ts`, and `app.ts`: strict administrator POST, canonical validation and unique indexes, durable insert before connection, sanitized 201 connected/offline outcomes, live revision-aware inspection. Reuses dashboard session/Origin/CSRF guards.
- `upstream/registry.ts`, `upstream/types.ts`, `tools/aggregator.ts`, `tools/types.ts`, `tools/resolver.ts`, `tools/invoker.ts`, and `execution/types.ts`: per-server maintenance serialization, connection/catalog generations carried through resolution and checked before actual invocation, stale failure/publication guards and shutdown cleanup, duplicate discovered-name rejection isolated to that upstream.
- `app.test.ts` and `tools/aggregator.test.ts`: real HTTP/SDK/MongoDB coverage for creation, restart, unchanged schemas/results/audit attribution, strict validation, concurrent ID/canonical endpoint duplicates, session/role/Origin/CSRF, blocked/offline connection isolation and recovery, revocation, persistence failure, collision isolation and stale mappings/failures.
- `README.md`, `docs/systemdesign.md`, `docs/threat-model.md`, and `docs/upstream-registrations.md`: API examples, security and operator behavior, canonicalization and partial failure semantics.

## Verification

Gateway typecheck and build passed. Targeted compiled `node:test` runs passed for creation/restart, validation/concurrency, session guards, offline recovery, persistence failure, generation checks and collision isolation. The initial create regression failed with missing POST (404), then passed after implementation.

The first full gateway suite through the real MongoDB integration runner passed 102/102 tests. The final run including the review regression passed **103/103 tests, zero failures or skips**, and cleaned up its disposable databases. The focused review regression failed before the fix (current client remained connected after a transport failure following refresh) and passed after it. Gateway typecheck and build passed again after the fix.

Two-axis review uses the starting commit `96ff922541f17b87d5ae94c3bcaf212db546cd1b` as its fixed point and issue #18 as its spec.

Executed commands:

- `pnpm --filter @urumi/gateway typecheck` — passed, including after review fix.
- `pnpm --filter @urumi/gateway build` — passed, including after review fix.
- `env MONGODB_TEST_URI=… node --test --test-name-pattern=… apps/gateway/dist/app.test.js` — targeted creation, validation, security, recovery, persistence, generation and collision tests passed against the isolated database.
- `node --test --test-name-pattern='transport failure from the current client' apps/gateway/dist/app.test.js` — review regression failed as expected before the fix; rerun alongside stale-mapping coverage passed after the fix.
- `pnpm --filter @urumi/gateway test:integration` — final full suite passed 103/103; provisions real replica-set/standalone MongoDB, builds gateway, runs all configured gateway tests, and removes disposable containers afterward. Logs: `/private/tmp/urumi-18-integration-final.log`.
- `git diff --check` — passed.

Sandbox-only attempts initially denied Docker/socket access; authorized reruns executed successfully. No shared consumers or Helm manifests changed, so workspace and Helm checks are not required. Live Kubernetes readiness, connectivity, RBAC/NetworkPolicy enforcement and WooCommerce operations were not tested or deployed.

## Operator steps and limitations

Rebuild/deploy the gateway and retain one replica. Approve any new destination origin/CIDRs and deployment connectivity before POST; no new environment variables or chart changes are introduced. Use an eligible administrator session, trusted Origin and CSRF token; inspect detail/tools and use an already connected MCP client to list/call. See [registration examples and failure behavior](upstream-registrations.md#register-without-restart-18).

Only authentication mode none can be created. Secret resolution, edit/enable/disable/remove/manual-refresh APIs, frontend screens and multi-replica synchronization remain separate tickets. Connection failures return a durable 201/unreachable resource and automatic recovery runs every 30 seconds. A lost response may follow a durable write; inspect by ID before retrying. A process interruption between insert and runtime reconciliation recovers on restart. Desired registrations persist, while observed status/tools and audit records are not durably persisted by this work. No cluster, Secret, commerce data or persistent volume changes were made.


## Standards

The reviewer identified one P2: successful catalog refresh advanced the generation while preserving the client, which could suppress a later failure from that still-current connection (AGENTS.md §12 requires marking connection failures unhealthy). The fix retains the catalog generation check before invocation and uses client identity for transport failure attribution. A replaced client's delayed failure remains ignored. The reviewer verified the follow-up and reported no remaining documented-standard breaches or material heuristic smells.

## Spec

No findings. The reviewer confirmed the create-only scope, strict administrator POST, canonical validation and concurrent duplicates, persistence-first/offline behavior, generation-aware invocation, coherent discovery and same-client MCP use, authorization/audit preservation and documented partial failures.

Review totals: Standards 1 found and fixed, 0 remaining; Spec 0 findings.
