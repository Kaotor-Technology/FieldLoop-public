"""Client for `tool-calls:check` (PRD GR-4). Any failure is a block: the tool never runs."""

import hashlib
import json
from collections.abc import Mapping
from typing import Any

import httpx

TOKEN_HEADER = "x-fieldloop-internal-user-token"
DECISIONS = frozenset({"allow", "convert_l1", "hold_l2", "block"})


def idempotency_key(session_id: str, tool: str, args: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        {"tool": tool, "args": args}, sort_keys=True, separators=(",", ":"), default=str
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]
    return f"{session_id}:{digest}"[:128]


def blocked(reason: str) -> dict[str, Any]:
    return {"decision": "block", "reason": reason}


class GuardrailClient:
    def __init__(self, client: httpx.AsyncClient, base_url: str) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")

    async def check_tool_call(
        self, user_token: str, envelope: Mapping[str, Any], key: str
    ) -> dict[str, Any]:
        try:
            response = await self._client.post(
                f"{self._base_url}/guardrail/v1/tool-calls:check",
                headers={TOKEN_HEADER: user_token, "Idempotency-Key": key},
                json=dict(envelope),
            )
        except httpx.HTTPError:
            return blocked("guardrail_unavailable")
        if response.status_code != 200:
            return blocked(f"guardrail_status_{response.status_code}")
        try:
            decision = response.json()
        except ValueError:
            return blocked("guardrail_invalid_response")
        if (
            not isinstance(decision, dict)
            or decision.get("decision") not in DECISIONS
            or not isinstance(decision.get("reason"), str)
        ):
            return blocked("guardrail_invalid_response")
        return decision
