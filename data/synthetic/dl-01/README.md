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
same records.

```sh
FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> \
  node data/synthetic/dl-01/seed.mjs
```

To inspect generated SQL and its parameter bindings without a database connection:

```sh
node data/synthetic/dl-01/seed.mjs --print-sql --org-id demo-pipeline
```

**--print-sql** emits a JSON array of **sql** and **parameters** pairs. Values,
including Organisation IDs, GeoJSON and Asset attributes, stay outside the SQL
text. This preview is for inspection; it is not a standalone SQL script for psql.

Every loaded record is marked **simulated=true** and uses the **internal**
classification. The Asset attributes, GeoJSON features and Bowtie A metadata
carry the **SYNTHETIC** label. Bowtie A's rate and probability inputs are
illustrative simulation values, not operating measurements or a QRA.

Cathodic-protection Evidence is dated **2025-10-13** with a **12-month** interval.
The fixture's simulation clock starts **2026-10-12**, so Scenario A's `T+3d`
Evidence-ageing event occurs after that interval has passed. The older Evidence
record remains in the history.

## Test the load

Run **pnpm test:seed** from the repository root. It needs Docker. It loads this
seed twice into an empty, migrated PostgreSQL and checks the rows; the root
README describes the cases.

The route and Facility shape can be regenerated without database access.
