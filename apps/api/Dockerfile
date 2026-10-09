FROM node:22.23.3-bookworm-slim AS build
WORKDIR /workspace
ENV TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api ./apps/api
COPY apps/guardrail ./apps/guardrail
COPY apps/signal-worker ./apps/signal-worker
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@fieldloop/api... --filter=@fieldloop/web...
RUN pnpm --filter=@fieldloop/api deploy --prod /output

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app/apps/api
COPY --from=build --chown=node:node /output ./
COPY --from=build --chown=node:node /workspace/apps/web/dist /app/apps/web/dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
