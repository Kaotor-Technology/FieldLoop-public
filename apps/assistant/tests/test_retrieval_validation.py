import asyncio
import importlib
import json
from types import ModuleType
from typing import Any

import pytest


def validation() -> ModuleType:
    try:
        return importlib.import_module("fieldloop_assistant.retrieval_validation")
    except ModuleNotFoundError:
        pytest.fail("FL-23 retrieval-validation harness is missing")


def test_checks_expected_current_citation_and_never_exports_retrieved_bodies() -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")
    report = module.evaluate_sample(
        [expected],
        [{"content": "BODY MUST NOT BE EXPORTED", "citation": {
            "document_id": expected.document_id, "revision": "B", "source_uri": "private://x"
        }}],
        elapsed_seconds=0.1,
    )
    assert report == {
        "expected_citation_found": True,
        "within_two_seconds": True,
        "elapsed_seconds": 0.1,
        "citations": [{"document_id": expected.document_id, "revision": "B"}],
    }
    assert "BODY" not in json.dumps(report)
    assert "private://" not in json.dumps(report)


@pytest.mark.parametrize("elapsed", [float("nan"), float("inf"), -0.1])
def test_invalid_measurements_cannot_be_reported_as_passes(elapsed: float) -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")
    with pytest.raises(ValueError, match="elapsed"):
        module.evaluate_sample([expected], [], elapsed_seconds=elapsed)


def test_empty_expectations_cannot_establish_relevance() -> None:
    with pytest.raises(ValueError, match="expected"):
        validation().evaluate_sample([], [], elapsed_seconds=0.1)


@pytest.mark.parametrize(("document_id", "revision"), [
    ("not-a-uuid", "B"), ("00000000-0000-0000-0000-000000000001", " ")
])
def test_invalid_expected_citation_is_rejected(document_id: str, revision: str) -> None:
    with pytest.raises(ValueError):
        validation().ExpectedCitation(document_id, revision)


@pytest.mark.parametrize("result", [
    {}, {"citation": {}}, {"citation": {"document_id": {"body": "x"}, "revision": "B"}}
])
def test_malformed_citation_metadata_is_rejected(result: dict[str, Any]) -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")
    with pytest.raises(ValueError, match="citation"):
        module.evaluate_sample([expected], [result], elapsed_seconds=0.1)


def test_measures_awaited_retrieval_without_promoting_fixture_acceptance() -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")
    calls: list[tuple[str, list[str]]] = []

    async def fixture_search(query: str, folders: list[str]) -> list[dict[str, Any]]:
        calls.append((query, folders))
        await asyncio.sleep(0.01)
        return [{"content": "DO NOT EXPORT", "citation": {
            "document_id": expected.document_id, "revision": "B"
        }}]

    assert hasattr(module, "measure_sample"), "FL-23 awaited runtime measurement is missing"
    report = asyncio.run(module.measure_sample(
        fixture_search, "cathodic protection survey interval", ["Company Standards/Procedures"],
        [expected], evidence_kind="local_fixture",
    ))
    assert calls == [("cathodic protection survey interval", ["Company Standards/Procedures"])]
    assert report["elapsed_seconds"] >= 0.01
    assert report["expected_citation_found"] is True
    assert report["retrieval_succeeded"] is True
    assert report["evidence_kind"] == "local_fixture"
    assert report["acceptance"] == "not_assessed"
    assert "DO NOT EXPORT" not in json.dumps(report)


@pytest.mark.parametrize("error", [TimeoutError("SECRET DSN"), RuntimeError("PRIVATE BODY")])
def test_failed_retrieval_is_recorded_without_exception_details(error: Exception) -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")

    async def failing_search(query: str, folders: list[str]) -> list[dict[str, Any]]:
        raise error

    report = asyncio.run(module.measure_sample(
        failing_search, "protection", ["Company Standards/Procedures"], [expected],
        evidence_kind="local_fixture",
    ))
    assert report["retrieval_succeeded"] is False
    assert report["expected_citation_found"] is False
    assert report["citations"] == []
    assert report["error"] == ("timeout" if isinstance(error, TimeoutError) else "retrieval_failed")
    assert report["acceptance"] == "not_assessed"
    assert "SECRET" not in json.dumps(report) and "PRIVATE BODY" not in json.dumps(report)


@pytest.mark.parametrize(("query", "folders", "has_expected", "kind"), [
    ("protection", ["Company Standards/Procedures"], False, "local_fixture"),
    ("protection", ["Company Standards/Procedures"], True, "live_accepted"),
    (" ", ["Company Standards/Procedures"], True, "local_fixture"),
    ("protection", [], True, "local_fixture"),
])
def test_invalid_evaluation_configuration_never_calls_runtime(
    query: str, folders: list[str], has_expected: bool, kind: str,
) -> None:
    module = validation()
    calls: list[str] = []

    async def search(query: str, folders: list[str]) -> list[dict[str, Any]]:
        calls.append(query)
        return []

    expected = [module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")]
    with pytest.raises(ValueError):
        asyncio.run(module.measure_sample(
            search, query, folders, expected if has_expected else [], evidence_kind=kind,
        ))
    assert calls == []


@pytest.mark.parametrize("reason", [
    "canceling statement due to statement timeout; SYNTHETIC SECRET",
    "canceling statement due to user request; SYNTHETIC SECRET",
])
def test_database_query_cancellation_is_distinct_without_inventing_timeout_reason(
    reason: str,
) -> None:
    from psycopg.errors import QueryCanceled

    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")

    async def canceled_search(query: str, folders: list[str]) -> list[dict[str, Any]]:
        raise QueryCanceled(reason)

    report = asyncio.run(module.measure_sample(
        canceled_search, "protection", ["Company Standards/Procedures"], [expected],
        evidence_kind="local_fixture",
    ))
    assert report["error"] == "query_canceled"
    assert report["retrieval_succeeded"] is False
    assert report["expected_citation_found"] is False
    assert report["citations"] == []
    assert report["acceptance"] == "not_assessed"
    assert "SYNTHETIC SECRET" not in json.dumps(report)
    assert reason not in json.dumps(report)


def test_outer_async_cancellation_propagates_without_a_measurement_report() -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")

    async def canceled_search(query: str, folders: list[str]) -> list[dict[str, Any]]:
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(module.measure_sample(
            canceled_search, "protection", ["Company Standards/Procedures"], [expected],
            evidence_kind="local_fixture",
        ))


# Characterization of the citation-match predicate; not new relevance calibration.
@pytest.mark.parametrize(("document_id", "revision"), [
    ("00000000-0000-0000-0000-000000000001", "A"),
    ("00000000-0000-0000-0000-000000000002", "B"),
])
def test_nonempty_unrelated_or_stale_citations_do_not_establish_relevance(
    document_id: str, revision: str,
) -> None:
    module = validation()
    expected = module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")
    report = module.evaluate_sample(
        [expected], [{"citation": {"document_id": document_id, "revision": revision}}],
        elapsed_seconds=0.1,
    )
    assert report["expected_citation_found"] is False


@pytest.mark.parametrize(("elapsed", "within"), [(1.999, True), (2.0, False), (2.001, False)])
def test_two_second_limit_is_strict_for_each_sample(elapsed: float, within: bool) -> None:
    module = validation()
    report = module.evaluate_sample(
        [module.ExpectedCitation("00000000-0000-0000-0000-000000000001", "B")], [],
        elapsed_seconds=elapsed,
    )
    assert report["within_two_seconds"] is within
