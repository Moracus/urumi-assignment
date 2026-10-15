# Upstream credentials through Secret references (#22)

Administrators can POST or PATCH `authentication` as one of:

```json
{"type":"none"}
{"type":"bearer","secretRef":{"namespace":"urumi","name":"extra-token","key":"token"}}
{"type":"header","headerName":"X-API-Key","secretRef":{"namespace":"urumi","name":"extra-token","key":"token"}}
```

`header` is the API spelling for custom-header mode. Authentication is replaced as a whole; modes cannot be combined. POST still requires all other registration fields. PATCH may combine authentication, URL and display-name changes. Both require an eligible administrator dashboard session, trusted Origin and CSRF token. MCP bearer keys cannot manage registrations. Members retain their existing tool allowlist. Raw credentials/headers and unknown fields are rejected with a generic 400 before persistence or outbound access. Responses disclose only authentication type and whether a reference is configured.

Namespace is a DNS label (up to 63 characters), Secret name a DNS subdomain (up to 253), and key uses letters, digits, dots, underscores or hyphens (up to 253). Header names must be HTTP tokens, at most 100 characters. Authorization is reserved for bearer mode. Routing, cookies, proxy/forwarding, method override, hop-by-hop, content negotiation, Origin/Referer, user-agent, security (`Sec-*`) and MCP protocol headers are forbidden. Resolved values must be nonempty printable ASCII, at most 8192 characters, without surrounding whitespace; bearer values additionally use bearer-token syntax. Do not provision credentials with a trailing newline.

## Configuration and pre-provisioning

`UPSTREAM_SECRET_REFERENCES` is a JSON array of exact `{namespace,name,key}` approvals; default `[]` denies all Secret references. It contains metadata only. Malformed JSON, unknown fields or malformed references abort startup before MongoDB or outbound connections. Missing, forbidden, invalid-value or no-longer-approved persisted references leave only the associated enabled server unreachable, without anonymous fallback. Disabled registrations do not read Secrets. Safe reference metadata remains persisted in MongoDB.

Helm sets this variable from `gateway.secretReferences`, using the release namespace:

```yaml
gateway:
  secretReferences:
    - namespace: urumi
      name: extra-token
      key: token
```

Pre-provision `extra-token` through your normal Secret delivery workflow, using a protected file containing the token bytes. For example:

```bash
kubectl create secret generic extra-token -n urumi --from-file=token=/protected/path/token
```

Never place Secret values in Helm values, MongoDB, source control or API payloads. The chart creates the dedicated `urumi-gateway` ServiceAccount and binds the gateway Deployment to it. Nonempty approvals create a namespaced `urumi-gateway-secrets` Role/RoleBinding with only `get` on the distinct approved Secret names. Empty approvals create no Secret Role or binding. Cross-namespace approvals fail rendering. RBAC grants access to the entire named Secret; application policy restricts the approved key. Prefer dedicated upstream Secrets rather than adding identity/database Secret names. No list/watch/write/delete or cluster-wide Secret permissions are granted. There is no Secret management API.

The external reader uses the mounted ServiceAccount token and CA to GET the exact Secret from `https://kubernetes.default.svc`. It rereads token/CA on each resolution, uses verified TLS, a five-second HTTP deadline and a bounded response, and follows no redirects. It does not reuse the gateway key. The Secret value is decoded and held only in backend memory and the associated MCP transport. Startup does not require Kubernetes API connectivity when no enabled server needs credentials. Outside Kubernetes, Secret-authenticated connections fail closed unless the application construction boundary supplies an external reader (the integration-test seam).

Approve destination origin/CIDRs separately through the existing destination policy. The guarded upstream transport prohibits redirects even to another approved origin, preventing credential forwarding. Existing ingress-only NetworkPolicies are not proof of egress isolation. If your deployment enforces gateway egress, explicitly permit DNS and Kubernetes API HTTPS alongside approved upstreams and MongoDB; API Service/backend addresses depend on the cluster/CNI. This ticket does not deploy or weaken NetworkPolicies.

## API and rotation

With an existing protected cookie jar and session CSRF token:

```bash
curl --cookie "$COOKIE_JAR" -X PATCH \
  -H "Origin: $DASHBOARD_ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"authentication":{"type":"bearer","secretRef":{"namespace":"urumi","name":"extra-token","key":"token"}}}' \
  "$GATEWAY_URL/api/admin/servers/extra"
```

For a new approval, pre-provision the Secret, add its namespace/name/key to Helm values, lint/render, and upgrade the release with the rebuilt gateway image. This updates application approval and get-only RBAC together and restarts the gateway. Then POST/PATCH the approved reference. If resolution fails after persistence, POST returns 201 or PATCH returns 200 with `unreachable`, zero public tools and a sanitized error; it never restores old credentials. Persistence/reconciliation has the same partial-success risks as URL edits: after a lost response, inspect desired state before retrying.

Authentication changes immediately retire the previous callable generation and catalog, drain already-started bounded calls, close the old connection, and resolve the replacement. Calls already sent may finish; new calls cannot use the retired generation. Display-only edits avoid reconnection. Removal does not delete Secrets.

Rotate a value in the same Secret using the operator workflow. Every new connection resolves the current value. To force rotation immediately, disable then enable the server (a brief availability gap); otherwise it takes effect on the next reconnect. Refresh on an already connected server rediscovers its tools using the current transport; refresh of an unreachable server reconnects and resolves again. No state-changing tool call is automatically retried. Old connections hold the previous value until retired; rotation is not per-call resolution.

Run one gateway replica. Configuration changes and rotation barriers coordinate only this process; multi-replica registry synchronization remains unsupported. Audit records retain user/key attribution but contain no resolved credentials or tool arguments. Treat upstream-returned content as untrusted, including upstreams that deliberately echo credentials.

## Verification

Run gateway typecheck/build, affected compiled tests, and `pnpm --filter @urumi/gateway test:integration` (real isolated replica-set MongoDB). Tests exercise dashboard/MCP authentication, approved bearer/custom headers, reference replacement and reconnect rotation, restart, malformed/unapproved inputs, missing/forbidden reads, invalid values, sanitized output, redirect denial and healthy-server isolation. Only the external Secret reader is substituted; reference policy and transport remain real. Persistence and captured output are inspected for synthetic Secret material.

Run both Helm lints and `ruby infra/helm/urumi/test-secret-rbac.rb`; it renders local/production defaults and configured approvals and checks exact ServiceAccount binding and get-only named RBAC. Live authorization checks require a reachable cluster and are reported separately in implementation notes. Rendering alone does not establish networking, workload health or Kubernetes API reachability from a gateway Pod.
