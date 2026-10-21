# Linked investigations #56

This evidence uses the existing Playwright browser-to-gateway harness, real cookie sessions, disposable Docker MongoDB, controlled MCP upstreams and the controlled chat/provider fixtures. It establishes no live Kubernetes health, Secret/RBAC access, network-policy enforcement or real-store behavior. No deployment, storage reset, cluster reset or real WooCommerce mutation was performed.

## Controlled demonstration

Run the repository's disposable MongoDB compose harness, then:

```sh
env MONGODB_TEST_URI='mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true' pnpm --filter @urumi/dashboard test:browser investigation.spec.ts
```

The `controlled success, tool error, timeout, healthy isolation and recovery` journey registers a unique controlled diagnostic calculator and invokes it once successfully, once with a valid MCP tool error and once with an actual gateway invocation timeout. While that registration is unhealthy, the existing calculator still returns 42 and the time tool returns a valid result. A deliberate discovery refresh after restoring the fixture recovers the diagnostic calculator, and one new explicit call succeeds. No failed call is replayed.

For the captured registration/window the report has exactly **4 attributed attempts, 2 failures, 3 duration samples, 1 timeout and 1 tool_error**. The test follows each total to history and checks the exact row count, population and outcome. It expands the UTC trend, follows the bucket failure count and verifies the clipped time bounds. Contradictory outcome/population filters return zero rows. Subsequent metrics refresh, inspection and detail refresh make no mutation/discovery/execution requests. Other journeys cover a display-name edit, removal/recreation under the same public name, historical snapshots, native Back/Forward, direct loading, exact filter context, invalid/empty/stale/error states, session expiry and real administrator demotion.

## Screenshot and keyboard review

The fixture screenshots show the linked [observability/trend at 360px](investigation-360.png), [768px](investigation-768.png) and [1440px](investigation-1440.png), plus [inspection at 360px](servers-360.png), [768px](servers-768.png), [1440px](servers-1440.png) and [history at 360px](audit-360.png), [768px](audit-768.png), [1440px](audit-1440.png). All nine retained screenshots were visually inspected; content and controls fit the document, with wide tables and schemas scrolling locally. The tests open the trend with Enter, focus its named scroll region, scroll horizontally using ArrowRight and assert no document overflow. They also exercise native keyboard details and the retained server/history journeys. The trend has a caption, semantic headers, explicit UTC interval columns and textual counts for every outcome; links can be followed without interpreting a graphic or color.

## Validation and review

Independent reviews used starting point: `5429793051480bf34a75fe984daadd0d9a8257d3`.

Executed focused checks: dashboard and gateway `typecheck`; gateway and dashboard `build`; the six-file browser run (`investigation.spec.ts observability.spec.ts audit.spec.ts servers.spec.ts server-edit.spec.ts server-lifecycle.spec.ts`) passed all 44 cases, and the final `investigation.spec.ts` run passed all 9 cases. The first investigation test failed at the missing inspection link before implementation. `git diff --check` passed. The full command is `pnpm test:workflow > /private/tmp/urumi-56-workflow.log 2>&1`; its final result is recorded below when complete.


## Standards

No documented-standard violations. The initial optional duplicated-population finding is resolved: `audit/activity.ts` supplies the same populations to observability counting, duration aggregation and matching-history filters. Follow-up review reported zero remaining Standards findings.

## Spec

No independent Spec findings. Durable identity, concrete windows, history populations, navigation and session/role protections meet the ticket. Review also confirmed the follow-up accessibility correction: metric links include the numeric count in their accessible names, with browser assertions covering it. The documented live-read and audit-completeness limits remain applicable.

Review summary: Standards 0 remaining findings; Spec 0 findings. Neither axis has an outstanding issue.

## Changed files and release

- Dashboard `investigation.ts`, `audit-query.ts`, `audit.tsx`, `observability.tsx` and `servers.tsx`: shared canonical navigation, durable inspection, historical fallback, matching metric/trend links and exact-filter context.
- Gateway `audit/activity.ts`, `storage.ts`, `observability.ts` and `routes.ts`: shared recorded populations and the additive AND-composed history population filter.
- `tests/investigation.spec.ts`: nine integrated browser journeys; the retained lifecycle tests now assert successful key issuance before opening an MCP client.
- Tool-history/dashboard guides and this evidence directory: final contracts, demonstration, screenshots, limits and validation.

Deploy rebuilt gateway and dashboard together using the existing deployment procedure when ready. No migration, environment or Helm changes are needed. No deployment or live Kubernetes validation was performed.


## Fixture-isolation regression

The initial full workflow passed all 208 gateway and 3 WooCommerce tests but failed three browser lifecycle cases (130/133 passed). A browser-only reproduction with explicit issuance assertions confirmed HTTP 409 at key creation: the new investigation fixtures left three active keys on the shared test administrator, exhausting its existing 20-key allowance before lifecycle tests ran. Each investigation key is now revoked through the public management API when its MCP client closes, including failed connection setup. The lifecycle assertions retain the precise failure signal. No authentication, authorization or key-limit policy changed. Initial log: `/private/tmp/urumi-56-workflow.log`; reproduction: `/private/tmp/urumi-56-key-diagnosis.log`; final full rerun: `/private/tmp/urumi-56-final-workflow.log`.

## Final results (2026-10-21)

`pnpm test:workflow > /private/tmp/urumi-56-final-workflow.log 2>&1` exited **0** after the fixture cleanup fix. Workspace typechecks/builds passed, all **3 WooCommerce tests**, all **208 gateway tests** (zero skips) and all **133 Playwright browser tests** passed. The three previously failing lifecycle cases all passed in the full sequence. The runner exercised disposable replica-set/standalone MongoDB, controlled MCP/provider fixtures and database-outage recovery, then removed its test containers and network. `pnpm test:env` passed both environment tests. Final `git diff --check` passed.

Separate `pnpm typecheck` and `pnpm build` also passed after shared population/count-accessibility changes. Follow-up Standards and Spec reviews reported zero remaining findings after population consolidation, accessible count labels and unconditional key cleanup. There are no known outstanding #56 behavior issues. Fixed bounds do not freeze audit persistence; late/missing writes and other documented completeness/diagnostic limits still apply. Helm validation was not applicable because deployment resources did not change.
