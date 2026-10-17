# Persistent MCP bearer authentication (#8)

External MCP clients authenticate with individually issued [gateway API keys](api-keys.md), using `Authorization: Bearer <gateway-api-key>`. The bootstrap secret is used only by initial administrator CLI setup and never authenticates `/mcp`. There is no bootstrap or cookie fallback during database outages. The existing chart still injects the legacy bootstrap Secret; the gateway runtime ignores that value. Complete MongoDB/API routing and the Kubernetes rollout remain later work.

Every incoming `/mcp` HTTP request checks current MongoDB state before entering the SDK handler: the SHA-256 digest must identify an unrevoked key whose user exists, is active, and has completed required password replacement. Missing, malformed, unknown, revoked, orphaned, disabled-user, and pending-password-change credentials receive `401 {"error":"Unauthorized"}` and `WWW-Authenticate: Bearer realm="urumi-gateway"`. Storage unavailability returns a bounded, safe `503 {"error":"Authentication unavailable"}`; database exceptions, connection strings, and credentials are not exposed. Readiness requires available storage and a connected upstream; liveness remains process-only.

Authentication happens once per incoming HTTP request. A request-local asynchronous scope carries the verified `{ userId, role, keyId }` into the MCP factory and shared `executeTool()` path. The role is resolved from the current user record, never headers or tool arguments. No gateway MCP sessions or reusable authentication cache are introduced. Initialization, discovery, calls, notifications, and GET/DELETE requests all pass the same authentication boundary. Client-supplied session identifiers and dashboard cookies confer no MCP authority. Existing connected clients must authenticate their subsequent requests again; already admitted operations need not be canceled.

Successful authentication advances the key's `lastUsedAt` before protocol handling, including when authorization, input validation, unknown-tool rejection, or execution later fails. A conditional update avoids updating a concurrently revoked key; `$max` prevents concurrent requests from moving the timestamp backwards. Invalid credentials never advance last use. MongoDB digest lookup uses the unique hash index; there is no raw-secret comparison in application code. Raw keys and hashes never appear in audit records.

Discovery filters tools by the current role. Members may use `woocommerce.list_products`, `woocommerce.list_orders`, `woocommerce.get_order`, `calculator.calculate`, and `time.current`. Administrators may use every registered tool, including the two WooCommerce writes. Every call entering the shared execution boundary is independently authorized before resolution/invocation. Hidden or unknown names cannot route arbitrary upstream tools. Upstream descriptions, schemas, names, structured results, and `isError` results retain their existing behavior. [Durable audit records](tool-history.md) attribute execution to the real user/key IDs and authentication origin with request/attempt IDs, historical display snapshots, timestamp, tool/upstream, duration, and outcome; credentials and payloads are omitted. Authentication and SDK rejections that never reach execution do not produce execution audit records.

The existing ten-second upstream call timeout, independent unhealthy-upstream exclusion, approximately 30-second refresh/reconnection, and no automatic retries of non-idempotent WooCommerce writes remain unchanged. Role changes affect subsequent requests. Dashboard logout and ordinary password changes preserve API keys. Pending required password replacement blocks a retained key until replacement is completed. [Account disabling/re-enabling](dashboard-sessions.md#disable-and-re-enable-users-11) permanently revokes old credentials. [Administrator reset](dashboard-sessions.md#reset-a-password-12) preserves keys and blocks them until password replacement; [operator recovery](identity-setup.md#operator-recovery-13) permanently revokes existing keys and requires fresh issuance. Direct database edits are privileged and do not implement these workflows.

## Read-only MCP requests and revocation

Use Node.js 24 and installed workspace dependencies. Follow [initial setup](identity-setup.md), [dashboard login/current-user requests](dashboard-sessions.md#http-examples), and [personal key issuance](api-keys.md#requests). Stop before revocation, retaining the successful creation response privately. The following example assumes the private `session_dir`, cookie jar, `me.json`, and `created-key.json` from those examples. It reads the raw credential from the protected file instead of putting it in command arguments, shell history, or output.

```bash
export URUMI_KEY_RESPONSE_FILE="$session_dir/created-key.json"
export URUMI_MCP_URL=http://localhost:3000/mcp
pnpm --filter @urumi/gateway exec node --input-type=module <<'JS'
import { readFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const { rawKey } = JSON.parse(await readFile(process.env.URUMI_KEY_RESPONSE_FILE, "utf8"));
const client = new Client({ name: "urumi-read-only-example", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.URUMI_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  }));
  console.log((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map((tool) => tool.name));
  console.log(await client.callTool({ name: "calculator.calculate", arguments: { operation: "multiply", a: 6, b: 7 } }));
  console.log(await client.callTool({ name: "time.current", arguments: { timezone: "UTC" } }));
} finally {
  await client.close();
}
JS
```

The calls are read-only. The calculator result is `42`; time reflects the current clock. An unavailable upstream is excluded from discovery while healthy tools continue working. Use your real HTTPS gateway URL in deployments. Client-side discovery caches can retain old catalogs without making requests; bypass the cache when checking role changes or revocation. The gateway independently checks every actual incoming request, and calls cannot use a cached catalog to bypass authentication or authorization.

Revoke through the dashboard session boundary, using trusted Origin and CSRF:

```bash
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
key_id=$(jq -r '.key.id' "$session_dir/created-key.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -X DELETE "http://localhost:3000/api/keys/$key_id"
unset csrf_token key_id
```

Revocation returns `204` and is idempotent. Running the SDK example again with that credential receives `401`, as does a subsequent request from an already connected client. Listing metadata shows the retained `revokedAt` timestamp; the rejected credential does not advance `lastUsedAt`. After confirming revocation, remove the creation response and unset the file/URL environment variables:

```bash
rm "$session_dir/created-key.json"
unset URUMI_KEY_RESPONSE_FILE URUMI_MCP_URL
```

Run `pnpm typecheck`, `pnpm build`, and `pnpm --filter @urumi/gateway test:integration`. The suite uses real MongoDB and actual SDK requests against controlled upstreams for attribution, invalid credentials, next-request revocation, current roles, concurrent identity isolation, logout/password independence, database outages, upstream timeouts/isolation, and normal refresh recovery. No real WooCommerce writes or Kubernetes workloads are exercised. Updating the gateway image requires previously issued persistent keys; old bootstrap clients are rejected immediately after deployment. There is no bootstrap credential migration.
