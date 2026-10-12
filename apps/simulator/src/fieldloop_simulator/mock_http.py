"""Shared HTTP plumbing for the read-only mock source systems (SIM-2)."""

import re
from collections.abc import Callable
from datetime import datetime
from typing import Annotated

from fastapi import FastAPI, Request, Response
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, AwareDatetime, BeforeValidator
from starlette.exceptions import HTTPException as StarletteHTTPException

from fieldloop_simulator.timestamps import to_utc

PROBLEM_JSON = "application/problem+json"
MOCK_PREFIX = "/mock/"

# RFC 3339 allows lowercase t and z. [0-9] is explicit because \d also matches other scripts.
_RFC3339 = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?"
    r"(?:[Zz]|[+-][0-9]{2}:[0-9]{2})"
)


def require_rfc3339(value: object) -> object:
    # FastAPI validates trusted datetime defaults too; HTTP query input is always a string.
    if isinstance(value, datetime):
        return value
    # Pydantic also accepts numeric epoch strings; the wire contract does not.
    if not isinstance(value, str) or _RFC3339.fullmatch(value) is None:
        raise ValueError("Expected a timezone-aware RFC 3339 timestamp.")
    return value


# Normalised to UTC at the boundary, so handlers never convert (and never overflow).
Rfc3339 = Annotated[AwareDatetime, BeforeValidator(require_rfc3339), AfterValidator(to_utc)]


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


def app_state[T](name: str, kind: type[T]) -> Callable[[Request], T]:
    """A dependency that returns ``app.state.<name>``, which must be a ``kind``."""

    def provide(request: Request) -> T:
        value = getattr(request.app.state, name, None)
        if not isinstance(value, kind):
            raise RuntimeError(f"The simulator has no {name} configured")
        return value

    return provide


def install_problem_handlers(app: FastAPI) -> None:
    """Answer every error under ``/mock/`` as RFC 9457 problem+json.

    That covers a bad query (400), an unknown path (404) and a method the path does not serve
    (405 with ``Allow: GET``, from the router's own partial match), whichever route raised it.
    Other paths keep FastAPI's defaults.
    """

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> Response:
        if not request.url.path.startswith(MOCK_PREFIX):
            return await request_validation_exception_handler(request, error)
        return problem(400, "Invalid mock source request", "validation_failed")

    @app.exception_handler(StarletteHTTPException)
    async def failed_request(request: Request, error: StarletteHTTPException) -> Response:
        if not request.url.path.startswith(MOCK_PREFIX):
            return await http_exception_handler(request, error)
        if error.status_code == 404:
            return problem(404, "Unknown mock source path", "not_found")
        if error.status_code == 405:
            allow = {"Allow": error.headers["Allow"]} if error.headers else None
            return problem(405, "Only GET is allowed", "method_not_allowed", headers=allow)
        return await http_exception_handler(request, error)
