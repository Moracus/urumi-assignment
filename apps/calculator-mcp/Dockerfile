FROM node:24-bookworm-slim

WORKDIR /app

# Enable pnpm through Corepack
RUN corepack enable

# Copy the monorepo
COPY . .

# Install dependencies
RUN pnpm install --frozen-lockfile

# Compile Calculator MCP
RUN pnpm --filter @urumi/calculator-mcp build

ENV NODE_ENV=production

ENV PORT=3002
ENV HOST=0.0.0.0

EXPOSE 3002

CMD ["node", "apps/calculator-mcp/dist/index.js"]