import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app

# The methods that would change a source system. Every mock endpoint must refuse them.
WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]
# A sample for each path parameter, so templated routes can be called.
SAMPLES = {"tag": "DL-01.flow.line", "id": "SYN-ILI-2026-001"}


def mock_paths() -> list[str]:
    templates = {
        route.path
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/mock/")
    }
    return sorted(
        re.sub(r"\{(\w+)\}", lambda match: SAMPLES.get(match.group(1), "x"), path)
        for path in templates
    )


def test_every_mock_endpoint_is_discovered() -> None:
    # A router added without being included, or renamed, must not silently shrink the guard.
    paths = mock_paths()
    assert "/mock/historian/tags/DL-01.flow.line" in paths
    assert "/mock/patrol/findings" in paths
    assert "/mock/ili/reports/SYN-ILI-2026-001" in paths


@pytest.mark.parametrize("path", mock_paths())
@pytest.mark.parametrize("method", WRITE_METHODS)
def test_no_mock_endpoint_accepts_a_write_method(path: str, method: str) -> None:
    with TestClient(app) as client:
        response = client.request(method, path, json={})
    assert response.status_code == 405
    assert "GET" in response.headers["allow"]


@pytest.mark.parametrize(
    "path",
    [
        "/mock/historian/tags/DL-01.flow.line",
        "/mock/patrol/findings",
        "/mock/ili/reports/SYN-ILI-2026-001",
    ],
)
@pytest.mark.parametrize("method", ["HEAD", "OPTIONS"])
def test_these_sources_also_refuse_head_and_options(path: str, method: str) -> None:
    # Stricter than the requirement: only GET reaches a handler, so there is no method to audit.
    with TestClient(app) as client:
        response = client.request(method, path)
    assert response.status_code == 405
    assert response.headers["allow"] == "GET"
