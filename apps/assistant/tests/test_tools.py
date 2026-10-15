import asyncio
import json
from typing import Any

import pytest
from fieldloop_assistant.tools import ToolContext, TurnState, build_tools

from .support import BOWTIE


class Platform:
    def __init__(self, payload: Any) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str]] = []

    async def get(self, path: str, user_token: str, params: Any = None) -> Any:
        self.calls.append((path, user_token))
        return self.payload


class Knowledge:
    def __init__(self) -> None:
        self.folders: list[list[str]] = []

    async def search(self, query: str, folders: list[str], bbox: Any) -> list[dict[str, Any]]:
        self.folders.append(folders)
        return [{"content": "clause", "citation": {"document_id": "d1", "folder": folders[0]}}]


class Drafts:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> str:
        self.created.append(kwargs)
        return "draft-1"


class GeoPlatform:
    def __init__(self, source: dict[str, Any]) -> None:
        self.source = source
        self.reads: list[tuple[str, str]] = []
        self.created: list[dict[str, Any]] = []

    async def get_geo_source(self, document_id: str, internal_user_token: str) -> dict[str, Any]:
        self.reads.append((document_id, internal_user_token))
        return self.source

    async def create_geo_reference_drafts(
        self,
        document_id: str,
        internal_user_token: str,
        idempotency_key: str,
        references: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self.created.append({
            "document_id": document_id,
            "internal_user_token": internal_user_token,
            "idempotency_key": idempotency_key,
            "references": references,
        })
        return {"references": references, "replayed": False}


class GeoGuardrail:
    def __init__(self, content: str) -> None:
        self.content = content
        self.scanned: list[dict[str, Any]] = []
        self.scan_keys: list[str] = []
        self.completions: list[dict[str, Any]] = []

    async def scan_geo_content(self, **kwargs: Any) -> dict[str, Any]:
        self.scanned.append(kwargs)
        self.scan_keys.append(kwargs["idempotency_key"])
        return {"decision": "allow", "content": kwargs["content"], "classification": "INTERNAL"}

    async def structured_chat_completion(self, **kwargs: Any) -> dict[str, Any]:
        self.completions.append(kwargs)
        return {"choices": [{"message": {"content": self.content}}]}


def context(**override: Any) -> ToolContext:
    base: dict[str, Any] = dict(
        session_id="s1", agent_id="regulatory", user_sub="user-1", user_token="tok",
        knowledge_folders=("Regulatory",), simulated=True, classification="INTERNAL",
        platform=Platform({}), knowledge=Knowledge(), drafts=Drafts(), state=TurnState(),
    )
    base.update(override)
    return ToolContext(**base)


def tool(ctx: ToolContext, name: str, allowed: tuple[str, ...] | None = None):
    functions = {f.__name__: f for f in build_tools(ctx, allowed or (name,))}
    return functions[name]


def test_only_allowed_tools_are_built() -> None:
    names = [f.__name__ for f in build_tools(context(), ("get_barriers", "spatial_query"))]
    assert names == ["get_barriers"]  # spatial_query is in the vocabulary but not implemented


def test_geo_extraction_builds_only_when_allowed_and_returns_confirmation_drafts() -> None:
    document_id = "11111111-2222-4333-8444-555555555555"
    source_text = "Latitude 13.75, Longitude 100.5 at Ban Klang"
    candidate = {
        "latitude": 13.75,
        "longitude": 100.5,
        "chainageFrom": None,
        "chainageTo": None,
        "assetCode": None,
        "placeName": "Ban Klang",
        "sourceSnippet": source_text,
        "confidence": 0.91,
    }
    geo_platform = GeoPlatform({
        "id": document_id, "folder": "Regulatory", "text": source_text,
        "classification": "INTERNAL",
    })
    geo_guardrail = GeoGuardrail(json.dumps({"references": [candidate]}))
    ctx = context(geo_platform=geo_platform, geo_guardrail=geo_guardrail, turn_id="turn-1")

    assert [fn.__name__ for fn in build_tools(ctx, ("spatial_query",))] == []
    extract = tool(ctx, "extract_geo_references")
    result = asyncio.run(extract(document_id))

    assert result == {
        "status": "needs_human_confirmation", "references": [candidate], "replayed": False,
    }
    assert geo_platform.reads == [(document_id, "tok")]
    assert geo_platform.created[0]["internal_user_token"] == "tok"
    assert len(geo_platform.created[0]["idempotency_key"]) >= 16
    assert geo_platform.created[0]["references"] == [candidate]
    assert geo_guardrail.scanned[0]["content"] == source_text
    assert geo_guardrail.scanned[0]["classification"] == "INTERNAL"
    assert geo_guardrail.completions[0]["response_format"]["type"] == "json_schema"

    asyncio.run(extract(document_id))
    assert geo_platform.created[1]["idempotency_key"] == geo_platform.created[0]["idempotency_key"]
    assert geo_guardrail.scan_keys[1] == geo_guardrail.scan_keys[0]

    with pytest.raises(ValueError, match="UUID"):
        asyncio.run(extract("not-a-document-id"))


def test_knowledge_search_is_limited_to_the_agents_folders_and_collects_citations() -> None:
    ctx = context()
    search = tool(ctx, "search_knowledge")
    result = asyncio.run(search("clause 5", ["Regulatory", "Integrity"]))
    assert ctx.knowledge.folders == [["Regulatory"]]  # type: ignore[union-attr]
    assert result["untrusted_content"] is True
    assert ctx.state.citations == [{"document_id": "d1", "folder": "Regulatory"}]
    with pytest.raises(ValueError, match="outside"):
        asyncio.run(search("x", ["Integrity"]))


def test_reads_use_the_internal_user_token_and_validate_identifiers() -> None:
    platform = Platform({"id": BOWTIE, "barriers": [{"id": "b"}], "simulated": True})
    ctx = context(platform=platform)
    asyncio.run(tool(ctx, "get_barriers")(BOWTIE))
    assert platform.calls == [(f"/api/v1/bowties/{BOWTIE}", "tok")]
    with pytest.raises(ValueError, match="UUID"):
        asyncio.run(tool(ctx, "get_bowtie_risk")("../../admin"))


def test_get_asset_reads_the_by_id_endpoint_and_reports_missing() -> None:
    platform = Platform({"id": "a1", "code": "DL-01", "name": "SYNTHETIC pipeline"})
    ctx = context(platform=platform)
    get_asset = tool(ctx, "get_asset")
    assert asyncio.run(get_asset("DL-01"))["asset"]["code"] == "DL-01"
    assert platform.calls == [("/api/v1/assets/DL-01", "tok")]
    missing = context(platform=Platform({"error": "platform_404"}))
    assert asyncio.run(tool(missing, "get_asset")("DL-99")) == {
        "asset": None, "error": "asset_not_found"}
    with pytest.raises(ValueError, match="unsupported"):
        asyncio.run(get_asset("../../v1/me"))


def test_create_draft_records_the_session_and_user_and_never_approves() -> None:
    ctx = context()
    result = asyncio.run(tool(ctx, "create_draft")("management_summary", "text", ["EV-1"]))
    assert result == {"draft_id": "draft-1", "status": "needs_approval"}
    created = ctx.drafts.created[0]  # type: ignore[union-attr]
    assert created["user_sub"] == "user-1" and created["session_id"] == "s1"
    assert ctx.state.draft_ids == ["draft-1"]


def test_create_action_request_body_never_posts_anything() -> None:
    platform = Platform({})
    ctx = context(platform=platform)
    result = asyncio.run(tool(ctx, "create_action_request")(
        "system_of_record", "l0", "cmms", {"a": 1}, "why", ["EV-1"]))
    assert result["status"] == "recommendation_only"
    assert platform.calls == []
