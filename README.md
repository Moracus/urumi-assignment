# Urumi MCP Gateway

A TypeScript MCP gateway that exposes WooCommerce, calculator, and time tools through one authenticated Streamable HTTP endpoint. Kubernetes workloads are packaged in a Helm chart, with WordPress and MariaDB persistence, gateway and storefront Ingress resources, and ingress NetworkPolicies.

Repository: [Moracus/urumi-assignment](https://github.com/Moracus/urumi-assignment).

This document describes source at commit [`f740f55`](https://github.com/Moracus/urumi-assignment/tree/f740f557e524dd9ccf45e41014038a08a66aad92). Deployment checks below are instructions, not a claim that a particular cluster has passed them.

## Implemented capabilities

- MCP Streamable HTTP at `/mcp` on the gateway and three upstream services.
- Gateway bearer authentication using `GATEWAY_BOOTSTRAP_KEY`, with SHA-256 digest comparison through `timingSafeEqual`.
- An execution boundary that authorizes, resolves, invokes, and audits tool calls.
- Upstream discovery, namespaced tool aggregation, schema forwarding, and routing to the original upstream tool name.
- Independent upstream connections, request timeouts, periodic discovery, and reconnection attempts.
- JSON tool-execution audit records on standard output.
- Five WooCommerce tools backed by the WooCommerce REST API, plus arithmetic and timezone tools.
- Dockerfiles for the gateway and upstream services; Helm Deployments, ClusterIP Services, health probes, resource settings, and persistent volumes for WordPress and MariaDB.
- Gateway `/mcp` and storefront `/` Ingress routes, plus ingress restrictions between platform components.

The React dashboard is a scaffold. User management, key management, audit browsing, server management, and chat are not implemented.

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

Only the gateway and WordPress have Ingress templates. Upstream MCP services and MariaDB use internal ClusterIP Services. See [system design](docs/systemdesign.md) for request flow, trust boundaries, failure behavior, and deployment decisions.

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

Admin authorization permits all registered tools. The member policy permits the three WooCommerce read tools, calculator, and time, but rejects product creation and order updates. **HTTP authentication currently always creates the bootstrap admin identity**; there is no member login or member API-key issuance flow.

## Repository layout

```text
apps/
  gateway/             Authentication, discovery, routing, execution, audit
  woocommerce-mcp/     WooCommerce REST API adapter and MCP tools
  calculator-mcp/      Arithmetic MCP server
  time-mcp/            Timezone MCP server
  dashboard/           React/Vite scaffold
packages/shared/       Shared types
infra/
  helm/urumi/          Chart, values, workloads, ingress, network policies
  kind/cluster.yaml    Single-control-plane local cluster configuration
docs/systemdesign.md   Architecture and implementation limitations
```

## Prerequisites

- Node.js 24 to match the service Dockerfiles, and Corepack/pnpm. The root `package.json` pins pnpm `12.10.1`; use that version rather than the older version previously shown in the scaffold README.
- Docker, kubectl, Helm, and Kind for local Kubernetes deployment.
- A working storage class matching `global.storageClassName` (`standard` in local values).
- An installed Ingress controller matching the chart's class and namespace. Local values select `traefik`; policies default to namespace `traefik`.
- A network plugin that actually enforces Kubernetes NetworkPolicy. The supplied Kind configuration does not configure one; the default Kind network must not be treated as proof of isolation.
- A configured WordPress site with the WooCommerce plugin and a read/write WooCommerce REST API key for all five tools.

The chart does not install the controller, network plugin, WooCommerce plugin, or application Secrets.

## Run the applications locally

Clone the repository, then install from its root:

```bash
git clone https://github.com/Moracus/urumi-assignment.git
cd urumi-assignment
corepack enable
pnpm install --frozen-lockfile
```

Provide credentials in your shell; these prompts avoid putting literal credentials in the commands:

```bash
read -r -s -p 'Gateway bootstrap key: ' GATEWAY_BOOTSTRAP_KEY; printf '\n'
read -r -s -p 'WooCommerce consumer key: ' WC_CONSUMER_KEY; printf '\n'
read -r -s -p 'WooCommerce consumer secret: ' WC_CONSUMER_SECRET; printf '\n'
export GATEWAY_BOOTSTRAP_KEY WC_CONSUMER_KEY WC_CONSUMER_SECRET
export WC_URL=http://localhost:8080
export WOOCOMMERCE_MCP_URL=http://localhost:3001/mcp
export CALCULATOR_MCP_URL=http://localhost:3002/mcp
export TIME_MCP_URL=http://localhost:3003/mcp
pnpm dev
```

Run this prompt block in Bash (`bash` if your default shell is zsh). Set `WC_URL` to your actual WordPress canonical URL; `localhost:8080` is only a local example. `WC_INTERNAL_URL` is optional and should normally be unset for a direct local connection. The Node applications do not provision WordPress or MariaDB, and do not automatically load a `.env` file.

| Service | Local address |
| --- | --- |
| Dashboard scaffold | `http://localhost:5173` |
| Gateway MCP | `http://localhost:3000/mcp` |
| WooCommerce MCP | `http://localhost:3001/mcp` |
| Calculator MCP | `http://localhost:3002/mcp` |
| Time MCP | `http://localhost:3003/mcp` |

Each backend exposes `/health/live` and `/health/ready`. Gateway readiness requires at least one connected upstream, so it does not mean all seven tools are available. Upstream health endpoints report process health without validating WooCommerce connectivity.

Use an MCP-capable client with Streamable HTTP and the header `Authorization: Bearer <your-bootstrap-key>` for gateway requests. Calculator example: call `calculator.calculate` with `{"operation":"multiply","a":6,"b":7}`. A successful text result contains `42`. Time example: call `time.current` with `{"timezone":"Asia/Kolkata"}`.

## Deploy to local Kubernetes

Commands below use namespace `urumi` and release name `urumi`. Resource names and default DNS/allowed-host settings are fixed around those names; alternate namespaces or multiple releases need additional configuration or template changes.

### 1. Prepare the cluster and images

```bash
kind create cluster --config infra/kind/cluster.yaml
kubectl create namespace urumi
kubectl get storageclass
```

Before relying on isolation, configure a policy-enforcing network plugin using its installation instructions. Install/configure Traefik separately and ensure its controller namespace matches `networkPolicy.ingressNamespace`. The supplied Kind file has no host-port mappings; an Ingress object alone will not expose localhost ports.

Build from the repository root so the Dockerfiles can access the pnpm workspace:

```bash
docker build -f apps/gateway/Dockerfile -t urumi/gateway:dev .
docker build -f apps/woocommerce-mcp/Dockerfile -t urumi/woocommerce-mcp:dev .
docker build -f apps/calculator-mcp/Dockerfile -t urumi/calculator-mcp:dev .
docker build -f apps/time-mcp/Dockerfile -t urumi/time-mcp:dev .
kind load docker-image --name urumi \
  urumi/gateway:dev urumi/woocommerce-mcp:dev \
  urumi/calculator-mcp:dev urumi/time-mcp:dev
```

### 2. Create database and gateway Secrets

In Bash, collect non-empty passwords and a bootstrap key:

```bash
read -r -s -p 'Database password: ' DB_PASSWORD; printf '\n'
read -r -s -p 'Database root password: ' DB_ROOT_PASSWORD; printf '\n'
read -r -s -p 'Gateway bootstrap key: ' GATEWAY_BOOTSTRAP_KEY; printf '\n'

kubectl -n urumi create secret generic urumi-db-secret \
  --from-literal=database-password="$DB_PASSWORD" \
  --from-literal=root-password="$DB_ROOT_PASSWORD"
kubectl -n urumi create secret generic urumi-gateway-auth \
  --from-literal=bootstrap-key="$GATEWAY_BOOTSTRAP_KEY"
unset DB_PASSWORD DB_ROOT_PASSWORD
```

For an existing installation, update existing Secrets through your normal secret-management workflow instead of repeating `create`.

### 3. Bootstrap WordPress and WooCommerce

Deploy without the gateway or WooCommerce adapter until the store and API credentials exist:

```bash
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm upgrade --install urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml \
  --set gateway.enabled=false \
  --set woocommerceMcp.enabled=false
kubectl -n urumi rollout status deployment/urumi-mariadb
kubectl -n urumi rollout status deployment/urumi-wordpress
```

Expose the Ingress controller locally. If its Service is named `traefik` in namespace `traefik`, this is one option in a separate terminal:

```bash
kubectl -n traefik port-forward svc/traefik 8080:80
```

Use `http://store.localhost:8080` for this access pattern. Resolve `store.localhost` to `127.0.0.1` if your machine does not do so automatically. Complete the WordPress installer, install and activate WooCommerce, configure store settings and permalinks, and create a read/write REST API key under WooCommerce settings. Products, orders, payment settings, and checkout data require store configuration; they are not seeded by the chart.

WordPress's canonical site URL must match `woocommerceMcp.wordpressUrl`, including scheme and port. For the above port-forward, use `http://store.localhost:8080`; when exposing the controller on port 80, local values already use `http://store.localhost`. A URL mismatch or redirect can break the adapter's signed requests.

Create the adapter Secret in Bash:

```bash
read -r -s -p 'WooCommerce consumer key: ' WC_CONSUMER_KEY; printf '\n'
read -r -s -p 'WooCommerce consumer secret: ' WC_CONSUMER_SECRET; printf '\n'
kubectl -n urumi create secret generic urumi-woocommerce-api \
  --from-literal=consumer-key="$WC_CONSUMER_KEY" \
  --from-literal=consumer-secret="$WC_CONSUMER_SECRET"
unset WC_CONSUMER_KEY WC_CONSUMER_SECRET
```

### 4. Enable the complete backend

For the controller port-forward on port 8080:

```bash
helm upgrade --install urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml \
  --set woocommerceMcp.wordpressUrl=http://store.localhost:8080
kubectl -n urumi get pods,svc,ingress,pvc,networkpolicy
kubectl -n urumi rollout status deployment/urumi-gateway
```

Omitting the earlier disabling overrides restores the enabled defaults. Access the gateway with an MCP client at `http://gateway.localhost:8080/mcp` and the bearer header. Its Ingress exposes exactly `/mcp`; health routes are not published by that Ingress. If needed, resolve `gateway.localhost` to `127.0.0.1` as well.

For a direct development health check, use a separate terminal:

```bash
kubectl -n urumi port-forward svc/urumi-gateway 3000:3000
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Port-forwarding is administrative access and is not evidence that pod-to-pod NetworkPolicy works.

## Configuration reference

| Variable | Service | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | Backends | Listen address; local defaults use loopback, containers use `0.0.0.0`. |
| `MCP_ALLOWED_HOSTS` | Backends | Comma-separated allowed HTTP hostnames. |
| `GATEWAY_BOOTSTRAP_KEY` | Gateway | Required bearer credential; maps to one admin identity. |
| `WOOCOMMERCE_MCP_URL` | Gateway | WooCommerce MCP endpoint. |
| `CALCULATOR_MCP_URL` | Gateway | Calculator MCP endpoint. |
| `TIME_MCP_URL` | Gateway | Time MCP endpoint. |
| `WC_URL` | WooCommerce MCP | Canonical storefront base URL used for signing. |
| `WC_INTERNAL_URL` | WooCommerce MCP | Optional internal destination; chart uses `http://urumi-wordpress`. |
| `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` | WooCommerce MCP | Store REST API credentials. |

The Helm chart supplies these variables from values and Secret references. Keep raw credentials out of committed values. Changing an environment-backed Secret requires restarting the affected Deployment to load the new value. `values-prod.yaml` contains placeholder hosts and storage settings; it is not a complete production configuration. Changing gateway hostnames also requires updating `gateway.allowedHosts`.

## Validation

From the repository root:

```bash
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway exec tsx --test \
  src/execution/execute-tool.test.ts src/tools/aggregator.test.ts
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm template urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml
```

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

- One environment-backed bootstrap admin credential; no persisted users, teams, hashed key store, key expiry, or revocation API. Digest comparison is not persisted hashed-key management.
- Registry, discovery cache, and connections are in memory. No registry CRUD API or persisted upstream configuration.
- Audits are console records, with no durable audit database, queue, query API, or dashboard. Authentication failures and SDK-level validation failures do not necessarily reach the execution audit boundary.
- NetworkPolicies cover ingress only. They do not restrict egress and require an enforcing network plugin. Controller namespace and workload-label selectors are broader than cryptographic service identity.
- No upstream bearer authentication or mutual TLS; upstream access relies on cluster networking and policy.
- No TLS block in the Ingress templates, request rate limiting, or automatic retry of failed tool calls. Failed writes can have uncertain outcomes and need inspection before retrying.
- Single-replica workloads; database and WordPress persistence use PVCs with `Recreate` Deployments. Backups, high availability, restore automation, and production hardening are not supplied.
- WooCommerce installation and store configuration are manual. Health probes do not prove that store APIs or checkout work.
- Dashboard remains a local scaffold with no Helm workload or Ingress template. A dashboard hostname/image value alone does not deploy it.

These limits describe the current implementation and should be revised as capabilities are added.
