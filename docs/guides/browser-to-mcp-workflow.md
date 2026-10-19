# Browser-to-MCP demonstration (#36)

The repeatable application demonstration uses the real React dashboard, Fastify
gateway, transaction-capable MongoDB, and external MCP SDK clients. Controlled
MCP servers make catalog changes, authentication replacement, outages, and recovery
deterministic. They do not contact WordPress or prove a live WooCommerce deployment.
No production execution, authentication, or management contracts change in #36.

## Run the complete application demonstration

Prerequisites: the repository's pinned pnpm, Node 24, Docker, installed workspace
dependencies, and Chromium. Install once:

```sh
pnpm install --frozen-lockfile
pnpm --filter @urumi/dashboard exec playwright install chromium
```

Reserve localhost ports 27417/27418 for MongoDB and 3009/5174 for the gateway and
browser server. Do not run other integration/browser jobs concurrently. The
`urumi-identity-integration` Compose project is disposable test infrastructure;
the runner starts and stops it, including pre-existing containers of that project.
Never use that project or its tmpfs databases for application data.

```sh
pnpm test:workflow
```

This runs workspace typechecks and builds, the complete gateway suite through
the existing real replica-set/standalone runner, then the complete browser suite.
The gateway outage tests finish before browser startup. The EXIT trap stops the
test containers on success or failure. No application PVC or cluster is changed.
The existing gateway-only command remains available:
`pnpm --filter @urumi/gateway test:integration`.

For a focused rerun with the disposable Compose fixture already started:

```sh
env MONGODB_TEST_URI='mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true' \
  pnpm --filter @urumi/dashboard test:browser workflow.spec.ts server-edit.spec.ts
```

The focused command requires a current gateway build. Browser startup creates a
random isolated database and consumes initial administrator setup through its
existing interface. Shutdown drops only that database. The fixture-only controls
for expiry, login-budget isolation, and upstream modes are absent in production.

## What to observe

`workflow.spec.ts` performs the primary journey entirely through visible browser
forms: administrator login, member creation, logout, member login with the assigned
password, password replacement, fresh login, reload restoration, and named key
issuance. An external SDK client using that key discovers exactly the member's
five permitted tools and invokes calculator, time, product listing, order listing,
and order detail. Write-tool calls fail independently of discovery. Management
administrator routes, missing/invalid CSRF, missing/untrusted Origin, and
bearer-only management calls fail. Browser logout clears the raw key while the
same MCP client continues working; fresh browser login and confirmed key revocation
cause that client's next uncached discovery request to fail with HTTP 401.

`server-edit.spec.ts` keeps one administrator MCP client connected across visible
registration, metadata edits, explicit bearer-to-header credential-reference
replacement, disable, enable, refresh, and removal. Fresh catalogs preserve the
namespace and schemas; obsolete, disabled and removed tools cannot execute.
`server-lifecycle.spec.ts` adds deterministic outage/recovery, healthy-upstream
isolation, changed recovery catalogs, confirmation cancellation, pending mutations,
and delayed responses after logout.

The rest of the browser suite remains part of the demonstration:

| Coverage | Browser files |
| --- | --- |
| Assigned password, session restore/expiry/invalidation, safe errors, CSRF refresh without replay, logout failure | `auth.spec.ts` |
| One-time keys, clipboard, ownership, revocation, browser storage/request/log cleanup, stale creation responses | `keys.spec.ts` |
| Administrator-assisted issuance/revocation, owner attribution, paginated metadata, disable cleanup | `admin-keys.spec.ts` |
| Account creation, pagination, last-administrator protection, safe pending/error states | `users.spec.ts` |
| Promotion/demotion and disable/re-enable; old cookies and continuing-client keys stay invalid permanently | `access.spec.ts` |
| Accurate summaries beyond page one, unavailable/empty/loading states, stale sessions and role changes | `overview.spec.ts` |
| Hostile descriptions as text, schemas, failed discovery, member denial, transient connection states | `servers.spec.ts` |

These are public application-boundary assertions. Targeted intercepted responses
supplement real API/MongoDB/MCP behavior for difficult pending and error branches.
The fixture's synthetic Secret reader checks reference replacement without
requiring a Kubernetes API or reading actual credentials.

## Live read-only smoke with operator credentials

