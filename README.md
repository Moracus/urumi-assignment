# Urumi MCP Gateway

A TypeScript MCP gateway that exposes WooCommerce, calculator, and time tools through one authenticated Streamable HTTP endpoint. Kubernetes workloads are packaged in a Helm chart, with WordPress and MariaDB persistence, gateway and storefront Ingress resources, and ingress plus gateway egress NetworkPolicies.

Repository: [Moracus/urumi-assignment](https://github.com/Moracus/urumi-assignment).

This document describes the current repository implementation. Deployment checks below are instructions, not a claim that a particular cluster has passed them. Use the [milestone operator walkthrough and Day 5 handoff](docs/planning/milestone-handoff.md) and current verification record (historical evidence file is not included in this checkout) to distinguish executed checks from outstanding prerequisites.

## Implemented capabilities

- MCP Streamable HTTP at `/mcp` on the gateway and three upstream services.
- [Persistent gateway API-key authentication](docs/guides/mcp-authentication.md), checking current key/user eligibility and roles on every incoming MCP request.
- An execution boundary that authorizes, resolves, invokes, and audits tool calls.
- Upstream discovery, namespaced tool aggregation, schema forwarding, and routing to the original upstream tool name.
- Independent upstream connections, request timeouts, periodic discovery, and reconnection attempts.
- [Durable MongoDB tool-execution history and administrator browsing](docs/guides/tool-history.md).
- MongoDB-backed users, transaction-validated startup, database-aware health, one-time administrator CLI setup, and [secure dashboard login/logout, password replacement, and administrator reset](docs/guides/dashboard-sessions.md). See [identity setup](docs/guides/identity-setup.md) for the required local replica set and operator steps.
- Five WooCommerce tools backed by the WooCommerce REST API, plus arithmetic and timezone tools.
- Dockerfiles for the gateway and upstream services; Helm Deployments, ClusterIP Services, health probes, resource settings, and persistent volumes for WordPress and MariaDB.
- Gateway `/mcp` and storefront `/` Ingress routes, plus ingress restrictions between platform components.

The React dashboard supports [login, session restoration, required password replacement, and logout](docs/guides/dashboard-sessions.md#browser-dashboard-25), and lands eligible users on a [role-specific overview](docs/guides/dashboard-sessions.md#dashboard-overviews-33) with complete counts and public connection information. The [personal-key page](docs/guides/api-keys.md#personal-key-dashboard-26) supports named issuance, one-time copy, paginated metadata, confirmed revocation, and public MCP client instructions. Administrators can [browse paginated accounts, inspect users, and create members](docs/guides/dashboard-sessions.md#member-account-dashboard-27) at `/admin/users`. Administrators can also change account access and [manage a selected user’s keys](docs/guides/api-keys.md#administrator-key-dashboard-29) from user details, and [inspect, register, edit, disable, enable, remove, and reconnect upstream servers](docs/guides/upstream-registrations.md#dashboard-availability-and-recovery-32) at `/admin/servers`. Eligible users can [manage their personal gateway API keys](docs/guides/api-keys.md), with one-time disclosure, safe metadata, and revocation. Administrators can also [manage another user’s keys](docs/guides/api-keys.md#administrator-assistance-9). Administrators can [promote and demote users](docs/guides/dashboard-sessions.md#promote-and-demote-administrators-10), with atomic last-active-administrator protection. Administrators can also [disable and re-enable users](docs/guides/dashboard-sessions.md#disable-and-re-enable-users-11), permanently invalidating existing sessions and keys. [Tool history](docs/guides/tool-history.md) is available to administrators at `/admin/audit`; chat remains later work.

## Architecture

```text
MCP client ──> Ingress controller ──> Gateway :3000 /mcp
                                         │
                         ┌───────────────┼───────────────┐
                         ▼               ▼               ▼
                 WooCommerce MCP    Calculator MCP    Time MCP
                    :3001              :3002            :3003
                         │
                         ▼
Browser ──> Ingress controller ──> WordPress + WooCommerce :80
                                         │
                                         ▼
                                    MariaDB :3306
```

Dashboard Ingress serves the SPA and routes same-origin `/api` to the gateway. The separate gateway Ingress exposes `/mcp`, and WordPress retains its storefront Ingress. Upstream MCP services, MariaDB, and optional managed MongoDB remain internal. See [system design](docs/architecture/systemdesign.md) for request flow, trust boundaries, failure behavior, and deployment decisions.

## Available tools

Gateway names include the upstream prefix. Direct upstream endpoints use the unprefixed name.

| Gateway tool | Behavior and principal inputs |
| --- | --- |
| `woocommerce.list_products` | Search and paginate products; `limit` (1–100, default 10), `page` (default 1), optional `search`. |
| `woocommerce.create_product` | Create a simple product; `name`, `regular_price` as a non-negative decimal string, optional `description`, `status` (`draft` by default or `publish`). |
| `woocommerce.list_orders` | Paginate orders; `limit`, `page`, optional `status`, `after`, and `before` as ISO datetimes with offsets. |
| `woocommerce.get_order` | Retrieve an order by positive integer `order_id`. |
| `woocommerce.update_order_status` | Change `order_id` to `processing`, `on-hold`, `completed`, or `cancelled`. |
| `calculator.calculate` | `operation`: `add`, `subtract`, `multiply`, or `divide`; numeric `a` and `b`. Rejects division by zero and non-finite results. |
| `time.current` | Current time in an IANA `timezone` (default `UTC`), with date, local time, UTC ISO timestamp, and Unix timestamp. |

Admin authorization permits all registered tools. The member policy permits the three WooCommerce read tools, calculator, and time, but rejects product creation and order updates. MCP bearer authentication resolves the current user and role from the individually hashed key on every request. Dashboard session cookies and API keys authenticate only their respective boundaries; bootstrap credentials never authenticate MCP.

## Repository layout

```text
apps/
  gateway/             Authentication, discovery, routing, execution, audit
  woocommerce-mcp/     WooCommerce REST API adapter and MCP tools
  calculator-mcp/      Arithmetic MCP server
  time-mcp/            Timezone MCP server
  dashboard/           React/Vite session dashboard
packages/shared/       Shared types
infra/
  helm/urumi/          Chart, values, workloads, ingress, network policies
  kind/cluster.yaml    Single-control-plane local cluster configuration
docs/architecture/systemdesign.md   Architecture and implementation limitations
```

## Local setup and configuration

Start with the [complete workspace setup guide](docs/setup/local-development.md).
It covers host development with the root `.env`, Docker-backed MongoDB,
and the full Docker → Kind → Kubernetes deployment including the dashboard,
WordPress/WooCommerce, MariaDB, and persistent identity storage.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env   # First setup only; preserve an existing .env.
```

Fill the blank credentials in `.env`, start MongoDB, and build/setup the first
administrator as described in the guide before running `pnpm dev`.
Backend `dev`, `start`, and gateway setup/recovery commands load the workspace
`.env` from any working directory. Shell variables take precedence. Each service
uses its own `*_PORT`; explicit `PORT` overrides it for an individual backend.
The dashboard loads root Vite env files and exposes only `VITE_*` to browser code.
Kubernetes uses Helm values and Secret references; it does not read the host `.env`.

See [.env.example](.env.example) for known URLs, hosts, ports and local destination
approvals. See the [documentation index](docs/README.md) for categorized guides,
architecture, deployment/security operations, decisions and planning material.

## Validation

From the repository root:

```bash
pnpm test:env
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway test:integration
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm template urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml
```

For the complete browser-to-MCP demonstration, run `pnpm test:workflow`; see the [workflow, coverage, live read-only smoke, and Day 5 handoff](docs/guides/browser-to-mcp-workflow.md). For focused browser authentication tests, see the [browser test commands](docs/guides/dashboard-sessions.md#browser-integration-tests).

The automated gateway tests include real MongoDB CLI setup, concurrent/durable consumption, transaction/index validation, outages and reconnection, dashboard login/me/logout/password replacement, administrator password reset with preserved keys and restored SDK access, required-change restrictions, all-device invalidation and concurrent replacement/login, session expiry/restart/device independence, Origin/CSRF, shared throttling, proxy/cookie modes, plus MCP SDK discovery and calls against controlled upstreams. The runner provisions disposable MongoDB containers; no Kubernetes or commerce services are needed. `createGatewayApp()` accepts default-migration upstream configurations, an audit logger, and an optional `mongodbUri`; it validates storage, restores persisted registrations, connects and refreshes the registry, returns an unlistening Fastify app, and releases MCP/registry/database resources on `app.close()`. The process entry point owns listening and signal shutdown. MCP requests use current persisted key/user state, with real user/key attribution in durable MongoDB audits; see [tool history](docs/guides/tool-history.md) for fields and failure semantics.

With all three upstream endpoints reachable and the gateway URL variables set as in the local setup:

```bash
pnpm --filter @urumi/gateway exec tsx src/upstream/test-registry.ts
pnpm --filter @urumi/gateway exec tsx src/tools/test-aggregation.ts
pnpm --filter @urumi/gateway exec tsx src/tools/test-routing.ts
```

These scripts exercise internal registry/routing code; they do not verify the public gateway authentication or Ingress path. Use an MCP client separately to confirm missing/invalid bearer credentials receive HTTP 401, valid credentials discover seven tools when all upstreams are connected, calculator division by zero returns an MCP tool error, and WooCommerce reads return store data.

`src/tools/test-failure-isolation.ts` is an interactive gateway script: it asks you to stop and restore the calculator port-forward during two 15-second windows. Run it only with upstream port-forwards configured and follow its prompts. It checks that other upstreams remain usable and explicitly refreshes the registry for recovery.

Verify network isolation using ordinary test Pods: unrelated Pods should be denied access to upstream MCP ports and MariaDB; a gateway Pod should reach each MCP service; the WooCommerce MCP Pod should reach WordPress; WordPress should reach MariaDB. Verify the controller can reach gateway and storefront. Do not infer enforcement from the mere presence of NetworkPolicy objects.

## Current limitations

- MCP uses individually revocable hashed API keys with per-request eligibility/role lookup. Users, one-time CLI setup, independent eight-hour dashboard sessions, shared login throttling, and key metadata are persisted. Administrator key management is available through session-protected APIs; role changes preserve an active administrator; account disabling permanently invalidates sessions and keys. [Operator recovery](docs/guides/identity-setup.md#operator-recovery-13) restores an existing administrator through a separate database-authorized CLI and permanently invalidates their credentials.
- [Desired upstream registrations](docs/guides/upstream-registrations.md) persist in MongoDB with transactional one-time default migration, administrator inspection APIs, live unauthenticated registration, and durable disable/enable/remove controls. Connections and discovery remain in memory; authenticated upstreams resolve approved pre-provisioned Kubernetes Secret references in backend memory. See [credential configuration and rotation](docs/operations/upstream-credentials.md). Administrators can manually refresh enabled servers and recover connections through the [refresh API](docs/guides/upstream-registrations.md#refresh-tools-and-recover-connections-21). Run one gateway replica.
- [Audits are durable MongoDB execution records](docs/guides/tool-history.md), with an administrator API and dashboard. No durable queue or lossless outage guarantee exists. Authentication and SDK rejections before execution are outside this slice.
- NetworkPolicies preserve workload ingress isolation and restrict gateway egress. Supply explicit MongoDB/API site approvals and an enforcing CNI; defaults fail closed for those destinations. See [egress configuration and live verification](docs/operations/gateway-egress.md). Controller namespace and workload-label selectors require trusted namespace administration.
- Upstream bearer/custom-header authentication uses approved Kubernetes Secret references; mutual TLS is not implemented. Cluster networking and destination policy still apply.
- TLS requires operator-provided certificates and exact ingress proxy trust; no broader request rate limiting beyond dashboard login or automatic retry of failed tool calls. Failed writes can have uncertain outcomes and need inspection before retrying.
- Single-replica workloads; database and WordPress persistence use PVCs with `Recreate` Deployments. Backups, high availability, restore automation, and production hardening are not supplied.
- WooCommerce installation and store configuration are manual. Health probes do not prove that store APIs or checkout work.
- The [dashboard deployment](docs/operations/dashboard-deployment.md) includes a production static image, deep-link fallback, same-origin `/api` routing, TLS Secret references, probes, and isolation. Production proxy IPs/certificates remain operator configuration.

These limits describe the current implementation and should be revised as capabilities are added.

### Upstream destination approval

Upstream HTTP connections now require an approved origin and resolved IP range. The three existing internal MCP services are approved by default; changing an upstream URL does not grant outbound access. See [upstream destination configuration](docs/operations/upstream-destinations.md) for `UPSTREAM_DESTINATION_RULES`, the controlled `UPSTREAM_ALLOW_LOOPBACK` development exception, Helm settings, and required deployment egress approval.

Administrators can now register approved unauthenticated upstreams through `POST /api/admin/servers` without restarting. Registration persists before discovery, including offline endpoints; connected MCP clients see new permitted tools on their next uncached list. See [registration examples and failure semantics](docs/guides/upstream-registrations.md#register-without-restart-18).
