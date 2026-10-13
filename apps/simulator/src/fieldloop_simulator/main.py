import asyncio
import logging
import os
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from functools import lru_cache
from importlib.resources import files
from ipaddress import ip_address
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fieldloop_common.sql_connection import sql_connection_factory

from fieldloop_simulator.mock_cmms import SimulatedCmms
from fieldloop_simulator.mock_cmms import router as mock_cmms_router
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_historian import router as mock_historian_router
from fieldloop_simulator.mock_http import install_problem_handlers, problem
from fieldloop_simulator.mock_ili import SimulatedIliDrop
from fieldloop_simulator.mock_ili import router as mock_ili_router
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_patrol import router as mock_patrol_router
from fieldloop_simulator.mock_signals import (
    SimulatedSignalEmitter,
    signal_publisher_from_environment,
)
from fieldloop_simulator.organisation import org_id_from_environment
from fieldloop_simulator.player import PlayerError, ScenarioPlayer
from fieldloop_simulator.player_http import router as player_router
from fieldloop_simulator.player_service import SimulationService
from fieldloop_simulator.player_store import PostgresPlayerStore
from fieldloop_simulator.scenario import load_catalog

ORG_ID = org_id_from_environment(os.environ)

_store: PostgresPlayerStore | None = None
_runtime_lock = threading.RLock()


def _noop() -> None:
    pass


_close_connector: Callable[[], None] = _noop


def store() -> PostgresPlayerStore:
    global _store, _close_connector
    with _runtime_lock:
        if _store is None:
            connect, _close_connector = sql_connection_factory(os.environ)
            _store = PostgresPlayerStore(connect, ORG_ID)
        return _store


@lru_cache(maxsize=1)
def emitter() -> SimulatedSignalEmitter:
    return SimulatedSignalEmitter(signal_publisher_from_environment(os.environ), org_id=ORG_ID)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    if _store:
        await asyncio.to_thread(_store.close)
    _close_connector()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
install_problem_handlers(app)
app.state.cmms = SimulatedCmms(org_id=ORG_ID)
app.state.historian = SimulatedHistorian(org_id=ORG_ID)
app.state.patrol = SimulatedPatrol(org_id=ORG_ID)
app.state.ili = SimulatedIliDrop(bucket=os.environ.get("FIELDLOOP_ILI_DROP_BUCKET") or None)
local_catalog = Path(__file__).resolve().parents[4] / "data/scenarios"
default_catalog = (
    local_catalog
    if local_catalog.is_dir()
    else Path(str(files("fieldloop_simulator").joinpath("scenarios")))
)
catalog_path = Path(os.environ.get("FIELDLOOP_SCENARIO_DIR", str(default_catalog)))
if "FIELDLOOP_SCENARIO_DIR" in os.environ and not catalog_path.is_dir():
    raise RuntimeError("The configured Scenario catalog is not a directory")
catalog = load_catalog(catalog_path)
player = ScenarioPlayer(
    catalog,
    ORG_ID,
    emitter,
)
app.state.simulation = SimulationService(player, store, app.state.historian)
app.include_router(player_router)
app.include_router(mock_cmms_router)
app.include_router(mock_historian_router)
app.include_router(mock_patrol_router)
app.include_router(mock_ili_router)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.exception_handler(PlayerError)
async def player_error(request: Request, error: PlayerError) -> Response:
    return problem(error.status, "Simulation request could not be completed", error.code)


@app.exception_handler(Exception)
async def unavailable(request: Request, error: Exception) -> Response:
    logging.getLogger(__name__).error("Simulation boundary failed: %s", type(error).__name__)
    return problem(503, "Simulation service unavailable", "service_unavailable")


@app.middleware("http")
async def private_surface(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    if request.url.path.startswith(("/v1/simulation/", "/v1/scenarios")):
        environment = os.environ.get("FIELDLOOP_ENV", "local")
        if environment not in ("local", "dev", "demo"):
            return problem(
                503, "Simulation is unavailable in this environment", "environment_denied"
            )
        if environment == "local":
            try:
                loopback = (
                    request.client is not None and ip_address(request.client.host).is_loopback
                )
            except ValueError:
                loopback = False
            if not loopback:
                return problem(403, "Local simulation requires a loopback caller", "caller_denied")
    # Rehydrate source reads after a cold start without advancing or publishing from GET /mock.
    if request.url.path.startswith("/mock/") and (
        _store is not None
        or "FIELDLOOP_DATABASE_URL" in os.environ
        or "FIELDLOOP_DB_NAME" in os.environ
    ):
        await asyncio.to_thread(app.state.simulation.hydrate_sources)
    return await call_next(request)
