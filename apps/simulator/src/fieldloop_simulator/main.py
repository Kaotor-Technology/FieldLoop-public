from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from fieldloop_simulator.mock_cmms import router as mock_cmms_router

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(mock_cmms_router)


@app.exception_handler(RequestValidationError)
async def validation_problem(request: Request, exception: RequestValidationError) -> Response:
    if not request.url.path.startswith("/mock/cmms/"):
        return await request_validation_exception_handler(request, exception)
    return JSONResponse(
        status_code=400,
        media_type="application/problem+json",
        content={
            "type": "about:blank",
            "title": "Invalid mock CMMS query",
            "status": 400,
            "code": "validation_failed",
            "detail": "Use a valid boolean and timezone-aware asOf.",
        },
    )


@app.exception_handler(StarletteHTTPException)
async def http_problem(request: Request, exception: StarletteHTTPException) -> Response:
    if not request.url.path.startswith("/mock/cmms/"):
        return await http_exception_handler(request, exception)
    return JSONResponse(
        status_code=exception.status_code,
        media_type="application/problem+json",
        headers=exception.headers,
        content={
            "type": "about:blank",
            "title": str(exception.detail),
            "status": exception.status_code,
            "code": "not_found" if exception.status_code == 404 else "validation_failed",
        },
    )


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
