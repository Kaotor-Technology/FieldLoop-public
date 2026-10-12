import os

from fastapi import FastAPI

from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_historian import router as mock_historian_router
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_patrol import router as mock_patrol_router
from fieldloop_simulator.organisation import org_id_from_environment

ORG_ID = org_id_from_environment(os.environ)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.state.historian = SimulatedHistorian(org_id=ORG_ID)
app.state.patrol = SimulatedPatrol(org_id=ORG_ID)
app.include_router(mock_historian_router)
app.include_router(mock_patrol_router)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
