import os

from fastapi import FastAPI

from fieldloop_simulator.mock_cmms import SimulatedCmms
from fieldloop_simulator.mock_cmms import router as mock_cmms_router
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_historian import router as mock_historian_router
from fieldloop_simulator.mock_http import install_problem_handlers
from fieldloop_simulator.mock_hydro import SimulatedHydro
from fieldloop_simulator.mock_hydro import router as mock_hydro_router
from fieldloop_simulator.mock_ili import SimulatedIliDrop
from fieldloop_simulator.mock_ili import router as mock_ili_router
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_patrol import router as mock_patrol_router
from fieldloop_simulator.mock_pumps import SimulatedPumps
from fieldloop_simulator.mock_pumps import router as mock_pumps_router
from fieldloop_simulator.organisation import org_id_from_environment

ORG_ID = org_id_from_environment(os.environ)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
install_problem_handlers(app)
app.state.cmms = SimulatedCmms(org_id=ORG_ID)
app.state.historian = SimulatedHistorian(org_id=ORG_ID)
app.state.patrol = SimulatedPatrol(org_id=ORG_ID)
app.state.ili = SimulatedIliDrop(bucket=os.environ.get("FIELDLOOP_ILI_DROP_BUCKET") or None)
app.state.hydro = SimulatedHydro(org_id=ORG_ID)
app.state.pumps = SimulatedPumps(org_id=ORG_ID)
app.include_router(mock_cmms_router)
app.include_router(mock_historian_router)
app.include_router(mock_patrol_router)
app.include_router(mock_ili_router)
app.include_router(mock_hydro_router)
app.include_router(mock_pumps_router)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
