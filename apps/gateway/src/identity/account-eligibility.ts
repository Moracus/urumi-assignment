import type { StoredUser } from "./storage.js";

// Shared by dashboard management and later API-key/MCP authentication boundaries.
export function isUserEligibleForOrdinaryAccess(
  user: Pick<StoredUser, "status" | "requiredPasswordChange">,
): boolean {
  return user.status === "active" && !user.requiredPasswordChange;
}
