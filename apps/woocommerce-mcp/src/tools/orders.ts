import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { orderDateRange, type OrderDateRange } from "../order-date-range.js";

import {
  WooCommerceClient,
} from "../woocommerce-client.js";

import {
  success,
  failure,
} from "../responses.js";

interface WooOrderItem {
  id: number;
  product_id: number;
  name: string;
  quantity: number;
  total: string;
}

interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  date_created_gmt: string;
  payment_method: string;
  payment_method_title: string;
  line_items: WooOrderItem[];
}

const orderStatusSchema = z.enum([
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
]);

export function registerOrderTools(
  server: McpServer,
  client: WooCommerceClient,
) {
  server.registerTool(
    "list_orders",
    {
      description:
        "List WooCommerce orders. For today's orders use date=today and an explicit IANA timezone. " +
        "For a calendar day use date=YYYY-MM-DD and timezone; do not combine with after/before. " +
        "Returns the selected inclusive UTC start and exclusive UTC end. Supports status and pagination.",

      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10),

        page: z.number().int().min(1).default(1),

        status: orderStatusSchema.optional(),

        date: z.union([z.literal("today"), z.iso.date()]).optional(),

        timezone: z.string().min(1).max(100).optional(),

        after: z.iso
          .datetime({
            offset: true,
          })
          .optional(),

        before: z.iso
          .datetime({
            offset: true,
          })
          .optional(),
      }),
    },

    async ({ limit, page, status, after, before, date, timezone }) => {
      try {
        let dateRange: OrderDateRange | undefined;
        if (date !== undefined || timezone !== undefined) {
          if (!date || !timezone || after !== undefined || before !== undefined) {
            return { isError: true, content: [{ type: "text" as const,
              text: "Supply date and an explicit IANA timezone together, without after/before" }] };
          }
          try {
            dateRange = orderDateRange(date, timezone);
          } catch {
            return { isError: true, content: [{ type: "text" as const,
              text: "Invalid calendar date or IANA timezone; use today or an existing contiguous YYYY-MM-DD between 1900 and 9998" }] };
          }
        }
        if (
          after &&
          before &&
          new Date(after).getTime() > new Date(before).getTime()
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Invalid date range: after must be earlier than before",
              },
            ],
          };
        }

        const query: Record<string, string> = {
          per_page: String(limit),
          page: String(page),
          orderby: "date",
          order: "desc",
        };

        if (status) {
          query.status = status;
        }

        if (after) {
          query.after = after;
        }

        if (before) {
          query.before = before;
        }

        if (dateRange) {
          // WooCommerce's REST date_query uses exclusive comparisons at second
          // precision. Move after back one second to include local midnight.
          query.after = new Date(Date.parse(dateRange.start) - 1000).toISOString().replace(".000Z", "Z");
          query.before = dateRange.end.replace(".000Z", "Z");
          query.dates_are_gmt = "true";
        }

        const orders = await client.get<WooOrder[]>("/orders", query);

        return success({
          orders: orders.map((order) => ({
            id: order.id,
            number: order.number,
            status: order.status,
            currency: order.currency,
            total: order.total,
            date_created: order.date_created,
            date_created_gmt: order.date_created_gmt,
            payment_method: order.payment_method,
            items: order.line_items.map((item) => ({
              product_id: item.product_id,
              name: item.name,
              quantity: item.quantity,
              total: item.total,
            })),
          })),
          count: orders.length,
          page,
          ...(dateRange ? { date_range: dateRange } : {}),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "get_order",
    {
      description: "Get details of a WooCommerce order by its numeric ID.",

      inputSchema: z.object({
        order_id: z.number().int().positive(),
      }),
    },

    async ({ order_id }) => {
      try {
        const order = await client.get<WooOrder>(`/orders/${order_id}`);

        return success({
          id: order.id,
          number: order.number,
          status: order.status,
          currency: order.currency,
          total: order.total,
          date_created: order.date_created,
          date_created_gmt: order.date_created_gmt,
          payment_method: order.payment_method,
          payment_method_title: order.payment_method_title,
          items: order.line_items.map((item) => ({
            product_id: item.product_id,
            name: item.name,
            quantity: item.quantity,
            total: item.total,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
    server.registerTool(
    "update_order_status",
    {
      description:
        "Update the status of an existing WooCommerce order. " +
        "Supports processing, on-hold, completed, and cancelled.",

      inputSchema: z.object({
        order_id: z.number()
          .int()
          .positive(),

        status: z.enum([
          "processing",
          "on-hold",
          "completed",
          "cancelled",
        ]),
      }),
    },

    async ({ order_id, status }) => {
      try {
        const updatedOrder =
          await client.put<WooOrder>(
            `/orders/${order_id}`,
            {
              status,
            },
          );

        return success({
          message: "Order status updated successfully",
          order: {
            id: updatedOrder.id,
            number: updatedOrder.number,
            status: updatedOrder.status,
            total: updatedOrder.total,
            currency: updatedOrder.currency,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
