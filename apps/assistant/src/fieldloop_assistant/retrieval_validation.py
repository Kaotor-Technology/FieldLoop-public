"""Metadata-only FL-23 validation; results never constitute legal or live acceptance.

Expected citations must come from a separately reviewed relevance set. This module
neither assigns review status nor loads/indexes data, constructs access scopes,
opens a database, or creates an embedding client. Local/fake runs are checks of
the harness only; real target evidence requires separately authorized execution.
"""

import math
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from psycopg.errors import QueryCanceled

UUID_TEXT = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


@dataclass(frozen=True)
class ExpectedCitation:
    document_id: str
    revision: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.document_id, str)
            or UUID_TEXT.fullmatch(self.document_id) is None
            or not isinstance(self.revision, str)
            or not self.revision.strip()
        ):
            raise ValueError("Invalid citation document ID or revision")


def evaluate_sample(
    expected: Sequence[ExpectedCitation],
    results: Sequence[Mapping[str, Any]],
    *,
    elapsed_seconds: float,
) -> dict[str, Any]:
    """Check returned IDs/revisions; a nonempty result alone does not prove relevance."""
    if not expected:
        raise ValueError("At least one expected citation is required")
    if not math.isfinite(elapsed_seconds) or elapsed_seconds < 0:
        raise ValueError("Invalid elapsed measurement")
    citations = []
    for result in results:
        citation = result.get("citation")
        if not isinstance(citation, Mapping):
            raise ValueError("Missing citation metadata")
        document_id, revision = citation.get("document_id"), citation.get("revision")
        if not isinstance(document_id, str) or not isinstance(revision, str):
            raise ValueError("Invalid citation document ID or revision")
        item = ExpectedCitation(document_id, revision)
        citations.append({"document_id": item.document_id, "revision": item.revision})
    return {
        "expected_citation_found": any(
            {"document_id": item.document_id, "revision": item.revision} in citations
            for item in expected
        ),
        "within_two_seconds": elapsed_seconds < 2,
        "elapsed_seconds": elapsed_seconds,
        "citations": citations,
    }


async def measure_sample(
    search: Callable[[str, list[str]], Awaitable[list[dict[str, Any]]]],
    query: str,
    folders: list[str],
    expected: Sequence[ExpectedCitation],
    *,
    evidence_kind: str,
) -> dict[str, Any]:
    """Time the supplied scoped search, including query embeddings and SQL.

    The caller owns operator authorization and verified user scope. Evidence kind
    is a caller assertion, not proof of a real model or target environment.
    """
    if evidence_kind not in {"local_fixture", "operator_runtime"}:
        raise ValueError("Unknown evidence kind; acceptance labels are not execution evidence")
    if not query.strip() or len(query) > 1200 or not folders or any(not f.strip() for f in folders):
        raise ValueError("Invalid query or folders")
    evaluate_sample(expected, [], elapsed_seconds=0)
    start = time.perf_counter()
    try:
        results = await search(query, folders)
    except Exception as error:
        report = evaluate_sample(expected, [], elapsed_seconds=time.perf_counter() - start)
        # SQLSTATE 57014 includes statement deadlines and external query cancellation;
        # do not infer the reason from potentially sensitive database error text.
        failure = "retrieval_failed"
        if isinstance(error, TimeoutError):
            failure = "timeout"
        elif isinstance(error, QueryCanceled):
            failure = "query_canceled"
        report.update({
            "retrieval_succeeded": False,
            "error": failure,
            "evidence_kind": evidence_kind,
            "acceptance": "not_assessed",
        })
        return report
    report = evaluate_sample(expected, results, elapsed_seconds=time.perf_counter() - start)
    report.update({
        "retrieval_succeeded": True,
        "evidence_kind": evidence_kind,
        "acceptance": "not_assessed",
    })
    return report
