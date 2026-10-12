FROM node:24-bookworm-slim

WORKDIR /app

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @urumi/time-mcp build

ENV NODE_ENV=production

ENV PORT=3003
ENV HOST=0.0.0.0

EXPOSE 3003

CMD ["node", "apps/time-mcp/dist/index.js"]