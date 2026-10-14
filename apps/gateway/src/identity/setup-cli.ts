import { parseArgs } from "node:util";
import { connectIdentityStorage, IdentityStorageError } from "./storage.js";
import { initializeAdministrator, SetupConsumedError } from "./initial-setup.js";
import { hiddenPrompt, readSecretFile } from "./secret-input.js";

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: "string" }, "password-file": { type: "string" },
    "bootstrap-secret-file": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (!values.email) throw new Error("Email required");
  const configuredSecret = process.env.GATEWAY_BOOTSTRAP_KEY_FILE
    ? await readSecretFile(process.env.GATEWAY_BOOTSTRAP_KEY_FILE)
    : process.env.GATEWAY_BOOTSTRAP_KEY ?? "";
  if (!configuredSecret) throw new Error("Setup credential not configured");
  const suppliedSecret = values["bootstrap-secret-file"]
    ? await readSecretFile(values["bootstrap-secret-file"])
    : await hiddenPrompt("Bootstrap secret: ");
  const password = values["password-file"]
    ? await readSecretFile(values["password-file"])
    : await hiddenPrompt("Final administrator password: ");
  const storage = await connectIdentityStorage();
  try {
    const user = await initializeAdministrator(storage, {
      email: values.email, password, configuredSecret, suppliedSecret,
    });
    process.stdout.write(`${JSON.stringify(user)}\n`);
  } finally { await storage.close(); }
}

try { await main(); } catch (error) {
  // Even parser and validation errors can contain input values. Only emit fixed messages.
  const stage = error instanceof IdentityStorageError ? error.stage : "inputs/configuration";
  process.stderr.write(error instanceof SetupConsumedError
    ? "Initial administrator setup already consumed; use operator recovery\n"
    : `Initial administrator setup failed (${stage}); check configuration, inputs, and identity storage\n`);
  process.exitCode = 1;
}
