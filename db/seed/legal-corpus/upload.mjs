import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGoogleCloudBlobStore } from "../../../packages/adapters/dist/index.js";
import { readManifest, validateManifest } from "./seed.mjs";

const CORPUS_URL = new URL("../../../data/corpus/legal/", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Upload source PDFs/XML plus native-text copies; only then emit a DB handoff. */
export async function uploadCorpus(store, bucket, manifest = readManifest(), sourceDirectory) {
  validateManifest(manifest);
  const records = [];
  for (const record of manifest.records) {
    if (record.contentState !== "full_text_snapshot") continue;
    const text = await readFile(new URL(record.contentPath, CORPUS_URL));
    const textType = record.contentPath.endsWith(".xml") ? "application/xml" : "text/plain; charset=utf-8";
    const textBlobUri = await store.put(`legal/${record.documentKey}/${record.contentSha256}/text`, text, textType);
    let blobUri = textBlobUri;
    if (record.sourceSnapshotUrl) {
      const url = new URL(record.sourceSnapshotUrl);
      if (!/\.(go\.th|or\.th|gov)$/.test(url.hostname) || !["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Invalid public agency source for ${record.documentKey}.`);
      }
      let bytes;
      if (sourceDirectory) {
        bytes = await readFile(resolve(sourceDirectory, `${record.documentKey}.pdf`));
      } else {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
        if (!response.ok) throw new Error(`Source fetch failed for ${record.documentKey}: ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || digest(bytes) !== record.sourceSha256) {
        throw new Error(`Original source hash mismatch for ${record.documentKey}.`);
      }
      blobUri = await store.put(`legal/${record.documentKey}/${record.sourceSha256}/source.pdf`, bytes, "application/pdf");
    }
    records.push({ documentKey: record.documentKey, revision: record.revision, contentSha256: record.contentSha256,
      indexingEligibility: record.indexingEligibility,
      ...(record.sourceSha256 ? { sourceSha256: record.sourceSha256 } : {}), blobUri, textBlobUri });
  }
  return { schemaVersion: 1, bucket, records };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!["--bucket", "--output", "--source-directory"].includes(name) || !value || value.startsWith("--")) {
      throw new Error("Usage: upload.mjs --bucket <private-docs-bucket> --output <storage-manifest.json> [--source-directory <verified-pdfs>]");
    }
    options[name] = value;
  }
  if (!options["--bucket"] || !options["--output"]) throw new Error("--bucket and --output are required.");
  const report = await uploadCorpus(await createGoogleCloudBlobStore(options["--bucket"]), options["--bucket"],
    readManifest(), options["--source-directory"]);
  await mkdir(dirname(resolve(options["--output"])), { recursive: true });
  await writeFile(options["--output"], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Verified ${report.records.length} stored source documents in ${report.bucket}.\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
