# Two-user acceptance and deployment handoff (#46)

This is the ordered operator checklist for the mandatory walkthrough in #38.
[Executed regression evidence and remaining checks](../validation/issue-46.md)
are separate from these instructions. No live deployment, provider, commerce or
packet-isolation result is implied by passing fixtures or rendering Helm.

## Prepare the deployment

For local host/Kind setup use [local development](../setup/local-development.md).
For a VPS use [production-like k3s setup](../setup/k3s.md). Both use the same images
and `infra/helm/urumi` chart. Configure [identity and initial administrator setup](../guides/identity-setup.md),
[MongoDB](mongodb-deployment.md), [dashboard routes/runtime URL/TLS](dashboard-deployment.md),
[upstream credentials](upstream-credentials.md), [destination approvals](upstream-destinations.md)
and [provider Secret/model/egress](chat-deployment.md) before the walkthrough.
Initial setup is consumed once; existing deployments retain their accounts and
registrations. Recovery is a separate privileged CLI operation. Keep one gateway
replica. Do not overwrite existing Secrets or switch database mode to troubleshoot.

Record UTC time, source revision, image tags/digests, Kubernetes context,
namespace, Helm revision, overlay revision, CNI/version, query timezone and tester.
Use pass/fail/skipped per row with sanitized evidence. Never attach keys, cookies,
Secret YAML, customer billing data or raw provider transcripts. Record explicit
operator authorization separately for product publication, checkout/order creation
and the upstream Pod failure exercise before those actions. This guide authorizes
none of those live mutations by itself.

## Live checklist

