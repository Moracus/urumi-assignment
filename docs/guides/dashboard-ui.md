# Shared dashboard UI (#48)

The dashboard retains React, ordinary URL navigation and the existing same-origin API client. Direct nested URLs still load their corresponding protected pages after a session check. At widths above 900px, the console has a sidebar; smaller screens have a keyboard-operable Navigation disclosure. Escape closes that disclosure and restores focus to its button. The account email, textual role and logout remain available when navigation is collapsed. Required password replacement suppresses ordinary page navigation.

`apps/dashboard/src/style.css` defines shared surface, border, text, accent and spacing tokens. Use native labeled form controls, textual status badges (`StatusBadge`), visible focus, 44px action targets and semantic headings. The main landmark has a skip link. Tables use labeled, keyboard-focusable local scrolling regions; schema previews are independently labeled and focusable. Wrap long identifiers and descriptions; preserve code whitespace inside local scroll areas. Reduced-motion preferences suppress animation and smooth scrolling.

`Dialog` in `src/ui.tsx` owns native modal semantics, background inertness, initial Cancel focus, Tab/Shift+Tab containment, Escape and Cancel behavior, and focus restoration. Confirmation triggers remain enabled until an action is pending so focus can be captured before the background becomes inert. Pending actions disable cancellation and Escape; no action is replayed. Keep action errors inside an open dialog so they remain readable. If a successful mutation removes its trigger, focus falls back to the main landmark. Server disable/removal, user disable, password reset and API-key revocation share this component.

`ReadState` provides initial loading, failed/invalid reads, empty results and explicitly stale retained results. The overview uses it: a failed refresh retains the last complete authorized summary with a stale warning and safe error, while an initial failed read shows no counts. Empty successful summaries have explicit empty copy. Since #49, personal/selected-user key lists, user lists and user details also use this convention; user detail mutations stay disabled until a successful read. Other pages retain their existing refresh behavior. Retain data only within the protected account view and never reuse it across query identities or accounts. The existing session generation key unmounts it on logout, expiry, role changes or password restrictions, and API generations reject late responses. Mutations, key issuance and chat submissions require deliberate user action.

