# Legal source records for the Knowledge Library

`manifest.json` contains 16 Thai legal or planning records and the two
requested 49 CFR parts. It records source links, revision, status, folder,
classification, licence note and whether a full text snapshot is present.

The Thai records are metadata-only in this batch. Items marked `status
unverified` remain in that status and have no body file. The Thai-law research
note calls out these items for human status review. Other Thai statuses reflect
that research note and linked agency sources; they are not a consolidated legal
opinion. The ETDA item is explicitly a draft. Legal text reuse rights should be
confirmed before copying or publishing the Thai material.

The 49 CFR Part 192 and Part 195 files are extracted from the official GovInfo
current eCFR Title 49 XML snapshot updated 2026-10-06. They are full XML
documents, with the source URL and snapshot date stored in the manifest. ASME
and API standards named by reference remain outside this corpus. The records
can be seeded into `controlled_document` without connecting to a database by
running:

```sh
node data/corpus/legal/seed.mjs --print-sql --org-id demo-pipeline
```

The seed creates metadata records. `blob_uri` remains null because this repo
has no object-storage uploader; the full-text XML remains in this directory
until a deployment uploads it to the approved document store. The FL-70 indexer
owns chunk creation and retrieval indexing. Do not mark a Thai item current
until its status and source text have been reviewed by a person.

Re-running the seed refreshes source metadata while preserving the
`superseded_by` link and `blob_uri` once a person or storage step has set them.
A record that is still `status unverified` takes its status from the manifest,
so a verified status recorded there reaches the database on the next run. Any
other stored status is kept. A changed revision is rejected transactionally;
create a new document key and supersede the old record through the document
workflow. This prevents a new revision label from pointing to an old blob.

Source links point to public agencies only. Do not link to an Organisation's
website.
