# Public tool names

Gateway MCP discovery, invocation, server inspection, dashboard chat, OpenAI
function definitions and new audit records use `<server_name>_<tool_name>`.
The seven bundled tools are:

```text
woocommerce_list_products
woocommerce_create_product
woocommerce_list_orders
woocommerce_get_order
woocommerce_update_order_status
calculator_calculate
time_current
```

`apps/gateway/src/tools/public-name.ts` owns name generation. It joins the server
and native tool names with `_`, lowercases the result and replaces runs outside
`a-z`, `0-9` and `_` with `_`. Names longer than 64 characters use the first 47
characters, `_`, and the first 16 hexadecimal characters of the normalized name's
SHA-256 hash. This keeps the same public names usable by MCP and OpenAI.

The catalog retains public name, upstream name, native tool name and generation.
For example, `woocommerce_list_orders` maps explicitly to `woocommerce` and
`list_orders`; the internal MCP request still uses `name: "list_orders"`.
Native names, descriptions, schemas and structured results are preserved.
Routing never splits a public name or translates underscores back into dots.

If multiple discovered tools map to one public name, **all tools at that name are
omitted** from public discovery, server inspection and resolution. Invocation
rechecks the mapping, so a previously resolved tool cannot bypass a new collision.
Unrelated tools continue working. Collision detection includes cached definitions
of enabled unreachable servers; an outage cannot transfer a known ambiguous name
to another server. Disabled/removed servers do not reserve names. Administrators
can disable/remove a conflicting registration or change its native catalog; a
server ID is immutable, so changing it requires a new registration. This policy
also applies to normalization and hash collisions, and duplicate native entries.

Dotted public names have no aliases and fail as unknown tools (or forbidden for
members). Reconnect clients to discard cached catalogs. Existing dotted audit
rows remain readable and filterable; no collection/schema/data migration is
needed. Historical planning notes retain the terminology used when written.

## Rebuild and deploy to the existing Kind release

Run from the repository root. These commands target the existing `urumi` cluster,
namespace and Helm release, preserve its configured values and update only the
gateway/dashboard images. Use a fresh image tag for subsequent rebuilds.

```bash
docker build -f apps/gateway/Dockerfile -t urumi/gateway:snake-case .
docker build -f apps/dashboard/Dockerfile -t urumi/dashboard:snake-case .
kind load docker-image --name urumi urumi/gateway:snake-case urumi/dashboard:snake-case
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm upgrade urumi infra/helm/urumi -n urumi --kube-context kind-urumi \
  --reuse-values \
  --set images.gateway=urumi/gateway:snake-case \
  --set images.dashboard=urumi/dashboard:snake-case \
  --wait --timeout 300s
kubectl --context kind-urumi -n urumi rollout status deployment/urumi-gateway --timeout=300s
kubectl --context kind-urumi -n urumi rollout status deployment/urumi-dashboard --timeout=300s
kubectl --context kind-urumi -n urumi get pods,svc,ingress,pvc,networkpolicy
```

Upstream images need no rebuild. Keep existing Secrets, MongoDB, PVCs,
NetworkPolicies and Traefik routing. No additional forwarding is needed; continue
using the existing public ingress on port 80 and `/mcp`. If your current ingress
uses another public port, retain that URL instead. Rollback uses the prior image
tags/Helm revision and restores the prior naming convention; reconnect clients.

## Cursor and MCP Inspector verification

Issue a personal gateway API key in the dashboard. Configure the public gateway
URL with its bearer header using your private client configuration. For Cursor,
merge this entry into `~/.cursor/mcp.json`, replacing the placeholder locally:

```json
{
  "mcpServers": {
    "urumi": {
      "url": "http://gateway.localhost/mcp",
      "headers": { "Authorization": "Bearer <personal-gateway-api-key>" }
    }
  }
}
```

Restart Cursor or toggle the server to clear discovery. Inspect its tool list,
then ask Agent to invoke the three calls below and inspect the actual tool calls
and responses. Use MCP Logs if discovery still contains old names. Cursor's
[official MCP configuration guide](https://prod.cursor.com/help/customization/mcp)
documents the URL/header configuration and reconnect controls.

For MCP Inspector, launch `pnpm dlx @modelcontextprotocol/inspector`, open its
displayed UI URL, choose Streamable HTTP and connect to the same gateway URL.
Configure `Authorization: Bearer <personal-gateway-api-key>` in its request
headers/authentication controls. The local Inspector proxy's own authentication
token is separate from the gateway key. See the Inspector's
[server configuration documentation](https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-server-configuration.md).
List tools and invoke:

| Public tool | Arguments | Expected evidence |
| --- | --- | --- |
| `calculator_calculate` | `{"operation":"multiply","a":6,"b":7}` | Result `42` |
| `time_current` | `{"timezone":"UTC"}` | Current UTC time |
| `woocommerce_list_orders` | `{"limit":1,"page":1}` | Order page, possibly empty; requires working store credentials |

Neither client should advertise dotted public names or report “Tool not found”
for these discovered tools. Members see only permitted read tools; administrators
also see the two WooCommerce write tools. Use read-only calls for verification.
In dashboard chat, request multiplication/time and orders, check the same public
names in the call table and inspect administrator tool history for correct user,
key/session origin, upstream and outcome. A valid MCP tool error remains a tool
error rather than proof of transport failure.

Automated fixtures exercise the protocol, role checks, native routing, chat
encoding and call/result IDs. They do not establish live Cursor/Inspector access,
paid OpenAI availability, deployed store connectivity or workload readiness.
