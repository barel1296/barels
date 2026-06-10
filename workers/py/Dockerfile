# GROS Worker — Python agent/ingestion plane.
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY workers/py/pyproject.toml workers/py/uv.lock* ./
RUN uv sync --no-dev --no-install-project || uv sync --no-dev --no-install-project --no-cache
COPY workers/py/gros_workers gros_workers
COPY infra/clickhouse /infra/clickhouse
RUN uv sync --no-dev

FROM python:3.12-slim
RUN useradd -r -m gros
WORKDIR /app
COPY --from=build --chown=gros:gros /app /app
COPY --from=build --chown=gros:gros /infra /infra
USER gros
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
CMD ["python", "-m", "gros_workers.main"]
