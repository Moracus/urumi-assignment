import { Schema, type Connection } from "mongoose";
import { z } from "zod/v4";
import { identityTransactionOptions } from "../identity/storage.js";
import type { UpstreamConfig } from "./types.js";
import type { DestinationPolicy } from "./destination-policy.js";

const secretReference = z.strictObject({
  namespace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(63),
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).max(253),
  key: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(253),
});
const authentication = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), secretRef: secretReference }),
  z.strictObject({ type: z.literal("header"), secretRef: secretReference,
    headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).max(100)
      .refine(value => !/^(authorization|proxy-authorization|host|cookie|connection|content-.*|transfer-encoding|upgrade|te|trailer|keep-alive)$/i.test(value)),
  }),
]);
export const registrationInput = z.strictObject({
  serverId: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(100),
  displayName: z.string().trim().min(1).max(200),
  url: z.string().url().transform(value => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("Invalid upstream URL");
    }
    return url.href;
  }),
  transport: z.literal("streamable-http"),
  enabled: z.boolean(),
  authentication,
  configurationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type UpstreamRegistration = z.infer<typeof registrationInput>;

// Public creation cannot set revisions, timestamps or submit credentials.
export const createRegistrationInput = registrationInput.pick({
  serverId: true, displayName: true, url: true, transport: true, enabled: true,
}).extend({ authentication: z.strictObject({ type: z.literal("none") }) });
export type CreateRegistrationInput = z.infer<typeof createRegistrationInput>;

const registrationSchema = new Schema<UpstreamRegistration>({
  serverId: { type: String, required: true },
  displayName: { type: String, required: true },
  url: { type: String, required: true },
  transport: { type: String, enum: ["streamable-http"], required: true },
  enabled: { type: Boolean, required: true },
  authentication: { type: Schema.Types.Mixed, required: true },
  configurationRevision: { type: Number, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { strict: "throw", bufferCommands: false, versionKey: false });
registrationSchema.pre("validate", function () {
  const { _id, ...value } = this.toObject();
  const parsed = registrationInput.parse(value);
  this.set(parsed);
});
registrationSchema.index({ serverId: 1 }, { unique: true, name: "unique_upstream_server_id" });
registrationSchema.index({ url: 1 }, { unique: true, name: "unique_upstream_url" });
const migrationSchema = new Schema({
  _id: { type: String, required: true },
  completedAt: { type: Date, default: null },
  revision: { type: Number, default: 0 },
}, { strict: "throw", bufferCommands: false });
const migrationId = "upstream-defaults-v1";

export async function createRegistrationStorage(connection: Connection) {
  const registrations = connection.model("UpstreamRegistration", registrationSchema, "upstream_registrations");
  const migrations = connection.model("UpstreamMigration", migrationSchema, "upstream_migrations");
  await registrations.createCollection();
  await migrations.createCollection();
  await registrations.createIndexes();
  return {
    async create(input: CreateRegistrationInput): Promise<UpstreamRegistration> {
      const now = new Date();
      const desired = registrationInput.parse({ ...input, configurationRevision: 1, createdAt: now, updatedAt: now });
      await registrations.create(desired);
      return desired;
    },
    async migrate(defaults: UpstreamConfig[], policy: DestinationPolicy) {
      // Create the coordination row before the transaction. A competing upsert may win.
      try {
        await migrations.updateOne({ _id: migrationId }, { $setOnInsert: { completedAt: null, revision: 0 } }, { upsert: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === 11000)) throw error;
      }
      await connection.transaction(async session => {
        const marker = await migrations.findOneAndUpdate({ _id: migrationId }, { $inc: { revision: 1 } }, { session, returnDocument: "after" });
        if (!marker) throw new Error("Upstream migration unavailable");
        if (marker.completedAt) return;
        for (const config of defaults) {
          if (await registrations.exists({ serverId: config.name }).session(session)) continue;
          policy.validate(config.url);
          const now = new Date();
          const desired = registrationInput.parse({
            serverId: config.name, displayName: config.name, url: config.url,
            transport: "streamable-http", enabled: config.enabled, authentication: config.authentication ?? { type: "none" },
            configurationRevision: 1, createdAt: now, updatedAt: now,
          });
          await registrations.create([desired], { session });
        }
        await migrations.updateOne({ _id: migrationId }, { $set: { completedAt: new Date() } }, { session });
      }, identityTransactionOptions);
    },
    async list(policy: DestinationPolicy): Promise<UpstreamRegistration[]> {
      const documents = await registrations.find().sort({ serverId: 1 }).lean();
      return documents.map(({ _id, ...value }) => {
        const registration = registrationInput.parse(value);
        // Reject noncanonical stored values rather than letting duplicate spellings evade the index.
        if (registration.url !== value.url) throw new Error("Invalid upstream configuration");
        policy.validate(registration.url);
        return registration;
      });
    },
  };
}
export type RegistrationStorage = Awaited<ReturnType<typeof createRegistrationStorage>>;
