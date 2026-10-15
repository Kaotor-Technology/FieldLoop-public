"""The production source-status guard must reject before any I/O or embeddings."""

import asyncio
from uuid import NAMESPACE_URL, uuid5

import pytest
from fieldloop_assistant.corpus import DocumentSource
from fieldloop_assistant.indexing import index_document


@pytest.mark.parametrize("status", ["superseded", "withdrawn", "draft", "status unverified"])
def test_ineligible_source_is_rejected_before_dependencies(status: str) -> None:
    calls: list[str] = []

    class ForbiddenDependency:
        def __getattr__(self, name: str) -> None:
            calls.append(name)
            raise AssertionError(f"Forbidden runtime dependency touched: {name}")

    source = DocumentSource(
        id=uuid5(NAMESPACE_URL, "fieldloop:public-indexing-guard-test"),
        title="PUBLIC synthetic guard fixture", revision="A", folder="Company Standards",
        status=status, classification="PUBLIC", simulated=True,
        blob_uri="synthetic://public-indexing-guard-test", text="## Test\nSYNTHETIC",
        format="markdown", licence="synthetic",
    )
    tripwire = ForbiddenDependency()
    with pytest.raises(
        ValueError, match="^Only current documents in an explicit Organisation may be indexed$"
    ):
        asyncio.run(index_document(tripwire, "contract-test", source, tripwire))
    assert calls == []
