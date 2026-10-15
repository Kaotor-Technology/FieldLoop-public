"""Process wiring. Without configuration only /healthz answers and every route returns 503."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import FastAPI
from google.adk.models.base_llm import BaseLlm
from google.adk.models.lite_llm import LiteLlm
from google.adk.sessions import DatabaseSessionService
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from .catalog import AgentDefinition, load_catalog
from .geo_extraction import HttpGeoExtractionPlatform
from .guardrail_client import GuardrailClient
from .identity import InternalTokenVerifier
from .knowledge import KnowledgeScope, KnowledgeSearch
from .runtime import AgentRuntime, RuntimeDeps
from .service import create_service
from .tools import DEFINITION_VOCABULARY, HttpPlatformReader, KnowledgeProvider
from .trace import PostgresDraftStore, PostgresStore, SessionRecord

ROUTES = {1: "flash", 2: "pro", 3: "pro"}
CLASSES = ("PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED")


@dataclass(frozen=True)
class Settings:
    org_id: str
    database_url: str
    adk_database_url: str
    guardrail_url: str
    platform_url: str
    jwks: str
    issuer: str
    audience: str
    packs_dir: Path
    schema_path: Path
    simulated: bool

    @classmethod
    def from_env(cls) -> "Settings | None":
        names = {
            "org_id": "FIELDLOOP_ORG_ID",
            "database_url": "FIELDLOOP_DATABASE_URL",
            "adk_database_url": "FIELDLOOP_ADK_DATABASE_URL",
            "guardrail_url": "FIELDLOOP_GUARDRAIL_URL",
            "platform_url": "FIELDLOOP_PLATFORM_API_URL",
            "jwks": "FIELDLOOP_INTERNAL_JWKS",
            "issuer": "FIELDLOOP_INTERNAL_TOKEN_ISSUER",
            "audience": "FIELDLOOP_INTERNAL_TOKEN_AUDIENCE",
        }
        values = {key: os.environ.get(env, "") for key, env in names.items()}
        if not all(values.values()):
            return None
        return cls(
            **values,
            packs_dir=Path(os.environ.get("FIELDLOOP_DOMAIN_PACKS_DIR", "/app/domain-packs")),
            schema_path=Path(os.environ.get(
                "FIELDLOOP_AGENT_SCHEMA",
                "/app/packages/contracts/agent-definition.v1.schema.json",
            )),
            simulated=os.environ.get("SIMULATED", "true").lower() != "false",
        )


def guardrail_model(definition: AgentDefinition, guardrail_url: str) -> BaseLlm:
    """Every model call goes to the Guardrail's OpenAI-compatible endpoint (PRD GR-1)."""
    return LiteLlm(
        model=f"openai/{ROUTES[definition.model_tier]}",
        api_base=f"{guardrail_url.rstrip('/')}/guardrail/v1",
        api_key="not-a-secret",  # the Guardrail authenticates the internal user token header
        extra_body={"aiSystem": definition.ai_system_id},
    )


class _Knowledge:
    def __init__(self, search: KnowledgeSearch) -> None:
        self._search = search

    async def search(
        self, query: str, folders: list[str], bbox: tuple[float, float, float, float] | None
    ) -> list[dict[str, object]]:
        results = await self._search.search_knowledge(query, folders, bbox)
        return list(results)


def build_app(settings: Settings | None) -> FastAPI:
    if settings is None:
        return create_service(None, None, None)
    catalog = load_catalog(settings.packs_dir, settings.schema_path, DEFINITION_VOCABULARY)
    pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
        settings.database_url, open=False, min_size=0, max_size=5,
        kwargs={"row_factory": dict_row},
    )
    http = httpx.AsyncClient(timeout=httpx.Timeout(10.0))
    store = PostgresStore(pool)
    folders = tuple(sorted({f for a in catalog.ids() for f in catalog.get(a).knowledge_folders}))

    def knowledge(session: SessionRecord) -> KnowledgeProvider | None:
        # Imported lazily: constructing Vertex embeddings needs project credentials.
        project = os.environ.get("FIELDLOOP_GCP_PROJECT")
        if not project:
            return None
        from fieldloop_adapters.embeddings import vertex_embeddings

        classes = CLASSES[: CLASSES.index(session.classification) + 1]
        scope = KnowledgeScope(session.org_id, folders, classes)
        return _Knowledge(KnowledgeSearch(pool, vertex_embeddings(project), scope))

    adk_sessions = DatabaseSessionService(
        db_url=settings.adk_database_url,
        connect_args={"server_settings": {"search_path": "adk"}},
    )
    deps = RuntimeDeps(
        catalog=catalog, guardrail=GuardrailClient(http, settings.guardrail_url),
        platform=HttpPlatformReader(http, settings.platform_url), sessions=store, trace=store,
        adk_sessions=adk_sessions,
        model_factory=lambda d: guardrail_model(d, settings.guardrail_url),
        geo_platform=HttpGeoExtractionPlatform(http, settings.platform_url),
        knowledge=knowledge,
        drafts=lambda s: PostgresDraftStore(pool, s.org_id, s.simulated, s.classification),
    )
    verifier = InternalTokenVerifier(
        settings.jwks, settings.issuer, settings.audience, settings.org_id
    )
    app = create_service(AgentRuntime(deps), store, verifier, simulated=settings.simulated)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await pool.open()
        try:
            yield
        finally:
            await http.aclose()
            await adk_sessions.close()
            await pool.close()

    app.router.lifespan_context = lifespan
    return app


app = build_app(Settings.from_env())
