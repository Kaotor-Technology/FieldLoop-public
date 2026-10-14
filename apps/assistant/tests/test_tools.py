import asyncio
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


def test_get_asset_matches_a_feature_and_reports_missing() -> None:
    platform = Platform({"features": [{"properties": {"code": "DL-01"}, "id": 1}]})
    ctx = context(platform=platform)
    get_asset = tool(ctx, "get_asset")
    assert asyncio.run(get_asset("DL-01"))["asset"] is not None
    assert asyncio.run(get_asset("DL-99"))["error"] == "asset_not_found"


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
