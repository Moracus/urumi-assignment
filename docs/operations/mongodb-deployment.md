# MongoDB deployment (#34)

The chart supports an optional authenticated, persistent **single-node** MongoDB 8.0 replica set, or an operator-provided transaction-capable database. The managed deployment is **not highly available**. It does not provide TLS, backups, disaster recovery, or multi-node failover; use an appropriately operated external database when those are required. The gateway authentication, session/API-key separation, execution boundary and member permissions are unchanged.

## Credentials and initialization

Managed mode defaults off, preserving existing external deployments. Enable it explicitly with `--set mongodb.enabled=true` alongside local or production-like values. Never enable it over an existing external deployment without planning the data migration and URI change: the chart does not migrate data.

Pre-provision `mongodb.authSecretName` (default `urumi-mongodb-auth`) in the release namespace with keys `username`, `password`, and `keyfile`. Use protected files or your Secret manager, never literal passwords in shell history, committed values, Helm arguments, or logs. Generate the shared keyfile with `openssl rand -base64 756` into a protected file. For example, with three existing mode-0600 credential files:

```sh
kubectl create secret generic urumi-mongodb-auth -n urumi \
  --from-file=username=/secure/mongodb-username \
  --from-file=password=/secure/mongodb-password \
  --from-file=keyfile=/secure/mongodb-keyfile
```

The official image creates the initial administrator on an empty `/data/db`. An init container copies the membership key from its read-only Secret to a memory volume, owned by `mongodb` with mode 0400. The main process starts with authentication, membership authentication, and replica-set name `urumi`. A bounded post-start hook waits for authenticated access, initializes only a previously uninitialized replica set, and validates existing configuration on restart. It never forces reconfiguration or resets users/data. Authenticated startup/readiness require a writable primary; liveness checks a database ping. Credentials are read from environment in mongosh, rather than command arguments; probe and initialization output is suppressed.

The replica member advertises `urumi-mongodb-0.urumi-mongodb.<namespace>.svc:27017`. A headless, internal-only Service publishes the stable address before readiness for initialization. There is no MongoDB Ingress or host port.

After initial administrator creation, provision a separate gateway database user with `readWrite` on the gateway's database, using authenticated mongosh and protected operator input. Do not use the database root account as the application's permanent identity. Store its percent-encoded connection URI in a protected file, for example the shape below (placeholders only):

```text
mongodb://<encoded-user>:<encoded-password>@urumi-mongodb-0.urumi-mongodb.urumi.svc:27017/urumi?authSource=urumi&replicaSet=urumi
```

Create the existing gateway URI Secret from that file:

```sh
kubectl create secret generic urumi-identity-storage -n urumi \
  --from-file=uri=/secure/gateway-mongodb-uri
```

`gateway.mongodbSecretName` remains the Secret name, with required key `uri`, for **both modes**. No URI enters values or frontend assets. Initial database administrator credentials are not rotated by changing the initialization Secret on an existing PVC: update MongoDB users deliberately, update dependent Secrets, and restart consumers. Keep credentials and keyfile available for recovery. Avoid casually changing the replica-set identity, namespace, or advertised Service name of an existing data volume.

## Storage, network, and external mode

The StatefulSet requests `mongodb.storage.size` (default 5Gi), using `global.storageClassName` (local: `standard`; production-like: `local-path`). The claim is `data-urumi-mongodb-0`, mounted at `/data/db`. Claims are retained on scale-down and deletion. Do not delete the claim or namespace during restart verification. Storage class and provisioner must exist; PVC expansion requires storage-provider support and an operator-managed procedure. WordPress and MariaDB templates, claims, data and signing configuration are untouched.

With NetworkPolicies enabled, MongoDB ingress permits only same-namespace Pods labelled `app: urumi-gateway` on TCP 27017. Managed mode adds only that MongoDB Pod/port pair to existing gateway egress. DNS and bundled upstream rules remain in place. Other Pods cannot reach MongoDB under an enforcing CNI. Labels and namespace administration remain trusted; authentication protects the database independently. Existing named-Secret, get-only gateway RBAC is unchanged; MongoDB credentials are mounted by Kubernetes, not read through gateway API permissions.

For an external database leave `mongodb.enabled=false`, supply the URI Secret, and configure **every** replica-set destination in `networkPolicy.gatewayEgress.mongodb`. Include your DNS/API site approvals as described in [gateway egress](gateway-egress.md). Managed mode does not require external database peer approvals. Both modes require a transaction-capable replica set or sharded database; gateway startup performs its existing real transaction check.

```sh
helm lint infra/helm/urumi -f infra/helm/urumi/values-local.yaml --set mongodb.enabled=true
helm template urumi infra/helm/urumi -n urumi \
  -f infra/helm/urumi/values-local.yaml --set mongodb.enabled=true
helm upgrade --install urumi infra/helm/urumi -n urumi --create-namespace \
  -f infra/helm/urumi/values-local.yaml -f /secure/site-values.yaml \
  --set mongodb.enabled=true
```

Use `values-prod.yaml` for production-like lint/render as well. Its hostnames remain placeholders; one-node MongoDB and passing Helm lint are not production-readiness evidence. Gateway restarts may be needed to retry initial startup while a new database becomes ready.

## Non-destructive live verification

First inspect the target context and namespace. Run these commands only in an approved test deployment. The verifier writes only fixed markers in the separate `urumi_deployment_verification` database using the database administrator already injected into the MongoDB Pod. It checks a majority-committed transaction before and after **Pod** deletion; it never deletes database data or PVCs.

```sh
kubectl config current-context
kubectl get pods,svc,pvc,networkpolicy -n urumi
kubectl rollout status statefulset/urumi-mongodb -n urumi --timeout=300s
kubectl exec -i -n urumi urumi-mongodb-0 -- \
  env URUMI_VERIFY_PHASE=seed mongosh --quiet --file /dev/stdin \
  < infra/mongodb/verify-persistence.js
kubectl get pvc data-urumi-mongodb-0 -n urumi -o jsonpath='{.metadata.uid}'
kubectl delete pod urumi-mongodb-0 -n urumi
kubectl rollout status statefulset/urumi-mongodb -n urumi --timeout=300s
kubectl exec -i -n urumi urumi-mongodb-0 -- \
  env URUMI_VERIFY_PHASE=restore mongosh --quiet --file /dev/stdin \
  < infra/mongodb/verify-persistence.js
kubectl get pvc data-urumi-mongodb-0 -n urumi -o jsonpath='{.metadata.uid}'
```

Confirm the PVC UID is unchanged. Check gateway readiness and existing authenticated identity workflows separately; this storage check alone does not prove gateway integration. On a policy-enforcing cluster, test TCP 27017 from the gateway Pod (allowed) and a controlled Pod without its label (denied), test unauthenticated database reads (denied), and verify no database Ingress/NodePort. See [network verifier](gateway-egress.md) for policy/CNI limitations. Kind's default networking is not evidence of enforced NetworkPolicies.

Automated rendered checks: `ruby infra/helm/urumi/test-mongodb.rb`, plus existing `test-secret-rbac.rb` and `test-gateway-egress.rb`. Live results for this implementation are recorded in issue 34 validation (historical evidence file is not included in this checkout); do not treat these instructions as executed checks.
