# Issue #17 implementation notes

Implemented persistent desired upstream registrations, versioned atomic default migration, startup restoration, and administrator-only GET inspection through the existing application and dashboard-session boundaries. Observed status and discovered tools remain runtime state. Existing namespace IDs, role policies, destination controls, MCP transport, execution/audit path, and identity ADRs are preserved.

Changed files:

- `apps/gateway/src/upstream/registrations.ts`: validated registration model, unique canonical endpoint/ID indexes, transactional migration and desired-configuration loading.
- `apps/gateway/src/upstream/inspection-routes.ts`: safe list/detail/tool projections.
- `apps/gateway/src/app.ts`, `identity/storage.ts`, `identity/dashboard-routes.ts`: shared storage/startup/admin-route integration.
- `apps/gateway/src/upstream/types.ts`, `upstream/registry.ts`: reference metadata, fail-closed unresolved credentials and serialized refresh maintenance.
- `apps/gateway/src/app.test.ts`, `identity/persistence.integration.test.ts`, `identity/roles.integration.test.ts`: real-database HTTP/SDK restart, migration, auth and outage regressions.
- `README.md`, `docs/systemdesign.md`, `docs/threat-model.md`, `docs/upstream-registrations.md`, `docs/upstream-destinations.md`: implemented behavior, response contracts, security and operator guidance.

Review used the implementation skill's code-review step against starting commit `e02b4c6965a68807e2ad505881de6f254824342f`, reviewing the staged work before commit. Standards review reported no findings. Spec review identified unconditional static-default validation after migration; regression coverage and correction ensure obsolete defaults cannot gate persisted configuration on restart.

Executed validation:

- `pnpm --filter @urumi/gateway typecheck`: passed.
- `pnpm --filter @urumi/gateway build`: passed.
- Focused compiled `app.test.js` regressions against real replica-set MongoDB: passed (five persistence/inspection scenarios), plus three final regressions covering initial destination rejection, obsolete-default restart and the existing roles/revocation restart test.
- TDD red runs confirmed the initial missing inspection route and obsolete-default restart failure before implementation/correction.
- Initial `pnpm --filter @urumi/gateway test:integration`: 93 passed, one existing restart fixture failed because persisted upstreams now require their destination approval on restart. Corrected that fixture and reran it successfully.
- Final `pnpm --filter @urumi/gateway test:integration`: passed, **95 tests, zero failures or skips**, including all compiled gateway unit and real MongoDB integration suites. The runner built the gateway, verified replica-set/standalone behavior and removed its disposable containers on completion.
- `git diff --check` and `git diff --cached --check`: passed.


No chart/shared-consumer changes; workspace-wide and Helm checks are not required for this ticket. Live Kubernetes deployment, Pod readiness, NetworkPolicy/RBAC enforcement, Ingress and store smoke tests were not performed. The runner uses isolated disposable Docker MongoDB databases, with controlled MCP upstreams; it does not mutate commerce data.

Deploy a rebuilt gateway image against transaction-capable MongoDB with one gateway replica. First startup migrates automatically; preserve the migration marker. Configure intended default URLs and destination approvals before that first start. No new environment variables, Helm values, PVC changes or manual data migration command are required. See [contracts and operator rollout](upstream-registrations.md) for authenticated GET examples, readiness, URL normalization and restart demonstration. Credential resolution, live lifecycle APIs, frontend work and multi-replica coordination remain separate work.
