# DL-01 seed loader

`seed.mjs` loads the synthetic DL-01 pipeline, its Segments and Facilities, and
Bowtie A into the database. It reads the generator and the seed file from
[data/synthetic/dl-01/](../../../data/synthetic/dl-01/); that directory's README
describes the command, the data and how `dev` and `demo` are loaded.

```sh
FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> pnpm db:seed:dl-01
```

`Dockerfile` builds the image of the Cloud Run job `db-seed-dl-01-<env>`. Build
it from the repository root.
