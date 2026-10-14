import type { HydratedDocument } from "mongoose";
import type { StoredUser } from "./storage.js";

export function safeUser(user: HydratedDocument<StoredUser>) {
  return {
    id: user._id.toHexString(), email: user.email, role: user.role, status: user.status,
    requiredPasswordChange: user.requiredPasswordChange, createdAt: user.createdAt, updatedAt: user.updatedAt,
  };
}
