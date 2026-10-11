# Synthetic DL-01 route and Asset seed

This directory contains a deterministic synthetic route, its Segments and
three block valve Station Facilities. The route is 180,000 m long and is
labelled SYNTHETIC. Coordinates are hand-authored control points near Lampang,
Phayao and Chiang Rai. They do not trace a real pipeline or road. The map's
terrain and surrounding features come from the basemap at render time.

## Generate GeoJSON

Run from the repository root:

```sh
node data/synthetic/dl-01/generate.mjs
```

The generator writes **route.geojson**, **segments.geojson** and
**facilities.geojson** in this directory. It accepts **--output-dir** for
temporary or review copies.

## Load the seed

The target database must have the FL-60 schema and Bowtie seed fields migrated.
Install repository dependencies with **pnpm install --frozen-lockfile** before
running the loader.
Set **FIELDLOOP_ORG_ID** to the Organisation key used by the application, and
set **FIELDLOOP_DATABASE_URL** from the approved local secret source. The loader
creates the Asset, Facilities, Segments and Bowtie A records from
**bowtie-a.json** in one command. It uses Kysely with the PostgreSQL driver,
parameter bindings and one transaction. Stable IDs make re-running it update the
same records. In the same transaction it then removes rows that an earlier run
of this seed loaded (**created_by** is **seed:dl-01**) and that are no longer in
the seed files. It never removes a row it did not create; if such a row still
references a stale seed row, the load fails and changes nothing. It also loads one
**organisation** row for the Organisation and never removes that row.

```sh
FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> pnpm db:seed:dl-01
```

For `dev` and `demo`, **FIELDLOOP_ORG_ID** is the Terraform variable
**demo_org_id** (default `fieldloop-demo`). `web-api` gives that value to every
demo account as **FIELDLOOP_DEFAULT_ORG_ID**, so rows seeded under another key
are not visible to them.

After the load the command reads the database back and prints the row count of
each seeded table for that Organisation, the number of DL-01 pipeline Assets,
and the Chainage its Segments cover with the number of gaps or overlaps.

**FIELDLOOP_DATABASE_URL** may name a Unix socket directory with an empty host
and **?socket=** or **?host=**, the form dbmate and Cloud SQL use.

## Load into dev or demo

`dev` and `demo` are loaded by the Cloud Run job **db-seed-dl-01-<env>**, not
from a workstation. The job runs the image built from
**db/seed/dl-01/Dockerfile** as the migration identity of its environment, with the database URL
from Secret Manager. Nothing runs it automatically. The operator steps are in
[infra/terraform/README.md](../../../infra/terraform/README.md).

```sh
gcloud run jobs execute db-seed-dl-01-dev --region asia-southeast1 --wait
```

To inspect generated SQL and its parameter bindings without a database connection:

```sh
node db/seed/dl-01/seed.mjs --print-sql --org-id demo-pipeline
```

**--print-sql** emits a JSON array of **sql** and **parameters** pairs. Values,
including Organisation IDs, GeoJSON and Asset attributes, stay outside the SQL
text. This preview is for inspection; it is not a standalone SQL script for psql.

Every loaded record is marked **simulated=true** and classified by PRD §9.1:
Asset and Segment rows are **HIGHLY_RESTRICTED** (Asset geometry), Bowtie A,
Barrier and Evidence rows are **CONFIDENTIAL**, and the Organisation row is
**INTERNAL**. Route, Facility and Segment rows take both values from their own
generated feature, and Bowtie A rows from the seed file's metadata; the loader
rejects a feature or seed file without them, or with a class outside the four
PRD classes, before it inserts. The Asset attributes, GeoJSON features and Bowtie A metadata
carry the **SYNTHETIC** label. Bowtie A's rate and probability inputs are
illustrative simulation values, not operating measurements or a QRA.

Cathodic-protection Evidence is dated **2025-10-13** with a **12-month** interval.
The fixture's simulation clock starts **2026-10-12**, so Scenario A's `T+3d`
Evidence-ageing event occurs after that interval has passed. The older Evidence
record remains in the history. Every other Barrier has two Evidence records,
dated **2025-09-15** and **2026-09-15**; the loader rejects a Barrier with
fewer than two.

## Test the load

Run **pnpm test:seed** from the repository root. It needs Docker. It loads this
seed twice into an empty, migrated PostgreSQL and checks the rows; the root
README describes the cases.

The route and Facility shape can be regenerated without database access.
