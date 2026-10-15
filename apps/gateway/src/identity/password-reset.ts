import { identityTransactionOptions, type IdentityStorage } from "./storage.js";
import { hashPassword } from "./passwords.js";
import { DashboardAuthError } from "./dashboard-sessions.js";

export async function resetUserPassword(storage: IdentityStorage, userId: string, password: string) {
  const passwordHash = await hashPassword(password);
  await storage.connection.transaction(async (session) => {
    // Serialize with login, password replacement, and key issuance on this user.
    const user = await storage.users.findByIdAndUpdate(userId, {
      $set: { passwordHash, requiredPasswordChange: true }, $inc: { credentialRevision: 1 },
    }, { session, returnDocument: "after" });
    if (!user) throw new DashboardAuthError(404, "User not found");
    await storage.sessions.deleteMany({ userId: user._id }, { session });
  }, identityTransactionOptions);
}
