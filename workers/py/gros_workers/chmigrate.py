"""Applies ClickHouse schema files (infra/clickhouse/schema/*.sql) idempotently."""

from __future__ import annotations

from pathlib import Path

import clickhouse_connect

from .settings import get_settings


def main() -> None:
    s = get_settings()
    host = s.clickhouse_url.split("//")[-1].split(":")[0]
    tail = s.clickhouse_url.split("//")[-1]
    port = int(tail.rsplit(":", 1)[-1]) if ":" in tail else 8123
    client = clickhouse_connect.get_client(
        host=host,
        port=port,
        username=s.clickhouse_user,
        password=s.clickhouse_password,
        database=s.clickhouse_db,
    )
    schema_dir = Path(__file__).parents[3] / "infra" / "clickhouse" / "schema"
    for path in sorted(schema_dir.glob("*.sql")):
        sql = path.read_text(encoding="utf-8")
        statements = [
            st.strip() for st in sql.split(";")
            if st.strip() and not st.strip().startswith("--")
        ]
        for stmt in statements:
            client.command(stmt)
        print(f"applied {path.name} ({len(statements)} statements)")


if __name__ == "__main__":
    main()
