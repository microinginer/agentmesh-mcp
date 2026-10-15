FROM node:26-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY shared ./shared
COPY drizzle ./drizzle
COPY web ./web
RUN pnpm build
RUN CI=true pnpm prune --prod

FROM node:26-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/microinginer/agentmesh-mcp"
LABEL org.opencontainers.image.description="Open-source MCP mailbox for collaborating AI coding agents"
LABEL org.opencontainers.image.licenses="Apache-2.0"

RUN addgroup -S -g 10001 agentmesh \
  && adduser -S -D -H -u 10001 -G agentmesh agentmesh

COPY --from=build --chown=agentmesh:agentmesh /app/package.json ./package.json
COPY --from=build --chown=agentmesh:agentmesh /app/node_modules ./node_modules
COPY --from=build --chown=agentmesh:agentmesh /app/dist ./dist
COPY --from=build --chown=agentmesh:agentmesh /app/drizzle ./drizzle

USER 10001:10001
EXPOSE 3000

CMD ["node", "dist/server.js"]
