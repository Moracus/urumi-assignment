# Chat deployment (#44)

Chat uses OpenAI Chat Completions at the fixed HTTPS destination
`api.openai.com:443`. There is no runtime endpoint override. Helm exposes
`gateway.chat.enabled`, `provider` (only `openai`), `model` (default
`gpt-4.1-mini-2025-04-14`), `secretName` and `secretKey`.
Both local and production values inherit disabled chat with no provider egress.
Model names are syntax-validated; operators must choose a model accessible to
their account that supports the implemented function-calling protocol and
`max_completion_tokens`. A syntactically valid but unavailable or incompatible
model fails safely at the provider, without replaying calls.

## Credentials and site configuration

Provision an existing Secret in the release namespace through your Secret
manager. For a protected file containing only the API key, an example is:

```bash
kubectl create secret generic urumi-chat-provider -n urumi \
  --from-file=api-key=/protected/openai-api-key
```

Keep that file outside the checkout with restricted permissions. Do not paste
keys into command arguments, chart values, logs or browser variables. Do not
print Secret YAML or use shell tracing. The kubelet injects the selected key
using `secretKeyRef`; this needs no new gateway Secret API permissions. Never
add the provider Secret to `gateway.secretReferences`: those approvals are for
upstream credentials, a separate purpose. The chart does not create a provider
Secret or expose its value in public configuration.

Merge this nonsecret example with the site's existing MongoDB, Kubernetes API,
DNS, destination and ingress approvals:

```yaml
gateway:
  chat:
    enabled: true
    provider: openai
    model: gpt-4.1-mini-2025-04-14
    secretName: urumi-chat-provider
    secretKey: api-key
networkPolicy:
  gatewayEgress:
    chatProvider:
      # Documentation-only address: replace with each approved provider IP.
      - cidr: 203.0.113.10/32
        ports: [443]
```

Each provider peer is one IPv4 `/32` or fully expanded IPv6 `/128`, with TCP 443
only. No subnet, wildcard, Pod selector or general proxy permission is accepted.
Enabled chat with enabled NetworkPolicies requires at least one explicit peer.
Keep `networkPolicy.enabled: true`. Approving provider traffic does not add an
MCP destination approval or alter existing approvals. Disabling chat removes
its provider rules even when the peer list remains in values.

Provider addresses can change and may have multiple A/AAAA records. Resolve
`api.openai.com` using the gateway's actual DNS path, review the resolved
addresses against the provider/site policy and approve every address the
runtime may use. A DNS lookup alone is not a trustworthy ownership approval.
Review address changes through the same site change process; remove obsolete
approvals. Standard NetworkPolicy has no FQDN matching or hostname/TLS-path
restriction: these rules permit any TLS service on the approved IP/port.
Shared CDN addresses retain this limitation. If IP pinning cannot meet site
requirements, use separately reviewed CNI-specific FQDN controls; never open
unrestricted egress to work around changing provider addresses. DNS UDP/TCP 53
must retain the site's exact resolver approvals. See [gateway egress](gateway-egress.md)
for CNI, NAT, policy union, DNS and IPv6 prerequisites.

## Configuration failures

Helm rejects unknown provider settings, malformed model names, empty enabled
Secret references, raw-key fields and broad/invalid network peers. A missing
Secret or missing Secret key prevents the Pod starting (`CreateContainerConfigError`);
it cannot preserve service on that new Pod. Pre-provision and verify the Secret
reference before rollout. The gateway has one replica and a Recreate strategy,
so an upgrade can interrupt service.

For host development, `OPENAI_API_KEY`, optional `CHAT_PROVIDER=openai` and
`CHAT_MODEL` select chat; absent provider/model settings use the defaults.
`CHAT_ENABLED=false` disables it; absent `CHAT_ENABLED` preserves the existing
key-driven host setup. Any other explicit enable value except `true`, unsupported
provider, malformed/empty model, or absent/blank/malformed key makes chat
unavailable (authenticated GET reports `available: false`, POST returns 503).
These process-level configuration failures leave management, readiness and MCP
usable. A syntactically valid rejected key, denied network connection or provider
failure instead fails a chat request safely; readiness does not call the provider.
No raw provider exception or credential is logged. Settings load at startup.

