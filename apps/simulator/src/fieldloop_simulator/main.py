import os

from fastapi import FastAPI

from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_historian import router as mock_historian_router
from fieldloop_simulator.mock_signals import DEMO_ORG_ID

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.state.historian = SimulatedHistorian(org_id=os.environ.get("FIELDLOOP_ORG_ID", DEMO_ORG_ID))
app.include_router(mock_historian_router)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
