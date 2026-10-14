# One-off in-VPC latency job. Build from the repository root:
#   docker build --platform linux/amd64 -f apps/guardrail/performance/Dockerfile .
FROM node:22.23.3-bookworm-slim AS build
WORKDIR /workspace
ENV TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY DESIGN.md ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY data/synthetic/dl-01/bowtie-a.json ./data/synthetic/dl-01/bowtie-a.json
COPY data/synthetic/bangkok/bowtie-d.json ./data/synthetic/bangkok/bowtie-d.json
COPY apps/api ./apps/api
COPY apps/guardrail ./apps/guardrail
COPY apps/signal-worker ./apps/signal-worker
COPY domain-packs ./domain-packs
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@fieldloop/api...
RUN pnpm --filter=@fieldloop/api deploy --prod /output

FROM grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 AS k6

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=build --chown=node:node /output ./
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY apps/guardrail/performance/tier1-content-scan.js /scripts/tier1-content-scan.js
COPY apps/guardrail/performance/run-in-vpc.mjs ./run-in-vpc.mjs
USER node
CMD ["node", "run-in-vpc.mjs"]
