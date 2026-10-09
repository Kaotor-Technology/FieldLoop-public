from fastapi import FastAPI

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
