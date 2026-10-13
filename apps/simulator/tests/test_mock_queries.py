"""Query rules every mock source shares: a request says exactly what it means, or it is a 400."""

from typing import Annotated

import pytest
from fastapi import APIRouter, Depends, FastAPI, Query
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_http import install_problem_handlers, known_query_only

CMMS = "/mock/cmms/work-orders"
HISTORIAN = "/mock/historian/tags/DL-01.pressure.line"
WINDOW = "from=2026-10-12T00:00:00Z&to=2026-10-12T00:05:00Z"
# One valid read of each source.
READS = [
    CMMS,
    f"{CMMS}?pmDue=true&asOf=2026-10-13T00:00:00Z",
    f"{HISTORIAN}?{WINDOW}",
    "/mock/patrol/findings",
    "/mock/ili/reports/SYN-ILI-2026-001",
]


def assert_refused(url: str) -> None:
    with TestClient(app) as client:
        response = client.get(url)
    assert response.status_code == 400, url
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "validation_failed"


@pytest.mark.parametrize("url", READS)
def test_the_valid_reads_are_served(url: str) -> None:
    with TestClient(app) as client:
        assert client.get(url).status_code == 200


@pytest.mark.parametrize("url", READS)
def test_an_undeclared_query_parameter_is_refused(url: str) -> None:
    assert_refused(url + ("&" if "?" in url else "?") + "unknown=1")


@pytest.mark.parametrize("query", ["pmdue=true", "pm_due=true", "as_of=2026-10-13T00:00:00Z"])
def test_a_misspelt_filter_is_refused_and_not_ignored(query: str) -> None:
    assert_refused(f"{CMMS}?{query}")


@pytest.mark.parametrize(
    "url",
    [
        f"{CMMS}?asOf=2026-10-12T00:00:00Z&asOf=2026-10-13T00:00:00Z",
        f"{CMMS}?pmDue=true&pmDue=false",
        f"{HISTORIAN}?{WINDOW}&to=2026-10-12T00:10:00Z",
    ],
)
def test_a_repeated_query_parameter_is_refused(url: str) -> None:
    assert_refused(url)


@pytest.mark.parametrize("value", ["1", "0", "yes", "on", "t", "TRUE", "True", ""])
def test_a_boolean_is_only_true_or_false(value: str) -> None:
    assert_refused(f"{CMMS}?pmDue={value}")


def test_false_is_the_unfiltered_read() -> None:
    with TestClient(app) as client:
        assert client.get(f"{CMMS}?pmDue=false").json() == client.get(CMMS).json()


def test_a_timestamp_carries_at_most_microseconds() -> None:
    with TestClient(app) as client:
        kept = client.get(f"{CMMS}?asOf=2026-10-13T00:00:00.123456Z")
    assert kept.json()["asOf"] == "2026-10-13T00:00:00.123456Z"
    # A finer fraction would be truncated without a word, so it is refused.
    assert_refused(f"{CMMS}?asOf=2026-10-13T00:00:00.1234567Z")
    assert_refused(f"{HISTORIAN}?from=2026-10-12T00:00:00.000000001Z&to=2026-10-12T00:05:00Z")


def guarded_app() -> FastAPI:
    """One guarded route under /mock/ and one elsewhere; a dependency declares the parameter."""

    def page_size(limit: Annotated[int, Query()] = 10) -> int:
        return limit

    guarded = FastAPI()
    install_problem_handlers(guarded)
    router = APIRouter(dependencies=[Depends(known_query_only)])

    @router.get("/mock/stand-in")
    @router.get("/elsewhere")
    def read(limit: Annotated[int, Depends(page_size)]) -> dict[str, int]:
        return {"limit": limit}

    guarded.include_router(router)
    return guarded


def test_a_parameter_declared_by_a_dependency_of_the_route_is_known() -> None:
    with TestClient(guarded_app()) as client:
        assert client.get("/mock/stand-in?limit=3").json() == {"limit": 3}
        assert client.get("/mock/stand-in?limit=3&unknown=1").status_code == 400


def test_outside_the_mock_namespace_the_guard_answers_a_readable_422() -> None:
    with TestClient(guarded_app()) as client:
        response = client.get("/elsewhere?unknown=1")
    assert response.status_code == 422
    assert response.json()["detail"] == [
        {
            "type": "extra_forbidden",
            "loc": ["query"],
            "msg": "Undeclared or repeated query parameter",
        }
    ]
