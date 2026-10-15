"""Configured-process retrieval wiring; no database or Vertex calls."""

import pytest
from fieldloop_adapters import embeddings
from fieldloop_assistant import main
from fieldloop_assistant.trace import SessionRecord

from .support import REPO
from .test_service import JWKS


@pytest.mark.parametrize(
    ("override", "standard", "expected"),
    [
        (None, "cloud-project", "cloud-project"),
        ("app-project", "cloud-project", "app-project"),
        ("  ", "cloud-project", "cloud-project"),
        (None, None, None),
    ],
)
def test_process_retrieval_uses_configured_project(monkeypatch, override, standard, expected):
    for name, value in (("FIELDLOOP_GCP_PROJECT", override), ("GOOGLE_CLOUD_PROJECT", standard)):
        monkeypatch.delenv(name, raising=False)
        if value is not None:
            monkeypatch.setenv(name, value)
    calls = []
    marker = object()
    monkeypatch.setattr(
        embeddings, "vertex_embeddings", lambda project: calls.append(project) or marker
    )
    captured = []
    runtime = main.AgentRuntime

    def capture(deps):
        captured.append(deps)
        return runtime(deps)

    monkeypatch.setattr(main, "AgentRuntime", capture)
    settings = main.Settings(
        org_id="org-1",
        database_url="postgresql://u:p@127.0.0.1:1/db",
        adk_database_url="postgresql+asyncpg://u:p@127.0.0.1:1/db",
        guardrail_url="http://guardrail.internal",
        platform_url="http://web-api.internal",
        jwks=JWKS,
        issuer="web-api",
        audience="assistant",
        packs_dir=REPO / "domain-packs",
        schema_path=REPO / "packages/contracts/agent-definition.v1.schema.json",
        simulated=True,
    )
    main.build_app(settings)
    assert calls == [], "building the process must not create a credential-bearing client"
    session = SessionRecord(
        "s", "org-1", "integrity-orchestrator", "user-1", True, "INTERNAL", "active"
    )
    provider = captured[0].knowledge(session)
    if expected is None:
        assert provider is None and calls == []
    else:
        assert provider is not None
        assert calls == [expected]
        assert provider._search._embeddings is marker
        assert provider._search._scope.org_id == "org-1"
        assert provider._search._scope.classifications == ("PUBLIC", "INTERNAL")
