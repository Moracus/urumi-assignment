# Upstream destination policy (#16)

Every Streamable HTTP upstream uses the same destination policy in the registry connection boundary, including startup, periodic recovery and explicit registry reconnects. Discovery and calls keep their existing five-second and ten-second SDK bounds. Failed services remain isolated. Tool writes are never automatically retried.

## Operator configuration

The built-in origins are HTTP on `urumi-woocommerce-mcp:3001`, `urumi-calculator-mcp:3002`, and `urumi-time-mcp:3003`. Each also accepts its exact `.urumi.svc` and `.urumi.svc.cluster.local` spelling. These origins may resolve only to RFC1918 IPv4 or unique-local IPv6 addresses. A different namespace, cluster domain, port, scheme or hostname needs an explicit rule. Existing `*_MCP_URL` variables choose endpoints; they do not grant permission.

`UPSTREAM_DESTINATION_RULES` is a JSON array of additional exact origins and allowed IP CIDRs. It defaults to `[]`. For example, an operator-owned service could use:

```json
[{"origin":"https://tools.example.com","cidrs":["203.0.113.10/32"]}]
```

The address above is illustrative documentation space. Use the destination's actual approved addresses, preferably narrow ranges. Wildcards and hostname suffix matching are unsupported. Rules include only `origin` and nonempty `cidrs`; origins contain no path (except `/`), query, credentials or fragment. URL parsing canonicalizes endpoint hostnames and default ports. Malformed destination policy aborts startup before database/network access. Unapproved persisted upstream URLs abort startup after storage validation, including disabled upstreams; missing default migration inputs are validated before insertion. Completed migration ignores obsolete static defaults (see [registration startup](upstream-registrations.md)). DNS failures or denied resolved addresses mark only the affected upstream unavailable.

`UPSTREAM_DENIED_CIDRS` is an optional JSON array of CIDRs (default `[]`) that always overrides approvals. Include deployment-specific Kubernetes API VIPs and administrative-service ranges. The Kubernetes-injected `KUBERNETES_SERVICE_HOST` IP is automatically denied on every port, including 443, and through DNS aliases; an invalid injected address fails startup. This does not depend on the upstream hostname.

For Helm, set `gateway.destinationPolicy.rules` to the array set `gateway.destinationPolicy.deniedCidrs` for deployment-specific denials, and leave `gateway.destinationPolicy.allowLoopback: false`. These render to the same environment variables in local and production configurations. No additional destinations are enabled by default.

Controlled local development can set `UPSTREAM_ALLOW_LOOPBACK=true` **and** explicitly allow the exact loopback origin and CIDR. The boolean accepts only `true` or `false`; enabling it under `NODE_ENV=production` aborts startup. Application fixtures configure their ephemeral loopback origins explicitly. Never enable this exception in a deployed gateway.

Metadata/link-local, multicast, unspecified, IPv4-mapped IPv6, common address-translation ranges, cloud platform addresses, known administrative hostnames and administrative ports are denied even with explicit rules. Loopback is denied without the development exception. HTTP(S) is required, and URL credentials and fragments are forbidden. All redirects (including same-origin redirects) are denied before the target receives any request or credentials. Upstreams must serve MCP at the configured URL directly. No gateway bearer credential is forwarded to upstreams.

## Actual connection boundary

A dedicated Undici dispatcher bypasses ambient proxy configuration and resolves each new socket's approved hostname once. Every DNS answer must pass the origin's address ranges and hard denials; mixed safe/unsafe answers fail closed. The connector receives a validated IP literal, preventing a second DNS lookup between validation and connection. HTTPS retains the original server name for certificate validation and SNI; HTTP retains the original Host header. DNS has a 4.5-second bound, sockets a five-second bound, and SDK connection/discovery/call limits remain in place. Existing sockets continue using their already approved destination. A new socket or registry reconnect resolves and validates afresh. Dispatchers are destroyed on failed setup and connection cleanup.

`DestinationPolicy.validate(url)` is the shared synchronous validator for future registration/edit operations **before persistence**. It checks origin and literal-address eligibility; DNS checks occur at the actual socket boundary. Those management APIs are separate tickets and are not added here. Tests substitute only external lookup/dial I/O; the real policy runs inside `createGatewayApp` with real MongoDB, dashboard-issued keys and SDK clients.

## Deployment limits and operator steps

An IP allowlist cannot authenticate the workload behind an IP, discover arbitrary administrative HTTP services, or prevent routing/NAT/service-mesh changes after socket creation. Built-in private ranges accommodate cluster Service and Pod addressing; protect DNS, Service definitions and cluster routing. Operators must ensure approved hostnames cannot resolve to unrelated private workloads and must use TLS for external destinations. Narrow per-destination CIDRs are recommended for additional services. Short service names rely on the gateway running in namespace `urumi` and the cluster DNS search configuration.

Before adding an origin, approve its exact scheme/host/port and address ranges, configure its `*_MCP_URL` or later persistent registration, and separately approve the destination in deployment egress policy. Application approval never grants network permission. Preserve DNS access, MongoDB access and the existing internal MCP routes. The current chart provides ingress isolation only; it does **not** establish egress enforcement. Required deployment-specific egress restrictions and an enforcing CNI must be supplied/verified by operators (the broader registry network-policy work is a separate ticket). Account for Service DNAT, Pod/service CIDRs, mesh proxies and IPv6 in that verification. Do not expose upstreams through public Ingress.

Deploy the rebuilt gateway image and updated Helm values, then verify readiness, read-only tool discovery/calls and allowed/blocked connectivity using an enforcing CNI. No cluster deployment or live connectivity verification is performed by this implementation. No PVC, database data, OAuth signing, role policy, identity interface, or public tool names are changed.
