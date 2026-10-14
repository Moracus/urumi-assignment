# Persistent identity storage and initial administrator setup (#3)

This ticket implements storage, passwords, one-time CLI enrollment, and database health. It does not implement login, sessions, persistent MCP keys, account management, operator recovery, dashboard UI, dynamic upstream persistence, or durable audits. Normal MCP requests still use `GATEWAY_BOOTSTRAP_KEY` and the bootstrap identity until the persistent MCP authentication ticket replaces them. Creating an administrator does not yet make that account usable for MCP or dashboard login. This is an incremental development slice, not a production completion claim.

## Local replica set

Use Node.js **24.7 or newer** (built-in asynchronous Argon2) and the pinned pnpm version. Docker Compose provisions an unauthenticated, loopback-only single-node MongoDB 8.0 replica set for local development:

```bash
docker compose -p urumi-identity -f infra/mongodb/compose.yaml up -d --wait
export MONGODB_URI='mongodb://127.0.0.1:27017/urumi?replicaSet=urumi&directConnection=true'
pnpm install --frozen-lockfile
pnpm --filter @urumi/gateway build
```

The healthcheck initializes the replica set and waits for a writable primary. `directConnection=true` lets the host reach this single-node set despite its container-side advertised address; use a properly reachable replica-set connection string for deployments. Data persists in the Compose project volume. Shut down with the following command, which preserves that volume:

```bash
docker compose -p urumi-identity -f infra/mongodb/compose.yaml down
```

Do not expose this development database remotely. Shared or deployed databases require authentication, transport security, backups, and appropriate network isolation; those are not supplied by this local recipe.

## First administrator

Setup is CLI-only. There is no HTTP enrollment route. Configure `GATEWAY_BOOTSTRAP_KEY` through the existing secret mechanism, or set `GATEWAY_BOOTSTRAP_KEY_FILE` to an operator-provided file for CLI setup. The file setting takes precedence in the CLI; it does not change existing MCP authentication.

Interactive setup accepts only the email on the command line and reads the supplied bootstrap secret and final password using hidden terminal prompts:

```bash
pnpm --filter @urumi/gateway setup-admin --email admin@example.com
```

For mounted secret files, point the CLI at existing operator-managed files (the paths below are examples, not committed credentials):

```bash
export GATEWAY_BOOTSTRAP_KEY_FILE=/run/secrets/configured-bootstrap
pnpm --filter @urumi/gateway setup-admin --email admin@example.com \
  --bootstrap-secret-file /run/secrets/supplied-bootstrap \
  --password-file /run/secrets/admin-password
```

Use restrictive permissions for these files. File input is limited to 4096 bytes; one final LF or CRLF is removed, and other whitespace is preserved. Secret values and passwords are never accepted as CLI arguments or emitted in output. Unknown flags and positional arguments fail without echoing their values. A noninteractive invocation requires mounted files.

Passwords accept 12–128 Unicode code points, with no composition rules or normalization/truncation. Argon2id uses a random 16-byte salt, a 32-byte tag, 64 MiB memory, three passes, and parallelism one, encoded in PHC format. A process admits at most two simultaneous hashing/verification jobs (128 MiB algorithm memory), rejecting excess work rather than queuing it without bounds. This limit is per process, not a fleet-wide admission policy. Node's built-in Argon2 API is experimental.

Successful setup returns safe user JSON: canonical ObjectId string `id`, normalized email, role `admin`, status `active`, `requiredPasswordChange: false`, and timestamps. Password hashes are excluded from default model queries and document serialization and are never included in CLI responses. Emails are trimmed and lowercased and have a unique index. Future administrator-created members and resets will require password replacement; the first administrator chooses their final password here.

The `initial_setup` singleton is permanently consumed in the same majority-write transaction that creates the administrator. Competing setup processes can create only one initial administrator. Repetition, deleted/disabled administrators, and connectivity errors do not reset that state. Do not delete the marker to recover access; operator recovery is a separate later ticket. A failed transaction rolls back both user creation and consumption. If a connection fails during commit, the CLI can report failure after MongoDB committed; inspect the setup marker through authorized database administration before any recovery action. Retrying setup cannot create another initial administrator.

## Startup, runtime health, and shutdown

`MONGODB_URI` is required. Startup opens an independent Mongoose connection, disables buffering, creates required collections/indexes, validates the unique normalized-email index, and commits an actual transactional probe. Standalone MongoDB, conflicting indexes, duplicate legacy emails, unavailable storage, or insufficient database privileges prevent serving. The database account must be able to create collections/indexes and perform transactional reads/writes. Startup emits only a fixed safe error, never a raw URI or driver exception.

Errors include a safe failure stage (configuration, connection, collections, indexes, transactions, setup-transaction, or shutdown) without raw database exceptions or input values. Connection error events emit a fixed diagnostic. Use the stage to distinguish topology, permission/index, and connectivity problems; inspect the database through authorized operator tooling for further detail.

Connection and server-selection timeouts are two seconds; socket inactivity and ordinary operation deadlines are five seconds. Transaction callbacks and retries share a five-second deadline, with a two-second commit limit. Readiness actively pings storage with a two-second deadline and still requires at least one connected upstream. A database outage produces HTTP 503 readiness and `503 {"error":"Authentication unavailable"}` on new MCP requests; liveness remains process-only. Driver reconnection restores readiness without restarting the gateway. Already admitted operations need not be canceled. Application close and process signal shutdown release identity storage alongside MCP and upstream resources.

## Real-database tests

```bash
pnpm typecheck
pnpm build
pnpm --filter @urumi/gateway test:integration
```

The integration runner provisions separate ephemeral databases on loopback ports 27417 (replica set) and 27418 (standalone), runs compiled gateway tests, and removes its containers on exit. It uses the reserved Compose project `urumi-identity-integration`; do not reuse that project for application data. Test files run serially because the outage test stops and restarts the test replica container. CLI concurrency is exercised by independent processes within one test. Tests use unique database names and drop only those databases. Existing MCP SDK, execution, authorization, discovery, schema, and audit tests are included. No Kubernetes or WooCommerce instance is needed.

To run selected compiled files manually, provide `MONGODB_TEST_URI`; persistence tests also require `MONGODB_STANDALONE_TEST_URI` and `MONGODB_TEST_CONTAINER` pointing to the isolated disposable replica container. Never point the outage test at an application database.

## Kubernetes limitation

The gateway Deployment reads `MONGODB_URI` from key `uri` in the Secret selected by `gateway.mongodbSecretName` (default `urumi-identity-storage`). Supply the URI through your secret-management workflow; never put it in committed Helm values. Existing bootstrap Secret wiring is unchanged. Local and production values inherit the same Secret reference.

The chart does **not** provision MongoDB, identity PVCs, database access policies, authentication/TLS, or replica-set topology. Existing installations cannot run this gateway image without a usable replica set and URI Secret. Arrange those dependencies before upgrading the gateway; full Kubernetes rollout and connectivity verification remain later work. No cluster workloads or network-policy enforcement were verified for this ticket.
