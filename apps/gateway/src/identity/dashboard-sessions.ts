import { createHash, randomBytes } from "node:crypto";
import { identityTransactionOptions, type IdentityStorage } from "./storage.js";
import { safeUser } from "./safe-user.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { reserveLoginAttempt } from "./login-throttle.js";
import { isUserEligibleForOrdinaryAccess } from "./account-eligibility.js";

export class DashboardAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const dashboardSessionLifetimeSeconds = 8 * 60 * 60;
const credentialHash = (credential: string) => createHash("sha256").update(credential).digest("hex");
const csrfToken = (credential: string) => createHash("sha256").update("urumi-dashboard-csrf:").update(credential).digest("hex");

export async function createDashboardSessions(storage: IdentityStorage) {
  // Unknown identifiers incur the same bounded Argon2 work as known accounts.
  const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
  return {
    async login(email: string, password: string, ip: string) {
      const attempt = await reserveLoginAttempt(storage, email, ip);
      if (!attempt.allowed) throw new DashboardAuthError(429, "Too many attempts");
      const user = await storage.users.findOne({ email }).select("+passwordHash");
      const matches = await verifyPassword(password, user?.passwordHash ?? dummyHash);
      if (!user || !matches || user.status !== "active") {
        throw new DashboardAuthError(401, "Invalid credentials");
      }
      const credential = randomBytes(32).toString("base64url");
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + dashboardSessionLifetimeSeconds * 1000);
      const currentUser = await storage.connection.transaction(async (session) => {
        // A write conflicts with concurrent password/status changes and their invalidation transaction.
        const current = await storage.users.findOneAndUpdate({
          _id: user._id, status: "active", passwordHash: user.passwordHash,
        }, { $inc: { credentialRevision: 1 } }, { session, returnDocument: "after", timestamps: false });
        if (!current) throw new DashboardAuthError(401, "Invalid credentials");
        await storage.sessions.create([{
          userId: user._id, credentialHash: credentialHash(credential), createdAt, expiresAt,
        }], { session });
        // Successful credentials are not account failures; IP limits count every attempt.
        await storage.loginThrottles.updateOne({ _id: attempt.accountId }, {
          $pull: { attempts: { id: attempt.id } },
        }, { session });
        return safeUser(current);
      }, identityTransactionOptions);
      return { credential, expiresAt, user: currentUser, csrfToken: csrfToken(credential) };
    },
    async authenticate(credential: string | undefined, options: { allowRequiredPasswordChange?: boolean } = {}) {
      if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential)) {
        throw new DashboardAuthError(401, "Unauthorized");
      }
      const session = await storage.sessions.findOne({ credentialHash: credentialHash(credential), expiresAt: { $gt: new Date() } });
      const user = session ? await storage.users.findById(session.userId) : null;
      if (!user || user.status !== "active") throw new DashboardAuthError(401, "Unauthorized");
      if (!options.allowRequiredPasswordChange && !isUserEligibleForOrdinaryAccess(user)) {
        throw new DashboardAuthError(403, "Password change required");
      }
      return { user: safeUser(user), csrfToken: csrfToken(credential) };
    },
    async logout(credential: string) {
      await storage.sessions.deleteOne({ credentialHash: credentialHash(credential) });
    },
    async changePassword(credential: string, currentPassword: string, newPassword: string) {
      const dashboardSession = await storage.sessions.findOne({
        credentialHash: credentialHash(credential), expiresAt: { $gt: new Date() },
      });
      const user = dashboardSession ? await storage.users.findById(dashboardSession.userId).select("+passwordHash") : null;
      if (!user || user.status !== "active") throw new DashboardAuthError(401, "Unauthorized");
      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new DashboardAuthError(400, "Current password is incorrect");
      }
      if (currentPassword === newPassword) throw new DashboardAuthError(400, "New password must be different");
      const passwordHash = await hashPassword(newPassword);
      await storage.connection.transaction(async (session) => {
        const validSession = await storage.sessions.exists({
          credentialHash: credentialHash(credential), userId: user._id, expiresAt: { $gt: new Date() },
        }).session(session);
        if (!validSession) throw new DashboardAuthError(401, "Unauthorized");
        const updated = await storage.users.updateOne({
          _id: user._id, status: "active", passwordHash: user.passwordHash,
        }, {
          $set: { passwordHash, requiredPasswordChange: false }, $inc: { credentialRevision: 1 },
        }, { session });
        if (updated.matchedCount !== 1) throw new DashboardAuthError(401, "Unauthorized");
        await storage.sessions.deleteMany({ userId: user._id }, { session });
      }, identityTransactionOptions);
    },
  };
}
