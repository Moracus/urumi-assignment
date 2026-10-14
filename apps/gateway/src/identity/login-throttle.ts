import { createHash, randomUUID } from "node:crypto";
import { identityTransactionOptions, type IdentityStorage } from "./storage.js";

const windowMs = 15 * 60 * 1000;
const bucket = (kind: string, value: string) => `${kind}:${createHash("sha256").update(value).digest("hex")}`;

export async function reserveLoginAttempt(storage: IdentityStorage, email: string, ip: string) {
  const accountId = bucket("account", email);
  const ipId = bucket("ip", ip);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + windowMs);
  // Seed outside the transaction: competing initial requests may race on the unique _id.
  for (const key of [ipId, accountId]) {
    try {
      await storage.loginThrottles.updateOne({ _id: key }, { $setOnInsert: { attempts: [], expiresAt } }, { upsert: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === 11000)) throw error;
    }
  }
  const allowed = await storage.connection.transaction(async (session) => {
    const now = new Date();
    const cutoff = now.getTime() - windowMs;
    const ipState = await storage.loginThrottles.findById(ipId).session(session).lean();
    const accountState = await storage.loginThrottles.findById(accountId).session(session).lean();
    if (!ipState || !accountState) return false;
    const ipAttempts = ipState.attempts.filter((attempt) => attempt.at.getTime() > cutoff).map(({ id, at }) => ({ id, at }));
    const accountAttempts = accountState.attempts.filter((attempt) => attempt.at.getTime() > cutoff).map(({ id, at }) => ({ id, at }));
    if (ipAttempts.length >= 30) return false;
    ipAttempts.push({ id, at: now });
    await storage.loginThrottles.updateOne({ _id: ipId }, {
      $set: { attempts: ipAttempts, expiresAt: new Date(now.getTime() + windowMs) },
    }, { session });
    // Blocked account attempts still count towards the source-IP budget.
    if (accountAttempts.length >= 5) return false;
    accountAttempts.push({ id, at: now });
    await storage.loginThrottles.updateOne({ _id: accountId }, {
      $set: { attempts: accountAttempts, expiresAt: new Date(now.getTime() + windowMs) },
    }, { session });
    return true;
  }, identityTransactionOptions);
  return { allowed, accountId, id };
}
