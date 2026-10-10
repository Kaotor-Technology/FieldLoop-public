# Synthetic document corpus

This directory contains candidate documents for the FieldLoop Demo A
Knowledge Library. The generator creates procedures, ILI reports, patrol logs,
root-cause analyses and engineering memos in Thai and English. Every record is
fictional, labelled **SYNTHETIC**, marked `simulated: true`, and remains in
`draft` status with human review pending.

## Generate the candidate batch

Run from the repository root:

```sh
node data/synthetic/corpus/generate.mjs
```

The deterministic batch contains 240 documents: 5 document types × 2
languages × 12 topics × 2 revisions. It writes Markdown files under
`documents/`, a machine-readable `manifest.json`, and a blank
`review-checklist.csv`. `--output-dir <path>` writes a review copy elsewhere.
Revision B references revision A as superseded, but neither revision is
promoted to an approved or current document by generation.

## Human review gate

A reviewer must inspect every document, record a decision and notes in the
checklist, and remove failed documents from any accepted batch. Generation does
not perform or simulate that human-only review. Do not load candidate files as
accepted Evidence or change their status until a person records the review.
OCR and document parsing are outside this task.

Thai laws and 49 CFR source records are tracked separately under
[`../../corpus/legal/`](../../corpus/legal/). Legal status labels must be read
with their source and verification date; an item marked `status unverified` is
metadata-only and must not be presented as current law.
