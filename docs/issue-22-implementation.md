# Issue #22 implementation notes

Issue: Connect authenticated upstreams through Kubernetes Secret references.

## Changes

- `apps/gateway/src/upstream/credentials.ts`: exact namespace/name/key approval and external Kubernetes GET adapter using mounted ServiceAccount token/CA, verified TLS, bounded request/response and no redirects. Resolved values remain in backend memory, with safe header-value validation.
- `apps/gateway/src/upstream/registrations.ts`, `management.ts`, `registry.ts`, `connection.ts`, and `apps/gateway/src/app.ts`: POST/PATCH none/bearer/custom-header configuration, validation before persistence, injected external reader with real policy, credential-aware generation replacement and fresh resolution on reconnect through the existing transport and shared execution boundary.
- `apps/gateway/src/app.test.ts`: authenticated real HTTP/MCP integration tests for approved bearer/custom-header calls, reference edits, failed replacement, reconnect rotation, restart, raw/unapproved/conflicting input and unsafe headers, invalid/missing/forbidden values, redirect denial, healthy-server isolation, persisted documents and captured output.
- `infra/helm/urumi/values.yaml`, `templates/gateway-deployment.yaml`, `templates/gateway-secret-rbac.yaml`: exact reference metadata environment variable, dedicated gateway ServiceAccount binding, namespaced get-only Role for distinct approved names and exact RoleBinding. Empty approval grants no Secret RBAC; cross-namespace references fail rendering.
- `infra/helm/urumi/test-secret-rbac.rb`: rendered local/production default/configured approval assertions for exact deployment binding, Role verbs/resources/names and RoleBinding subject/reference.
- `README.md`, `docs/upstream-registrations.md`, `docs/upstream-credentials.md`, `docs/systemdesign.md`, `docs/threat-model.md`: API, startup, pre-provisioning, rotation, approval/RBAC extension, credential lifetime and deployment limits.

## Verification

Focused gateway typecheck/build and compiled credential tests passed. TDD observed bearer creation failing with 400 before implementation, unsafe method-override headers being accepted before validation was tightened, and the missing ServiceAccount assertion failing before chart implementation. The initial affected application run passed 54/55 tests: one old test expected all authentication PATCH requests to fail; its expectation was updated for the new supported contract.

Executed commands:

- `pnpm --filter @urumi/gateway typecheck`
- `pnpm --filter @urumi/gateway build`
- `env MONGODB_TEST_URI=… node --test --test-name-pattern=… apps/gateway/dist/app.test.js`
- `env MONGODB_TEST_URI=… node --test apps/gateway/dist/app.test.js` (initial run described above)
- `pnpm --filter @urumi/gateway test:integration` (full result recorded below)
- `helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml`
- `helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml`
- `ruby infra/helm/urumi/test-secret-rbac.rb` (renders both environments with default/configured approvals)
- `git diff --check`

Both Helm lints and all rendered RBAC assertions passed. No shared packages or consumers changed; workspace-wide checks are not applicable.

Live Kubernetes checks were separate from rendered assertions. `kubectl get pods -n urumi` showed all six existing workloads 1/1 Running at inspection time. A unique temporary namespace received only the rendered ServiceAccount/Role/RoleBinding plus two synthetic Secrets. Actual impersonated GET succeeded on the approved named Secret and failed on the other Secret. `kubectl auth can-i` denied list/watch/create/update/patch/delete and cross-namespace GET. The temporary namespace was removed. Existing workloads, production Secrets and volumes were not changed. This checks live RBAC, not the production adapter's Pod-network path, CNI enforcement, rollout readiness or Ingress behavior.

## Operator steps and limitations

Pre-provision dedicated upstream Secrets, add exact namespace/name/key metadata to `gateway.secretReferences`, approve destinations separately, and deploy the rebuilt image/chart with one gateway replica. Existing default upstreams need no credentials. Use administrator session/Origin/CSRF-protected POST/PATCH requests to configure authentication. Extend approvals through Helm so application allowlist and RBAC change together. See [full examples](upstream-credentials.md).

Every reconnect reads current Secret values. For immediate same-reference rotation, disable/enable the server; healthy refresh uses its existing transport. Already-started calls may finish; failed credential replacement never reuses old credentials. Missing/unapproved/forbidden reads leave only that server unavailable. Resolved values are never persisted; malicious upstream-returned data remains untrusted.

No full gateway rollout, Pod-network Kubernetes API read, allowed/blocked connectivity matrix, Ingress smoke test or WooCommerce mutation was performed. Existing ingress-only NetworkPolicies are unchanged; deployments enforcing egress must approve DNS/API/upstreams/MongoDB explicitly. Multiple gateway replicas, frontend management UI and durable audit storage remain unsupported by this work. Pre-existing user changes are excluded from the commit.
