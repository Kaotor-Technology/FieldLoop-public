import asyncio

from fieldloop_assistant.guardrail_model import (
    GuardrailLiteLlm,
    GuardrailResponseClient,
    read_guardrail_decisions,
)
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
