# FieldLoop v2

A map-first risk and Gen AI guardrail platform for critical infrastructure, built for
the AI Builder Cup 2026 hackathon. The Living Bowtie keeps Barrier Health in step with
live Evidence and Signals, and every Gen AI call and agent tool call passes a Guardrail.
Bounded AI agents work in Agent Chat; a person approves every consequential action.

The demo runs on **synthetic** data (a gas pipeline, use case UC-1) and **simulated** data
(a Bangkok urban flood, use case UC-4). It is labelled SIMULATION or SYNTHETIC on screen,
and the repository contains no real customer or operator data.

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | React + Vite single-page console (map-first UI) |
| `apps/api` | Backend-for-frontend and REST API (Fastify) |
| `apps/guardrail` | Guardrail service every Gen AI call must pass |
| `apps/signal-worker` | Signal ingestion and Health Proposals |
| `apps/assistant`, `apps/simulator` | Python agent and scenario simulator |
| `packages/domain` | Pure, deterministic, golden-tested risk maths |
| `packages/contracts`, `packages/adapters`, `packages/ui`, `packages/map`, `packages/config` | Shared contracts, cloud adapters, design tokens, map layers, config |
| `db` | PostgreSQL migrations (dbmate) and seed loader |
| `data`, `domain-packs` | Synthetic and simulated datasets, use-case packs |
| `DESIGN.md` | Design tokens and screen specifications |

## Setup

Use Node **22.23.3**, pnpm **10.34.6**, Python **3.12** and uv **0.12.23**.

```sh
pnpm install --frozen-lockfile
uv sync --locked --all-packages
```

## Checks

```sh
pnpm check:safety
pnpm lint
pnpm typecheck
pnpm test
pnpm lint:design
pnpm build
uv run --locked --all-packages ruff check .
uv run --locked --all-packages mypy
uv run --locked --all-packages pytest
```

`pnpm test:migrations` and `pnpm test:seed` need Docker (PostgreSQL 16 with PostGIS and pgvector).

## Deployment

Cloud resource names in this repository are placeholders (`example-project`,
`auth.example.com`). Infrastructure and release workflows are not part of this public mirror.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
