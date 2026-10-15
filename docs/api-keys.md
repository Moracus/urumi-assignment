# Gateway API keys (#7–#9)

Eligible members and administrators can issue, list, and revoke their own keys using a dashboard session. All operations derive ownership from the authenticated session; bearer credentials cannot authenticate these endpoints. Disabled users receive `401 Unauthorized`; users awaiting password replacement receive `403 Password change required`. Complete [password replacement and fresh login](dashboard-sessions.md#replace-a-password) first when required.

Keys now authenticate external clients at `/mcp` with current eligibility and roles checked on every request; successful authentication advances `lastUsedAt`. See [read-only MCP requests and revocation](mcp-authentication.md). Administrators can also manage other users' keys through the endpoints below. [Account disabling](dashboard-sessions.md#disable-and-re-enable-users-11) permanently revokes existing keys; re-enabling requires new keys. The React dashboard belongs to a later ticket. The chart exposes only `/mcp`; use direct local access for `/api` until the public API rollout is implemented.

| Endpoint | Request | Successful response |
| --- | --- | --- |
| `POST /api/keys` | JSON `{}` or `{ "name": "Local client" }`, trusted Origin, session-bound `X-CSRF-Token` | `201 { "key": safe metadata, "rawKey": "<shown-once>" }` |
| `GET /api/keys?page=1&limit=20` | Dashboard cookie; defaults page 1 and limit 20 | `200 { "keys": [safe metadata], "page": 1, "limit": 20 }` |
| `DELETE /api/keys/:keyId` | Dashboard cookie, trusted Origin, session-bound `X-CSRF-Token`; no body or `{}` | `204` |

Every response uses `Cache-Control: no-store`. Creation accepts an optional string name of at most 100 UTF-16 code units, without trimming; omitted names are `null` in metadata. Only documented fields are accepted. Unknown mutation query/body fields, invalid names, and invalid pagination return `400 Invalid request`; JSON parsing, content type, and 4096-byte limits produce safe `400`/`415`/`413` responses. Mutations require the exact configured trusted Origin and this session's CSRF token; failures return `403 Forbidden`.

Lists include active and revoked records, sorted by key ID ascending. `limit` accepts 1–100 and `page` accepts 1–2147483647; unknown, repeated, non-integer, and out-of-range query fields are rejected. Pages past the end are empty. Offset pagination is not a snapshot across concurrent changes.

Safe metadata has exactly these fields (illustrative values):

```json
{
  "id": "000000000000000000000001",
  "prefix": "<display-prefix>",
  "name": "Local client",
  "createdAt": "2026-10-14T12:00:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null
}
```

The raw credential is `ugw_` followed by base64url encoding of 32 `crypto.randomBytes()` bytes. Only the SHA-256 digest of the complete credential is stored in `api_keys`, alongside its owner ID and metadata. The display prefix is the first 12 characters, containing eight random characters after `ugw_`. Neither raw credentials nor hashes appear in lists or revocation responses or application logs. Hashes are excluded from default model queries and serialization. Startup creates a unique hash index and an owner/ID index. Keys have no automatic expiration or TTL index.

At most 20 active keys may belong to a user. Issuance writes the eligible user and counts/inserts keys within a MongoDB transaction, coordinating requests across gateway instances and with credential-invalidating account changes. Exceeding the limit returns `409 Active key limit reached`. Revocation preserves the record and its first revocation timestamp, is idempotent, and frees an active slot. Missing, malformed, or other users' key IDs return the same `404 Key not found`, including for administrators using these self-service routes.

## Requests

Follow [dashboard login and current-user examples](dashboard-sessions.md#http-examples) to create the private `session_dir`, cookie jar, and `me.json`. Use the same trusted local origin, or replace URLs and Origin together with your configured HTTPS origin. Treat both the cookie jar and creation response as secrets.

```bash
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -H 'Content-Type: application/json' \
  --data-binary '{"name":"Local client"}' http://localhost:3000/api/keys \
  > "$session_dir/created-key.json"

curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" 'http://localhost:3000/api/keys?page=1&limit=20'

key_id=$(jq -r '.key.id' "$session_dir/created-key.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -X DELETE "http://localhost:3000/api/keys/$key_id"
unset csrf_token key_id
rm "$session_dir/created-key.json"
```

The creation response is the only disclosure of `rawKey`; retain it privately if needed before deleting the response file. Never put raw keys into shell history, logs, browser localStorage, or source control. Losing it requires revoking the record and issuing a replacement. Logout ends only the dashboard session; ordinary password changes preserve keys.

Database failures return safe `503 Authentication unavailable` with no credential fallback. A commit-time connection failure may leave a key issued despite a failed response, making the raw key unavailable. List metadata and revoke that record before issuing a replacement; issuance is not automatically retried by the HTTP layer.

## Administrator assistance (#9)

An eligible administrator dashboard session can list, issue, and revoke keys belonging to another user. The backend resolves the administrator's current role and eligibility on every request; member sessions and bearer keys cannot access these routes. POST and DELETE require the administrator session's trusted Origin and CSRF token.

| Endpoint | Successful response |
| --- | --- |
| `GET /api/admin/users/:userId/keys?page=1&limit=20` | `200 { "keys": [safe metadata], "page": 1, "limit": 20 }` |
| `POST /api/admin/users/:userId/keys` | `201 { "key": safe metadata, "rawKey": "<shown-once>" }` |
| `DELETE /api/admin/users/:userId/keys/:keyId` | `204` |

These routes share personal key name/input bounds, pagination (maximum 100), safe metadata, no-store responses, one-time raw disclosure, and transactional 20-active-key limit. Concurrent personal and administrator issuance share the same owner limit across gateway instances. The key belongs to the route user, rather than the administrator issuing it. Issuance to a disabled owner or one awaiting password replacement returns `403 Forbidden`. Listing and revocation remain available to eligible administrators for those owners. Malformed or missing user IDs return `404 User not found`; missing, malformed, or mismatched key IDs for an existing route user return `404 Key not found` without changing another user's key. Repeated revocation preserves the original timestamp and record.

Log in as an administrator using the earlier session instructions. Select the target ID from the [administrator user list](dashboard-sessions.md#create-and-inspect-members-6); the example ID below is a placeholder. Keep the creation response private and share its raw key only through your intended secure channel.

```bash
user_id='000000000000000000000001'
csrf_token=$(jq -r '.csrfToken' "$session_dir/me.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  "http://localhost:3000/api/admin/users/$user_id/keys?page=1&limit=20"

curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -H 'Content-Type: application/json' --data-binary '{"name":"Assisted client"}' \
  "http://localhost:3000/api/admin/users/$user_id/keys" \
  > "$session_dir/admin-created-key.json"

key_id=$(jq -r '.key.id' "$session_dir/admin-created-key.json")
curl --fail-with-body --silent --show-error \
  -b "$session_dir/cookies" \
  -H 'Origin: http://localhost:3000' -H "X-CSRF-Token: $csrf_token" \
  -X DELETE "http://localhost:3000/api/admin/users/$user_id/keys/$key_id"
unset csrf_token user_id key_id
rm "$session_dir/admin-created-key.json"
```

## Validation and deployment

Run `pnpm typecheck`, `pnpm build`, and `pnpm --filter @urumi/gateway test:integration`. The integration runner includes real replica-set HTTP tests for disclosure/storage/log safety, ownership, eligibility, CSRF, strict inputs, pagination, idempotence, concurrent issuance, and outages. No dependencies, environment variables, Helm resources, or public routes change. Restart the gateway with its existing transaction-capable MongoDB configuration; startup creates the key collection/indexes. Full Kubernetes/API routing remains unimplemented.
