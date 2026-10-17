# Require MongoDB transaction support

Urumi requires a MongoDB replica set, including a single-node replica set locally, so initial setup, administrator changes, and credential invalidation can be coordinated transactionally. This deliberately adds a deployment requirement instead of relying on standalone MongoDB and best-effort multi-record updates; concurrent operations must preserve one-time setup, the last active administrator, and account access rules.
