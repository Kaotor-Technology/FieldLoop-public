# Loads the synthetic DL-01 seed into the database named by FIELDLOOP_DATABASE_URL
# for the Organisation FIELDLOOP_ORG_ID, then exits. Build from the repository root.
FROM node:22.23.3-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY db/seed/dl-01 ./db/seed/dl-01
RUN pnpm install --frozen-lockfile --filter=@fieldloop/seed-dl-01
RUN pnpm --filter=@fieldloop/seed-dl-01 deploy --prod /output

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production
# The loader reads the generator and the seed file by a path relative to itself.
WORKDIR /app/db/seed/dl-01
COPY --from=build --chown=node:node /output ./
COPY --chown=node:node data/synthetic/dl-01/generate.mjs data/synthetic/dl-01/bowtie-a.json /app/data/synthetic/dl-01/
USER node
# The loader also writes the generated GeoJSON; the image's own copy stays read-only.
CMD ["node", "seed.mjs", "--output-dir", "/tmp/dl-01"]
