export type Role = "admin" | "member";

export interface AuthenticatedIdentity {
  userId: string;

  role: Role;

  keyId: string;
}