## Rollout and rollback

Build and publish a versioned gateway image containing this change using the
existing [deployment procedure](dashboard-deployment.md). No dashboard image
change is needed for provider configuration. Record the prior Helm revision,
image tag, site overlay and PVC identities. Keep existing Secret, storage,
ServiceAccount, MongoDB and upstream configuration in the overlay.

```bash
ruby infra/helm/urumi/test-chat.rb
ruby infra/helm/urumi/test-gateway-egress.rb
ruby infra/helm/urumi/test-secret-rbac.rb
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml -f /protected/site.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-local.yaml -f /protected/site.yaml
helm lint infra/helm/urumi -f infra/helm/urumi/values-prod.yaml -f /protected/site.yaml
helm template urumi infra/helm/urumi -n urumi -f infra/helm/urumi/values-prod.yaml -f /protected/site.yaml
helm history urumi -n urumi
helm upgrade --install urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml -f /protected/site.yaml \
  --set gateway.image.tag=REPLACE_VERSION
kubectl rollout status deployment/urumi-gateway -n urumi --timeout=120s
```

Use `values-prod.yaml` and the reviewed production site overlay for k3s. The
production hostnames are placeholders. Review rendered differences before
applying; preserve dashboard `/api`, gateway `/mcp`, storefront routes and PVCs.
Secret updates require a gateway restart because credentials are environment
variables: `kubectl rollout restart deployment/urumi-gateway -n urumi` followed
by rollout status. Never dump credentials to verify rotation.

To withdraw chat, set `gateway.chat.enabled=false` in the overlay and upgrade;
this removes both credential injection and dedicated provider egress. For an
image/configuration regression, run `helm rollback urumi REPLACE_REVISION -n urumi
--wait --timeout 120s` using the recorded revision, then repeat readiness and
connectivity checks. Helm rollback does not restore external Secret contents;
coordinate credential rollback/rotation through the Secret manager. Do not
reset MongoDB, replace the cluster, delete PVCs or replay uncertain writes.

## Required deployed checks

Rendered manifests and fixture tests do not establish live CNI enforcement.
After an operator deploys, record date, image, Helm revision, CNI/version, overlay
revision and actual results separately from automated regression evidence:

- Inspect Pods, Services, Ingresses, PVCs, policies and RBAC using the read-only
  commands in [gateway egress](gateway-egress.md#read-only-live-checks). Verify
  readiness and PVC identity/binding against the prior release.
- Verify allowed DNS resolution, provider TCP 443 and TLS access from the gateway
  Pod, plus existing MongoDB/API and internal MCP paths. Add each approved
  provider address as an allowed target in the existing egress verifier's
  `targets` list; retain the existing denied/control targets and Secret checks.
- Verify a listening unapproved external host on TCP 443 is blocked from the
  gateway while reachable from the control Pod. Check another listening port on
  an approved provider-address fixture is blocked where such a fixture is
  available. A closed port or absent listener is not proof of denial. Use CNI
  telemetry to attribute drops; do not make extra provider port approvals.
- Log in and make a read-only calculator/time chat request against the real
  configured provider. Confirm call outcomes/final answer and administrator
  history attribution. Never use automatic commerce mutation probes.
- Check authenticated external MCP discovery/calculator/time, read-only commerce,
  missing/invalid key rejection, dashboard management and storefront GET through
  their real Ingresses. Confirm no upstream public route was added.
- Exercise a disabled-chat rollout: GET availability false and POST 503 for an
  eligible session, while management/MCP remain usable. Restore the intended
  overlay if appropriate. Readiness alone does not verify provider access.

Any unexecuted live check remains outstanding. Follow the
[commerce walkthrough](commerce-chat-walkthrough.md) for separately authorized
live product/checkout demonstrations.
