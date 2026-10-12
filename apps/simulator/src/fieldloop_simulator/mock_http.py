"""Shared HTTP plumbing for the read-only mock source systems (SIM-2)."""

import re
from collections.abc import Callable, Coroutine
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from fastapi.types import DecoratedCallable
from pydantic import AwareDatetime, BeforeValidator

PROBLEM_JSON = "application/problem+json"

# RFC 3339 allows lowercase t and z. [0-9] is explicit because \d also matches other scripts.
_RFC3339 = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?"
    r"(?:[Zz]|[+-][0-9]{2}:[0-9]{2})"
)
# Every method except GET is refused, so a mock source has no write path to forget about.
_REFUSED_METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE", "CONNECT"]


def require_rfc3339(value: object) -> object:
    # FastAPI validates trusted datetime defaults too; HTTP query input is always a string.
    if isinstance(value, datetime):
        return value
    # Pydantic also accepts numeric epoch strings; the wire contract does not.
    if not isinstance(value, str) or _RFC3339.fullmatch(value) is None:
        raise ValueError("Expected a timezone-aware RFC 3339 timestamp.")
    return value


Rfc3339 = Annotated[AwareDatetime, BeforeValidator(require_rfc3339)]


def problem(
    status: int, title: str, code: str, *, headers: dict[str, str] | None = None
) -> JSONResponse:
    # Never echo request values: they may carry restricted identifiers (RFC 9457 detail rule).
    return JSONResponse(
        status_code=status,
        media_type=PROBLEM_JSON,
        headers=headers,
        content={"type": "about:blank", "title": title, "status": status, "code": code},
    )


class ProblemRoute(APIRoute):
    """Report request validation failures as 400 problem+json."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def route_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                return problem(400, "Invalid mock source request", "validation_failed")

        return route_handler


async def _refuse_write() -> JSONResponse:
    # The shared ErrorCode enum has no method-specific code; validation_failed is the closest.
    return problem(405, "Only GET is allowed", "validation_failed", headers={"Allow": "GET"})


class ReadOnlyRouter(APIRouter):
    """A router that answers every method except GET with 405 on each path it serves."""

    def __init__(self, *, prefix: str, tag: str) -> None:
        super().__init__(prefix=prefix, tags=[tag], route_class=ProblemRoute)

    def read(self, path: str, **kwargs: Any) -> Callable[[DecoratedCallable], DecoratedCallable]:
        self.add_api_route(path, _refuse_write, methods=_REFUSED_METHODS, include_in_schema=False)
        return self.get(path, **kwargs)
