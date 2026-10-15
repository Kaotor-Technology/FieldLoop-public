"""Fakes for runtime tests: no network, no model, no database."""

import asyncio
import json
import re
from collections.abc import AsyncGenerator, Callable
from typing import Any

import httpx
from fieldloop_assistant.events import StreamEvent
from fieldloop_assistant.guardrail_client import GuardrailClient
from fieldloop_assistant.runtime import AgentRuntime, RuntimeDeps
from fieldloop_assistant.tools import HttpPlatformReader, KnowledgeProvider
from fieldloop_assistant.trace import MemoryStore, SessionRecord
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import PrivateAttr

from .support import BOWTIE, REPO, RUN_ID, USER_TOKEN, catalog

__all__ = ["BOWTIE", "REPO", "RUN_ID", "USER_TOKEN"]

def call(name: str, **args: Any) -> LlmResponse:
    part = types.Part(function_call=types.FunctionCall(name=name, args=args))
    return LlmResponse(
        content=types.Content(role="model", parts=[part]),
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=10, candidates_token_count=5),
    )


def say(text: str, tokens: int = 15) -> LlmResponse:
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text=text)]),
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=tokens, candidates_token_count=0),
    )


def answer(**extra: Any) -> LlmResponse:
    body = {"answer": "ok", "citations": [], "known": [], "unknown": [], "assumptions": [],
            "confidence": "medium", "confidence_reason": "tests", **extra}
    return say(json.dumps(body))


class ScriptedLlm(BaseLlm):
    """Replays a script; a callable entry sees the request, so tests can inspect headers."""

    model: str = "scripted"
    script: list[Any]
    _index: int = PrivateAttr(default=0)
    requests: list[LlmRequest] = []

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(llm_request)
        item = self.script[min(self._index, len(self.script) - 1)]
        self._index += 1
        yield item(llm_request) if callable(item) else item


class Harness:
    def __init__(
        self,
        script: list[Any],
        guardrail: Callable[[dict[str, Any]], dict[str, Any] | int] | None = None,
        platform: dict[str, Any] | None = None,
        simulated: bool = False,
        knowledge: KnowledgeProvider | None = None,
    ) -> None:
        self.guardrail_requests: list[httpx.Request] = []
        self.platform_requests: list[httpx.Request] = []
        self._guardrail = guardrail or (
            lambda body: {"decision": "allow", "reason": "registered_read"}
        )
        self._platform = platform if platform is not None else {}
        self.scan: Callable[[dict[str, Any]], dict[str, Any] | int] = lambda body: {
            "decision": "allow", "content": body["content"], "classification": "INTERNAL",
            "policyId": "00000000-0000-4000-8000-000000000000",
        }
        self.store = MemoryStore()
        self.adk = InMemorySessionService()
        self.llm = ScriptedLlm(script=script)
        self.simulated = simulated
        client = httpx.AsyncClient(transport=httpx.MockTransport(self._route))
        self.runtime = AgentRuntime(RuntimeDeps(
            catalog=catalog(), guardrail=GuardrailClient(client, "http://guardrail"),
            platform=HttpPlatformReader(client, "http://platform"), sessions=self.store,
            trace=self.store, adk_sessions=self.adk, model_factory=lambda _: self.llm,
            knowledge=lambda _: knowledge,
        ))

    def _route(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "guardrail":
            self.guardrail_requests.append(request)
            body = json.loads(request.content)
            if request.url.path.endswith("content:scan"):
                outcome = self.scan(body)
                if isinstance(outcome, int):
                    return httpx.Response(outcome)
                return httpx.Response(200, json=outcome)
            result = self._guardrail(body)
            if isinstance(result, int):
                return httpx.Response(result)
            return httpx.Response(200, json=result)
        self.platform_requests.append(request)
        for pattern, payload in self._platform.items():
            if re.fullmatch(pattern, request.url.path):
                return httpx.Response(200, json=payload)
        return httpx.Response(404, json={})

    async def session(self, agent: str) -> SessionRecord:
        return await self.store.create(
            org_id="org-1", agent_id=agent, user_sub="user-1", simulated=self.simulated,
            classification="INTERNAL",
        )

    async def run(self, agent: str, message: str = "Review DL-01") -> list[StreamEvent]:
        record = await self.session(agent)
        return await self.collect(record, agent, message)

    async def collect(
        self, record: SessionRecord, agent: str, message: str = "Review DL-01"
    ) -> list[StreamEvent]:
        async def go() -> list[StreamEvent]:
            return [e async for e in self.runtime.run_turn(record, USER_TOKEN, message, agent)]

        return await asyncio.wait_for(go(), 20)

    @staticmethod
    def names(events: list[StreamEvent]) -> list[str]:
        return [e.name for e in events]
