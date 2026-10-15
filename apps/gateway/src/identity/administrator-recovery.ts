import type { IdentityStorage } from "./storage.js";
import { withActiveAdministrator } from "./administrator-invariant.js";
import { hashPassword } from "./passwords.js";
import { safeUser } from "./safe-user.js";

export async function recoverAdministrator(storage: IdentityStorage, userId: string, password: string) {
  const passwordHash = await hashPassword(password);
  return withActiveAdministrator(storage, async (session) => {
    // Conflict with login, password replacement and key issuance on this user.
    const user = await storage.users.findByIdAndUpdate(userId, {
      $set: { role: "admin", status: "active", passwordHash, requiredPasswordChange: true },
      $inc: { credentialRevision: 1 },
    }, { session, returnDocument: "after" });
    if (!user) throw new Error("Recovery target not found");
    await storage.sessions.deleteMany({ userId: user._id }, { session });
    await storage.apiKeys.updateMany({ userId: user._id, revokedAt: null }, {
      $set: { revokedAt: new Date() },
    }, { session });
    return safeUser(user);
  });
}
