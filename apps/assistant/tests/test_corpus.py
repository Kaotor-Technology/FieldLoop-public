from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pytest
from fieldloop_assistant.corpus import _body, load_corpus

REPO = Path(__file__).resolve().parents[3]


def test_reviewed_delivery_has_only_current_and_eligible_text_and_stable_ids() -> None:
    sources = load_corpus(REPO, "corpus-unit", REPO / "data/corpus/legal/storage/dev.json")
    assert len(sources) == 125
    synthetic = [source for source in sources if source.simulated]
    legal = [source for source in sources if not source.simulated]
    assert len(synthetic) == 120 and len(legal) == 5
    assert all(source.status == "current" and source.revision == "B" for source in synthetic)
    assert all(
        source.classification == "INTERNAL" and "SYNTHETIC" in source.text for source in synthetic
    )
    assert all(source.classification == "PUBLIC" for source in legal)
    assert all(
        "Water Resources" not in source.title and "Energy Industry" not in source.title
        for source in legal
    )
    assert synthetic[0].id == uuid5(
        NAMESPACE_URL, "fieldloop:fl-70:corpus-unit:SYN-UC1-PROC-EN-001-B"
    )


def test_corpus_paths_cannot_escape_the_reviewed_directory(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        _body(tmp_path, "../other.md")
    with pytest.raises(ValueError):
        _body(tmp_path, "network.kmz")


def test_an_explicit_organisation_is_required_before_source_loading() -> None:
    with pytest.raises(ValueError):
        load_corpus(REPO, "", REPO / "data/corpus/legal/storage/dev.json")
