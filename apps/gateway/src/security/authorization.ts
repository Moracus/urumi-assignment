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
    "woocommerce_list_products",
    "woocommerce_list_orders",
    "woocommerce_get_order",
    "calculator_calculate",
    "time_current",
  ]);

  if (!memberAllowedTools.has(toolName)) {
    throw new AuthorizationError();
  }
}