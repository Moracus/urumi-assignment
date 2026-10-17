# Local workspace setup

Run all commands from the repository root. The two modes below share the same
code but use different networking and configuration:

| Mode | Applications | Databases and storefront | Configuration |
| --- | --- | --- | --- |
| Host development | Five apps via `pnpm dev` | MongoDB via Docker Compose; WordPress/MariaDB via the Kind setup below or an existing store | Root `.env` |
| Full Kubernetes | Five built app images in Kind | WordPress, MariaDB and authenticated MongoDB with PVCs | Helm values and Kubernetes Secrets |

## Prerequisites

Install Node.js 24.7+ (24 LTS recommended), Corepack, Docker with Compose, kubectl,
Helm and [Kind](https://kind.sigs.k8s.io/docs/user/quick-start/). Start Docker.
Use the pnpm version pinned in root `package.json`.

```bash
node --version
corepack enable
pnpm --version
docker version
docker compose version
kubectl version --client
helm version
kind version
pnpm install --frozen-lockfile
```

## Host development with `.env`

On first setup only:

```bash
cp .env.example .env
chmod 600 .env
```

An existing `.env` must be merged rather than overwritten. Fill `WC_CONSUMER_KEY`,
`WC_CONSUMER_SECRET` from WooCommerce and choose a private random
`GATEWAY_BOOTSTRAP_KEY` for initial administrator setup. No real credentials are
prefilled. `.env` is gitignored and excluded from Docker build contexts.
`WC_URL` is the supported canonical storefront variable; an old `WC_BASE_URL`
setting alone does not configure the adapter. `LLM_API_KEY` has no current consumer.

```bash
docker compose -p urumi-identity -f infra/mongodb/compose.yaml up -d --wait
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway setup-admin --email admin@example.com
pnpm dev
```

The setup CLI prompts for the same bootstrap secret configured in `.env` and a
final administrator password (12–128 characters). Setup runs once per database;
for an existing account, log in or follow [operator recovery](../guides/identity-setup.md#operator-recovery-13).
Open `http://localhost:5173`, log in and create a personal gateway API key. The
bootstrap secret cannot authenticate MCP. See [identity setup](../guides/identity-setup.md)
for the full enrollment flow and [API keys](../guides/api-keys.md) for MCP access.

| Service | Host URL |
| --- | --- |
| Dashboard | `http://localhost:5173` |
| Gateway | `http://localhost:3000/mcp` |
| WooCommerce MCP (development only) | `http://127.0.0.1:3001/mcp` |
| Calculator MCP (development only) | `http://127.0.0.1:3002/mcp` |
| Time MCP (development only) | `http://127.0.0.1:3003/mcp` |
| MongoDB (development only) | `127.0.0.1:27017` |
| Storefront via Kind below | `http://store.localhost:8080` |

All backend health checks are `/health/live` and `/health/ready`. Gateway readiness
requires MongoDB but permits zero connected upstreams. WooCommerce health does
not prove its store credentials work.

Backend `dev`/`start` and gateway `setup-admin`/`recover-admin` scripts load the
root `.env` even with filtered pnpm commands. They work without a file when all
configuration is supplied externally. Existing shell variables win over `.env`.
Use `GATEWAY_PORT`, `WOOCOMMERCE_MCP_PORT`, `CALCULATOR_MCP_PORT`, and
`TIME_MCP_PORT` to avoid a shared `PORT` collision. Explicit `PORT` overrides the
service-specific value. Dashboard uses `DASHBOARD_PORT` and
`DASHBOARD_PROXY_TARGET`. If ports change, also update upstream URLs, destination
rules, trusted origins and the public MCP URL; no variable interpolation occurs.
Vite reads root `.env`, `.env.local` and mode-specific files with Vite's usual
precedence. Only `VITE_*` variables are public; never prefix secrets with `VITE_`.

Default local upstream approvals permit only the three explicit loopback origins.
`UPSTREAM_ALLOW_LOOPBACK=true` and HTTP session cookies are development settings;
production mode rejects them. Initial upstream URLs seed a fresh database once.
For an existing database, edit persistent registrations through the admin dashboard
rather than expecting `.env` URL changes to overwrite them.

Stop apps with Ctrl-C. Preserve MongoDB data when stopping Docker:

```bash
docker compose -p urumi-identity -f infra/mongodb/compose.yaml down
```

## Full Docker, Kind and Kubernetes workspace

### 1. Cluster and ingress

Check for an existing cluster before creating one. Reuse it without deleting data.

```bash
kind get clusters
# Only if urumi does not exist:
kind create cluster --config infra/kind/cluster.yaml
kubectl config use-context kind-urumi
kubectl get nodes
kubectl get storageclass
kubectl create namespace urumi --dry-run=client -o yaml | kubectl apply -f -
```

The local chart uses storage class `standard`. Install Traefik in namespace
`traefik` using its [official Helm instructions](https://doc.traefik.io/traefik/getting-started/kubernetes/#install-traefik).
For a fresh local ingress installation:

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm upgrade --install traefik traefik/traefik -n traefik --create-namespace \
  --set service.type=ClusterIP --set providers.kubernetesIngress.enabled=true \
  --set ingressRoute.dashboard.enabled=false --wait
kubectl -n traefik rollout status deployment/traefik
kubectl get ingressclass
```

Confirm IngressClass `traefik` exists. For a pre-existing controller, preserve its
reviewed configuration. The supplied Kind config has no host-port mappings;
keep this running in another terminal after its Service is ready:

```bash
kubectl -n traefik port-forward svc/traefik 8080:80
```

Resolve `store.localhost`, `dashboard.localhost`, and `gateway.localhost` to
`127.0.0.1` in local DNS or your hosts file if necessary. Use a networking
implementation/version that enforces NetworkPolicy and verify allowed and denied
traffic; policy objects alone do not establish isolation.

### 2. Build every application image

```bash
docker build -f apps/gateway/Dockerfile -t urumi/gateway:dev .
docker build -f apps/woocommerce-mcp/Dockerfile -t urumi/woocommerce-mcp:dev .
docker build -f apps/calculator-mcp/Dockerfile -t urumi/calculator-mcp:dev .
docker build -f apps/time-mcp/Dockerfile -t urumi/time-mcp:dev .
docker build -f apps/dashboard/Dockerfile \
  --build-arg VITE_PUBLIC_MCP_URL=http://gateway.localhost:8080/mcp \
  -t urumi/dashboard:dev .
kind load docker-image --name urumi urumi/gateway:dev urumi/woocommerce-mcp:dev \
  urumi/calculator-mcp:dev urumi/time-mcp:dev urumi/dashboard:dev
```

Build for the cluster's architecture. WordPress, MariaDB and MongoDB use the
chart's upstream images and are pulled by Kubernetes. The dashboard public URL is
embedded at build time; a different public URL requires a new dashboard build.

### 3. Provision Secrets and a local overlay

Use protected files or a Secret manager. The example paths below must refer to
operator-created mode-0600 files; they are not supplied by the repository.

```bash
kubectl -n urumi create secret generic urumi-db-secret \
  --from-file=database-password=/secure/wordpress-db-password \
  --from-file=root-password=/secure/mariadb-root-password
kubectl -n urumi create secret generic urumi-gateway-auth \
  --from-file=bootstrap-key=/secure/gateway-bootstrap
kubectl -n urumi create secret generic urumi-mongodb-auth \
  --from-file=username=/secure/mongodb-username \
  --from-file=password=/secure/mongodb-password \
  --from-file=keyfile=/secure/mongodb-keyfile
```

Generate the MongoDB membership keyfile with `openssl rand -base64 756` into a
protected file. Follow [MongoDB credentials and initialization](../operations/mongodb-deployment.md#credentials-and-initialization)
for its administrator credentials and subsequent application-user provisioning.
For existing Secrets, use your deliberate rotation workflow rather than repeating
`create`; initialization Secrets do not rotate existing database passwords.

Create an operator overlay outside version control, for example
`/secure/urumi-local.yaml` (non-secret values):

```yaml
mongodb:
  enabled: true
gateway:
  dashboard:
    trustedOrigins: ["http://dashboard.localhost:8080"]
woocommerceMcp:
  wordpressUrl: http://store.localhost:8080
```

Retain the default `woocommerceMcp.wordpressInternalUrl: http://urumi-wordpress`.
Signing uses the public URL, while network traffic uses that internal Service.
Review [gateway egress](../operations/gateway-egress.md) for any required exact
DNS/API site approvals and add them to this overlay. Managed MongoDB adds its
narrow gateway egress rule automatically; external MongoDB needs all replica-set
peers approved. Do not disable policies to make setup work.

### 4. Bring up storage and the store first

```bash
helm upgrade --install urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml -f /secure/urumi-local.yaml \
  --set gateway.enabled=false --set dashboard.enabled=false \
  --set woocommerceMcp.enabled=false
kubectl -n urumi rollout status statefulset/urumi-mongodb --timeout=300s
kubectl -n urumi rollout status deployment/urumi-mariadb --timeout=300s
kubectl -n urumi rollout status deployment/urumi-wordpress --timeout=300s
```

Open `http://store.localhost:8080`. Complete WordPress installation, install and
activate WooCommerce, configure permalinks and store settings, then create a
read/write REST API key. Save its key/secret to protected files:

```bash
kubectl -n urumi create secret generic urumi-woocommerce-api \
  --from-file=consumer-key=/secure/woocommerce-key \
  --from-file=consumer-secret=/secure/woocommerce-secret
```

Using authenticated database administration as described in the MongoDB guide,
create a gateway database user with `readWrite` on `urumi`. Save its percent-encoded
URI in `/secure/gateway-mongodb-uri` with this shape:

```text
mongodb://<encoded-user>:<encoded-password>@urumi-mongodb-0.urumi-mongodb.urumi.svc:27017/urumi?authSource=urumi&replicaSet=urumi
```

```bash
kubectl -n urumi create secret generic urumi-identity-storage \
  --from-file=uri=/secure/gateway-mongodb-uri
```

### 5. Enable and verify the complete workspace

```bash
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml -f /secure/urumi-local.yaml
helm upgrade --install urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml -f /secure/urumi-local.yaml
kubectl -n urumi rollout status deployment/urumi-gateway --timeout=300s
kubectl -n urumi rollout status deployment/urumi-dashboard --timeout=300s
kubectl -n urumi get pods,svc,ingress,pvc,networkpolicy
```

For an existing release switching the gateway strategy to Recreate, apply the
one-time strategy patch in [dashboard deployment](../operations/dashboard-deployment.md#build-and-configure)
before upgrading. Omit the earlier disabling flags to restore enabled defaults.

Enroll the first cluster administrator through the gateway image CLI. The
Deployment injects the configured MongoDB URI and bootstrap Secret. This direct
Node command uses those Kubernetes variables:

```bash
kubectl -n urumi exec -it deployment/urumi-gateway -- \
  node apps/gateway/dist/identity/setup-cli.js --email admin@example.com
```

Open `http://dashboard.localhost:8080`, log in, issue a personal API key, and connect
an MCP client to `http://gateway.localhost:8080/mcp`. Test calculator/time and
read-only WooCommerce calls. Upstream MCP Services remain internal ClusterIP
Services with no public ingress. Do not use the bootstrap key as an MCP token.
Follow [deployed dashboard verification](../operations/dashboard-deployment.md#verification)
and the [egress verification matrix](../operations/gateway-egress.md) for session,
Ingress, allowed/blocked network checks and Secret RBAC checks. Do not infer
workload health from successful lint or template rendering.

For host development against only this store, use its public URL and WooCommerce
credentials in `.env`; keep the host's separate MongoDB Compose database. Avoid
confusing the host administrator account/database with the cluster account/database.

Keep PVCs, Secrets and the cluster when stopping work. Ending the Traefik
port-forward stops local browser access without deleting data. Do not run
`docker compose down -v`, delete PVCs/namespaces, or recreate the cluster as a
setup troubleshooting shortcut.