Use a deployed gateway with real calculator, time, and WooCommerce upstreams.
Provision WooCommerce consumer credentials through the existing Kubernetes Secret
workflow; preserve the public signing URL and internal WordPress destination.
Issue a fresh eligible member gateway key in the dashboard and select an existing
readable order ID. A store without an order cannot verify order detail; do not
create an order as a smoke-test shortcut.

Populate `URUMI_MCP_URL`, `URUMI_API_KEY`, and `URUMI_ORDER_ID` in the process
environment through your private credential workflow, then run:

```sh
pnpm --filter @urumi/dashboard smoke:readonly
```

The command uses Streamable HTTP, discovers tools, and invokes only
`calculator_calculate`, `time_current`, `woocommerce_list_products`,
`woocommerce_list_orders`, and `woocommerce_get_order`. It reports one PASS per
successful call, exits nonzero for missing configuration/tools or an MCP tool
error, and never prints keys, result bodies, order data, or raw exceptions.
It does not retry writes or issue any write call. The automated primary journey
also checks this command against controlled upstreams; that establishes command
behavior, not live commerce success. Clear the credential environment after use
and revoke the smoke key in the dashboard.

For a manual continuing-client check, keep the SDK client from the dashboard's
connection example running while revoking its key; make a fresh `listTools` call
with `{ cacheMode: 'bypass' }` to avoid confusing a client-side cached catalog with
gateway authorization. Keep an administrator client open separately while driving
server changes, inspecting fresh catalogs and attempting an obsolete tool after
each change. Cancel destructive confirmation dialogs once before confirming them.

## Deployment evidence and Day 5 handoff

This application harness does not prove production-image ingress, TLS,
NetworkPolicy enforcement, or persistence across Kubernetes restarts. Follow
[dashboard deployment verification](../operations/dashboard-deployment.md#verification),
[MongoDB restart verification](../operations/mongodb-deployment.md#non-destructive-live-verification),
and the [gateway egress matrix](../operations/gateway-egress.md) separately. Existing deployment
evidence is recorded in #34 (historical evidence file is not included in this checkout) and
#35 (historical evidence file is not included in this checkout); it is not a new deployment claim for this issue.
Use an enforcing CNI and controlled allowed/blocked connectivity tests; modern Kind includes NetworkPolicy support, but its name alone does not prove enforcement.

Day 5 callers must reuse server-resolved `AuthenticatedIdentity` (`userId`, `role`,
actual authentication origin, and a real `keyId` only for bearer execution) and
`executeTool({ identity, toolName, arguments, requestId }, dependencies)`. Dashboard
sessions explicitly use `authenticationOrigin: "dashboard_session"` and `keyId: null`.
Authorization precedes resolution against the actual catalog; invocation retains
timeouts, valid MCP `isError` results, and structured content. The execution
boundary records attributed outcomes through the audit interface; [durable
MongoDB history and administrator browsing](tool-history.md) are implemented by #39. Never invoke upstreams directly
from the [session-authenticated chat controller](dashboard-chat.md). Persistent server metadata and live registry
lifecycle remain owned by the upstream modules. Dashboard cookies/CSRF remain
separate from gateway bearer keys. No raw key or upstream Secret enters persistent
browser storage or management responses beyond one-time gateway-key issuance.

Capability-level Day 4 status and exact executed results for this issue are in
the validation record (historical evidence file is not included in this checkout). A full milestone verification
still requires the separately identified live deployment and commerce checks.

## Completed two-user workflow (#46)

The primary journey now starts with administrator A making a two-upstream chat
request through a real provider HTTP fixture and verifying session-origin audit
rows. Distinct member B is created through the browser, replaces their password,
uses only the public gateway URL and a personal key with a real MCP SDK client,
calls two upstreams and commerce reads, and loses access on the continuing client
after revocation. Administrator history distinguishes A’s null-key dashboard
session from B’s actual bearer-key attribution. Backend member audit denial and
credential non-disclosure are asserted. The gateway commerce suite also withdraws
a server while its provider response holds an old catalog, checks fresh provider
and MCP discovery and stale execution denial, and retains healthy commerce access.
Existing timeout/periodic recovery, audit classifications, identity and security
regressions remain part of the full workflow runner.

Use the [ordered live checklist](../operations/acceptance-handoff.md) and
[k3s setup/upgrade/rollback](../setup/k3s.md). The [issue #46 evidence record](../validation/issue-46.md)
separates fixture results from remaining live provider, store, CNI and failure checks.
