import re
from dataclasses import replace

import pytest
from fieldloop_assistant.catalog import AgentCatalog, CatalogError
from fieldloop_assistant.limits import TurnBudget
from fieldloop_assistant.tools import DEFINITION_VOCABULARY, TOOL_NAMES

from .support import REPO, catalog


def test_real_domain_pack_definitions_load_and_validate() -> None:
    found = catalog()
    assert set(found.ids()) >= {"integrity-orchestrator", "flood-situation"}
    assert found.get("integrity-orchestrator").delegates
    assert found.get("flood-situation").ai_system_id == "demo-uc-4"


def test_definition_vocabulary_matches_the_shared_typescript_set() -> None:
    source = (REPO / "packages/adapters/src/demo-agent-tools.ts").read_text()
    names = set(re.findall(r'"([a-z_]+)"', source.split("new Set([", 1)[1]))
    assert names == set(DEFINITION_VOCABULARY)
    assert TOOL_NAMES <= names


def test_unknown_tool_unknown_delegate_and_cross_system_delegation_are_rejected() -> None:
    base = catalog().get("integrity-orchestrator")
    other = catalog().get("flood-situation")
    spec = catalog().get("code-standard")
    with pytest.raises(CatalogError, match="unknown tools"):
        unlisted = replace(base, allowed_tools=("cmms_write",), delegates=())
        AgentCatalog([unlisted], DEFINITION_VOCABULARY)
    with pytest.raises(CatalogError, match="unknown agents"):
        AgentCatalog([replace(base, delegates=("ghost",))], DEFINITION_VOCABULARY)
    with pytest.raises(CatalogError, match="across AI Systems"):
        AgentCatalog([replace(base, delegates=("flood-situation",)), other], DEFINITION_VOCABULARY)
    with pytest.raises(CatalogError, match="cannot delegate"):
        AgentCatalog([replace(spec, delegates=("code-standard",))], DEFINITION_VOCABULARY)


def test_turn_budget_enforces_the_architecture_limits() -> None:
    budget = TurnBudget.for_agent(catalog().get("integrity-orchestrator"))
    assert [budget.take_tool_call() for _ in range(8)] == [None] * 8
    assert budget.take_tool_call() == "tool_calls"
    other = TurnBudget()
    assert [other.take_handoff() for _ in range(3)] == [None] * 3
    assert other.take_handoff() == "handoffs"
    assert TurnBudget(max_tokens=100).charge_tokens(100) == "token_budget"
    assert TurnBudget(max_seconds=0).check_time() == "wall_clock"
