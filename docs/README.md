# Documentation

| Folder | Contents |
| --- | --- |
| [setup](setup/local-development.md) | Complete host, Docker, Kind and Kubernetes local setup; root environment configuration |
| [architecture](architecture/systemdesign.md) | System design and [threat model](architecture/threat-model.md) |
| [guides](guides/identity-setup.md) | Identity, [sessions](guides/dashboard-sessions.md), [keys](guides/api-keys.md), [MCP authentication](guides/mcp-authentication.md), [upstream management](guides/upstream-registrations.md), [browser workflow](guides/browser-to-mcp-workflow.md) |
| [operations](operations/dashboard-deployment.md) | Dashboard and [MongoDB deployment](operations/mongodb-deployment.md), [egress](operations/gateway-egress.md), [destination approvals](operations/upstream-destinations.md), [upstream credentials](operations/upstream-credentials.md), [operator demo](operations/phase1-operator-demo.md) |
| [adr](adr/) | Recorded architecture decisions |
| [planning](planning/milestone-handoff.md) | Milestone handoff and historical Day 4 briefs |

[Project overview](../README.md) · [Domain glossary](../GLOSSARY.md)

Run commands from the repository root unless a guide explicitly says otherwise.
Historical briefs describe work at a point in time; use implementation guides for
current behavior. Some historical issue validation records are not present in
this checkout and are not evidence of a newly verified deployment.

- [Durable tool history and administrator browsing](guides/tool-history.md)
