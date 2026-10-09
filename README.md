# Urumi MCP Gateway — Day 1 starter

**Status: scaffold only.** Health endpoints and the React page work once dependencies are installed. MCP routes, WooCommerce, database deployments and Helm workloads are not implemented yet.

## Prerequisites

- Node.js 22+ and Corepack/pnpm 10
- Docker Desktop or Docker Engine
- kubectl, kind, helm

## Local start

```bash
corepack enable
corepack prepare pnpm@10.18.0 --activate
pnpm install
pnpm dev
```

- Dashboard: http://localhost:5173
- Gateway health: http://localhost:3000/health/live
- Woo MCP health: http://localhost:3001/health/live
- Calculator health: http://localhost:3002/health/live
- Time MCP health: http://localhost:3003/health/live

Typecheck: `pnpm typecheck`. Build: `pnpm build`.

## Kubernetes setup (day 1)

```bash
kind create cluster --config infra/kind/cluster.yaml
kubectl get nodes
kubectl create namespace urumi
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml
helm template urumi infra/helm/urumi -f infra/helm/urumi/values-local.yaml
```

**Important:** the Helm chart is a placeholder scaffold, not a deployable platform yet. Day 2 adds MariaDB/WordPress resources, PVCs and ingress. For Kind ingress configuration follow the current official Kind ingress guide; don't assume that an Ingress object by itself creates a controller.

## Planned endpoints

- `/api/*`: dashboard authentication, users, server registry, keys, audit and chat (Day 3–5)
- `/mcp`: real Streamable HTTP endpoint for the gateway and upstream MCP services (Day 2–3)
- `/health/live` and `/health/ready`: Kubernetes probes (today: process-only readiness; add dependency-aware readiness later)

## Boundary rules

- Only the gateway routes tool calls to upstream MCP servers.
- No upstream MCP ingress; allow calls only from gateway using enforced network policy.
- No raw credentials in source code, committed values, MongoDB, or browser responses.
- Team API keys are persisted hashed and can be revoked.
- Keep upstream identity separate from user identity; audit all tool executions.

## Next: Day 2

1. Helm install MariaDB with PVC and Secret.
2. Helm install WordPress with PVC and Ingress.
3. Install WooCommerce, enable COD, create REST API keys, verify checkout.
4. Implement WooCommerce MCP five required tools with SDK v2 and REST API.
5. Deploy MCP as internal ClusterIP with gateway-only network policy when the gateway exists.
