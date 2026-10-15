"""Carry Guardrail completion outcomes from the private gateway into the agent turn."""

import json
import logging
from collections.abc import AsyncGenerator, Mapping
from typing import Any

from google.adk.models.lite_llm import LiteLlm, LiteLLMClient
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

DECISION_HEADER = "x-fieldloop-guardrail-decisions"
DECISIONS_METADATA_KEY = "fieldloop_guardrail_decisions"
GUARDRAIL_DECISIONS = frozenset({"allow", "redact", "block", "reroute"})
_ERROR_DECISIONS_ATTRIBUTE = "_fieldloop_guardrail_decisions"
_LOGGER = logging.getLogger(__name__)


def read_guardrail_decisions(headers: object) -> list[dict[str, str]]:
    if not isinstance(headers, Mapping):
        return []
    encoded = next(
        (value for key, value in headers.items() if str(key).lower() == DECISION_HEADER),
        None,
    )
    if not isinstance(encoded, str):
        return []
    try:
        values = json.loads(encoded)
    except ValueError:
        _LOGGER.warning("Guardrail response decision header contained invalid JSON")
        return []
    if not isinstance(values, list):
        _LOGGER.warning("Guardrail response decision header had an invalid structure")
        return []
    decisions: list[dict[str, str]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        decision = value.get("decision")
        policy_id = value.get("policyId")
        reason = value.get("reason")
        if (
            isinstance(decision, str) and decision in GUARDRAIL_DECISIONS
            and isinstance(policy_id, str) and policy_id
            and isinstance(reason, str) and reason
        ):
            decisions.append({"decision": decision, "policy_id": policy_id, "reason": reason})
    return decisions


class GuardrailResponseClient(LiteLLMClient):
    """Capture the gateway's decision header while retaining LiteLLM's request handling."""

    def __init__(self) -> None:
        self._decisions: list[dict[str, str]] = []

    async def acompletion(
        self, model: Any, messages: Any, tools: Any, **kwargs: Any
    ) -> Any:
        self._decisions = []
        try:
            response = await super().acompletion(
                model=model, messages=messages, tools=tools, **kwargs
            )
        except Exception as error:
            self._decisions = _read_error_decisions(error)
            if self._decisions:
                setattr(error, _ERROR_DECISIONS_ATTRIBUTE, self._decisions)
            raise
        self._decisions = read_guardrail_decisions(getattr(response, "_response_headers", None))
        return response

    def take_decisions(self) -> list[dict[str, str]]:
        decisions, self._decisions = self._decisions, []
        return decisions


def _read_error_decisions(error: Exception) -> list[dict[str, str]]:
    response = getattr(error, "response", None)
    decisions = read_guardrail_decisions(getattr(response, "headers", None))
    if decisions:
        return decisions

    # LiteLLM may turn the HTTP response into an APIError and retain its JSON body
    # without the response headers. The Guardrail's 403 problem body still carries
    # the policy ID and reason needed for the user-facing block notice.
    body = getattr(error, "body", None)
    status = getattr(error, "status_code", getattr(response, "status_code", None))
    if not isinstance(body, Mapping) or status != 403:
        return []
    error_body = body.get("error")
    if (
        body.get("code") != "guardrail_blocked"
        or not isinstance(error_body, Mapping)
        or error_body.get("code") != "guardrail_blocked"
    ):
        return []
    policy_id = body.get("policyId") or error_body.get("policy_id")
    reason = body.get("detail") or error_body.get("message")
    if isinstance(policy_id, str) and policy_id and isinstance(reason, str) and reason:
        return [{"decision": "block", "policy_id": policy_id, "reason": reason}]
    return []


def guardrail_error_decisions(error: object) -> object:
    """Return decision metadata preserved on a failed Guardrail completion."""
    return getattr(error, _ERROR_DECISIONS_ATTRIBUTE, None)


class GuardrailLiteLlm(LiteLlm):
    """Attach server-authored decision metadata to the ADK response for runtime reporting."""

    def __init__(
        self,
        model: str,
        *,
        api_base: str,
        api_key: str,
        extra_body: dict[str, Any],
        llm_client: GuardrailResponseClient,
    ) -> None:
        super().__init__(
            model=model, api_base=api_base, api_key=api_key,
            extra_body=extra_body, llm_client=llm_client,
        )

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        async for response in super().generate_content_async(llm_request, stream):
            client = self.llm_client
            if isinstance(client, GuardrailResponseClient):
                decisions = client.take_decisions()
                if decisions:
                    response.custom_metadata = {
                        **(response.custom_metadata or {}),
                        DECISIONS_METADATA_KEY: decisions,
                    }
            yield response