Authentication continues to use server-issued cookies, in-memory CSRF, runtime response decoders and backend roles. No routing, dependency, API, infrastructure, Secret, storage or MCP changes are required. Rebuild and serve the dashboard using the existing setup in [dashboard sessions](dashboard-sessions.md#browser-dashboard-25); no deployment or data migration is performed by this ticket.

## Verification

Focused commands executed during development:

```sh
pnpm --filter @urumi/dashboard typecheck
pnpm --filter @urumi/dashboard build
env 'MONGODB_TEST_URI=mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true' pnpm --filter @urumi/dashboard test:browser shell.spec.ts auth.spec.ts server-lifecycle.spec.ts
env 'MONGODB_TEST_URI=mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true' pnpm --filter @urumi/dashboard test:browser shell.spec.ts overview.spec.ts
pnpm test:workflow
git diff --check
```

`tests/shell.spec.ts` uses real gateway sessions and the disposable MongoDB harness. It captures login, overview, users, servers, keys, history, chat (including controlled tool-call results), server editing, confirmation and required-password screenshots at 360px, 768px and 1440px, with page overflow assertions. Browser tests also exercise mobile keyboard navigation, direct nested loading, pending-dialog Escape protection, keyboard containment, focus restoration and stale summaries. Extended overview coverage delivers an administrator read after server-side demotion and verifies that protected data stays cleared; existing account replacement/logout coverage remains in place.

Screenshots are generated under `apps/dashboard/test-results/shell-shell-and-account-pages-fit-{width}px/`. Representative reviewed evidence is retained in [dashboard-ui evidence](../evidence/dashboard-ui-48/). These are controlled fixtures, not live Kubernetes evidence. Helm validation is unnecessary because no deployment manifests change.

### Final results (2026-10-21)

`pnpm test:workflow` passed workspace typechecks/builds, all 3 WooCommerce service tests, all 190 gateway tests (zero skips), and all 85 Playwright tests. The runner stopped and removed its disposable database containers afterward. Dashboard typecheck/build and `git diff --check` also passed after the review fix. Full run log: `/private/tmp/urumi-48-workflow.log` (local artifact).

Standards review found no actionable violations. Spec review found that the shared minimum table width could overflow Chat on mobile; Chat now uses the same labeled local scroll region, and the browser tests exercise an actual tool-call result at all three widths. Follow-up review found no remaining issues.

Visually inspected final screenshots: [360px console](../evidence/dashboard-ui-48/dashboard-360.png), [768px console](../evidence/dashboard-ui-48/dashboard-768.png), [1440px console](../evidence/dashboard-ui-48/dashboard-1440.png), [mobile modal](../evidence/dashboard-ui-48/dialog-360.png), [mobile chat result](../evidence/dashboard-ui-48/chat-result-360.png), and [mobile server form](../evidence/dashboard-ui-48/server-form-360.png). The evidence directory also retains login/password-replacement and tablet/desktop modal screenshots. The full generated screenshot set remains in the Playwright output paths above.

No known outstanding #48 behavior issues. This slice applies stale-read retention to the overview; other pages keep their existing refresh behavior. No live Kubernetes checks, deployment, migration or Helm validation was performed or required.

## User and key management (#49)

User creation and key issuance use shared responsive form surfaces; details and tables use textual role/status badges, compact action labels with full accessible names, and labeled local scrolling for long values. Personal/selected-user key lists and user lists/details retain authorized stale reads. Refreshing selected-user details clears one-time secrets while preserving safe key metadata. Password-reset confirmations share the existing keyboard and pending safeguards.

See [user/key evidence](../evidence/access-management-49/) for reviewed 360px, 768px and 1440px screenshots, separate Standards/Spec review results, exact executed commands and final validation. `pnpm test:workflow` passed all 190 gateway, 3 WooCommerce and 96 browser tests with workspace typechecks/builds. The environment tests also passed. No infrastructure change or migration is required; publish the rebuilt dashboard through the existing deployment process.

## Server management (#50)

Server lists and inspection now use `ReadState`, textual configuration/runtime badges and shared form/detail surfaces. Read failures retain explicitly stale authorized data, and a list refresh preserves inspection. Creation/editing has predictable field focus, idle Escape cancellation and focus restoration; pending saves block competing server controls. Complete schemas have labeled local scroll regions and descriptions wrap long values. See [server-management guidance](upstream-registrations.md#responsive-server-management-50) and [reviewed evidence](../evidence/server-management-50/) for behavior, screenshots and validation.

## Overview and chat (#51)

Overview counts use responsive cards with role-specific actions. Administrator summaries retain complete registered-server, available-tool and user totals; member summaries retain complete active personal-key counts and runtime public MCP connection instructions. Members do not request administrator summaries. Counts still appear only after every required page succeeds, and failed refreshes retain the last complete authorized summary with an explicit stale warning. No internal upstream URL is substituted for the public MCP URL.

The chat composer, submitted prompt and plain-text answer wrap long content. Tool calls retain a labeled local scroll region, with textual outcome explanations including uncertain writes. Availability checks are deliberate reads; a failed recheck retains stale status but prevents new submissions until a successful check. See [chat guidance](dashboard-chat.md#responsive-single-prompt-interface-51) for single-prompt and recovery behavior. Layout targets remain 360px, 768px and 1440px; no backend contracts or deployment configuration changed.

Regression verification uses the existing browser-to-gateway seam, real sessions and disposable MongoDB. `chat.spec.ts` now checks long prompt/answer wrapping, keyboard submission and horizontal scrolling at all three target widths, stale availability refresh without replay, invalid execution outcomes, deliberate independent prompt bodies, logout during pending execution, and verified role changes rejecting delayed results and clearing completed data. `overview.spec.ts` additionally captures the member overview and public connection example at all three widths; `runtime-config.spec.ts` verifies that both URL text and the client example follow the runtime public URL. Focused run: 34 Playwright tests passed. The scroll-description assertion failed before its UI guidance was added, then passed; keyboard scrolling uses ArrowRight in the focused region. Screenshots under `apps/dashboard/test-results/` were visually inspected, alongside the existing administrator overview captures. These are controlled fixture results, not live provider or Kubernetes evidence.

Final #51 validation: `pnpm test:workflow` passed workspace typechecks/builds, all 3 WooCommerce tests, all 190 gateway tests (zero skips), and all 109 Playwright tests. Full run log: `/private/tmp/urumi-51-final-workflow.log` (local artifact). The runner removed its disposable database containers after success. Separate dashboard typecheck/build and `git diff --check` passed. Standards and specification reviews found no issues, including the final completed-answer clearing check after administrator demotion. No deployment, migration or live Kubernetes checks were performed; Helm validation is not applicable because no manifests changed. Deploy the rebuilt dashboard through the existing release process when ready.

## Linked server investigations (#56)

Server inspection, recorded metrics and matching tool history now share durable registration IDs and fixed inclusive-from/exclusive-to windows. Metric and trend counts open their matching recorded populations; exact history filters remain available as explicit navigation context. Removed registrations stay investigable without opening a replacement sharing the public name. See [final contracts and limits](tool-history.md#linked-investigations-56) and the [controlled demonstration/evidence](../evidence/linked-investigations-56/README.md). Navigation and metrics refresh are read-only, and existing session-generation and administrator boundaries apply to all three views.
