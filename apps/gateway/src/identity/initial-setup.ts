import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { hashPassword } from "./passwords.js";
import { IdentityStorageError, identityTransactionOptions, type IdentityStorage } from "./storage.js";

export class SetupConsumedError extends Error {
  constructor() { super("Initial administrator setup already consumed; use operator recovery"); }
}

export async function initializeAdministrator(storage: IdentityStorage, input: {
  email: string; password: string; suppliedSecret: string; configuredSecret: string;
}) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!input.configuredSecret || !timingSafeEqual(digest(input.configuredSecret), digest(input.suppliedSecret))) {
    throw new Error("Initial administrator setup authorization failed");
  }
  const email = z.string().trim().toLowerCase().email().max(254).parse(input.email);
  const passwordHash = await hashPassword(input.password);
  try {
    return await storage.connection.transaction(async (session) => {
      const state = await storage.setup.findOneAndUpdate({
        _id: "initial-administrator", consumedAt: null,
      }, { $set: { consumedAt: new Date() } }, { session, new: true });
      if (!state) throw new SetupConsumedError();
      const [user] = await storage.users.create([{
        email, passwordHash, role: "admin", status: "active", requiredPasswordChange: false,
      }], { session });
      return {
        id: user._id.toHexString(), email: user.email, role: user.role,
        status: user.status, requiredPasswordChange: user.requiredPasswordChange,
        createdAt: user.createdAt, updatedAt: user.updatedAt,
      };
    }, identityTransactionOptions);
  } catch (error) {
    if (error instanceof SetupConsumedError) throw error;
    throw new IdentityStorageError("setup-transaction");
  }
}
