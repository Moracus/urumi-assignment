import { parseArgs } from "node:util";
import { connectIdentityStorage, IdentityStorageError } from "./storage.js";
import { hiddenPrompt, readSecretFile } from "./secret-input.js";
import { recoverAdministrator } from "./administrator-recovery.js";

async function main() {
  const { values } = parseArgs({ options: {
    "user-id": { type: "string" }, "password-file": { type: "string" },
  }, strict: true, allowPositionals: false });
  const userId = values["user-id"];
  if (!userId || !/^[a-fA-F0-9]{24}$/.test(userId)) throw new Error("Existing user ID required");
  const password = values["password-file"]
    ? await readSecretFile(values["password-file"])
    : await hiddenPrompt("Temporary administrator password: ");
  const storage = await connectIdentityStorage();
  try {
    const user = await recoverAdministrator(storage, userId, password);
    process.stdout.write(`${JSON.stringify(user)}\n`);
  } finally { await storage.close(); }
}

try { await main(); } catch (error) {
  // Parser, filesystem and driver exceptions can contain secrets; never emit them.
  const stage = error instanceof IdentityStorageError ? error.stage : "inputs/recovery";
  process.stderr.write(`Administrator recovery failed (${stage}); check target, inputs, and identity storage\n`);
  process.exitCode = 1;
}
