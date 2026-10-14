# Threat model

Expand before submission: shared credentials, delegated tool authority, client tokens, malicious upstream tool metadata, SSRF, privilege escalation, member/member interactions and secrets exposure.

## Identity storage slice (#3)

Initial administrator enrollment is operator CLI-only and requires the configured bootstrap secret. Passwords and supplied secrets use hidden terminal input or mounted files, never literal command-line arguments. CLI and startup errors are fixed messages to avoid exposing driver URIs or parser inputs. Passwords use Argon2id (64 MiB, three passes, parallelism one), with at most two admitted jobs per process. Hashes are excluded from default queries, model serialization, and successful CLI output.

A permanent singleton and first administrator are committed together in a majority-write transaction. Repeated or competing enrollment cannot create another administrator, and deleting accounts or losing database connectivity cannot reopen enrollment. Recovery is intentionally a separate later operator action. MongoDB operator access remains a trust boundary: operators able to delete identity state can invalidate these guarantees.

Startup fails without usable indexes and transaction-capable persistence. Database outages fail new MCP requests and readiness safely while liveness remains process-only. There is no database-error fallback. Normal MCP bootstrap authentication is nevertheless still the previous shared credential mechanism; replacing it with per-request persisted API-key authentication belongs to the next ticket. Creating a user here does not enforce persistent-user access controls yet.

The Docker database is unauthenticated and bound to loopback for local development only. Full MongoDB Kubernetes isolation, credentials/TLS, backup/recovery operations, sessions, persistent MCP keys, and management endpoint security remain outside this ticket. Existing upstream authorization, tool execution, and console audit boundaries remain in place.
