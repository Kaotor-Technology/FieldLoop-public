# FieldLoop v2

AI-Harness Living Bowtie. The current workspace is the FL-57 bootstrap: buildable
empty shared packages, a blank React entry point, and service health probes.
Product behavior, identity, infrastructure provisioning and deployment belong to
later issues. Start with [project context](docs/context.md) and [architecture](docs/architecture.md).

## Setup

Use Node **22.23.3**, pnpm **10.34.6**, Python **3.12**, and uv **0.12.23**.
The Node and pnpm versions are enforced by `package.json` and `.npmrc`.
Python is restricted to 3.12 by the workspace manifests.

```sh
pnpm install --frozen-lockfile
uv sync --locked --all-packages
```

One pnpm lockfile covers the four TypeScript apps and six shared packages;
one uv lockfile covers the two Python apps and `py/fieldloop_common`.
Run Python tooling with `--all-packages` so every editable workspace package is installed.

## Checks

Run from the repository root:

```sh
pnpm check:safety
pnpm lint
pnpm typecheck
pnpm test
pnpm lint:design
pnpm lint:api
pnpm build
uv run --locked --all-packages ruff check .
uv run --locked --all-packages mypy
uv run --locked --all-packages pytest
uv build --all-packages
```

`pnpm build` emits the SPA in `apps/web/dist`, service JavaScript in each
TypeScript app's `dist`, and declarations for the empty shared modules.
The config package validates its source presets without emitting runtime code.
`uv build --all-packages` emits wheels and source distributions in root `dist`.
`pnpm lint:api` checks `packages/contracts/openapi.yaml` against the API conventions
in [packages/contracts](packages/contracts/README.md).
Empty shared packages currently allow zero tests; service probes and the Git path
boundary have real tests. Domain and risk-engine tests arrive with their implementations.

## Local service probes

```sh
pnpm --filter @fieldloop/web dev
pnpm --filter @fieldloop/api start
uv run --locked --package fieldloop-assistant uvicorn fieldloop_assistant.main:app --port 8081
uv run --locked --package fieldloop-simulator uvicorn fieldloop_simulator.main:app --port 8082
```

Build before starting the API. The API serves the built SPA from the same origin.
The five services expose `GET /healthz`; TypeScript services use `PORT` (default
8080). These are process liveness probes, not readiness checks for future dependencies.
The React entry point is intentionally blank; no demo screens exist yet.

## Containers and CI

All Dockerfiles use the repository root as their build context:

```sh
docker build -f apps/api/Dockerfile -t fieldloop-local:api .
node scripts/smoke-container.mjs api fieldloop-local:api
```

Replace `api` with `web`, `guardrail`, `signal-worker`, `assistant` or `simulator`.
The runtime images use non-root users and production dependencies. Python
packages are installed without editable links. The web image is a standalone
validation image; deployment uses the SPA embedded in the API image (`web-api`).
The allowlist in `.dockerignore` excludes local secrets and confidential material;
update it when adding new build inputs.

GitHub Actions runs on pull requests and pushes to `main`. It checks confidential
paths before a redacted Gitleaks scan, then lint, types, Vitest, pytest, DESIGN.md
lint, OpenAPI lint, builds, and a six-app Linux amd64 container build/startup matrix. It publishes
no images and provisions no cloud resources in the CI workflow. Action references are pinned to commits.

The path checker inspects only Git metadata for the index, HEAD and fetched
history. It rejects any `raw-data` path segment or `.kmz` extension, including
case variants and additions removed in later commits. Tests use empty Git blobs
and index metadata in temporary repositories, without opening prohibited files.

## GCP infrastructure and releases

See [the FL-58 operator handoff](infra/terraform/README.md) for the adopted resources,
remote state, approved THB budget and release workflow, and
[the FL-58 acceptance record](docs/reviews/FL-58-acceptance.md) for the work handed to other issues.
Terraform checks run without cloud credentials on pull requests. The separate
Deploy workflow publishes digest-pinned images through GitHub OIDC and updates
dev after successful main CI, or demo for a `demo-*` tag. The private web-api
remote probe is `GET /health`; `/healthz` remains available locally. Schema-bearing
releases require a configured FL-60 dbmate job before application updates.
