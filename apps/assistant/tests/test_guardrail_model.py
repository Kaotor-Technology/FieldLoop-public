import asyncio

import httpx
import litellm
import openai
import pytest
from fieldloop_assistant.guardrail_model import (
    GuardrailLiteLlm,
    GuardrailResponseClient,
    guardrail_error_decisions,
    read_guardrail_decisions,
)
from google.adk.models.lite_llm import LiteLLMClient
from google.adk.models.llm_request import LlmRequest
from google.genai import types
from litellm.types.utils import ModelResponse


def test_guardrail_response_header_keeps_only_candid_policy_decisions() -> None:
    decisions = read_guardrail_decisions({
        "X-FieldLoop-Guardrail-Decisions": '[{"decision":"redact","policyId":"synthetic-policy",'
        '"reason":"SYNTHETIC input was redacted."},{"decision":"unknown","policyId":"x",'
        '"reason":"ignored"},{"decision":"reroute","policyId":"synthetic-route",'
        '"reason":"SYNTHETIC private tier required."}]',
    })

    assert decisions == [
        {
            "decision": "redact", "policy_id": "synthetic-policy",
            "reason": "SYNTHETIC input was redacted.",
        },
        {
            "decision": "reroute", "policy_id": "synthetic-route",
            "reason": "SYNTHETIC private tier required.",
        },
    ]


def test_guardrail_response_header_fails_closed_to_no_displayed_decision_on_invalid_json() -> None:
    assert read_guardrail_decisions({"x-fieldloop-guardrail-decisions": "not-json"}) == []


def test_guardrail_response_header_logs_invalid_json(caplog) -> None:  # type: ignore[no-untyped-def]
    with caplog.at_level("WARNING", logger="fieldloop_assistant.guardrail_model"):
        assert read_guardrail_decisions({"x-fieldloop-guardrail-decisions": "not-json"}) == []

    assert "contained invalid JSON" in caplog.text


@pytest.mark.parametrize("include_decision_header", [True, False])
def test_guardrail_client_recovers_block_decision_from_litellm_mapped_403(
    monkeypatch: pytest.MonkeyPatch, include_decision_header: bool
) -> None:
    reason = "SYNTHETIC policy blocked completion."
    problem = {
        "code": "guardrail_blocked",
        "detail": reason,
        "policyId": "synthetic-policy",
        "error": {
            "code": "guardrail_blocked",
            "policy_id": "synthetic-policy",
            "message": reason,
        },
    }
    headers = {}
    if include_decision_header:
        headers["x-fieldloop-guardrail-decisions"] = (
            '[{"decision":"block","policyId":"synthetic-policy",'
            '"reason":"SYNTHETIC policy blocked completion."}]'
        )
    request = httpx.Request("POST", "https://guardrail.invalid/guardrail/v1/chat/completions")
    response = httpx.Response(403, headers=headers, json=problem, request=request)

    async def blocked_completion(*args, **kwargs):  # type: ignore[no-untyped-def]
        try:
            raise openai.PermissionDeniedError(
                "403 Guardrail blocked request", response=response, body=problem
            )
        except openai.PermissionDeniedError as original:
            # This is LiteLLM 1.81's mapping shape: the APIError loses the HTTP
            # response/body and retains the original exception as __context__.
            raise litellm.exceptions.APIError(
                status_code=403,
                message=str(original),
                llm_provider="openai",
                model="synthetic-model",
            ) from original

    monkeypatch.setattr(LiteLLMClient, "acompletion", blocked_completion)
    client = GuardrailResponseClient()

    async def call_client():  # type: ignore[no-untyped-def]
        await client.acompletion(model="synthetic", messages=[], tools=None)

    with pytest.raises(litellm.exceptions.APIError) as caught:
        asyncio.run(call_client())

    assert getattr(caught.value, "response", None) is None
    assert getattr(caught.value, "body", None) is None
    assert isinstance(caught.value.__cause__, openai.PermissionDeniedError)
    assert guardrail_error_decisions(caught.value) == [
        {
            "decision": "block",
            "policy_id": "synthetic-policy",
            "reason": reason,
        },
    ]


def test_guardrail_llm_carries_gateway_decisions_on_the_adk_response() -> None:
    class SyntheticResponseClient(GuardrailResponseClient):
        async def acompletion(self, model, messages, tools, **kwargs):  # type: ignore[no-untyped-def]
            headers = {
                "x-fieldloop-guardrail-decisions": '[{"decision":"redact",'
                '"policyId":"synthetic-policy","reason":"SYNTHETIC input redacted."}]',
            }
            self._decisions = read_guardrail_decisions(headers)
            return ModelResponse(
                model="SYNTHETIC-model",
                choices=[{
                    "message": {"role": "assistant", "content": "SYNTHETIC answer"},
                    "finish_reason": "stop",
                }],
                _response_headers=headers,
            )

    model = GuardrailLiteLlm(
        model="openai/synthetic-model", api_base="https://guardrail.invalid/guardrail/v1",
        api_key="synthetic-key", extra_body={"aiSystem": "synthetic-system"},
        llm_client=SyntheticResponseClient(),
    )
    request = LlmRequest(contents=[
        types.Content(role="user", parts=[types.Part(text="SYNTHETIC request")]),
    ])

    async def generate():
        return [response async for response in model.generate_content_async(request)]

    responses = asyncio.run(generate())
    assert responses[0].custom_metadata == {
        "fieldloop_guardrail_decisions": [
            {
                "decision": "redact", "policy_id": "synthetic-policy",
                "reason": "SYNTHETIC input redacted.",
            },
        ],
    }
