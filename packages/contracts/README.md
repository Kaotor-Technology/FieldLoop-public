# @fieldloop/contracts

## API reference (FL-68 / FL-135)

`pnpm --filter @fieldloop/contracts build:reference` generates `dist/reference/`
from `openapi.yaml`, with linked operations/components, complete JSON definitions,
downloadable YAML/JSON and a source SHA-256. The static renderer escapes all spec
content. It supports local JSON Pointer references, including recursive schemas;
unresolved or external `$ref` values fail the build rather than fetching content.
Markdown in descriptions is displayed as text. There is no request execution UI.

The CI **Build API reference** job lints the spec, builds the reference and retains
the artifact for seven days. The contracts package build also generates the same
files. `web-api` depends on contracts, so its existing Docker/Turbo build and pnpm
production deployment carry the reference in the image. Spec-only changes affect
`web-api` through that dependency, and the trusted release workflow deploys the
new image to `dev` after successful CI on `main`.

Open `https://fieldloop-dev.kaotor.com/api/reference/` after the release. Locally,
build the workspace and start the BFF with its normal SSO configuration, then open
`/api/reference/` on that origin. Vite's existing `/api` proxy serves it too.
Signed-out document navigation redirects through the BFF login route. Every
document, spec, script, stylesheet and font requires the opaque cookie session;
revocation and IdP errors use the existing fail-closed BFF checks. Responses use
`private, no-store`, `noindex` and a same-origin CSP. Fonts and design values come
from the existing IBM Plex packages and `DESIGN.md`; no CDN is needed.

The Cloud Run IAM/DNS/Keycloak origin prerequisites remain those of FL-59. This
feature does not change public invoker access. Before claiming the dev page is
delivered, verify the deployed image and a real SSO round trip on that environment.

