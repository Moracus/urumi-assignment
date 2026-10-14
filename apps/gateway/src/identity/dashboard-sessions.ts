import { createHash, randomBytes } from "node:crypto";
import type { HydratedDocument } from "mongoose";
import { identityTransactionOptions, type IdentityStorage, type StoredUser } from "./storage.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { reserveLoginAttempt } from "./login-throttle.js";

export class DashboardAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const dashboardSessionLifetimeSeconds = 8 * 60 * 60;
const credentialHash = (credential: string) => createHash("sha256").update(credential).digest("hex");
const csrfToken = (credential: string) => createHash("sha256").update("urumi-dashboard-csrf:").update(credential).digest("hex");

export async function createDashboardSessions(storage: IdentityStorage) {
  // Unknown identifiers incur the same bounded Argon2 work as known accounts.
  const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
  function safeUser(user: HydratedDocument<StoredUser>) {
    return {
      id: user._id.toHexString(), email: user.email, role: user.role, status: user.status,
      requiredPasswordChange: user.requiredPasswordChange, createdAt: user.createdAt, updatedAt: user.updatedAt,
    };
  }
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
    async authenticate(credential: string | undefined) {
      if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential)) {
        throw new DashboardAuthError(401, "Unauthorized");
      }
      const session = await storage.sessions.findOne({ credentialHash: credentialHash(credential), expiresAt: { $gt: new Date() } });
      const user = session ? await storage.users.findById(session.userId) : null;
      if (!user || user.status !== "active") throw new DashboardAuthError(401, "Unauthorized");
      return { user: safeUser(user), csrfToken: csrfToken(credential) };
    },
    async logout(credential: string) {
      await storage.sessions.deleteOne({ credentialHash: credentialHash(credential) });
    },
  };
}
