import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

// A process admits at most two 64 MiB jobs, with no unbounded wait queue.
let activeJobs = 0;

export function validatePassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 12 || length > 128) {
    throw new Error("Password must contain 12–128 characters");
  }
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeJobs >= 2) throw new Error("Password hashing busy; retry later");
  activeJobs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      argon2("argon2id", {
        message: password, nonce: salt, memory: 65536,
        passes: 3, parallelism: 1, tagLength: 32,
      }, (error, value) => error ? reject(error) : resolve(value));
    });
  } finally {
    activeJobs--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `$argon2id$v=19$m=65536,t=3,p=1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  validatePassword(password);
  const match = encoded.match(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/);
  if (!match) return false;
  const actual = await derive(password, Buffer.from(match[1], "base64"));
  return timingSafeEqual(actual, Buffer.from(match[2], "base64"));
}
