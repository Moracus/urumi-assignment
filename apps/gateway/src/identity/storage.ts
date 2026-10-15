import mongoose, { Schema } from "mongoose";
import { createRegistrationStorage } from "../upstream/registrations.js";

// Mongoose passes these to withTransaction; its declaration omits the driver's timeout.
export const identityTransactionOptions = {
  timeoutMS: 5000, maxCommitTimeMS: 2000, writeConcern: { w: "majority" },
} satisfies mongoose.mongo.TransactionOptions & { timeoutMS: number };

type StorageFailureStage = "configuration" | "connection" | "collections" | "indexes"
  | "transactions" | "setup-transaction" | "shutdown";

export class IdentityStorageError extends Error {
  constructor(readonly stage: StorageFailureStage) {
    super("Identity storage unavailable or invalid");
    this.name = "IdentityStorageError";
  }
}

export interface StoredUser {
  email: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  passwordHash: string;
  requiredPasswordChange: boolean;
  credentialRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<StoredUser>({
  email: { type: String, required: true, trim: true, lowercase: true },
  role: { type: String, enum: ["admin", "member"], required: true },
  status: { type: String, enum: ["active", "disabled"], required: true },
  passwordHash: { type: String, required: true, select: false },
  requiredPasswordChange: { type: Boolean, required: true },
  credentialRevision: { type: Number, default: 0 },
}, {
  timestamps: true, strict: "throw", bufferCommands: false,
  toJSON: { transform: (_document, value) => { const { passwordHash, ...safe } = value; return safe; } },
  toObject: { transform: (_document, value) => { const { passwordHash, ...safe } = value; return safe; } },
});
userSchema.index({ email: 1 }, { unique: true, name: "unique_normalized_email" });

export interface StoredApiKey {
  userId: mongoose.Types.ObjectId;
  keyHash: string;
  prefix: string;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const apiKeySchema = new Schema<StoredApiKey>({
  userId: { type: Schema.Types.ObjectId, required: true },
  keyHash: { type: String, required: true, select: false },
  prefix: { type: String, required: true },
  name: { type: String, maxlength: 100, default: null },
  createdAt: { type: Date, required: true },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, {
  strict: "throw", bufferCommands: false,
  toJSON: { transform: (_document, value) => { const { keyHash, ...safe } = value; return safe; } },
  toObject: { transform: (_document, value) => { const { keyHash, ...safe } = value; return safe; } },
});
apiKeySchema.index({ keyHash: 1 }, { unique: true, name: "unique_api_key_hash" });
apiKeySchema.index({ userId: 1, _id: 1 }, { name: "api_key_owner" });

const setupSchema = new Schema({
  _id: { type: String, required: true },
  consumedAt: { type: Date, default: null },
  validationRevision: { type: Number, default: 0 },
}, { strict: "throw", bufferCommands: false });

const accountCoordinationSchema = new Schema({
  _id: { type: String, required: true },
  revision: { type: Number, required: true },
}, { strict: "throw", bufferCommands: false });

const dashboardSessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  credentialHash: { type: String, required: true },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { strict: "throw", bufferCommands: false });
dashboardSessionSchema.index({ credentialHash: 1 }, { unique: true });
dashboardSessionSchema.index({ userId: 1 });
dashboardSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const loginThrottleSchema = new Schema({
  _id: { type: String, required: true },
  attempts: { type: [{ _id: false, id: { type: String, required: true }, at: { type: Date, required: true } }], default: [] },
  expiresAt: { type: Date, required: true },
}, { strict: "throw", bufferCommands: false });
loginThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export async function connectIdentityStorage(uri = process.env.MONGODB_URI) {
  if (!uri) throw new IdentityStorageError("configuration");
  const connection = mongoose.createConnection();
  // Driver errors can contain credentials/URIs; never send or log raw errors.
  connection.on("error", () => { console.error("Identity storage connection error"); });
  let stage: StorageFailureStage = "connection";
  try {
    await connection.openUri(uri, {
      serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000,
      socketTimeoutMS: 5000, timeoutMS: 5000, heartbeatFrequencyMS: 1000,
      maxPoolSize: 10, bufferCommands: false, autoIndex: false,
    });
    const users = connection.model("User", userSchema, "users");
    const setup = connection.model("InitialSetup", setupSchema, "initial_setup");
    const sessions = connection.model("DashboardSession", dashboardSessionSchema, "dashboard_sessions");
    const loginThrottles = connection.model("LoginThrottle", loginThrottleSchema, "login_throttles");
    const apiKeys = connection.model("ApiKey", apiKeySchema, "api_keys");
    const accountCoordination = connection.model("AccountCoordination", accountCoordinationSchema, "account_coordination");
    stage = "collections";
    await users.createCollection();
    await setup.createCollection();
    await sessions.createCollection();
    await loginThrottles.createCollection();
    await apiKeys.createCollection();
    await accountCoordination.createCollection();
    stage = "indexes";
    await users.createIndexes();
    await setup.createIndexes();
    await sessions.createIndexes();
    await loginThrottles.createIndexes();
    await apiKeys.createIndexes();
    await accountCoordination.createIndexes();
    const upstreamRegistrations = await createRegistrationStorage(connection);
    const indexes = await users.collection.indexes();
    if (!indexes.some((index) => index.name === "unique_normalized_email"
      && index.unique && index.key.email === 1 && !index.sparse && !index.partialFilterExpression)) {
      throw new IdentityStorageError("indexes");
    }
    stage = "transactions";
    await accountCoordination.updateOne({ _id: "active-administrators" }, {
      $setOnInsert: { revision: 0 },
    }, { upsert: true });
    await setup.updateOne({ _id: "initial-administrator" }, {
      $setOnInsert: { consumedAt: null, validationRevision: 0 },
    }, { upsert: true });
    // An actual transactional write proves support and permissions, not just topology.
    await connection.transaction(async (session) => {
      await setup.updateOne({ _id: "initial-administrator" }, {
        $inc: { validationRevision: 1 },
      }, { session });
    }, identityTransactionOptions);

    return {
      connection, users, setup, sessions, loginThrottles, apiKeys, accountCoordination, upstreamRegistrations,
      async isAvailable(): Promise<boolean> {
        try {
          if (connection.readyState !== 1 || !connection.db) return false;
          await connection.db.command({ ping: 1 }, { timeoutMS: 2000 });
          return true;
        } catch { return false; }
      },
      async close() {
        try { await connection.close(); }
        catch { throw new IdentityStorageError("shutdown"); }
      },
    };
  } catch {
    await connection.close().catch(() => { console.error("Identity storage shutdown error"); });
    throw new IdentityStorageError(stage);
  }
}

export type IdentityStorage = Awaited<ReturnType<typeof connectIdentityStorage>>;
