# @fieldloop/contracts

API and message contracts shared by the TypeScript and Python services
([architecture §1](../../docs/architecture.md#1-folder-structure)).

| File | Holds |
| --- | --- |
| `openapi.yaml` | The OpenAPI 3.1 contract of the platform API. Today it is the base: shared components and no paths. |
| `.spectral.yaml` | The Spectral ruleset that enforces the conventions below. |
| `test/` | Fixtures and a test that prove each rule fires, and that conforming paths pass. |

Clients are generated from `openapi.yaml`, never written by hand (AGENTS.md §2).
Client generation and the JSON Schemas for Signals and Scenarios arrive with
their own issues.

## Checks

```sh
pnpm lint:api                             # from the repository root; CI runs this
pnpm --filter @fieldloop/contracts test   # ruleset tests
```

Every finding fails the lint, warnings included.

## Adding an endpoint

Add the path to `openapi.yaml` in the issue that implements the feature, reuse
the shared components, and run `pnpm lint:api`.
[`test/fixtures/conforming.yaml`](test/fixtures/conforming.yaml) is a worked
example of a list and a command.

## Conventions

The **Rule** column names the Spectral rule. "Review" means no rule checks it,
so the reviewer does.

| Convention | Rule |
| --- | --- |
| OpenAPI 3.1 | `fieldloop-openapi-3-1` |
| Paths start with `/v1/`. The only other roots are `/auth/`, `/guardrail/v1/` and `/internal/`. | `fieldloop-path-prefix` |
| Path segments are lowercase kebab-case; path parameters are `{camelCase}`. | `fieldloop-path-kebab-case` |
| Resources are plural nouns: `/v1/health-proposals`. | Review |
| A command is `POST …/{id}:verb` with one kebab-case verb, and defines no other method. | `fieldloop-path-kebab-case`, `fieldloop-command-post-only` |
| A consequential command takes `Idempotency-Key` (`#/components/parameters/IdempotencyKey`). | Review |
| `operationId`, JSON properties and query parameters are camelCase. | `fieldloop-operation-id-camel-case`, `fieldloop-property-camel-case`, `fieldloop-query-camel-case` |
| Every operation has an `operationId`, a description and a declared tag. | `operation-operationId`, `operation-description`, `operation-tags`, `operation-tag-defined` |
| Every 4xx and 5xx response is `application/problem+json` (RFC 9457) with the shared `Problem` schema. Reuse `#/components/responses/*`. | `fieldloop-error-problem-json`, `fieldloop-error-problem-schema` |
| Responses list status codes; no `default`. | `fieldloop-no-default-response` |
| Errors carry a stable `code` from `ErrorCode`. Add a value there before a service returns it. | Review |
| The session cookie `fl_session` is the default security requirement. A public endpoint says `security: []`. | `fieldloop-session-cookie-scheme`, `fieldloop-global-session-security` |
| No OAuth 2, OpenID Connect or query-string key scheme: the browser holds no token (ADR-0008). | `fieldloop-no-browser-token-scheme` |
| Every non-GET `/v1` operation on a session takes `X-CSRF-Token` (`#/components/parameters/CsrfToken`). | `fieldloop-csrf-on-unsafe-methods` |
| A list takes `cursor` and `limit`, and returns `CursorPage` composed with a required `items` array. | Review |
| Enum values are lowercase `snake_case` ([glossary](../../docs/glossary.md)). | Review |

### Error codes

| `code` | Status | When |
| --- | --- | --- |
| `validation_failed` | 400 | The body, a query parameter or a header is invalid; `errors` lists each field. |
| `unauthenticated` | 401 | There is no valid session. |
| `forbidden` | 403 | The user's role, clearance or Asset scope does not allow this. |
| `csrf_token_invalid` | 403 | `X-CSRF-Token` is missing or wrong. |
| `reauthentication_required` | 403 | An approval needs a login newer than the allowed `authTime` age. |
| `not_found` | 404 | The resource does not exist, or the user may not know that it does. |
| `conflict` | 409 | The resource is not in a state that allows this. |
| `idempotency_key_reused` | 409 | The `Idempotency-Key` was used before with a different body. |
| `payload_hash_mismatch` | 409 | The `payloadHash` sent with an approval is not the current payload's hash. |
| `rate_limited` | 429 | Too many requests; see `Retry-After`. |
| `internal_error` | 500 | Unexpected failure. |
| `service_unavailable` | 503 | A dependency is down; see `Retry-After`. |
