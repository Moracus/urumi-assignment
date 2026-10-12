import {
  WooCommerceClient,
} from "./woocommerce-client.js";

const consumerKey = process.env.WC_CONSUMER_KEY;
const consumerSecret = process.env.WC_CONSUMER_SECRET;

if (!consumerKey || !consumerSecret) {
  throw new Error(
    "Missing WooCommerce API credentials",
  );
}

const client = new WooCommerceClient({
  baseUrl:
    process.env.WC_URL ??
    "http://localhost:8080",

  consumerKey,
  consumerSecret,
});

interface Product {
  id: number;
  name: string;
  price: string;
  status: string;
}

interface Order {
  id: number;
  status: string;
  total: string;
  date_created: string;
}

async function main() {
  console.log("Fetching products...");

  const products = await client.get<Product[]>(
    "/products",
    {
      per_page: "10",
    },
  );

  console.table(
    products.map((product) => ({
      id: product.id,
      name: product.name,
      price: product.price,
      status: product.status,
    })),
  );

  console.log("Fetching orders...");

  const orders = await client.get<Order[]>(
    "/orders",
    {
      per_page: "10",
    },
  );

  console.table(
    orders.map((order) => ({
      id: order.id,
      status: order.status,
      total: order.total,
      created: order.date_created,
    })),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});