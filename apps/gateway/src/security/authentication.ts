import {
  createHash,
} from "node:crypto";
import type { IdentityStorage } from "../identity/storage.js";
import { isUserEligibleForOrdinaryAccess } from "../identity/account-eligibility.js";

import type {
  AuthenticatedIdentity,
} from "./identity.js";

export class AuthenticationError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthenticationError";
  }
}

export async function authenticateRequest(
  authorizationHeader: string | undefined,
  storage: IdentityStorage,
): Promise<AuthenticatedIdentity> {
  const match = authorizationHeader?.match(
    /^Bearer (ugw_[A-Za-z0-9_-]{43})$/,
  );

  if (!match) {
    throw new AuthenticationError();
  }

  const keyHash = createHash("sha256").update(match[1]).digest("hex");
  const key = await storage.apiKeys.findOne({ keyHash, revokedAt: null });
  const user = key ? await storage.users.findById(key.userId) : null;
  if (!key || !user || !isUserEligibleForOrdinaryAccess(user)) throw new AuthenticationError();
  // Revocation between lookup and admission must not restore or update the key.
  // $max prevents concurrent request completion from moving last-use backwards.
  const updated = await storage.apiKeys.updateOne({ _id: key._id, revokedAt: null }, {
    $max: { lastUsedAt: new Date() },
  });
  if (updated.matchedCount !== 1) throw new AuthenticationError();

  return {
    userId: user._id.toHexString(),
    role: user.role,
    userEmail: user.email,
    authenticationOrigin: "gateway_api_key",
    keyId: key._id.toHexString(),
  };
}
