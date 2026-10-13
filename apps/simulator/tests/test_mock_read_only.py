import re
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app

# The methods that would change a source system. Every mock endpoint must refuse them.
WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]
# The sources are GET-only, so any other method is refused too, an unregistered one included.
OTHER_METHODS = ["HEAD", "OPTIONS", "TRACE", "CONNECT", "PROPFIND"]


def mock_paths() -> list[str]:
    """Every route under /mock/, with each path parameter filled in."""
    templates = {
        route.path
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/mock/")
    }
    return sorted(re.sub(r"\{\w+\}", "x", path) for path in templates)


def test_the_guard_covers_every_source_that_has_a_contract() -> None:
    # Read from the contract files, so adding a source needs no edit here.
    contracts = Path(__file__).resolve().parents[3] / "packages/contracts"
    documented = {
        path.name.removeprefix("mock-").removesuffix(".v1.openapi.json")
        for path in contracts.glob("mock-*.v1.openapi.json")
    }
    assert documented
    assert {path.split("/")[2] for path in mock_paths()} == documented


@pytest.mark.parametrize("path", mock_paths())
@pytest.mark.parametrize("method", WRITE_METHODS)
def test_no_mock_endpoint_accepts_a_write_method(path: str, method: str) -> None:
    with TestClient(app) as client:
        response = client.request(method, path, json={})
    assert response.status_code == 405
    assert response.headers["allow"] == "GET"
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "method_not_allowed"


@pytest.mark.parametrize("path", mock_paths())
@pytest.mark.parametrize("method", OTHER_METHODS)
def test_other_methods_are_refused_with_the_methods_the_path_serves(path: str, method: str) -> None:
    # An unregistered method such as PROPFIND must not be answered with the wrong Allow header.
    with TestClient(app) as client:
        response = client.request(method, path)
    assert response.status_code == 405
    assert response.headers["allow"] == "GET"
    if method != "HEAD":  # a HEAD response has no body
        assert response.headers["content-type"].startswith("application/problem+json")
        assert response.json()["code"] == "method_not_allowed"


@pytest.mark.parametrize("method", ["GET", "POST", "DELETE"])
@pytest.mark.parametrize(
    "path",
    [
        "/mock/nope",
        "/mock/historian/nope",
        "/mock/cmms/nope",
        "/mock/patrol/findings/1",
        "/mock/hydro",
        "/mock/hydro/rain/latest",
        "/mock/pumps/P-3",
        "/mock/pumps/P-3/status/power",
    ],
)
def test_unknown_mock_paths_are_problem_json_not_found(method: str, path: str) -> None:
    with TestClient(app) as client:
        response = client.request(method, path)
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "not_found"


def test_paths_outside_the_mock_namespace_keep_the_framework_errors() -> None:
    with TestClient(app) as client:
        response = client.get("/v1/not-a-route")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"detail": "Not Found"}
