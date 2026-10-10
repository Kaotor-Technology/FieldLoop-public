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

The target database must have the FL-60 schema migrated. Install repository
dependencies with **pnpm install --frozen-lockfile** before running the loader.
Set **FIELDLOOP_ORG_ID** to the Organisation key used by the application, and
set **FIELDLOOP_DATABASE_URL** from the approved local secret source. The loader
uses Kysely with the PostgreSQL driver, parameter bindings and a single
transaction. Stable IDs make re-running it update the same records.

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

Assets and Segments are marked **simulated=true**. The Asset attributes and
GeoJSON features carry the **SYNTHETIC** label, and all rows use the **internal**
classification. The route and Facility shape can be regenerated without
database access.
