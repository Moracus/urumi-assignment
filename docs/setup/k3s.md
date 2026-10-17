# Production-like k3s VPS setup

Use the same chart and application images as [local Kind setup](local-development.md).
This is an operator procedure, not evidence of a deployed VPS or production readiness.

## Provision the host and images

1. Provision a Linux VPS with persistent SSD capacity and resources sufficient for
   the chart's requests/limits, the control plane and build/runtime overhead. Review
   [K3s requirements](https://docs.k3s.io/installation/requirements); its minimums
   exclude application workloads. Restrict SSH/API access to administrators; expose
   storefront/dashboard/gateway HTTP(S) only as intended. Keep overlay network ports
   private. Plan off-host database and WordPress filesystem backups and test restoration.
2. Install an operator-selected pinned K3s release using the reviewed
   [K3s installation/configuration procedure](https://docs.k3s.io/installation/configuration).
   Keep kubeconfig mode 0600 and use an explicitly selected context. Retain Traefik,
   DNS, a working `local-path` provisioner and a NetworkPolicy controller, or configure
   equivalent reviewed components. See [K3s networking services](https://docs.k3s.io/networking/networking-services).
   Record versions/settings; run allowed/blocked probes after deployment. Installation
   alone does not verify enforcement. Do not reinstall an existing cluster.
3. Check `kubectl get nodes`, `kubectl get storageclass`, `kubectl get pods -n kube-system`
   and `kubectl get ingressclass`. Discover the actual ingress namespace/Pod labels,
   resolver, API VIP/backends and ingress proxy IPs for the site overlay. The chart's
   default ingress namespace `traefik` must be overridden if the controller is in
   `kube-system`. Use [egress configuration](../operations/gateway-egress.md).
4. Build immutable versioned images for the VPS architecture and push them to a
   registry accessible to its runtime. Build from the repository root, for example
   `docker build --platform linux/amd64 -f apps/gateway/Dockerfile -t REGISTRY/urumi/gateway:VERSION .`.
   Repeat for `dashboard`, `woocommerce-mcp`, `calculator-mcp` and `time-mcp` Dockerfiles.
   Publish each tag with `docker push REGISTRY/urumi/COMPONENT:VERSION`. Use the VPS's
   architecture, not necessarily amd64. Configure private registry trust/authentication
   on nodes through [K3s registry configuration](https://docs.k3s.io/installation/private-registry)
   if required; do not put registry credentials into application values. Kind image
   loading does not distribute images to k3s.

## Configure and install

Create namespace `urumi` only if it does not already exist. Pre-provision the
[database/bootstrap/commerce Secrets](local-development.md),
[MongoDB credentials](../operations/mongodb-deployment.md),
[provider Secret](../operations/chat-deployment.md) and three TLS certificate
Secrets referenced by the production overlay. Store credentials in protected
files/your Secret manager, never CLI literals or committed YAML. For a new
installation, deploy storage/store first using the staged local procedure with
`values-prod.yaml`, configure WordPress/WooCommerce manually, then enable gateway,
upstreams and dashboard. An existing installation keeps its database mode/URI,
setup consumption, accounts, registrations and store data.

Prepare `/protected/urumi-site.yaml` containing nonsecret site configuration:

- Real distinct `global.dashboardHost`, `gatewayHost`, `storeHost`; DNS records to
  the ingress address; `global.ingressClassName: traefik` and
  `global.storageClassName: local-path` only if those exist.
- `dashboard.publicMcpUrl: https://YOUR_GATEWAY/mcp` and matching
  `gateway.allowedHosts`, including the Service/probe hosts;
  `gateway.dashboard.trustedOrigins: [https://YOUR_DASHBOARD]`, `allowHttp: false`
  and exact ingress `trustedProxies` addresses. Verify forwarded-header sanitization.
- `ingress.dashboard.tlsSecretName`, `ingress.gateway.tlsSecretName` and
  `ingress.wordpress.tlsSecretName` pointing to provisioned certificates.
- `woocommerceMcp.wordpressUrl: https://YOUR_STORE` for OAuth signing;
  retain `wordpressInternalUrl: http://urumi-wordpress` for transport.
- `gateway.image`, `dashboard.image`, `woocommerceMcp.image`, `calculatorMcp.image`
  and `timeMcp.image` repositories/tags/pull policies. Legacy `images.*` values are unused.
- Existing Secret names, approved upstream `gateway.secretReferences` and exact
  application destination/denial rules where needed. Use `mongodb.enabled: true`
  only for a new managed database installation; otherwise retain external mode and
  approve every replica-set peer. A standalone MongoDB cannot support identity transactions.
- `networkPolicy.enabled: true`, actual ingress namespace and narrow DNS, database,
  API and provider peers under `networkPolicy.gatewayEgress`. Enable chat and set
  model/Secret reference as in [chat deployment](../operations/chat-deployment.md).
  Approve provider addresses through the site's change process; never broaden
  egress to fix access. Do not expose upstream MCP services publicly.

Validate and review locally before applying:

```bash
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml -f /protected/urumi-site.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-prod.yaml -f /protected/urumi-site.yaml
helm upgrade --install urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-prod.yaml -f /protected/urumi-site.yaml --wait --timeout 300s
kubectl rollout status deployment/urumi-gateway -n urumi --timeout=300s
kubectl rollout status deployment/urumi-dashboard -n urumi --timeout=300s
kubectl get pods,svc,ingress,pvc,networkpolicy -n urumi
```

Run first-administrator CLI setup only for a new database, using the existing
[identity setup](../guides/identity-setup.md) procedure. Open the dashboard, issue
a personal gateway key, connect through the public MCP URL and execute the
[acceptance checklist](../operations/acceptance-handoff.md). No automated commerce
mutation or Pod deletion is part of installation.

## Upgrade and rollback

1. Record `helm history urumi -n urumi`, image digests, nonsecret overlay revision,
   database mode and `kubectl get pvc -n urumi -o wide`. Save claim UIDs as well.
   Take application-consistent MongoDB/MariaDB and WordPress filesystem backups
   using your operated backup process; verify recovery before risky upgrades.
   Keep the previous chart/images/configuration and external Secret versions.
2. Run workspace tests and chart regressions, lint/render the new chart with the
   same site overlay, and review differences. Change only intended immutable image
   tags/configuration. For legacy RollingUpdate gateway releases apply the one-time
   [Recreate strategy patch](../operations/dashboard-deployment.md#build-and-configure)
   before upgrading. Single gateway replicas can briefly interrupt access.
3. Run the `helm upgrade --install` above (or local values on Kind). On timeout,
   inspect rollout/events/configuration before retrying. Never reset storage to
   clear a startup error. For environment-injected Secret rotation restart only
   affected consumers after the Secret manager has updated credentials; use the
   documented database credential rotation sequence for existing database users.
4. Repeat readiness, routes, Secret-reference, persistence and connectivity checks.
   Confirm existing login/key, registration and audit history, and read-only store
   calls. Repeat real-provider read-only calculator/time chat. Commerce writes and
   failure exercises require separate explicit authorization.
5. If application/configuration rollback is necessary, select the recorded
   compatible prior revision and run
   `helm rollback urumi PRIOR_REVISION -n urumi --wait --timeout 300s`.
   Recheck readiness and the same acceptance controls, data and PVC UIDs. Helm
   restores manifests/images, not database changes, orders/products, or external
   Secret values. This release adds no data migration, but an older application
   may not understand newer configuration; choose a compatible revision. Do not
   uninstall/reinstall, delete PVCs/namespaces or recreate the cluster. Investigate
   uncertain tool outcomes before any manual retry.

Record all actual results, interruptions and remaining checks in the release
handoff. This single-node, single-gateway procedure does not supply HA, automatic
backups, disaster recovery or production certification.
