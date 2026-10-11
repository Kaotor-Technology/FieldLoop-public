FROM node:22.23.3-bookworm-slim AS build
WORKDIR /workspace
ENV TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY DESIGN.md ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api ./apps/api
COPY apps/guardrail ./apps/guardrail
COPY apps/signal-worker ./apps/signal-worker
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@fieldloop/web...

# Validation image only. The deployable web-api image embeds this same SPA.
FROM nginxinc/nginx-unprivileged:1.28-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
