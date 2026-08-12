# Hosted MCP server (Streamable HTTP, OAuth resource server). The stdio
# entry point is in the same image but unused here.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
# uid 1001 to match the cluster securityContext (same as the backend image).
RUN adduser -D -u 1001 mcp
WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/package.json ./
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
USER mcp
EXPOSE 8787
CMD ["node", "dist/http.mjs"]
