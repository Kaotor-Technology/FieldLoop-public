# Legal corpus loader

The data, source provenance and operator commands are in
[data/corpus/legal/README.md](../../../data/corpus/legal/README.md).

`upload.mjs` prepares a verified object-store handoff through the BlobStore
adapter. `seed.mjs` validates that handoff and loads Controlled Documents in
one transaction. Neither runs automatically during a build or release.

Changing a revision or its already-bound source fails the entire load; source
refreshes must use a new Controlled Document and the supersession workflow.

## On-demand dev/demo job after merge

Build `db/seed/legal-corpus/Dockerfile` from the repository root and publish it
as `v2-db-seed-legal-corpus` in the approved Artifact Registry repository.
Set `legal_seed_images` in Terraform to each environment's image digest, with
its existing `migration_secret_versions` entry. Apply the reviewed Terraform
plan, then execute `db-seed-legal-corpus-dev` / `db-seed-legal-corpus-demo`.
The job uses the environment's migration identity, private SQL network and
storage handoff. It runs once without retries and is absent by default.
It does not fetch credentials onto a workstation or execute on release.
