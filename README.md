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
pnpm test:migrations
pnpm test:seed
```

`pnpm test:migrations` needs Docker. It builds the `db-migrate` image, runs
`dbmate up`, rolls back every migration and runs `up` again on an empty
PostgreSQL 16 with PostGIS and pgvector, then runs the SQL regression tests in `db/test`.

`pnpm test:seed` needs Docker and installed dependencies. It migrates an empty
database of the same kind and loads the DL-01 seed into it. Two failing loads
must leave every table empty: a seed file without `classification`, which the
loader rejects before it inserts, and a database error on the first Evidence
row, which must roll back the rows already inserted. A load and a re-load must
then pass `db/test/seed/dl_01_loaded.sql` and leave identical rows.

`pnpm db:seed:dl-01` loads the synthetic DL-01 pipeline and Bowtie A into the
database named by `FIELDLOOP_DATABASE_URL` for the Organisation
`FIELDLOOP_ORG_ID`. The loader is in [db/seed/dl-01/](db/seed/dl-01/); the data and the full
instructions are in [data/synthetic/dl-01/README.md](data/synthetic/dl-01/README.md).

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
The React entry point protects `/map` with a BFF session and displays verified
identity. Map layers are still pending FL-77.

### Developing the authenticated SPA

Vite proxies `/api` to `http://127.0.0.1:8080` by default. Start the configured
BFF separately; set its `FIELDLOOP_BASE_URL` to the **browser origin**, rather
than the upstream API address. For cookie/SSO development, use HTTPS:

```sh
mkdir -p apps/web/.local
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout apps/web/.local/key.pem -out apps/web/.local/cert.pem
FIELDLOOP_DEV_TLS_CERT="$PWD/apps/web/.local/cert.pem" \
FIELDLOOP_DEV_TLS_KEY="$PWD/apps/web/.local/key.pem" \
pnpm --filter @fieldloop/web dev
```

Open `https://localhost:5173` and trust the local certificate. The key/certificate
are ignored by Git. Set `FIELDLOOP_BASE_URL=https://localhost:5173` when starting
the API with its existing database/KMS/SSO configuration. The Keycloak client must
allow `https://localhost:5173/api/auth/callback` and post-logout return
`https://localhost:5173/`; coordinate those additions with the client owner.

`FIELDLOOP_DEV_API_TARGET` overrides the upstream address. Certificate verification
is enabled for HTTPS upstreams; `FIELDLOOP_DEV_API_INSECURE=true` is an explicit
local-only option for a self-signed upstream. These settings affect the dev server,
not the browser bundle or production build.

For credential-free verification, build first and run
`pnpm --filter @fieldloop/web test:e2e`. The same 11 browser cases run against both
the built SPA and Vite over HTTPS, using a scripted IdP and in-memory BFF store.
Both fixtures shut down gracefully and delete their temporary TLS files.

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
lint, OpenAPI lint, builds, the migration and seed tests, and a six-app Linux amd64 container build/startup matrix. It publishes
no images and provisions no cloud resources in the CI workflow. Action references are pinned to commits.

The path checker inspects only Git metadata for the index, HEAD and fetched
history. It rejects any `raw-data` path segment or `.kmz` extension, including
case variants and additions removed in later commits. Tests use empty Git blobs
and index metadata in temporary repositories, without opening prohibited files.

### Choosing the runner

Workflows read their runner from repository variables and run on GitHub-hosted
`ubuntu-latest` when a variable is not set:

| Variable | Workflows | Current value |
| --- | --- | --- |
| `CI_RUNNER` | `ci.yml`, `terraform.yml` | `["self-hosted","linux","x64","kaotor-ci"]` |
| `RELEASE_RUNNER` | `release.yml` (called by `deploy.yml`) | `["self-hosted","linux","x64","kaotor-release"]` |

```sh
gh variable list                                # show the current values

# Use the organisation's self-hosted runners
gh variable set CI_RUNNER --body '["self-hosted","linux","x64","kaotor-ci"]'
gh variable set RELEASE_RUNNER --body '["self-hosted","linux","x64","kaotor-release"]'

# Go back to GitHub-hosted runners
gh variable delete CI_RUNNER
gh variable delete RELEASE_RUNNER
```

The value must be a JSON array or a JSON string; anything else fails every job
that reads it. A change applies to the next run. Do not point `RELEASE_RUNNER`
at the `kaotor-ci` runners: release jobs can obtain the deploy service account
and must not share a runner with pull request code.

Limits of the self-hosted runners: two CI jobs and one release job run at a
time, and images, build cache and workspaces survive between jobs, so a job
must not depend on a clean machine. They are operated from
[Core-CI-Platform](https://github.com/Kaotor-Technology/Core-CI-Platform); see its
[runbook](https://github.com/Kaotor-Technology/Core-CI-Platform/blob/main/docs/runbook.md)
when a job stays queued.

## GCP infrastructure and releases

See [the FL-58 operator handoff](infra/terraform/README.md) for the adopted resources,
remote state, approved THB budget and release workflow, and
[the FL-58 acceptance record](docs/reviews/FL-58-acceptance.md) for the work handed to other issues.
Terraform checks run without cloud credentials on pull requests. The separate
Deploy workflow publishes digest-pinned images through GitHub OIDC and updates
dev after successful main CI, or demo for a `demo-*` tag. The private web-api
remote probe is `GET /health`; `/healthz` remains available locally. Schema-bearing
releases require a configured FL-60 dbmate job before application updates.
