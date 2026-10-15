"""Reference-only results through the existing registered/guarded search tool."""

import asyncio
import json

import pytest
from fieldloop_assistant.guardrail_client import TOKEN_HEADER
from fieldloop_assistant.reference_catalog import load_reference_catalog
from fieldloop_assistant.tools import ToolContext, TurnState, build_tools

from .harness import Harness, answer, call
from .support import REPO, USER_TOKEN


@pytest.mark.parametrize("standard", ["ASME B31.8", "ASME B31.8S", "API RP 1160"])
def test_registered_search_returns_only_labelled_bibliography(standard):
    state = TurnState()
    ctx = ToolContext(
        session_id="s", agent_id="code-standard", user_sub="u", user_token=USER_TOKEN,
        knowledge_folders=("Codes & Standards",), simulated=True, classification="PUBLIC",
        platform=None, knowledge=None, drafts=None, state=state,  # type: ignore[arg-type]
        reference_catalog=load_reference_catalog(REPO),
    )
    tool = build_tools(ctx, ("search_knowledge",))[0]
    result = asyncio.run(tool(standard + " full text"))
    assert result["results"] == []
    assert len(result["references"]) == 1
    reference = result["references"][0]
    assert reference["standard"] == standard
    assert reference["contentState"] == "metadata_only"
    assert reference["verificationLabel"] == "not verified against source text"
    assert reference["citationReady"] is False and reference["clause"] is None
    assert not {"content", "text", "chunks", "embedding"}.intersection(reference)
    assert state.citations == []
    assert state.warnings == ["reference_not_verified_against_source_text"]


def test_runtime_keeps_reference_search_behind_tool_check():
    h = Harness([call("search_knowledge", query="ASME B31.8"), answer()])
    h.runtime._deps.reference_catalog = load_reference_catalog(REPO)
    events = asyncio.run(h.run("code-standard", "Find ASME B31.8"))
    assert json.loads(h.guardrail_requests[0].content)["tool"] == "search_knowledge"
    assert h.guardrail_requests[0].headers[TOKEN_HEADER] == USER_TOKEN
    result = next(e for e in events if e.name == "tool.result")
    assert "ASME B31.8" in json.dumps(result.data)
    assert "reference_not_verified_against_source_text" in next(
        e for e in events if e.name == "answer.final"
    ).data["warnings"]


def test_denied_reference_call_does_not_return_metadata():
    h = Harness(
        [call("search_knowledge", query="ASME B31.8"), answer()],
        guardrail=lambda body: {"decision": "block", "reason": "denied"},
    )
    h.runtime._deps.reference_catalog = load_reference_catalog(REPO)
    events = asyncio.run(h.run("code-standard", "Find ASME B31.8"))
    results = [e.data for e in events if e.name == "tool.result"]
    assert all("references" not in json.dumps(result) for result in results)


def test_reference_search_does_not_cross_agent_folder_scope():
    ctx = ToolContext(
        session_id="s", agent_id="regulatory", user_sub="u", user_token=USER_TOKEN,
        knowledge_folders=("Regulatory",), simulated=True, classification="PUBLIC",
        platform=None, knowledge=None, drafts=None, state=TurnState(),  # type: ignore[arg-type]
        reference_catalog=load_reference_catalog(REPO),
    )
    with pytest.raises(ValueError, match="scope"):
        asyncio.run(build_tools(ctx, ("search_knowledge",))[0]("ASME B31.8"))


def test_an_unrelated_api_query_keeps_normal_knowledge_search():
    from .test_tools import Knowledge, context

    knowledge = Knowledge()
    ctx = context(knowledge=knowledge)
    result = asyncio.run(build_tools(ctx, ("search_knowledge",))[0]("public API architecture"))
    assert knowledge.folders == [["Regulatory"]]
    assert "references" not in result


def test_unknown_standard_never_falls_through_to_full_text():
    class FullTextTripwire:
        async def search(self, query, folders, bbox):
            raise AssertionError("unlicensed standards must not use full-text/embedding search")

    ctx = ToolContext(
        session_id="s", agent_id="code-standard", user_sub="u", user_token=USER_TOKEN,
        knowledge_folders=("Codes & Standards",), simulated=True, classification="PUBLIC",
        platform=None, knowledge=FullTextTripwire(), drafts=None, state=TurnState(),
        reference_catalog=load_reference_catalog(REPO),
    )
    tool = build_tools(ctx, ("search_knowledge",))[0]
    result = asyncio.run(tool("API 99999 full text"))
    assert result["results"] == [] and result["references"] == []
    assert asyncio.run(tool("ASME B31.8"))["references"][0]["standard"] == "ASME B31.8"
