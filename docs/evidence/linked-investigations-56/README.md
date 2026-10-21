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

The fixture screenshots show the linked [observability/trend at 360px](investigation-360.png), [768px](investigation-768.png) and [1440px](investigation-1440.png), plus inspection and history at each width. The tests open the trend with Enter, focus its named scroll region, scroll horizontally using ArrowRight and assert no document overflow. They also exercise native keyboard details and the retained server/history journeys. The trend has a caption, semantic headers, explicit UTC interval columns and textual counts for every outcome; links can be followed without interpreting a graphic or color.

## Validation and review

Results are recorded below after the final workflow and independent Standards/Spec reviews. Starting review point: `5429793051480bf34a75fe984daadd0d9a8257d3`.

Executed focused checks: dashboard and gateway `typecheck`; gateway and dashboard `build`; the six-file browser run (`investigation.spec.ts observability.spec.ts audit.spec.ts servers.spec.ts server-edit.spec.ts server-lifecycle.spec.ts`) passed all 44 cases, and the final `investigation.spec.ts` run passed all 9 cases. The first investigation test failed at the missing inspection link before implementation. `git diff --check` passed. The full command is `pnpm test:workflow > /private/tmp/urumi-56-workflow.log 2>&1`; its final result is recorded below when complete.
