"""Compare the documented internal HTTP/SSE contract with actual local service output."""

import json
from typing import Any

from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from fieldloop_assistant.service import create_service
from jsonschema import Draft202012Validator

from .harness import answer, call
from .support import BOWTIE, REPO
from .test_service import auth, make_client

SPEC = json.loads((REPO / "packages/contracts/assistant.v1.openapi.json").read_text())
SESSION = "/assistant/v1/sessions"
MESSAGE = SESSION + "/{session_id}/messages"
CANCEL = SESSION + "/{session_id}:cancel"


def check_response(path: str, response: Any) -> None:
    media = response.headers["content-type"].split(";")[0]
    contract = SPEC["paths"][path]["post"]["responses"][str(response.status_code)]
    Draft202012Validator(contract["content"][media]["schema"]).validate(response.json())


def test_actual_session_errors_and_cancellation_match_openapi() -> None:
    client, _ = make_client()
    for body, headers in [
        ({"agent": "flood-situation"}, {}),
        ({"agent": "code-standard"}, auth()),
        ({"agent": ""}, auth()),
        ({"agent": "flood-situation", "org_id": "spoofed"}, auth()),
    ]:
        check_response(SESSION, client.post(SESSION, json=body, headers=headers))
    unavailable = TestClient(create_service(None, None, None))
    check_response(
        SESSION, unavailable.post(SESSION, json={"agent": "flood-situation"}, headers=auth())
    )
    created = client.post(SESSION, json={"agent": "integrity-orchestrator"}, headers=auth())
    assert created.status_code == 201
    check_response(SESSION, created)
    sid = created.json()["id"]
    for headers in [auth(), auth(sub="foreign-user"), {}]:
        check_response(CANCEL, client.post(f"{SESSION}/{sid}:cancel", headers=headers))
    for body, headers in [
        ({"message": "hi"}, auth(sub="foreign-user")),
        ({"message": "hi"}, {}),
        ({"message": ""}, auth()),
    ]:
        check_response(
            MESSAGE, client.post(f"{SESSION}/{sid}/messages", json=body, headers=headers)
        )


def test_documented_sse_examples_and_actual_events_match_event_schemas() -> None:
    operation = SPEC["paths"][MESSAGE]["post"]
    response_contract = operation["responses"]["200"]
    examples = response_contract["content"]["text/event-stream"]["examples"]
    event_schemas = operation["x-fieldloop-sse-events"]
    client, _ = make_client(
        [call("get_barriers", bowtie_id=BOWTIE), answer()],
        platform={rf"/api/v1/bowties/{BOWTIE}": {"id": BOWTIE, "barriers": []}},
    )
    sid = client.post(SESSION, json={"agent": "integrity-orchestrator"}, headers=auth()).json()[
        "id"
    ]
    response = client.post(
        f"{SESSION}/{sid}/messages", json={"message": "Review DL-01"}, headers=auth()
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    for header, contract in response_contract["headers"].items():
        assert response.headers[header] == contract["schema"]["const"]
    streams = [example["value"] for example in examples.values()] + [response.text]
    for stream in streams:
        names = []
        for frame in stream.strip().split("\n\n"):
            fields = dict(line.split(": ", 1) for line in frame.splitlines())
            assert int(fields["id"]) > 0
            name = fields["event"]
            Draft202012Validator(event_schemas[name]).validate(json.loads(fields["data"]))
            names.append(name)
        assert {
            "agent.step",
            "tool.call",
            "guardrail.decision",
            "tool.result",
            "answer.final",
        } <= set(names)
        assert (
            names.index("tool.call")
            < names.index("guardrail.decision")
            < names.index("tool.result")
        )
        assert names[-1] == "answer.final"
    # The current non-partial runtime must not advertise unimplemented token streaming.
    assert "answer.partial" not in event_schemas


def native_operations(service: FastAPI) -> set[tuple[str, str]]:
    return {(method.lower(), route.path) for route in service.routes
            if isinstance(route, APIRoute) and route.path.startswith("/assistant/v1/")
            for method in route.methods}


def test_every_registered_native_assistant_operation_is_documented() -> None:
    documented = {(method, path) for path, item in SPEC["paths"].items()
                  for method in item if method in {"get", "post", "put", "patch", "delete"}}
    assert native_operations(create_service(None, None, None)) == documented


def test_hidden_native_operation_cannot_escape_inventory() -> None:
    service = create_service(None, None, None)

    @service.get("/assistant/v1/synthetic-undocumented", include_in_schema=False)
    def hidden() -> dict[str, str]:
        return {"status": "synthetic"}

    assert ("get", "/assistant/v1/synthetic-undocumented") in native_operations(service)
