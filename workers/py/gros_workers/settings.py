from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgres://gros:gros@localhost:5432/gros"
    clickhouse_url: str = "http://localhost:8123"
    clickhouse_db: str = "gros"
    clickhouse_user: str = "gros"
    clickhouse_password: str = "gros"
    worker_api_url: str = "http://localhost:3001"
    service_token: str = "dev-service-token-change-me"
    artifact_dir: str = "./var/artifacts"
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    llm_fast_model: str = "claude-haiku-4-5-20251001"
    llm_frontier_model: str = "claude-sonnet-4-6"
    worker_id: str = "worker-1"

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
