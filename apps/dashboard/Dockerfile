FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard ./apps/dashboard
RUN pnpm install --frozen-lockfile --filter @urumi/dashboard...
# This is public client configuration. Never pass secrets as build arguments.
ARG VITE_PUBLIC_MCP_URL
ENV VITE_PUBLIC_MCP_URL=${VITE_PUBLIC_MCP_URL}
RUN pnpm --filter @urumi/dashboard build

FROM nginx:1.28-alpine AS runtime
COPY apps/dashboard/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/health/live || exit 1
# Skip image entrypoint scripts; configuration is immutable and all writes use /tmp.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
