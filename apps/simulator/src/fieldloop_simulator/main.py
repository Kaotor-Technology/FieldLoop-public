import os

from fastapi import FastAPI

from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_historian import router as mock_historian_router
from fieldloop_simulator.mock_http import install_problem_handlers
from fieldloop_simulator.mock_ili import SimulatedIliDrop
from fieldloop_simulator.mock_ili import router as mock_ili_router
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_patrol import router as mock_patrol_router
from fieldloop_simulator.organisation import org_id_from_environment

ORG_ID = org_id_from_environment(os.environ)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
install_problem_handlers(app)
app.state.historian = SimulatedHistorian(org_id=ORG_ID)
app.state.patrol = SimulatedPatrol(org_id=ORG_ID)
app.state.ili = SimulatedIliDrop(bucket=os.environ.get("FIELDLOOP_ILI_DROP_BUCKET") or None)
app.include_router(mock_historian_router)
app.include_router(mock_patrol_router)
app.include_router(mock_ili_router)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
