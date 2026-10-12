"""Read-only simulated source APIs for the Demo B flood scenario."""

import os
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid5

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from fieldloop_common.google_pubsub import GooglePubSubTransport
from fieldloop_common.signal_publisher import SignalPublisher
from google.cloud.pubsub_v1 import PublisherClient  # type: ignore[import-untyped]
from pydantic import BaseModel, ConfigDict
from starlette.middleware.base import RequestResponseEndpoint

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

ORG_ID = os.getenv("FIELDLOOP_ORG_ID", "fieldloop-demo")
ENVIRONMENT = os.getenv("FIELDLOOP_ENVIRONMENT", "local")
SIMULATION_RUN_NAMESPACE = UUID("d97db000-2a89-4d59-b3ac-0e0c193b8b6d")


class HydroObservation(BaseModel):
    """One synthetic rain, water-level or tide observation."""

    model_config = ConfigDict(frozen=True)

    id: str
    kind: Literal["rain", "level", "tide"]
    value: float
    unit: str
    observed_at: datetime
    label: Literal["SIMULATION"] = "SIMULATION"


class PumpStatus(BaseModel):
    """Synthetic pump and gate state used by Demo B."""

    model_config = ConfigDict(frozen=True)

    id: str
    pump_id: str
    pump_status: Literal["running", "stopped"]
    power_status: Literal["available", "lost"]
    gate_status: Literal["open", "closed"]
    observed_at: datetime
    label: Literal["SIMULATION"] = "SIMULATION"


HYDRO_DATA: dict[str, tuple[str, str, float]] = {
    "rain": ("rain.rate", "mm/h", 60.0),
    "level": ("water.level", "m", 2.8),
    "tide": ("tide.level", "m", 1.4),
}
PUMP_DATA = PumpStatus(
    id="P-3",
    pump_id="P-3",
    pump_status="stopped",
    power_status="lost",
    gate_status="closed",
    observed_at=datetime(2026, 10, 12, tzinfo=UTC),
)


def _publisher() -> SignalPublisher | None:
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("GCP_PROJECT")
    if not project_id:
        return None
    return SignalPublisher(
        GooglePubSubTransport(PublisherClient(), project_id=project_id),
        environment=ENVIRONMENT,
        org_id=ORG_ID,
        simulation_only=True,
    )


@app.middleware("http")
async def reject_write_methods(
    request: Request, call_next: RequestResponseEndpoint
) -> Response:
    """Keep the mock-source surface read-only, including unknown write paths."""
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        return JSONResponse(
            status_code=405,
            content={"detail": "Mock source services are read-only"},
            headers={"Allow": "GET, HEAD, OPTIONS"},
        )
    return await call_next(request)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/mock/hydro/{kind}", response_model=list[HydroObservation])
def hydro(
    kind: Literal["rain", "level", "tide"],
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
) -> list[HydroObservation]:
    if start and end and start > end:
        raise HTTPException(status_code=422, detail="from must be before to")
    _, unit, value = HYDRO_DATA[kind]
    observed_at = end or start or datetime(2026, 10, 12, tzinfo=UTC)
    return [
        HydroObservation(
            id=f"{kind}-demo-001",
            kind=kind,
            value=value,
            unit=unit,
            observed_at=observed_at,
        )
    ]


def _signal_id(source: str, tag: str, observed_at: datetime) -> str:
    stable_input = f"{source}:{tag}:{observed_at.isoformat()}"
    return str(uuid5(SIMULATION_RUN_NAMESPACE, stable_input))


async def publish_hydro_signal(
    kind: Literal["rain", "level", "tide"], publisher: SignalPublisher | None = None
) -> dict[str, str]:
    """Publish the observation when called by the in-process scenario player."""
    publisher = publisher or _publisher()
    if publisher is None:
        raise RuntimeError("Signal publisher is not configured")
    tag, unit, value = HYDRO_DATA[kind]
    observed_at = datetime(2026, 10, 12, tzinfo=UTC)
    result = await publisher.publish(
        {
            "schemaVersion": "signal.v1",
            "id": _signal_id("mock-hydro", tag, observed_at),
            "orgId": ORG_ID,
            "source": "mock-hydro",
            "tag": tag,
            "value": value,
            "observedAt": observed_at.isoformat().replace("+00:00", "Z"),
            "simulated": True,
            "classification": "CONFIDENTIAL",
            "unit": unit,
            "payload": {"label": "SIMULATION", "kind": kind},
        }
    )
    return {"outcome": result.outcome, "messageId": result.message_id}


@app.get("/mock/pumps/{pump_id}/status", response_model=PumpStatus)
def pump_status(pump_id: str) -> PumpStatus:
    if pump_id != PUMP_DATA.pump_id:
        raise HTTPException(status_code=404, detail="Unknown simulated pump")
    return PUMP_DATA


async def publish_pump_signal(
    pump_id: str, publisher: SignalPublisher | None = None
) -> dict[str, str]:
    """Publish pump state when called by the in-process scenario player."""
    if pump_id != PUMP_DATA.pump_id:
        raise HTTPException(status_code=404, detail="Unknown simulated pump")
    publisher = publisher or _publisher()
    if publisher is None:
        raise RuntimeError("Signal publisher is not configured")
    observed_at = PUMP_DATA.observed_at
    result = await publisher.publish(
        {
            "schemaVersion": "signal.v1",
            "id": _signal_id("mock-pumps", "pump.power", observed_at),
            "orgId": ORG_ID,
            "source": "mock-pumps",
            "tag": "pump.power",
            "value": "lost",
            "observedAt": observed_at.isoformat().replace("+00:00", "Z"),
            "simulated": True,
            "classification": "CONFIDENTIAL",
            "payload": {
                "label": "SIMULATION",
                "pumpId": pump_id,
                "pumpStatus": PUMP_DATA.pump_status,
                "gateStatus": PUMP_DATA.gate_status,
            },
        }
    )
    return {"outcome": result.outcome, "messageId": result.message_id}
