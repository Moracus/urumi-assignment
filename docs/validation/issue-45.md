# #45 — public MCP URL runtime configuration

Validated on 2026-10-17. Baseline: `6510834`. These checks do not establish a live
Kubernetes deployment or external-client acceptance walkthrough.

## Executed image and configuration checks

Built the final image, then reused it across all runtime scenarios:

```sh
docker build -f apps/dashboard/Dockerfile -t urumi/dashboard:issue45 .
node apps/dashboard/scripts/verify-runtime-image.mjs urumi/dashboard:issue45
```

Passed against the same immutable Docker image ID in all seven scenarios:
`sha256:d848f0872de8bdb7a6383cf304e9da365f79eca1745c70a4eae6529c1b6c5b0e`.

- Local public URL: `http://gateway.localhost:8080/mcp`.
- Production-like public URL: `https://gateway.example.test/mcp`.
- Missing property, empty property, embedded credentials, wrong path, and missing file.

The containers used a read-only root filesystem and public configuration mounts,
no capabilities, and a bounded temporary filesystem. Real Chromium checked
connection text on personal keys and member overview, the own-key placeholder,
empty local/session storage, explicit error states, deep-link SPA responses,
no-store JSON, missing assets, and nginx API/MCP 404 separation. Synthetic
session/API responses isolate static-image behavior; no real gateway, provider,
Ingress, or store was exercised by this script. An initial fixture attempt reused
a mounted file between scenarios and received truncated JSON through Docker Desktop;
using a distinct immutable file per scenario corrected the fixture, and all seven
scenarios passed together on rerun.

## Application and chart checks

- The new Playwright test first failed because runtime loading did not exist.
  After implementation, `runtime-config.spec.ts` passed its initial 14 tests against the
  running gateway and disposable MongoDB browser fixture. A trailing-whitespace
  case was subsequently added for the final full browser run.
- `pnpm --filter @urumi/dashboard typecheck`: passed during implementation.
- `ruby infra/helm/urumi/test-dashboard.rb`: passed. Renders both environment values;
  verifies only public JSON, read-only mount, rollout checksum, route and security
  preservation, missing setting, invalid URL rejection, and valid IPv4/IPv6 URLs.
- `helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml` and the matching
  `values-prod.yaml` command: passed (optional chart icon advisory only).
- `ruby infra/helm/urumi/test-chat.rb`, `test-mongodb.rb`, `test-secret-rbac.rb`,
  and `test-gateway-egress.rb`: passed.
- `node --test scripts/workspace-env.test.mjs infra/helm/urumi/*.test.mjs`: 7 passed.
  Initial sandbox runs could not open local HTTP fixtures; rerun with approval passed.
- Full `pnpm test:workflow`: passed with exit 0. This ran workspace typecheck and
  build, 3 WooCommerce tests, 181 gateway tests (none skipped), and all 79 browser
  tests, including all 15 final runtime-configuration cases. Its disposable MongoDB
  containers/network were removed by the runner after success.
- Final `pnpm --filter @urumi/dashboard typecheck` and `build`: passed after the
  browser length/whitespace validation and fixed fetch-error message changes.
- `git diff --check` and staged diff whitespace validation: passed.

## Review

### Standards

No remaining findings. The obsolete development environment example was corrected.

### Spec

No remaining findings. Chart validation now rejects malformed IPv4 and IPv6 hosts.

Review used the starting commit as the fixed baseline and covered the staged
implementation in separate Standards and Spec agents. The obsolete development
environment example and permissive chart IP-host validation were corrected, with
regressions. No authentication, authorization, tool execution, store data, PVC,
Secret permissions, or ingress routing behavior changed.

## Deployment steps and remaining live checks

Publish the dashboard image with an immutable tag, set `dashboard.image` and
`dashboard.publicMcpUrl` in operator values, lint/render, and perform the normal
Helm upgrade. The checksum rolls dashboard Pods; reload the browser after rollout.
No data migration or reset is required. URL-only updates reuse the image.
See [deployment, upgrades and rollback](../operations/dashboard-deployment.md).

No application release was deployed for this issue. Workload readiness, Services,
real TLS/Ingress routing, Secret references, PVC preservation, allowed/blocked CNI
connectivity, a real external MCP client, and the two-user/storefront walkthrough
remain live operator checks. Rendered chart and controlled browser evidence must
not be substituted for these checks.
