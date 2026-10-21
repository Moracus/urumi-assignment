# Server diagnostics #55

The protected server inspector now shows a safe stage, observation time and frontend-owned operator guidance for current failures. Screenshots were inspected at [360px](diagnostics-360.png), [768px](diagnostics-768.png) and [1440px](diagnostics-1440.png). Text and controls remain readable, the table scrolls locally, and the document has no horizontal overflow. The failure section has a named region, heading and semantic observation time; existing keyboard navigation and lifecycle controls are preserved.

## Verification

- `pnpm typecheck` and `pnpm build` passed across the workspace.
- Targeted `app.test.ts` runs passed for protected API diagnostics, structured DNS/socket evidence, late metadata/disable failures, recovery, stale replacement-client failures and real five-second connection/discovery timeouts.
- The metadata-revision regression failed when its discovery publication guard was removed, and passed with the guard restored.
- `MONGODB_TEST_URI=… pnpm --filter @urumi/dashboard test:browser server-diagnostics.spec.ts` passed all four cases against real dashboard sessions, disposable MongoDB and controlled MCP upstreams.
- Browser cases cover HTTP authentication, discovery failure, recovery, malformed wire results, invocation failure, valid structured MCP tool errors, uncertain invocation timeouts, read-only inspection, no automatic replay, healthy calculator isolation, synthetic-secret/exception-URL absence and service failures with stale-data warnings.
- Existing affected server inspection/edit/lifecycle browser tests passed all 22 cases.

## Reviews and limits

Independent standards and specification reviews cover the diff against starting commit `5d083a3`. Review identified a late diagnostic publication race after metadata edits; captured configuration revisions now prevent publication of obsolete diagnostic evidence. Regression tests cover that race and disable barriers.

Evidence limits: DNS/TLS/refused classifications use controlled external network-adapter error codes, HTTP authentication uses actual controlled HTTP responses, and malformed content is injected on the wire. These checks do not establish live Kubernetes health, Secret access or network enforcement. No Helm resources changed. Rebuild and deploy gateway and dashboard artifacts together through the existing deployment procedure; there is no migration or new environment configuration.

## Standards

Hard documented violations: None found in the completed diff. The earlier regression-test gap is resolved with gateway tests for sanitized evidence, credential/discovery failures, recovery, configuration barriers, and timeouts, plus browser coverage through the public inspection and MCP interfaces.

Possible smells: None substantial. Diagnostic classification belongs in its dedicated module; network evidence is classified at the adapter boundary; frontend explanatory copy remains with the frontend. The changes preserve existing transport, registry, execution, authentication, and authorization boundaries. Test-only controlled upstream behavior stays in the fixture and includes cleanup.

## Spec

No remaining spec findings. The revision race is fixed, and regression coverage exercises stale publication, reset/recovery, structured network evidence, protected diagnostics, secret exclusion, valid tool errors, invocation failure, timeout/no replay, healthy-upstream isolation, and dashboard service failures.

The frontend keeps guidance local, distinguishes read refresh from discovery refresh, and explains uncertain write outcomes. Responsive evidence shows readable diagnostics and usable controls; browser tests cover three widths. No infrastructure or authorization policy changes were found.

Review summary: Standards 0 findings; Spec 0 findings. Neither axis has an outstanding issue.

## Changed files

- `apps/gateway/src/upstream/diagnostics.ts`: safe stage/code vocabulary and structured evidence classification.
- `apps/gateway/src/upstream/destination-policy.ts` and `connection.ts`: preserve sanitized network and HTTP evidence at the transport boundary.
- `apps/gateway/src/upstream/types.ts`, `registry.ts` and `inspection-routes.ts`: current observations, clearing and revision/client guards, additive protected inspection metadata.
- `apps/gateway/src/tools/invoker.ts`: invocation diagnostics while retaining the execution and audit boundaries.
- `apps/dashboard/src/servers.tsx`: validated diagnostic metadata and frontend-owned guidance.
- `apps/gateway/src/app.test.ts`, `apps/dashboard/tests/server-diagnostics.spec.ts` and `server.mjs`: controlled API/network/browser regression coverage and fixture cleanup.
- `docs/guides/upstream-registrations.md` and this evidence directory: operator guidance, evidence limits, validation and reviewed screenshots.

Final validation on 2026-10-21: `pnpm test:workflow` exited successfully with 3 WooCommerce tests, 208 gateway tests and 124 browser tests passing. It also ran workspace typechecks/builds, exercised disposable replica-set/standalone MongoDB and database-outage recovery, and cleaned up its test containers. The final `git diff --check` passed. Standards and Spec reviews each reported zero remaining findings. Helm and live Kubernetes validation were not run because no deployment resources changed.
