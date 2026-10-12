# Legal source snapshots for the Knowledge Library

`manifest.json` lists 16 Thai legal/planning records and 49 CFR Parts 192/195.
`status` is the document lifecycle (`current`, `superseded`, `withdrawn`, `draft`,
or the required `status unverified` exception). `legalStatus` records the
research label separately, such as `in force` or `current plan period`.

Nine records have source snapshots (five current, four quarantined drafts): seven Thai PDFs captured on
12 October 2026, and two CFR XML snapshots dated 6 October 2026. The Thai `.txt`
files retain native PDF text and PDF page boundaries. No OCR was performed;
figures and scanned-only content remain in the original PDFs in the private
object store. The Water Resources source is the ONWR July 2023 compilation,
including subordinate legislation; its source pages are compilation pages.
These copies do not certify subsequent amendments or a consolidated current
legal opinion. A person must check legal currency and text-extraction quality
before using them in the demo.

### Known extraction limitation (FL-65 review)

The Water Resources native-text snapshot contains unmapped private-use glyphs
and replacement characters, including whole unreadable lines. The Energy
Industry, national disaster plan and Bangkok disaster plan snapshots also contain
private-use marks. Matching a SHA-256 proves byte identity, not searchable text
quality. These four snapshots have `indexingEligibility: quarantined`, an
`indexingHoldReason` and lifecycle `draft`. The loader retracts previously
`current` records to `draft` while preserving withdrawn/superseded decisions.
Their original PDFs, text bytes, revisions, hashes and object URIs are retained.
They must remain outside retrieval until source-PDF comparison, font
mapping/re-extraction and human verification are complete. An `eligible` text
containing private-use or replacement characters is rejected by validation.
Do not silently rewrite immutable text or storage bindings, or
treat the retained original PDF as proof that the extracted text is usable.
OCR remains outside FL-65 scope; any OCR or revised snapshot requires its own
reviewed change and refreshed provenance/handoff.

Eight flagged Thai records remain `status unverified`, metadata-only, without
source URIs. The ETDA draft reference remains `draft` and metadata-only; this
batch does not substitute its press release for the draft legal instrument.
ASME/API copyrighted text is not ingested.

## Upload immutable sources

Build the adapters first, then upload to the existing private docs bucket:

```sh
pnpm exec turbo run build --filter=@fieldloop/adapters...
node db/seed/legal-corpus/upload.mjs \
  --bucket example-project-fieldloop-dev-docs \
  --output data/corpus/legal/storage/dev.json
```

For demo, substitute `fieldloop-demo-docs` and `storage/demo.json`. The uploader
checks source SHA-256, uses create-only content-addressed objects, downloads
stored bytes to verify them, and emits the handoff only after every source
succeeds. `--source-directory <directory>` uses verified cached PDFs named
`<documentKey>.pdf`, avoiding government-site availability during reruns.
It never creates a bucket or grants public access. Credentials use ADC.

## Load Controlled Documents

```sh
node db/seed/legal-corpus/seed.mjs --print-sql --org-id fieldloop-demo \
  --storage-manifest data/corpus/legal/storage/dev.json

FIELDLOOP_ORG_ID=fieldloop-demo FIELDLOOP_DATABASE_URL=<postgres-url> \
  node db/seed/legal-corpus/seed.mjs \
  --storage-manifest data/corpus/legal/storage/dev.json
```

A real load requires a complete storage handoff matching source hashes,
revision and URI. Use the manifest of the same environment as the database.
Seed reruns preserve human-managed withdrawn/superseded status, supersession and existing
source bindings. Legacy `in force` / `current plan period` labels are migrated
to lifecycle status. Changing a revision or replacing its existing source is
rejected and rolls back every write. A new revision needs a new document key
and the normal supersession workflow.

The dev/demo database load runs through the project's migration-identity job
workflow after merge; do not retrieve the migration secret on a workstation.
Object-store handoffs do not prove a Cloud SQL load or retrieval/indexing.
FL-70 owns chunk creation and indexing. Export its input with:

```sh
node db/seed/legal-corpus/seed.mjs --print-indexing-handoff --org-id fieldloop-demo \
  --storage-manifest data/corpus/legal/storage/demo.json > /tmp/legal-indexing-demo.json
```

This read-only command validates provenance and emits only `current` / `eligible`
native-text inputs (five in this batch). Use the matching environment report.
Raw storage reports include quarantined artifacts for provenance and must not
be used as indexing input. Before chunking, FL-70 must also check that each
`documentId` is still `current` in the target Organisation's database, preserving
subsequent human lifecycle changes. Eligibility is not human legal approval.
Source URLs, legal labels, PDF page metadata
and SHA-256 values remain in the versioned corpus manifest.

## Verification

- `pnpm test` covers manifest, storage binding, upload failure and review hashes.
- `pnpm test:seed:legal` uses isolated PostgreSQL 16 with the current migrations
  to check reruns, source URIs, revision rollback and human lifecycle preservation.
- Storage reports under `storage/` contain no credentials and can be inspected
  without querying a database. They record uploads, not human legal verification.