API and message contracts shared by the TypeScript and Python services
([architecture §1](../../docs/architecture.md#1-folder-structure)).

| File | Holds |
| --- | --- |
| `openapi.yaml` | The OpenAPI 3.1 contract of the platform API, including BFF auth/session routes and the shared components used by feature paths. |
| `.spectral.yaml` | The Spectral ruleset that enforces the conventions below. |
| `functions/shared-problem.js` | Checks resolved schema provenance against the canonical shared Problem, including cross-file response aliases. |
| `test/` | Fixtures and a test that prove each rule fires, and that conforming paths pass. |

Clients are generated from `openapi.yaml`, never written by hand (AGENTS.md §2).
Scenario contracts arrive with their own issue.

## Signal contract (FL-73 / FL-148)

`signal.v1.schema.json` is the canonical Draft 2020-12 wire contract. Real
connectors and simulated sources use the same camelCase envelope. Every message
states `schemaVersion`, producer-assigned UUID `id`, `orgId`, `source`, `tag`,
`value`, RFC 3339 `observedAt`, `simulated` and uppercase `classification`.
There are no provenance defaults. Signal and optional Asset/Barrier/run IDs use
plain hyphenated UUID text; URN prefixes, braces and compact forms are rejected.
Observation timestamps use years 0001–9999 and seconds 00–59; leap seconds and
year zero are rejected consistently by both validators.
Organisation, source and tag identifiers and observation timestamps reject all
carriage returns and line feeds.
`value` supports numeric measurements, status strings, flags and null for an
unavailable observation. Numbers must be in the finite binary64 interval
[-1.7976931348623157e308, 1.7976931348623157e308], including Python integers.
The generated Python numeric alias preserves scalar values on model serialization.
Source-specific detail (including GeoJSON) lives in
`payload`, and the consumer validates the Domain Pack's detail. A message
does not authorise a Health change. Consumers should persist numeric observations
in `signal.value` and preserve the entire envelope in `signal.payload` (FL-76).

`pnpm --filter @fieldloop/contracts generate:signal` generates TypeScript types
and the bundled schema; build runs it automatically. Import `Signal`,
`signalSchema` and `isSignal` from `@fieldloop/contracts`.

`uv run --locked --all-packages python scripts/generate-signal.py` generates
`fieldloop_common.generated_signal.Signal` with snake_case field names and wire
aliases, plus a packaged copy of the schema. Python outputs are committed so
wheels and containers need no generator at runtime. CI regenerates them and
rejects drift. Use `fieldloop_common.signal.parse_signal` on wire input before
Pydantic coercion; serialize models with `model_dump(mode="json", by_alias=True,
exclude_unset=True)`. Both languages validate with the canonical schema without
defaults, coercion or field removal and run the same JSON acceptance fixtures.
Environment routing is transport metadata, rather than part of the Signal.

### Validating publishers (FL-149)

TypeScript: compose `SignalPublisher` and `GooglePubSubTransport` from
`@fieldloop/adapters`, passing an SDK `PubSub` client configured for the project
(ADC in Cloud Run, `PUBSUB_EMULATOR_HOST` locally). Python: compose
`fieldloop_common.signal_publisher.SignalPublisher` and
`fieldloop_common.google_pubsub.GooglePubSubTransport`, passing an SDK
`PublisherClient` and `project_id`. The injected `MessageTransport` port also
supports an on-premise queue implementation without changing the wire contract.

Both publishers require the deployment's Organisation key, environment
(`dev`, `demo` or `local`) and explicit `simulationOnly` / `simulation_only`.
Mock sources and the Scenario player must set it to true; real connectors set
it to false. Environment and Organisation attributes come from configuration,
and cannot be overwritten by message input. Match the environment to the
existing Terraform subscription filter. Signals default to topic `signals`;
quarantine defaults to `fieldloop-v2-dead-letter`. Both publishers accept only
short topic IDs (3–255 characters, starting with a letter, followed by letters,
digits or `._~+%-`). Full resource paths and whitespace are rejected before
transport, so a short ID and its full-name alias cannot refer to the same signal
and quarantine destination. Give the runtime identity `roles/pubsub.publisher` on both topics;
the existing Pub/Sub service-agent DLQ grant only covers subscription forwarding.
The adapter creates no topics, subscriptions, credentials or IAM grants.

Valid input is sent unchanged as UTF-8 JSON, with `schemaVersion`, `signalId`,
`orgId`, `environment`, `classification` and `simulated` attributes. Invalid
JSON-shaped input, a foreign Organisation or a real-labelled mock observation
is sent **only** to quarantine, preserving its serialized body and adding
`failureReason` (`validation_failed`, `org_mismatch`, `simulation_required`).
Malformed provenance is not trusted: quarantine metadata is always
`HIGHLY_RESTRICTED`, and must be reviewed in the same private boundary. The
result reports `published` or `dead_lettered` with the acknowledged message ID;
callers must handle both outcomes. The library never logs bodies or values.

Non-JSON values (including non-finite numbers, cycles, tuples/Date objects,
undefined and non-string keys), nesting beyond 64 levels, and bodies larger
than 256 KiB raise before transport. They cannot be safely quarantined as this
wire format; callers must report the input error without logging sensitive
values. Pub/Sub failures on either destination propagate: failed sends are not
reclassified as validation failures. The Python SDK acknowledgement wait has
a configurable 30-second timeout. Cancellation/timeouts may leave a send in
flight; retry with the same producer `id`. Delivery is at least once, so the
consumer must deduplicate by environment + Organisation + Signal ID (FL-76).
Shutdown belongs to the caller: await publishes, then close/stop SDK clients.

After building adapters, run the credential-free integration check with a
loopback Pub/Sub emulator:

```sh
PUBSUB_EMULATOR_HOST=127.0.0.1:8685 uv run --locked --all-packages python scripts/test-signal-publisher.py
```

The script refuses real-cloud endpoints, creates unique test topics and
subscriptions, sends valid/invalid messages with both SDKs, verifies the
received bodies and attributes, and deletes its emulator resources. CI runs
the same check using a digest-pinned Docker emulator with a random loopback
port. Unit tests additionally cover SDK acknowledgement errors and timeouts.

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
| Paths start with `/v1/`. The only other roots are `/auth/`, `/guardrail/v1/` and `/internal/`, so the ruleset also fits a contract for the Guardrail gateway or the internal endpoints. `openapi.yaml` itself is the `web-api` contract. | `fieldloop-path-prefix` |
| Path segments are lowercase kebab-case; path parameters are `{camelCase}`. | `fieldloop-path-kebab-case` |
| Resources are plural nouns: `/v1/health-proposals`. | Review |
| A command is `POST …/{id}:verb` with one kebab-case verb, and defines no other method (`head`, `options` and `trace` included). | `fieldloop-path-kebab-case`, `fieldloop-command-post-only` |
| A POST `:verb` command takes required `Idempotency-Key` (`#/components/parameters/IdempotencyKey`). A stateless command may instead declare a nonempty `x-idempotency-exempt` reason. Review must verify the exemption has no persistent effects. Consequential POSTs without `:verb` still require review. | `fieldloop-command-idempotency` and Review |
| `operationId`, JSON properties and query parameters are camelCase. | `fieldloop-operation-id-camel-case`, `fieldloop-property-camel-case`, `fieldloop-query-camel-case` |
| Every operation has an `operationId`, a description and a declared tag. | `operation-operationId`, `operation-description`, `operation-tags`, `operation-tag-defined` |
| Every 4xx and 5xx response is `application/problem+json` (RFC 9457). Its schema is a `$ref` to the shared `Problem`, or an `allOf` that includes that `$ref`; an inline look-alike or another file’s schema named `Problem` fails. Cross-file response aliases are followed to the canonical `openapi.yaml` schema. Reuse `#/components/responses/*`. | `fieldloop-error-problem-json`, `fieldloop-error-problem-schema` |
| Responses list status codes; no `default`. | `fieldloop-no-default-response` |
| Errors carry a stable `code` from `ErrorCode`. Add a value there before a service returns it. | Review |
| The session cookie `fl_session` is the default security requirement. A public endpoint says `security: []`. | `fieldloop-session-cookie-scheme`, `fieldloop-global-session-security` |
| No OAuth 2, OpenID Connect or query-string key scheme: the browser holds no token (ADR-0008). | `fieldloop-no-browser-token-scheme` |
| Every non-GET operation (PUT, POST, PATCH, DELETE, HEAD, OPTIONS and TRACE) that uses the session takes `X-CSRF-Token` (`#/components/parameters/CsrfToken`), listed in the operation's own `parameters`, not the path item's. Only an operation whose `security` leaves out `sessionCookie` (for example `security: []`) is exempt. | `fieldloop-csrf-on-unsafe-methods` |
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

### Stateless command exemptions

Use `x-idempotency-exempt: "Pure risk calculation; no persistent effects."` on
an operation only when retrying it cannot change state or cause an external effect.
The lint verifies the presence of a non-whitespace reason, not whether the
operation is stateless. An approval, notification, ingestion or mutation must
never use this exemption. Header references are resolved before validation.

### Accepted policy and limits

The stakeholder accepted these conventions on 10 October 2026; see
[decisions.md](../../docs/decisions.md). List limits are default 50 and maximum
200; idempotency keys are 16–128 characters. Runtime retry storage, expiry and
scope must be specified by the feature that implements consequential operations.
The base contract does not implement runtime CSRF or idempotency enforcement.
