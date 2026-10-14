import { mongo } from "mongoose";
import type { IdentityStorage } from "./storage.js";
import { hashPassword } from "./passwords.js";
import { safeUser } from "./safe-user.js";
import { DashboardAuthError } from "./dashboard-sessions.js";

export async function createMember(storage: IdentityStorage, email: string, password: string) {
  const passwordHash = await hashPassword(password);
  try {
    const user = await storage.users.create({
      email, passwordHash, role: "member", status: "active", requiredPasswordChange: true,
    });
    return safeUser(user);
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000) {
      throw new DashboardAuthError(409, "Email already exists");
    }
    throw error;
  }
}
