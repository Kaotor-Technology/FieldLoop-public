"""Private Cloud Run surface; the BFF checks session, CSRF, roles and Organisation scope."""

import asyncio
import json
import re
import uuid
from importlib.resources import files
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate, ScenarioSummary
from jsonschema import Draft202012Validator, FormatChecker

from fieldloop_simulator.mock_http import app_state
from fieldloop_simulator.player import Command, PlayerError, classification
from fieldloop_simulator.player_service import SimulationService


async def validate_wire_body(request: Request) -> None:
    if request.method != "POST":
        return
    raw = await request.body()
    if len(raw) > 4096:
        raise PlayerError(400, "request_too_large")
    schema = json.loads(files("fieldloop_common").joinpath("simulation.v1.schema.json").read_text())
    name = "RunCreate" if request.url.path == "/v1/simulation/runs" else "PlayerCommand"
    validator = Draft202012Validator(schema["$defs"][name], format_checker=FormatChecker())
    try:
        valid = validator.is_valid(json.loads(raw))
    except (ValueError, UnicodeError):
        valid = False
    if not valid:
        raise PlayerError(400, "validation_failed")


router = APIRouter(prefix="/v1", tags=["Simulation"], dependencies=[Depends(validate_wire_body)])
get_service = app_state("simulation", SimulationService)
Service = Annotated[SimulationService, Depends(get_service)]


def command_key(key: Annotated[str, Header(alias="Idempotency-Key")]) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{16,128}", key):
        raise PlayerError(400, "invalid_idempotency_key")
    return key


Key = Annotated[str, Depends(command_key)]


@router.get("/scenarios", response_model=list[ScenarioSummary])
def scenarios(service: Service) -> list[ScenarioSummary]:
    return [
        ScenarioSummary.model_validate(
            {
                "id": s.id,
                "name": s.name,
                "version": s.version,
                "durationSeconds": s.duration_seconds,
                "simulated": True,
                "classification": classification(s),
            }
        )
        for s in service.player.catalog.values()
    ]


@router.post("/simulation/runs")
async def create_run(
    request: Request, body: RunCreate, service: Service, key: Key
) -> dict[str, object]:
    return await asyncio.to_thread(service.execute, request.url.path, key, body)


@router.get("/simulation/runs/current")
async def current_run(service: Service) -> dict[str, object] | None:
    return await asyncio.to_thread(service.current)


@router.get("/simulation/runs/{run_id}")
async def read_run(run_id: uuid.UUID, service: Service) -> dict[str, object] | None:
    return await asyncio.to_thread(service.current, run_id)


def _command_route(command: Command) -> None:
    async def execute_command(
        run_id: uuid.UUID, request: Request, body: PlayerCommand, service: Service, key: Key
    ) -> dict[str, object]:
        return await asyncio.to_thread(
            service.execute, request.url.path, key, body, run_id, command
        )

    router.add_api_route(
        f"/simulation/runs/{{run_id}}:{command}", execute_command, methods=["POST"]
    )


for _command in ("play", "pause", "step", "speed", "bookmark", "reset"):
    _command_route(_command)
