"""Deterministic chunks retaining original PDF pages and document clauses."""

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass

MAX_CHARS = 1200
CHUNKER_VERSION = "fl-70-v1"
PDF_PAGE = re.compile(r"^--- PDF page (\d+) ---$")
CLAUSE = re.compile(r"^(?:มาตรา\s+[0-9๐-๙]+|§\s*[\d.]+)")
UNMAPPED = re.compile("[\ue000-\uf8ff\U000f0000-\U000ffffd\U00100000-\U0010fffd\ufffd]")


@dataclass(frozen=True)
class Chunk:
    content: str
    page: int | None
    clause: str | None


def chunk_text(text: str, *, format: str = "text") -> list[Chunk]:
    if not text.strip() or UNMAPPED.search(text):
        raise ValueError("Indexing requires non-empty text without unmapped glyphs")
    if format == "xml":
        if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            raise ValueError("XML entities are not indexing input")
        root = ET.fromstring(text)
        chunks: list[Chunk] = []
        for section in root.iter("DIV8"):
            if section.get("TYPE") == "SECTION":
                body = "\n".join(" ".join("".join(e.itertext()).split()) for e in section)
                chunks.extend(_split(body, None, section.get("N")))
        if not chunks:
            raise ValueError("Legal XML has no numbered sections")
        return chunks
    if format not in {"text", "markdown"}:
        raise ValueError("Unsupported corpus format")
    if format == "markdown" and text.startswith("---\n"):
        text = text.split("\n---\n", 1)[1]
    chunks = []
    page: int | None = None
    clause: str | None = None
    lines: list[str] = []

    def flush() -> None:
        chunks.extend(_split("\n".join(lines), page, clause))
        lines.clear()

    for line in text.splitlines():
        stripped = line.strip()
        page_match = PDF_PAGE.fullmatch(stripped)
        clause_match = CLAUSE.match(stripped)
        if page_match:
            flush()
            page = int(page_match[1])
        elif stripped.startswith("## ") or clause_match:
            flush()
            clause = stripped[3:] if stripped.startswith("## ") else clause_match[0]  # type: ignore[index]
            lines.append(line)
        else:
            lines.append(line)
    flush()
    return chunks


def _split(text: str, page: int | None, clause: str | None) -> list[Chunk]:
    remaining = text.strip()
    result: list[Chunk] = []
    while remaining:
        cut = min(len(remaining), MAX_CHARS)
        if cut < len(remaining):
            boundary = max(remaining.rfind("\n", 0, cut), remaining.rfind(" ", 0, cut))
            if boundary >= MAX_CHARS // 2:
                cut = boundary
        content = remaining[:cut].strip()
        result.append(Chunk(content, page, clause))
        remaining = remaining[cut:].lstrip()
    return result
