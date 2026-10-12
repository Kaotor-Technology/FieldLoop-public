FROM node:22.23.3-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY db/seed/legal-corpus ./db/seed/legal-corpus
RUN pnpm install --frozen-lockfile --filter=@fieldloop/seed-legal-corpus
RUN pnpm --filter=@fieldloop/seed-legal-corpus deploy --prod /output

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/db/seed/legal-corpus
COPY --from=build --chown=node:node /output ./
COPY --chown=node:node data/corpus/legal /app/data/corpus/legal
USER node
CMD ["node", "seed.mjs"]
