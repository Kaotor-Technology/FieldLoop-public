"""Agent catalog loader: definitions are Domain Pack data (architecture §7.2)."""

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]
from jsonschema import Draft202012Validator

# Architecture §7.5 caps; a definition may only lower them.
MAX_TOOL_CALLS = 8
MAX_HANDOFFS = 3  # per turn, not per definition: a coordinator may list more delegates
MAX_WALL_SECONDS = 60
MAX_TOKENS = 30_000


class CatalogError(ValueError):
    """A definition is invalid or references something that is not registered."""


@dataclass(frozen=True)
class AgentDefinition:
    id: str
    kind: str
    use_case: str
    ai_system_id: str
    role_prompt: str
    reasoning_template: tuple[str, ...]
    allowed_tools: tuple[str, ...]
    delegates: tuple[str, ...]
    knowledge_folders: tuple[str, ...]
    refusal_rules: tuple[str, ...]
    model_tier: int
    max_steps: int
    max_tokens: int


class AgentCatalog:
    def __init__(self, definitions: Iterable[AgentDefinition], vocabulary: Iterable[str]) -> None:
        registered = set(vocabulary)
        by_id: dict[str, AgentDefinition] = {}
        for definition in definitions:
            if definition.id in by_id:
                raise CatalogError(f"Duplicate agent definition: {definition.id}")
            by_id[definition.id] = definition
        for definition in by_id.values():
            unknown = set(definition.allowed_tools) - registered
            if unknown:
                raise CatalogError(f"{definition.id} lists unknown tools: {sorted(unknown)}")
            missing = set(definition.delegates) - by_id.keys()
            if missing:
                raise CatalogError(
                    f"{definition.id} delegates to unknown agents: {sorted(missing)}"
                )
            if definition.kind == "specialist" and definition.delegates:
                raise CatalogError(f"{definition.id} is a specialist and cannot delegate")
            for delegate in definition.delegates:
                if by_id[delegate].ai_system_id != definition.ai_system_id:
                    raise CatalogError(f"{definition.id} delegates across AI Systems")
        self._by_id = by_id

    def get(self, agent_id: str) -> AgentDefinition:
        try:
            return self._by_id[agent_id]
        except KeyError:
            raise CatalogError(f"Unknown agent: {agent_id}") from None

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_id))


def _definition(raw: Mapping[str, Any]) -> AgentDefinition:
    return AgentDefinition(
        id=raw["id"], kind=raw["kind"], use_case=raw["useCase"], ai_system_id=raw["aiSystemId"],
        role_prompt=raw["rolePrompt"], reasoning_template=tuple(raw["reasoningTemplate"]),
        allowed_tools=tuple(raw["allowedTools"]), delegates=tuple(raw["delegates"]),
        knowledge_folders=tuple(raw["knowledgeFolders"]), refusal_rules=tuple(raw["refusalRules"]),
        model_tier=raw["modelTier"], max_steps=raw["maxSteps"], max_tokens=raw["maxTokens"],
    )


def load_catalog(packs_dir: Path, schema_path: Path, vocabulary: Iterable[str]) -> AgentCatalog:
    validator = Draft202012Validator(json.loads(schema_path.read_text(encoding="utf-8")))
    files = sorted(packs_dir.glob("*/agents/*.yaml"))
    if not files:
        raise CatalogError(f"No agent definitions under {packs_dir}")
    definitions = []
    for file in files:
        raw = yaml.safe_load(file.read_text(encoding="utf-8"))
        errors = sorted(validator.iter_errors(raw), key=lambda e: list(e.path))
        if errors:
            raise CatalogError(f"{file.name}: {errors[0].message}")
        definitions.append(_definition(raw))
    return AgentCatalog(definitions, vocabulary)
