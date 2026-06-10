"""Worker-side Postgres access.

The worker marks its connections with app.role='worker' (allows job-queue
polling across tenants) and sets app.tenant_id per unit of work before
touching tenant-scoped tables — RLS enforces the rest.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .settings import get_settings

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            get_settings().database_url.replace("postgres://", "postgresql://"),
            min_size=1,
            max_size=8,
            kwargs={"row_factory": dict_row},
        )
    return _pool


@contextmanager
def worker_conn(tenant_id: str | None = None) -> Iterator[psycopg.Connection[Any]]:
    """A transaction-scoped connection with worker role + optional tenant."""
    pool = get_pool()
    with pool.connection() as conn, conn.transaction():
        conn.execute("SELECT set_config('app.role', 'worker', true)")
        if tenant_id:
            conn.execute(
                "SELECT set_config('app.tenant_id', %s, true)", (tenant_id,)
            )
        yield conn
