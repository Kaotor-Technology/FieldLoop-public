"""Client for `tool-calls:check` (PRD GR-4). Any failure is a block: the tool never runs."""

import hashlib
import json
from collections.abc import Mapping
from typing import Any

import httpx

from .identity import CLASSIFICATIONS, TOKEN_HEADER

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

    async def scan_content(
        self, user_token: str, ai_system: str, content: str, key: str
    ) -> str | None:
        """`content:scan` (PRD GR-2). Returns text safe to quote to the model, else None."""
        try:
            response = await self._client.post(
                f"{self._base_url}/guardrail/v1/content:scan",
                headers={TOKEN_HEADER: user_token, "Idempotency-Key": key},
                json={"aiSystem": ai_system, "content": content},
            )
            if response.status_code != 200:
                return None
            result = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        if (
            not isinstance(result, dict) or result.get("decision") != "allow"
            or not isinstance(result.get("content"), str)
        ):
            return None
        return str(result["content"])

    async def scan_geo_content(
        self,
        *,
        ai_system: str,
        content: str,
        classification: str,
        internal_user_token: str,
        idempotency_key: str,
    ) -> Mapping[str, Any]:
        """Scan a controlled document and retain the effective classification for extraction."""
        try:
            response = await self._client.post(
                f"{self._base_url}/guardrail/v1/content:scan",
                headers={
                    TOKEN_HEADER: internal_user_token,
                    "Idempotency-Key": idempotency_key,
                    "x-fieldloop-classification": classification,
                },
                json={"aiSystem": ai_system, "content": content},
            )
            if response.status_code != 200:
                return {"decision": "block", "reason": f"guardrail_status_{response.status_code}"}
            result = response.json()
        except (httpx.HTTPError, ValueError):
            return {"decision": "block", "reason": "guardrail_unavailable"}
        if (
            not isinstance(result, dict)
            or result.get("decision") not in {"allow", "reroute"}
            or not isinstance(result.get("content"), str)
            or result.get("classification") not in CLASSIFICATIONS
        ):
            return {"decision": "block", "reason": "guardrail_invalid_response"}
        return result

    async def structured_chat_completion(
        self,
        *,
        ai_system: str,
        model: str,
        messages: list[dict[str, str]],
        response_format: dict[str, Any],
        classification: str,
        internal_user_token: str,
    ) -> Mapping[str, Any]:
        """Request structured output through Guardrail's scanned OpenAI-compatible endpoint."""
        try:
            response = await self._client.post(
                f"{self._base_url}/guardrail/v1/chat/completions",
                headers={
                    TOKEN_HEADER: internal_user_token,
                    "x-fieldloop-classification": classification,
                    "accept": "application/json",
                },
                json={
                    "aiSystem": ai_system,
                    "model": model,
                    "messages": messages,
                    "response_format": response_format,
                },
            )
            if response.status_code != 200:
                raise RuntimeError("Guardrail structured completion was not allowed")
            result = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RuntimeError("Guardrail structured completion is unavailable") from error
        if not isinstance(result, dict):
            raise RuntimeError("Guardrail returned an invalid structured completion")
        return result
