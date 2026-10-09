# System design and tradeoffs

Draft on Day 3.

- Backend hosts dashboard REST API, MCP server endpoint, and agent orchestration.
- Gateway is the only MCP client permitted to call upstream services.
- WooCommerce MCP uses WooCommerce REST API.
- MongoDB stores users, hashed API keys, registry metadata and audit logs.
- MariaDB stores WordPress/WooCommerce data.
- Credentials entered via the dashboard require scoped Kubernetes Secret management.
- Define collision naming, timeouts and authentication before implementing routing.
