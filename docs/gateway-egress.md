# Gateway egress policy and verification (#23)

The chart adds `urumi-gateway-egress` when both `networkPolicy.enabled` and `gateway.enabled` are true. Its exact `app: urumi-gateway` selector isolates gateway egress. The six existing ingress policies, ClusterIP Services, `/mcp` and storefront Ingress routes, selectors and WordPress/MariaDB PVCs are preserved. No MongoDB workload or public upstream endpoint is introduced. Keep one gateway replica: registry changes and credential rotation coordinate within one process only.

The policy permits:

| Destination | Selection | Ports |
| --- | --- | --- |
| Cluster DNS | `kube-system` AND `k8s-app: kube-dns` by default | UDP and TCP 53 |
| Enabled bundled MCP servers | Same-namespace exact `app` label per server | TCP 3001, 3002, 3003 by default |
| MongoDB | Explicit operator peers for all replica-set members | Explicit TCP ports |
| Kubernetes API | Explicit operator host routes | Explicit TCP API ports |
| Additional destinations | Explicit operator peers | Explicit TCP ports |

MongoDB/API/additional approvals default to empty and fail closed. Both environment values files render valid policy, but require a site overlay before deploying a working persistent gateway. The URI Secret does not reveal its destinations to Helm. Do not infer operational compatibility or production readiness from successful linting.

## Site overlay

Example metadata only; substitute actual labels, namespaces, IPs and ports:

```yaml
networkPolicy:
  gatewayEgress:
    dns:
      namespace: kube-system
      podLabels: {k8s-app: kube-dns}
      # Optional, only if your CNI matches the DNS VIP before DNAT,
      # or the deployment uses a specific NodeLocal DNS resolver.
      serviceCidrs: []
    mongodb:
      - namespace: identity
        podLabels: {app: identity-mongodb}
        ports: [27017]
    kubernetesApi:
      - cidr: 10.96.0.1/32  # example API Service VIP, not a portable default
        ports: [443]
      - cidr: 172.19.0.2/32 # example backend, not a portable default
        ports: [6443]
    additionalDestinations:
      - namespace: tools
        podLabels: {app: approved-mcp}
        ports: [8443]
gateway:
  destinationPolicy:
    rules:
      - origin: https://approved-mcp.tools.svc:8443
        cidrs: [10.244.2.20/32] # application's independent address approval
```

Every peer is either an exact namespace AND nonempty Pod-label map, or a single IP `cidr` with nonempty numeric TCP `ports`. IP routes accept valid IPv4 `/32` or fully expanded eight-group IPv6 `/128` only; subnet-wide approvals require deliberate chart changes and review. Kubernetes API and optional DNS IP approvals accept host routes only. Schema validation rejects empty selectors, invalid IPs, wildcard/subnet routes, empty ports, out-of-range ports and unknown peer fields. Pod labels are operator-controlled, not cryptographic identities. Restrict who can edit Pods, Services, DNS, values, policies and RBAC.

For external MongoDB, use one host route/port peer per destination instead of Pod selectors. Include every advertised replica-set member and its actual port, not just the seed. SRV requires approved DNS access and approval of all resolved members. Do not publish MongoDB with an Ingress. Provision `gateway.mongodbSecretName` with key `uri` through your Secret delivery workflow, outside Helm values. The chart does not deploy MongoDB.

API CIDRs are also appended to `UPSTREAM_DENIED_CIDRS`, alongside configured application denials, even when network policies are disabled. This prevents an MCP destination rule from reusing API Service or backend approvals. The application additionally denies the Kubernetes-injected Service host. NetworkPolicy is layer 3/4: it cannot limit HTTPS to Secret GET paths. The fixed TLS-verified Secret reader, exact namespace/name/key application approvals, dedicated ServiceAccount and named get-only Role enforce that layer. Nonempty `gateway.secretReferences` needs working API egress; pre-provision dedicated upstream Secrets and follow [Secret approval and rotation](upstream-credentials.md). Never approve identity/storage Secrets as upstream credentials.

## CNI and address requirements

