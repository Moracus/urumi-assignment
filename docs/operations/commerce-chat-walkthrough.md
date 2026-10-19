# Commerce and two-upstream chat walkthrough (#43)

This is an operator-run acceptance procedure. Automated fixtures do not create live products or orders. Run this only against a store where you are authorized to create a demonstration product and manually place a test order. Do not use real payment details.

## Prerequisites

Follow [local setup](../setup/local-development.md), [dashboard deployment](dashboard-deployment.md) and [chat configuration](../guides/dashboard-chat.md). Confirm workload readiness, gateway and storefront routes, existing PVCs and required provider/upstream connectivity. Health probes alone do not establish checkout or provider access. Keep existing store data and volumes.

Have an eligible Urumi administrator, a separate member and WordPress administrator access. Urumi dashboard accounts and WordPress accounts are separate. Record the store currency and timezone under WordPress Settings → General; choose an explicit IANA query timezone such as `Asia/Kolkata`.

## Publish and inspect a product

1. Log into the Urumi dashboard as an administrator and open Chat.
2. Send: “Create one simple product named Urumi Demo Mug 2026-10-17 priced at 12.50 with explicit status=publish.” Use a unique name for each deliberate demonstration.
3. Confirm the call table shows `woocommerce_create_product`, a successful outcome and a final answer. Record the returned product ID and permalink. If the request fails or disconnects, inspect WooCommerce Products and tool history before resubmitting: the write may already have completed.
4. In WordPress Products, verify the exact name, regular price and Published status. Open the permalink in a signed-out browser and verify the name, price and Add to cart control. Check catalog visibility, stock and cache settings if the published product is absent from the shop listing. Taxes or currency formatting can affect the displayed price; verify the regular price separately in admin.
5. As the Urumi member, request a different product creation. Confirm write access is denied and no product is created. Members retain order/product reads, calculator and time access. Inspect the administrator tool history for session attribution and the rejected or denied outcome; the provider may decline the request without proposing a call, in which case no execution row is expected.

## Place the order manually

1. In WooCommerce Settings → Payments, enable Cash on delivery (COD), or use an already configured test-only payment method. For COD, check shipping-method restrictions and whether virtual orders are allowed. Record any setting you change so the operator can restore it afterward.
2. Ensure the product is purchasable and in stock. Configure an appropriate shipping zone/method for the test address if the product requires shipping. Check that Cart and Checkout pages are assigned in WooCommerce Settings → Advanced. Use the classic checkout shortcode if the installed checkout block does not support the chosen test method.
3. In the signed-out storefront, add exactly one demonstration product, visit Cart, then Checkout. Enter operator-approved test contact/address data, choose shipping and COD, and review the total. Submit **Place order** manually once. Do not run checkout through chat or an automated script.
4. Record the confirmation order number. If submission has an uncertain outcome, check WooCommerce Orders before submitting again.
5. In WordPress WooCommerce → Orders, open that order and verify product ID/name, quantity, currency, totals, payment method and creation time. COD commonly leaves an unpaid processing/on-hold order; do not treat that as proof of an online payment. Do not mark it paid merely to pass the demonstration.

## Read orders and use two upstreams

1. In dashboard Chat, ask: “Get today's orders in Asia/Kolkata using date=today and timezone=Asia/Kolkata. Show the selected UTC boundaries and the demonstration order number. Fetch subsequent pages if needed.” Check the returned date range against the order's creation instant. A query timezone can differ from the WordPress display timezone. Each page contains at most 100 orders; the chat call limit can prevent fetching a large day's entire history.
2. Send one prompt: “Multiply 6 by 7 using calculator and get the current time in Asia/Kolkata using time. Use both tools and report each result.” Confirm two distinct public names, original call IDs, outcomes and a final answer. Text claiming both ran is insufficient evidence without actual calls.
3. For an operator-approved failure exercise, disable time through server management, then request calculator and time in one prompt. Confirm time is unavailable/absent and calculator still works. Restore time and refresh discovery. Do not stop workloads or modify network policies solely for this walkthrough without authorization.
4. Inspect administrator tool history for the verified user, dashboard-session origin, tool/upstream, timestamp, duration and outcome. No fictional API key should be attributed to chat. A failed audit write cannot guarantee a durable row and never causes automatic replay.

## Evidence and rollout

Deploy rebuilt WooCommerce MCP and gateway images for date support and refreshed chat instructions; use your existing Helm/image rollout process. No new secrets, environment variables, migrations, permissions or public upstream ingress are required. Preserve PVCs. The dashboard image needs rebuilding only when its application code changes.

Record environment/image revisions, time, query timezone, product/order IDs, visible call outcomes and audit rows. Record pass/fail and remaining checks for each step. Keep credentials, billing data and raw provider payloads out of the report. Automated date/provider/MCP/browser fixtures are regression evidence; live provider access, storefront visibility, checkout, deployment health and network enforcement remain separate operator results. This guide does not assert that any live steps have been executed.

## Implementation validation (2026-10-17)

- `pnpm test:env`: 2 tests passed.
- `pnpm --filter @urumi/woocommerce-mcp typecheck`, `build`, and `test`: passed, including 3 date tests after the review fix.
- `MONGODB_TEST_URI=<disposable replica set> node --test apps/gateway/tests/commerce.test.mjs`: all 4 commerce/provider/MCP boundary tests passed.
- Focused Playwright chat/key run: all 17 matching browser tests passed (including administrator-key tests matched by the filename filter).
- Final `pnpm test:workflow`: workspace typecheck/build, 3 date tests, all 174 gateway tests and all 64 browser tests passed. This runner includes real disposable MongoDB outage/transaction tests and removes its containers afterward.

An initial full run passed all gateway tests and 63 of 64 browser tests; one existing member-key workflow received an error from `time_current`. Neither the focused rerun nor the final full run reproduced it. The assertion now checks the complete expected clock result so any recurrence includes useful response diagnostics. No tool retry was added.

Review against starting commit `2baa89e`: Standards found no violations; Spec found one historical split-date boundary bug, fixed with regression cases for both affected Casey and Goose Bay dates and rejected before REST I/O. Both follow-up reviews have zero unresolved findings. Live commerce/provider/deployment checks remain unexecuted operator steps.
