"""Constants and the real Domain Pack catalog shared by the assistant tests."""

from pathlib import Path

from fieldloop_assistant.catalog import AgentCatalog, load_catalog
from fieldloop_assistant.tools import DEFINITION_VOCABULARY

REPO = Path(__file__).resolve().parents[3]
BOWTIE = "5f0c8b1e-2f2a-4c6e-9d5a-0a1b2c3d4e5f"
RUN_ID = "7a9c0f4e-1b2d-4e3f-8a6b-5c4d3e2f1a0b"
USER_TOKEN = "internal-user-token-for-tests"


def catalog() -> AgentCatalog:
    return load_catalog(
        REPO / "domain-packs", REPO / "packages/contracts/agent-definition.v1.schema.json",
        DEFINITION_VOCABULARY,
    )
