FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1
COPY pyproject.toml uv.lock ./
COPY apps/assistant ./apps/assistant
COPY apps/simulator ./apps/simulator
COPY py/fieldloop_common ./py/fieldloop_common
COPY packages/adapters/python ./packages/adapters/python
RUN uv sync --locked --no-dev --no-editable --package fieldloop-assistant

FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
RUN groupadd --gid 10001 fieldloop && useradd --uid 10001 --gid fieldloop --no-create-home fieldloop
COPY --from=build --chown=fieldloop:fieldloop /app/.venv /app/.venv
USER fieldloop
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn fieldloop_assistant.main:app --host 0.0.0.0 --port \"${PORT:-8080}\""]
