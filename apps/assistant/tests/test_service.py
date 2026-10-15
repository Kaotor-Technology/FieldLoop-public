import json
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from fieldloop_assistant.identity import InternalTokenVerifier, InvalidTokenError
from fieldloop_assistant.service import create_service
from jwt.algorithms import RSAAlgorithm

from .harness import Harness, answer, call
from .support import BOWTIE

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = json.loads(RSAAlgorithm.to_jwk(KEY.public_key()))
JWK.update(kid="k1", use="sig", alg="RS256")
JWKS = json.dumps({"keys": [JWK]})


def token(**claims: Any) -> str:
    now = int(time.time())
    body: dict[str, Any] = {
        "sub": "user-1", "org_id": "org-1", "roles": ["fieldloop.operator"],
        "clearance": "INTERNAL",
        "iss": "web-api", "aud": "assistant", "iat": now, "exp": now + 300,
    }
    key = claims.pop("_key", KEY)
    body.update(claims)
    return jwt.encode(body, key, algorithm="RS256", headers={"kid": "k1"})


def verifier() -> InternalTokenVerifier:
    return InternalTokenVerifier(JWKS, "web-api", "assistant", "org-1")


def test_verifier_accepts_a_valid_token_and_rejects_every_tampering() -> None:
    assert verifier().verify(token()).sub == "user-1"
    now = int(time.time())
    bad = [
        token(exp=now - 60, iat=now - 400), token(aud="guardrail"), token(iss="evil"),
        token(org_id="org-2"), token(roles=["other"]), token(clearance="SECRET"),
        token(exp=now + 3600), token(_key=OTHER), "not-a-jwt",
    ]
    for candidate in bad:
        try:
            verifier().verify(candidate)
        except InvalidTokenError:
            continue
        raise AssertionError("token was accepted")


def make_client(script: list[Any] | None = None, **kwargs: Any) -> tuple[TestClient, Harness]:
    h = Harness(script or [answer()], **kwargs)
    app = create_service(h.runtime, h.store, verifier(), simulated=False)
    return TestClient(app), h


def auth(**claims: Any) -> dict[str, str]:
    return {"x-fieldloop-internal-user-token": token(**claims)}


def test_routes_require_a_valid_token_and_unconfigured_service_is_unavailable() -> None:
    client, _ = make_client()
    anonymous = client.post("/assistant/v1/sessions", json={"agent": "flood-situation"})
    assert anonymous.status_code == 401
    assert client.post("/assistant/v1/sessions", json={"agent": "flood-situation"},
                       headers={"x-fieldloop-internal-user-token": "x"}).status_code == 401
    unconfigured = TestClient(create_service(None, None, None))
    assert unconfigured.get("/healthz").status_code == 200
    assert unconfigured.post("/assistant/v1/sessions", json={"agent": "flood-situation"},
                             headers=auth()).status_code == 503


def test_only_coordinators_start_and_sessions_belong_to_their_user() -> None:
    client, _ = make_client()
    refused = client.post("/assistant/v1/sessions", json={"agent": "code-standard"}, headers=auth())
    assert refused.status_code == 400
    created = client.post("/assistant/v1/sessions", json={"agent": "integrity-orchestrator"},
                          headers=auth())
    assert created.status_code == 201
    session_id = created.json()["id"]
    foreign = client.post(f"/assistant/v1/sessions/{session_id}/messages", json={"message": "hi"},
                          headers=auth(sub="user-2"))
    assert foreign.status_code == 404
    assert client.post(f"/assistant/v1/sessions/{session_id}:cancel",
                       headers=auth(sub="user-2")).status_code == 404


def test_message_streams_sse_events_in_order() -> None:
    client, _ = make_client(
        [call("get_barriers", bowtie_id=BOWTIE), answer()],
        platform={rf"/api/v1/bowties/{BOWTIE}": {"id": BOWTIE, "barriers": []}},
    )
    session_id = client.post("/assistant/v1/sessions", json={"agent": "integrity-orchestrator"},
                             headers=auth()).json()["id"]
    response = client.post(f"/assistant/v1/sessions/{session_id}/messages",
                           json={"message": "Review DL-01"}, headers=auth())
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "private, no-store"
    lines = response.text.splitlines()
    names = [line.split(": ", 1)[1] for line in lines if line.startswith("event:")]
    expected = {"agent.step", "tool.call", "guardrail.decision", "tool.result", "answer.final"}
    assert expected <= set(names)
    assert names.index("tool.call") < names.index("guardrail.decision") < names.index("tool.result")
    assert names[-1] == "answer.final"


