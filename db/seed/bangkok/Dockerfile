# Offline Bangkok seed; execution is an explicit operator action after migrations.
FROM node:22.23.3-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY db/seed/bangkok ./db/seed/bangkok
RUN pnpm install --frozen-lockfile --filter=@fieldloop/seed-bangkok
RUN pnpm --filter=@fieldloop/seed-bangkok deploy --prod /output

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/db/seed/bangkok
COPY --from=build --chown=node:node /output ./
COPY --chown=node:node db/seed/common.mjs /app/db/seed/common.mjs
COPY --chown=node:node data/synthetic/bangkok /app/data/synthetic/bangkok
USER node
CMD ["node", "seed.mjs"]
