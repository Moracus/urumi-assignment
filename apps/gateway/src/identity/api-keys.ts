import { createHash, randomBytes } from "node:crypto";
import type { HydratedDocument } from "mongoose";
import { identityTransactionOptions, type IdentityStorage, type StoredApiKey } from "./storage.js";
import { DashboardAuthError } from "./dashboard-sessions.js";
import { isUserEligibleForOrdinaryAccess } from "./account-eligibility.js";

export function safeApiKey(key: HydratedDocument<StoredApiKey>) {
  return {
    id: key._id.toHexString(), prefix: key.prefix, name: key.name,
    createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, revokedAt: key.revokedAt,
  };
}

export async function issueApiKey(storage: IdentityStorage, userId: string, name?: string) {
  const rawKey = `ugw_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const key = await storage.connection.transaction(async (session) => {
    // Serialize credential issuance with other issuance and account invalidation.
    const user = await storage.users.findOneAndUpdate({
      _id: userId, status: "active", requiredPasswordChange: false,
    }, { $inc: { credentialRevision: 1 } }, { session, returnDocument: "after", timestamps: false });
    if (!user || !isUserEligibleForOrdinaryAccess(user)) throw new DashboardAuthError(403, "Forbidden");
    const activeKeys = await storage.apiKeys.countDocuments({ userId: user._id, revokedAt: null }).session(session);
    if (activeKeys >= 20) throw new DashboardAuthError(409, "Active key limit reached");
    const [created] = await storage.apiKeys.create([{
      userId: user._id, keyHash, prefix: rawKey.slice(0, 12), name: name ?? null,
      createdAt: new Date(), lastUsedAt: null, revokedAt: null,
    }], { session });
    return safeApiKey(created);
  }, identityTransactionOptions);
  return { key, rawKey };
}

export async function revokeApiKey(storage: IdentityStorage, userId: string, keyId: string) {
  const revoked = await storage.apiKeys.updateOne({ _id: keyId, userId, revokedAt: null }, {
    $set: { revokedAt: new Date() },
  });
  if (revoked.matchedCount === 0 && !(await storage.apiKeys.exists({ _id: keyId, userId }))) {
    throw new DashboardAuthError(404, "Key not found");
  }
}