def test_message_body_is_strict() -> None:
    client, _ = make_client()
    session_id = client.post("/assistant/v1/sessions", json={"agent": "flood-situation"},
                             headers=auth()).json()["id"]
    url = f"/assistant/v1/sessions/{session_id}/messages"
    assert client.post(url, json={"message": ""}, headers=auth()).status_code == 422
    extra = client.post(url, json={"message": "x", "agent": "other"}, headers=auth())
    assert extra.status_code == 422


def test_configured_process_wiring_builds_without_touching_the_network() -> None:
    from fieldloop_assistant.main import Settings, build_app, guardrail_model
    from fieldloop_assistant.runtime import to_adk_name

    from .support import REPO, catalog

    settings = Settings(
        org_id="org-1", database_url="postgresql://u:p@127.0.0.1:1/db",
        adk_database_url="postgresql+asyncpg://u:p@127.0.0.1:1/db",
        guardrail_url="http://guardrail.internal", platform_url="http://web-api.internal",
        jwks=JWKS, issuer="web-api", audience="assistant", packs_dir=REPO / "domain-packs",
        schema_path=REPO / "packages/contracts/agent-definition.v1.schema.json", simulated=True,
    )
    client = TestClient(build_app(settings))  # no lifespan: the pool is never opened
    assert client.get("/healthz").json() == {"status": "ok"}
    unauthenticated = client.post("/assistant/v1/sessions", json={"agent": "flood-situation"})
    assert unauthenticated.status_code == 401
    # Every model call is routed to the Guardrail's OpenAI-compatible endpoint with the AI System.
    model = guardrail_model(catalog().get("flood-situation"), "http://guardrail.internal/")
    assert model.model == "openai/flash"
    assert to_adk_name("integrity-orchestrator") == "integrity_orchestrator"


def test_a_turn_running_elsewhere_refuses_a_second_turn_and_records_the_cancel() -> None:
    import asyncio

    client, h = make_client()
    session_id = client.post("/assistant/v1/sessions", json={"agent": "flood-situation"},
                             headers=auth()).json()["id"]
    # Another instance holds the session: only the shared status says so.
    asyncio.run(h.store.claim_turn(h.store.sessions[session_id]))
    busy = client.post(f"/assistant/v1/sessions/{session_id}/messages", json={"message": "x"},
                       headers=auth())
    assert busy.status_code == 409
    cancelled = client.post(f"/assistant/v1/sessions/{session_id}:cancel", headers=auth())
    assert cancelled.status_code == 202 and cancelled.json() == {"cancelling": True}
    assert h.store.sessions[session_id].status == "cancelling"  # visible to the other instance


def test_cancel_on_an_idle_session_changes_nothing() -> None:
    client, h = make_client()
    session_id = client.post("/assistant/v1/sessions", json={"agent": "flood-situation"},
                             headers=auth()).json()["id"]
    response = client.post(f"/assistant/v1/sessions/{session_id}:cancel", headers=auth())
    assert response.json() == {"cancelling": False}
    assert h.store.sessions[session_id].status == "active"


def test_litellm_sends_the_user_token_header_on_the_wire() -> None:
    """The header set in before_model_callback must reach the Guardrail's HTTP request."""
    import asyncio

    from fieldloop_assistant.identity import TOKEN_HEADER
    from fieldloop_assistant.main import guardrail_model
    from google.adk.models.llm_request import LlmRequest
    from google.genai import types
    from litellm import ModelResponse

    from .support import USER_TOKEN, catalog

    captured: dict[str, object] = {}

    class FakeClient:
        async def acompletion(self, model, messages, tools, **kwargs):  # type: ignore[no-untyped-def]
            captured.update(kwargs, model=model)
            return ModelResponse(choices=[{"message": {"role": "assistant", "content": "ok"}}])

    model = guardrail_model(catalog().get("flood-situation"), "http://guardrail.internal")
    model.llm_client = FakeClient()  # type: ignore[attr-defined]
    request = LlmRequest(
        model="openai/flash",
        contents=[types.Content(role="user", parts=[types.Part(text="hi")])],
        config=types.GenerateContentConfig(
            http_options=types.HttpOptions(headers={TOKEN_HEADER: USER_TOKEN})),
    )

    async def go() -> None:
        async for _ in model.generate_content_async(request):
            pass

    asyncio.run(go())
    assert captured["extra_headers"][TOKEN_HEADER] == USER_TOKEN  # type: ignore[index]
    assert captured["extra_body"] == {"aiSystem": "demo-uc-4"}
    assert captured["api_base"] == "http://guardrail.internal/guardrail/v1"
