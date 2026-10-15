"""HTTP surface of the assistant (architecture §7.4): sessions, SSE messages and cancel."""

from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .identity import (
    CLASSIFICATIONS,
    TOKEN_HEADER,
    InternalTokenVerifier,
    InvalidTokenError,
    UserIdentity,
)
from .runtime import AgentRuntime, TurnInProgressError
from .trace import SessionStore

# Agents a person may start from the UI; specialists run only as delegates of a coordinator.
STARTABLE = ("integrity-orchestrator", "flood-situation")
DEFAULT_CLASSIFICATION = "INTERNAL"


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent: str = Field(min_length=1, max_length=64)


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=4000)


class Authenticated:
    def __init__(self, identity: UserIdentity, token: str) -> None:
        self.identity = identity
        self.token = token


def session_classification(clearance: str) -> str:
    """A session never exceeds INTERNAL unless the user's clearance is lower."""
    cap = CLASSIFICATIONS.index(DEFAULT_CLASSIFICATION)
    return CLASSIFICATIONS[min(cap, CLASSIFICATIONS.index(clearance))]


def create_service(
    runtime: AgentRuntime | None, sessions: SessionStore | None,
    verifier: InternalTokenVerifier | None, *, simulated: bool = True,
    startable: tuple[str, ...] = STARTABLE,
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    def problem(status: int, code: str) -> JSONResponse:
        return JSONResponse(
            {"type": "about:blank", "title": code, "status": status, "code": code},
            status_code=status, media_type="application/problem+json",
            headers={"cache-control": "private, no-store"},
        )

    async def authenticate(
        request: Request,
        token: Annotated[str | None, Header(alias=TOKEN_HEADER)] = None,
    ) -> Authenticated:
        if verifier is None or runtime is None or sessions is None:
            raise HTTPException(503, "service_unavailable")
        if not token:
            raise HTTPException(401, "unauthenticated")
        try:
            return Authenticated(verifier.verify(token), token)
        except InvalidTokenError:
            raise HTTPException(401, "unauthenticated") from None

    @app.exception_handler(HTTPException)
    async def http_problem(_: Request, error: HTTPException) -> JSONResponse:
        return problem(error.status_code, str(error.detail))

    @app.post("/assistant/v1/sessions", status_code=201)
    async def create_session(
        body: SessionCreate, auth: Annotated[Authenticated, Depends(authenticate)]
    ) -> dict[str, Any]:
        assert runtime is not None and sessions is not None
        if body.agent not in startable:
            raise HTTPException(400, "agent_not_startable")
        record = await sessions.create(
            org_id=auth.identity.org_id, agent_id=body.agent, user_sub=auth.identity.sub,
            simulated=simulated, classification=session_classification(auth.identity.clearance),
        )
        return {"id": record.id, "agent": record.agent_id, "simulated": record.simulated,
                "classification": record.classification, "status": record.status}

    @app.post("/assistant/v1/sessions/{session_id}/messages")
    async def send_message(
        session_id: str, body: MessageCreate, auth: Annotated[Authenticated, Depends(authenticate)]
    ) -> StreamingResponse:
        assert runtime is not None and sessions is not None
        record = await sessions.get(session_id, auth.identity.org_id, auth.identity.sub)
        if record is None:
            raise HTTPException(404, "not_found")
        permitted = CLASSIFICATIONS[: CLASSIFICATIONS.index(auth.identity.clearance) + 1]
        if record.classification not in permitted:
            raise HTTPException(403, "forbidden")

        try:
            handle = await runtime.begin(record, auth.token, body.message, record.agent_id)
        except TurnInProgressError:
            raise HTTPException(409, "turn_in_progress") from None

        async def stream() -> AsyncIterator[str]:
            async for event in runtime.stream(handle):
                yield event.encode()

        return StreamingResponse(
            stream(), media_type="text/event-stream",
            headers={"cache-control": "private, no-store", "x-accel-buffering": "no"},
        )

    @app.post("/assistant/v1/sessions/{session_id}:cancel", status_code=202)
    async def cancel(
        session_id: str, auth: Annotated[Authenticated, Depends(authenticate)]
    ) -> dict[str, bool]:
        assert runtime is not None and sessions is not None
        record = await sessions.get(session_id, auth.identity.org_id, auth.identity.sub)
        if record is None:
            raise HTTPException(404, "not_found")
        return {"cancelling": await runtime.request_cancel(record)}

    return app
