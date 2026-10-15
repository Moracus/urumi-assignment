import type { IdentityStorage, StoredUser } from "./storage.js";
import { withActiveAdministrator } from "./administrator-invariant.js";
import { DashboardAuthError } from "./dashboard-sessions.js";
import { safeUser } from "./safe-user.js";

export async function changeUserRole(storage: IdentityStorage, userId: string, role: StoredUser["role"]) {
  return withActiveAdministrator(storage, async (session) => {
    const user = await storage.users.findByIdAndUpdate(userId,
      { $set: { role } }, { session, returnDocument: "after" });
    if (!user) throw new DashboardAuthError(404, "User not found");
    return safeUser(user);
  });
}
