import {
  WooCommerceError,
} from "./woocommerce-client.js";

export function success(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function failure(error: unknown) {
  if (error instanceof WooCommerceError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: {
              status: error.status,
              code: error.code,
              message: error.message,
            },
          }),
        },
      ],
    };
  }

  console.error("MCP tool failed:", error);

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: {
            code: "internal_error",
            message: "An unexpected tool error occurred",
          },
        }),
      },
    ],
  };
}