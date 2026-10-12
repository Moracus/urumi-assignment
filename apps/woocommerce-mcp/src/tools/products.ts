import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import {
  WooCommerceClient,
} from "../woocommerce-client.js";

import {
  success,
  failure,
} from "../responses.js";

interface WooProduct {
  id: number;
  name: string;
  slug: string;
  status: string;
  type: string;
  price: string;
  regular_price: string;
  stock_status: string;
  permalink: string;
}


export function registerProductTools(
  server: McpServer,
  client: WooCommerceClient,
) {
  server.registerTool(
    "list_products",
    {
      description:
        "List WooCommerce products with optional search and pagination.",

      inputSchema: z.object({
        limit: z.number()
          .int()
          .min(1)
          .max(100)
          .default(10),

        page: z.number()
          .int()
          .min(1)
          .default(1),

        search: z.string()
          .max(100)
          .optional(),
      }),
    },

    async ({ limit, page, search }) => {
      try {
        const query: Record<string, string> = {
          per_page: String(limit),
          page: String(page),
        };

        if (search) {
          query.search = search;
        }

        const products = await client.get<WooProduct[]>(
          "/products",
          query,
        );

        return success({
          products: products.map((product) => ({
            id: product.id,
            name: product.name,
            price: product.price,
            status: product.status,
            stock_status: product.stock_status,
            permalink: product.permalink,
          })),
          count: products.length,
          page,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_product",
    {
      description:
        "Create a new simple product in WooCommerce. Price must be a non-negative decimal string.",

      inputSchema: z.object({
        name: z.string()
          .trim()
          .min(1)
          .max(200),

        regular_price: z.string()
          .regex(
            /^\d+(\.\d{1,2})?$/,
            "Price must be a non-negative decimal string",
          ),

        description: z.string()
          .max(5000)
          .optional(),

        status: z.enum([
          "draft",
          "publish",
        ]).default("draft"),
      }),
    },

    async ({
      name,
      regular_price,
      description,
      status,
    }) => {
      try {
        const product = await client.post<WooProduct>(
          "/products",
          {
            name,
            type: "simple",
            regular_price,
            description: description ?? "",
            status,
          },
        );

        return success({
          message: "Product created successfully",
          product: {
            id: product.id,
            name: product.name,
            regular_price: product.regular_price,
            status: product.status,
            permalink: product.permalink,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}