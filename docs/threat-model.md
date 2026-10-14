# Threat model

Expand before submission: shared credentials, delegated tool authority, client tokens, malicious upstream tool metadata, SSRF, privilege escalation, member/member interactions and secrets exposure.

## Identity storage slice (#3)

Initial administrator enrollment is operator CLI-only and requires the configured bootstrap secret. Passwords and supplied secrets use hidden terminal input or mounted files, never literal command-line arguments. CLI and startup errors are fixed messages to avoid exposing driver URIs or parser inputs. Passwords use Argon2id (64 MiB, three passes, parallelism one), with at most two admitted jobs per process. Hashes are excluded from default queries, model serialization, and successful CLI output.

A permanent singleton and first administrator are committed together in a majority-write transaction. Repeated or competing enrollment cannot create another administrator, and deleting accounts or losing database connectivity cannot reopen enrollment. Recovery is intentionally a separate later operator action. MongoDB operator access remains a trust boundary: operators able to delete identity state can invalidate these guarantees.

Startup fails without usable indexes and transaction-capable persistence. Database outages fail new MCP requests and readiness safely while liveness remains process-only. There is no database-error fallback. Normal MCP bootstrap authentication is nevertheless still the previous shared credential mechanism; replacing it with per-request persisted API-key authentication belongs to the next ticket. Creating a user here does not enforce persistent-user access controls yet.

The Docker database is unauthenticated and bound to loopback for local development only. Full MongoDB Kubernetes isolation, credentials/TLS, backup/recovery operations, sessions, persistent MCP keys, and management endpoint security remain outside this ticket. Existing upstream authorization, tool execution, and console audit boundaries remain in place.

## Dashboard session slice (#4)

Dashboard authentication is separate from MCP bearer authentication. Random 32-byte opaque credentials are stored only as SHA-256 digests, with fixed eight-hour authentication expiry and independent device sessions. HttpOnly host-only cookies use Path=/api, SameSite=Lax, explicit expiry, and Secure except in explicit development HTTP mode; production rejects that setting. Secure mode checks actual TLS or a configured proxy's exact HTTPS assertion. Trusted Origins are exact scheme/host/port matches. Login requires trusted Origin and strict JSON, while logout additionally requires a session-bound CSRF token and revokes only that session. Auth responses are non-cacheable and omit credential/password hashes.

Persistent rolling 15-minute throttles limit five failed account attempts and 30 source-IP attempts, coordinated transactionally across replicas. Unknown users incur Argon2 verification, and credential failures remain generic. Forwarded IPs influence throttling only through explicitly trusted socket peers and right-to-left trusted proxy chains; malformed chains use the socket peer. Configured TLS edges must overwrite forwarded scheme headers. Hashing concurrency remains bounded; interrupted login reservations conservatively count until window expiry.

New dashboard requests fail safely during database outages and recover without credential fallback or session renewal. Future disable/password-change transactions must update the user and invalidate sessions; direct database edits are privileged and are not the account-management workflow. User/key management, durable audits, full Kubernetes/API ingress rollout, and broader traffic limits remain later work. See [dashboard configuration and safe examples](dashboard-sessions.md).