| Step | Check and evidence to record |
| --- | --- |
| 1. Readiness | `kubectl config current-context`; `kubectl get pods,deployments,statefulsets,svc,ingress,pvc,networkpolicy -n urumi`; rollout status for gateway/dashboard/store/upstreams and the selected database. Inspect `/health/live` and `/health/ready` internally; readiness requires MongoDB, but zero upstreams can still be ready. Record individual upstream status. |
| 2. Routes | Browser login on the dashboard; same-origin `/api/auth/me`; public gateway `/mcp` using a real MCP client; storefront GET. Missing/invalid MCP key gets 401; a dashboard cookie alone does not authenticate MCP. Dashboard-host `/mcp` stays 404. Check TLS hostname/certificate and proxy forwarded-header sanitization. Upstreams/databases remain ClusterIP without public ingress. |
| 3. Persistence/config | Record PVC names, UIDs, binding and database mode before/after rollout; retain MariaDB, WordPress and MongoDB claims. Inspect Deployment Secret **references** (not values), ServiceAccount and named get-only RBAC. Confirm provider settings, exact public runtime MCP URL, trusted Origin/proxy configuration and public versus internal WooCommerce signing/destination URLs. Existing accounts, keys, registrations, audit rows, products and orders survive upgrade. |
| 4. Network | Run the [gateway egress matrix](gateway-egress.md#read-only-live-checks) and [provider checks](chat-deployment.md#required-deployed-checks). Confirm gateway → each MCP/database/DNS/approved API/provider; WooCommerce → WordPress; WordPress → MariaDB; Traefik → gateway/dashboard/store. From unrelated ordinary Pods prove upstream/database ingress denial. Prove gateway egress to listening unapproved same/other-namespace and external targets is blocked while a control Pod reaches them. Retain CNI drop evidence. Absent listeners, refused ports or policy objects alone do not prove enforcement. |
| 5. User A chat | Log in as eligible administrator A. With explicit commerce authorization, ask “Create Acceptance Mug at 12.50 with status=publish.” Inspect actual `woocommerce.create_product` success, product ID/status/price and storefront visibility. Do not infer publication from model prose. Inspect audit user A, `dashboard_session`, null key ID, server/tool/time/duration/outcome through the administrator API/table. |
| 6. Manual COD | Follow [commerce checkout](commerce-chat-walkthrough.md): enable COD/test checkout, manually add the product to cart and complete checkout with approved test details. Record order ID and confirm matching items, totals and COD method in WooCommerce admin. No automated checkout. Do not repeat an uncertain order submission before inspecting store state. |
| 7. Today's orders | Ask “List today's orders in Asia/Kolkata using WooCommerce; report the date_range and pagination.” Confirm `date=today`, explicit IANA timezone and returned half-open UTC range; locate the manual order. Compare with the store's display timezone; page through remaining records if needed. Do not substitute UTC midnight. |
| 8. Two upstreams in chat | Ask “Multiply 6 by 7 using calculator and get current time in Asia/Kolkata using time; use both tools.” Record both actual call IDs/public names, outcomes and final answer, then inspect session-attributed audit rows. |
| 9. Distinct user B | A creates B if needed; B replaces the assigned password and logs in. B issues a personal key and copies the public URL from API keys. In an external MCP client configure **only** that URL and B's key; no upstream URL/credential or dashboard cookie. Discover all permitted enabled tools. As a member B sees five default tools, not create/update writes. Use calendar-day orders and the calculator/time two-upstream prompt. Record tool results and B's actual `gateway_api_key`/key ID audit attribution. Member requests to administrator users/servers/audit APIs must return 403. |
| 10. Revoke B | Keep the same external client open. Revoke B's key in the dashboard and attempt its next tool call: expect 401. Fresh uncached discovery also fails. Logging out alone must not revoke API keys. For later steps issue a fresh B key, record its ID, and revoke it at the end. |
| 11. Withdraw a server | Keep a remembered calculator tool in the external client. Disable calculator as A. Confirm disabled status, absence in fresh uncached MCP discovery and fresh chat tool definitions, and denial of remembered calls. Time remains usable. Re-enable and refresh; confirm rediscovery and actual calculation. For removal use a separately registered approved disposable server or explicitly approve removing the selected registration; confirm fresh/stale MCP and chat denial and retained historical audit attribution. Already admitted calls can finish; withdrawal prevents subsequent admissions. |
| 12. Pod failure/recovery | Only after explicit operator approval, record the selected upstream Deployment/Pod, obtain a fresh catalog, then delete **one upstream Pod only**, preserving its Deployment/Service/PVCs. Poll dashboard status and uncached MCP discovery; test a read-only call and healthy calculator/time/commerce as appropriate. Discovery refresh runs about every 30 s with 5 s connect/discovery bounds; calls have a 10 s timeout. A rapidly recreated Pod may recover before the next refresh: record that the outage was not observed, rather than claim detection. If observed, record elapsed detection/recovery time and classifications. Let the Deployment restore the Pod, confirm readiness, refresh/reconnect and verify actual tool recovery. Never reset the cluster, delete storage, broaden policies or replay uncertain writes. |
| 13. History throughout | Inspect User, Server, Tool, UTC time, duration, outcome, origin and key ID via the administrator API (origin/key are not table columns). Distinguish `success`, valid MCP `tool_error`, rejected/unauthorized/not-found, transport/unavailable/timeout outcomes. Identifiable revoked-key attempts have null verified identity. Inspect sanitized `audit_write_failed` signals: an audit outage can lose rows, and a lost acknowledgement can make persistence uncertain. No queue/backfill or tool replay exists. |

Use the [external SDK instructions](../guides/api-keys.md) and
[read-only smoke command](../guides/browser-to-mcp-workflow.md) for concrete client
configuration. Use `{ cacheMode: 'bypass' }` for fresh SDK discovery. After withdrawal,
explicitly call the remembered name; a cached list is not proof of continuing access.
For chat, the gateway owns each prompt's transcript and rechecks catalog/generation
before every call; the automated fixture exercises withdrawal while a provider
response still holds the old catalog. A manual fresh prompt alone cannot prove
that in-flight boundary.

## Upgrade, rollback and optional scope

Follow the [k3s upgrade/rollback sequence](../setup/k3s.md#upgrade-and-rollback)
for either environment, substituting `values-local.yaml` on Kind. Preserve the
site overlay, Secret references and existing claims. The completed Day 5 features
need gateway/dashboard/WooCommerce images containing #39–#45; no production code,
image, schema migration, Secret or Helm change is introduced by #46 itself.
Deploy missing prerequisite images/configuration, then repeat this checklist.
Rollback restores release manifests/images, not database side effects or external
Secret contents. Retain backups and use a compatible application revision.

Existing optional work includes role-filtered discovery and backend execution
denial, destination/SSRF checks, named Secret RBAC and ingress/gateway-egress
policies. Their live enforcement is subject to the checks above. A k3s deployment
is documented but unverified here. Automatic store provisioning/teardown,
OAuth, hosted container provisioning, many-tool search, custom per-user permission
systems, HA/scaling, metrics, automatic backups and durable audit queuing are not
implemented by this handoff. Manual WooCommerce installation/configuration remains
required. Do not expand optional scope to finish this walkthrough.
