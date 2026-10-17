export type Role = "admin" | "member";

// Missing origin is the legacy bearer-key contract. Sessions explicitly have no key.
export type AuthenticatedIdentity = {
  userId: string;
  role: Role;
  userEmail?: string;
} & ({ authenticationOrigin?: "gateway_api_key"; keyId: string }
  | { authenticationOrigin: "dashboard_session"; keyId: null });
