import type {
  AuthenticatedIdentity,
} from "./identity.js";

export class AuthorizationError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "AuthorizationError";
  }
}

export function authorizeTool(
  identity: AuthenticatedIdentity,
  toolName: string,
): void {
  if (identity.role === "admin") {
    return;
  }

  const memberAllowedTools = new Set([
    "woocommerce.list_products",
    "woocommerce.list_orders",
    "woocommerce.get_order",
    "calculator.calculate",
    "time.current",
  ]);

  if (!memberAllowedTools.has(toolName)) {
    throw new AuthorizationError();
  }
}