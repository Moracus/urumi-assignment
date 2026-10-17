# Urumi Gateway Identity

Urumi distinguishes the people authorized to use the gateway from the credentials they use to access it.

## Language

**User**:
A person with an account in Urumi and an assigned gateway role. Disabling a user withdraws their access; re-enabling permits them to obtain fresh credentials.
_Avoid_: Principal, team, customer

**Administrator**:
A user authorized to manage other users and their gateway API keys. Administrators have equal authority, and at least one must remain active.
_Avoid_: Superuser, owner

**Member**:
A user authorized to manage their own gateway API keys and use the tools permitted to their role.
_Avoid_: Guest, customer

**Gateway API key**:
A revocable credential belonging to one user that permits an external MCP client to act as that user.
_Avoid_: Dashboard session, bootstrap key

**Dashboard session**:
A revocable login granting one user access to the dashboard management interface. Ending a dashboard session does not revoke that user's gateway API keys.
_Avoid_: MCP session, gateway API key

**Initial administrator setup**:
The one-time establishment of Urumi's first administrator. Administrator recovery is a separate operator action after initial setup has been consumed.
_Avoid_: Bootstrap authentication, automatic recovery