Use an enforcing CNI installed and maintained through its official procedure. Kind v0.24+ includes [NetworkPolicy support](https://github.com/kubernetes-sigs/kind/releases/tag/v0.24.0). Identify the actual installed kindnetd image and execute the controlled matrix; a default networking configuration alone is not evidence of enforcement. Do not replace/recreate an existing cluster or install/replace its CNI as an automatic verification step.

Discover site settings using read-only commands:

```bash
kubectl get daemonsets,pods -n kube-system -o wide
kubectl get service kubernetes -n default -o wide
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o wide
kubectl get service kube-dns -n kube-system -o wide
kubectl get pods -n kube-system -l k8s-app=kube-dns --show-labels
kubectl get networkpolicies -A
```

Service DNAT can make a CNI see the Service VIP or backend address. Pod-selector MCP/MongoDB rules rely on CNI Service translation support; if explicit VIP host routes are required, add them with exact ports under `additionalDestinations` (and MongoDB peers respectively). Allow API VIP/backend host routes only as needed by the site's actual datapath; cover HA API backends individually. DNS NodeLocal/host-network behavior and IPv6 need site verification. Node traffic can have CNI-specific exemptions. A service mesh or ambient proxy can change the effective destination and weaken attribution; verify the real path or use CNI-specific controls. Never add `0.0.0.0/0`, `::/0`, whole node/Service/Pod subnets or an unrestricted proxy just to make connectivity work.

Policies are additive: any other policy selecting the gateway can broaden egress. Inspect all namespace and CNI-wide policies. Application approval alone grants no network permission; additional destinations require both operator layers and destination ingress permission. Disabling `networkPolicy.enabled` is an explicit isolation opt-out. Other application workloads retain their existing ingress rules and unrestricted egress; this is not namespace-wide egress lockdown.

Kubernetes describes [policy union, namespace/Pod selector semantics and Service NAT limits](https://kubernetes.io/docs/concepts/services-networking/network-policies/). Rendered YAML and API-object presence cannot prove dataplane enforcement.

## Validation and rollout

From the repository root, using either `local` or `prod` and a reviewed site overlay:

```bash
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml -f /protected/site.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-local.yaml -f /protected/site.yaml
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml -f /protected/site.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-prod.yaml -f /protected/site.yaml
ruby infra/helm/urumi/test-gateway-egress.rb
ruby infra/helm/urumi/test-secret-rbac.rb
```

Review the rendered policy, DNS selectors, API IP/port pairs, all MongoDB members, additional peers, application approvals/denials and get-only Secret Role. Then use the existing Helm upgrade procedure with the same overlay and rebuilt gateway image; API-denial environment changes require the gateway rollout. Existing active sockets may outlive policy updates depending on CNI connection tracking. A normal rollout establishes fresh connections. Preserve all PVCs and data. A wrong MongoDB approval can prevent startup/readiness; correct the overlay and redeploy without resetting storage.

## Read-only live checks

After operator deployment on an enforcing CNI:

```bash
kubectl get pods,deployments,services,ingress,pvc,networkpolicy -n urumi
kubectl rollout status deployment/urumi-gateway -n urumi --timeout=120s
kubectl get deployment urumi-gateway -n urumi -o jsonpath='{.spec.template.spec.serviceAccountName}'
kubectl get role,rolebinding -n urumi
```

Verify readiness, exact Service ports, existing Ingress routes and bound PVCs against the pre-rollout state. Run the existing [authenticated MCP discovery/calculator/time and read-only WooCommerce checks](mcp-authentication.md) through the real Ingress. Missing/invalid keys must still get 401. A storefront GET must still succeed. Administrative port-forwarding does not test the Ingress or ordinary Pod-network path.

The supplied verifier executes only DNS, TCP connections, MongoDB `ping` and TLS Secret GETs in existing Pods. It creates no resources, returns no Secret values and does not invoke WooCommerce mutations. It needs Node.js in both the deployed gateway image and an existing control Pod. The gateway probe uses its existing `MONGODB_URI`, installed Mongoose driver, mounted ServiceAccount token and CA. The control Pod requires no credentials.

Prepare a nonsecret JSON configuration outside source control:

```json
{
  "namespace": "urumi",
  "gatewayPod": "REPLACE-gateway-pod",
  "controlNamespace": "verification",
  "controlPod": "REPLACE-existing-node-control-pod",
  "dnsName": "urumi-calculator-mcp.urumi.svc.cluster.local",
  "targets": [
    {"name":"woocommerce","host":"urumi-woocommerce-mcp.urumi.svc.cluster.local","port":3001,"expect":"allowed"},
    {"name":"calculator","host":"urumi-calculator-mcp.urumi.svc.cluster.local","port":3002,"expect":"allowed"},
    {"name":"time","host":"urumi-time-mcp.urumi.svc.cluster.local","port":3003,"expect":"allowed"},
    {"name":"deniedSameNamespace","host":"REPLACE-listening-service.urumi.svc.cluster.local","port":8080,"expect":"denied"},
    {"name":"deniedOtherNamespace","host":"REPLACE-listening-service.other.svc.cluster.local","port":8080,"expect":"denied"}
  ],
  "secretReads": {
    "approvedSecret":{"namespace":"urumi","name":"approved-upstream-token"},
    "deniedSecret":{"namespace":"urumi","name":"unapproved-synthetic-token"},
    "deniedNamespaceSecret":{"namespace":"other","name":"synthetic-token"}
  }
}
```

The two denied targets must be existing, unrelated listening services in the stated namespaces, accepting ingress from both gateway and control Pods. They must have no separate ingress denial masking egress behavior. Prefer dedicated operator-provisioned verification fixtures. The control Pod must reach them immediately before the gateway probes; a refused connection, DNS error, absent listener or control timeout fails the check. Only a gateway timeout with a connected control is accepted as a denial; use CNI drop telemetry if your CNI actively rejects denied traffic. Inspect policies/telemetry to attribute the block, since a timeout alone cannot prove which control caused it.

Use pre-provisioned synthetic Secret names: one explicitly approved in `gateway.secretReferences`, one unapproved in the same namespace and one in another namespace. The expected live responses are 200, 403 and 403; a 404 is not authorization evidence. No Secret bodies are displayed. With credentials authorized to exec into the two existing Pods:

```bash
node infra/helm/urumi/verify-gateway-egress.mjs /protected/nonsecret-probes.json
```

Add allowed TCP targets for extra peers or individual MongoDB/API backends when diagnosing Service translation. DNS UDP tests a real A lookup; DNS TCP tests port reachability. MongoDB driver ping also exercises URI-driven member discovery and TLS. Secret GET exercises the actual gateway Pod network, fixed API hostname, TLS and ServiceAccount RBAC. Keep RBAC checks separate if using impersonated `kubectl auth can-i`: those do not exercise the gateway network. Capture the command, date, CNI/version, overlay revision and PASS/FAIL output. Report prerequisites or checks not executed as skipped. No cluster recreation, database reset, PVC deletion, Secret-value dump or commerce write is part of verification.
