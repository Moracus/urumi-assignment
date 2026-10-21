# Shared dashboard UI (#48)

The dashboard retains React, ordinary URL navigation and the existing same-origin API client. Direct nested URLs still load their corresponding protected pages after a session check. At widths above 900px, the console has a sidebar; smaller screens have a keyboard-operable Navigation disclosure. Escape closes that disclosure and restores focus to its button. The account email, textual role and logout remain available when navigation is collapsed. Required password replacement suppresses ordinary page navigation.

`apps/dashboard/src/style.css` defines shared surface, border, text, accent and spacing tokens. Use native labeled form controls, textual status badges (`StatusBadge`), visible focus, 44px action targets and semantic headings. The main landmark has a skip link. Tables use labeled, keyboard-focusable local scrolling regions; schema previews are independently labeled and focusable. Wrap long identifiers and descriptions; preserve code whitespace inside local scroll areas. Reduced-motion preferences suppress animation and smooth scrolling.

`Dialog` in `src/ui.tsx` owns native modal semantics, background inertness, initial Cancel focus, Tab/Shift+Tab containment, Escape and Cancel behavior, and focus restoration. Confirmation triggers remain enabled until an action is pending so focus can be captured before the background becomes inert. Pending actions disable cancellation and Escape; no action is replayed. Keep action errors inside an open dialog so they remain readable. If a successful mutation removes its trigger, focus falls back to the main landmark. Server disable/removal, user disable and API-key revocation share this component.

`ReadState` provides initial loading, failed/invalid reads, empty results and explicitly stale retained results. The overview uses it: a failed refresh retains the last complete authorized summary with a stale warning and safe error, while an initial failed read shows no counts. Empty successful summaries have explicit empty copy. Other lists retain their existing read behavior in this slice; broader page refresh work belongs to the next #47 slices. Retain data only within the protected account view and never reuse it across query identities or accounts. The existing session generation key unmounts it on logout, expiry, role changes or password restrictions, and API generations reject late responses. Mutations, key issuance and chat submissions require deliberate user action.

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

`tests/shell.spec.ts` uses real gateway sessions and the disposable MongoDB harness. It captures login, overview, users, servers, keys, server editing, confirmation and required-password screenshots at 360px, 768px and 1440px, with page overflow assertions. Browser tests also exercise mobile keyboard navigation, direct nested loading, pending-dialog Escape protection, keyboard containment, focus restoration and stale summaries. Extended overview coverage delivers an administrator read after server-side demotion and verifies that protected data stays cleared; existing account replacement/logout coverage remains in place.

Screenshots are generated under `apps/dashboard/test-results/shell-shell-and-account-pages-fit-{width}px/`. Representative reviewed evidence is retained in [dashboard-ui evidence](../evidence/dashboard-ui-48/). These are controlled fixtures, not live Kubernetes evidence. Helm validation is unnecessary because no deployment manifests change.
