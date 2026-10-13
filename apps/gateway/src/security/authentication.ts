import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

import type {
  AuthenticatedIdentity,
} from "./identity.js";

export class AuthenticationError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthenticationError";
  }
}

function hashToken(token: string): Buffer {
  return createHash("sha256")
    .update(token)
    .digest();
}

export function authenticateRequest(
  authorizationHeader: string | undefined,
): AuthenticatedIdentity {
  const configuredKey = process.env.GATEWAY_BOOTSTRAP_KEY;

  if (!configuredKey) {
    throw new Error(
      "Gateway bootstrap authentication is not configured",
    );
  }

  const match = authorizationHeader?.match(
    /^Bearer ([^\s]+)$/,
  );

  if (!match) {
    throw new AuthenticationError();
  }

  const providedKey = match[1];

  const expectedHash = hashToken(configuredKey);
  const providedHash = hashToken(providedKey);

  if (!timingSafeEqual(expectedHash, providedHash)) {
    throw new AuthenticationError();
  }

  return {
    userId: "bootstrap-admin",
    role: "admin",
    keyId: "bootstrap-key",
  };
}