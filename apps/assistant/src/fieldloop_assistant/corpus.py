"""Consume FL-65's reviewed synthetic delivery and eligible legal handoff only."""

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5


@dataclass(frozen=True)
class DocumentSource:
    id: UUID
    title: str
    revision: str
    folder: str
    status: str
    classification: str
    simulated: bool
    blob_uri: str
    text: str
    format: str
    asset_code: str | None = None
    chainage_from: int | None = None
    chainage_to: int | None = None


def _body(root: Path, relative: str) -> str:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix not in {".md", ".txt", ".xml"}:
        raise ValueError("Unsafe corpus content path")
    return path.read_text(encoding="utf-8")


def load_corpus(repo: Path, org_id: str, storage: Path) -> list[DocumentSource]:
    if not org_id.strip():
        raise ValueError("Organisation is required")
    # The read-only delivery gate verifies content-bound human decisions, not just manifest flags.
    subprocess.run(
        ["node", str(repo / "data/synthetic/corpus/generate.mjs"), "--check-delivery"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    synthetic = repo / "data/synthetic/corpus"
    manifest = json.loads((synthetic / "manifest.json").read_text())
    sources = []
    for record in manifest["documents"]:
        if record["status"] != "current":
            continue
        key = record["documentId"]
        sources.append(
            DocumentSource(
                id=uuid5(NAMESPACE_URL, f"fieldloop:fl-70:{org_id}:{key}"),
                title=record["title"],
                revision=record["revision"],
                folder=record["folder"],
                status="current",
                classification=record["classification"],
                simulated=True,
                blob_uri=f"synthetic://corpus/{key}",
                text=_body(synthetic, record["contentPath"]),
                format="markdown",
                asset_code=record["assetCode"],
                chainage_from=record["chainageFrom"],
                chainage_to=record["chainageTo"],
            )
        )
    # This existing FL-65 entrypoint validates all hashes, storage bindings and quality holds.
    result = subprocess.run(
        [
            "node",
            str(repo / "db/seed/legal-corpus/seed.mjs"),
            "--print-indexing-handoff",
            "--org-id",
            org_id,
            "--storage-manifest",
            str(storage.resolve()),
        ],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    handoff = json.loads(result.stdout)
    legal = repo / "data/corpus/legal"
    legal_manifest = json.loads((legal / "manifest.json").read_text())
    bindings = json.loads(storage.read_text())
    for item in handoff["records"]:
        record = next(
            r for r in legal_manifest["records"] if r["documentKey"] == item["documentKey"]
        )
        blob = next(r for r in bindings["records"] if r["documentKey"] == item["documentKey"])
        text = _body(legal, record["contentPath"])
        if hashlib.sha256(text.encode()).hexdigest() != item["contentSha256"]:
            raise ValueError("Legal indexing content differs from its source binding")
        title = (
            f"{record['titleTh']} — {record['titleEn']}" if record["titleTh"] else record["titleEn"]
        )
        sources.append(
            DocumentSource(
                id=UUID(item["documentId"]),
                title=title,
                revision=item["revision"],
                folder=record["folder"],
                status="current",
                classification="PUBLIC",
                simulated=False,
                blob_uri=blob["blobUri"],
                text=text,
                format="xml" if record["contentPath"].endswith(".xml") else "text",
            )
        )
    return sources
