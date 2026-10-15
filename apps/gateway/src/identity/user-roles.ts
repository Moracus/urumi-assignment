import type { IdentityStorage, StoredUser } from "./storage.js";
import { withActiveAdministrator } from "./administrator-invariant.js";
import { DashboardAuthError } from "./dashboard-sessions.js";
import { safeUser } from "./safe-user.js";

export interface UserAccessChanges {
  role?: StoredUser["role"];
  status?: StoredUser["status"];
}

export async function changeUserAccess(storage: IdentityStorage, userId: string, changes: UserAccessChanges) {
  return withActiveAdministrator(storage, async (session) => {
    const user = await storage.users.findByIdAndUpdate(userId,
      { $set: changes, $inc: { credentialRevision: 1 } }, { session, returnDocument: "after" });
    if (!user) throw new DashboardAuthError(404, "User not found");
    if (changes.status === "disabled") {
      // The user write conflicts with login and both routes' key issuance.
      // Invalidation and the administrator invariant commit or roll back together.
      await storage.sessions.deleteMany({ userId: user._id }, { session });
      await storage.apiKeys.updateMany({ userId: user._id, revokedAt: null }, {
        $set: { revokedAt: new Date() },
      }, { session });
    }
    return safeUser(user);
  });
}
