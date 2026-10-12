# Synthetic document corpus

This directory contains reviewed synthetic documents for the FieldLoop Demo A
Knowledge Library. The generator creates procedures, ILI reports, patrol logs,
root-cause analyses and engineering memos in Thai and English. Every record is
fictional, labelled **SYNTHETIC**, and marked `simulated: true`.

Napat Chenchai confirmed that all 240 documents passed human review on
12 October 2026 and explicitly requested recording those results. The checklist
records those human-supplied decisions with their existing content hashes.
The retained batch has 120 current revision-B documents and 120 superseded
revision-A documents; none are pending or failed. The assistant transcribed
the decisions and regenerated lifecycle annotations; it did not perform or
approve the human review.

## Generate the candidate batch

Run from the repository root:

```sh
node data/synthetic/corpus/generate.mjs
```

The deterministic batch contains 240 documents: 5 document types × 2
languages × 12 topics × 2 revisions. It writes Markdown files under
`documents/`, a machine-readable `manifest.json`, and `review-checklist.csv`.
`--output-dir <path>` writes a review copy elsewhere.

Each topic supplies its own focus, records and fictional finding, and each
series refers to its own SYNTHETIC Chainage range on DL-01, so no two documents
share a body. Revision B adds one section to revision A and records the change.
Folders follow the Pipeline Domain Pack structure in PRD KL-2.

## Human review gate

A reviewer must inspect every document and fill in `reviewer`, `decision`
(`pass` or `fail`), `reviewed_at` and `notes` in the checklist. Generation does
not perform or simulate that human-only review, and it rejects a decision that
has no reviewer or date. Each row also carries a `review_hash` binding the
authored text and metadata; do not edit that hash. Lifecycle annotations do not
change the hash. A changed template or edited candidate causes regeneration to
fail before overwriting files or decisions. Archive the old checklist, clear the
affected decision, regenerate, and have a person review the new candidate.
Legacy decisions without a bound hash must be reviewed again.

Run the generator again after recording decisions. It keeps what the checklist
records and applies it:

- `fail`: the document file and its manifest entry are removed. Its checklist
  row stays as the record of the decision.
- `pass`: `review_status` becomes `passed` and `status` becomes `current`, or
  `superseded` once the next revision has also passed.
- blank: the document stays a `draft` candidate with review pending.

Do not load a `draft` candidate as accepted Evidence. OCR and document parsing
are outside this task.

Before handing the reviewed batch to FL-70, run:

```sh
node data/synthetic/corpus/generate.mjs --check-delivery
```

This read-only check exits nonzero while any human decision is pending, if fewer
than 200 or more than 300 documents remain after removals, or when files,
manifest or checklist differ from the recorded reviewed batch. It writes no
decisions and performs no review. Use `--output-dir <path>` for a review copy.
The committed batch passes this check with 240 human-reviewed documents.
New or changed authored content still requires an actual human decision;
AI cannot supply those decisions.

Thai laws and 49 CFR source records are tracked separately under
[`../../corpus/legal/`](../../corpus/legal/). Legal status labels must be read
with their source and verification date; an item marked `status unverified` is
metadata-only and must not be presented as current law.
