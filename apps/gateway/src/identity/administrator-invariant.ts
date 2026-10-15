import type { ClientSession } from "mongoose";
import { identityTransactionOptions, type IdentityStorage } from "./storage.js";
import { DashboardAuthError } from "./dashboard-sessions.js";

// Every role change and future disable operation must use this transaction.
// The shared write precedes reads so concurrent changes retry with a fresh
// snapshot, avoiding write skew when they affect different administrators.
export async function withActiveAdministrator<T>(
  storage: IdentityStorage,
  change: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return storage.connection.transaction(async (session) => {
    const lock = await storage.accountCoordination.updateOne({ _id: "active-administrators" }, {
      $inc: { revision: 1 },
    }, { session });
    if (lock.matchedCount !== 1) throw new DashboardAuthError(503, "Authentication unavailable");
    const result = await change(session);
    if (await storage.users.countDocuments({ role: "admin", status: "active" }).session(session) === 0) {
      throw new DashboardAuthError(409, "At least one active administrator must remain");
    }
    return result;
  }, identityTransactionOptions);
}
