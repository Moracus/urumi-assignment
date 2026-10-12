FROM node:24-bookworm-slim

WORKDIR /app

# Enable pnpm through Corepack
RUN corepack enable

# Copy the monorepo
COPY . .

# Install dependencies from the lockfile
RUN pnpm install --frozen-lockfile

# Compile WooCommerce MCP TypeScript
RUN pnpm --filter @urumi/woocommerce-mcp build

ENV NODE_ENV=production

ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

CMD ["node", "apps/woocommerce-mcp/dist/index.js"]