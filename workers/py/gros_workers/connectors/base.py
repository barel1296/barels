"""Connector framework (docs/04 §4.4).

Every source implements the same contract: check credentials, pull raw
batches (backfill or incremental from a cursor), and normalize to canonical
rows. Raw payloads are persisted BEFORE normalization — a normalizer bug
never requires re-pulling an external API.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class HealthReport:
    ok: bool
    detail: str = ""
    scopes: list[str] = field(default_factory=list)
    account_name: str | None = None


@dataclass
class RawBatch:
    """One batch of raw source payloads + the rows they normalize to."""

    entity_kind: str  # spend_row | entity_snapshot | attribution | ...
    raw_payloads: list[dict[str, Any]]
    normalized: dict[str, list[dict[str, Any]]]  # table -> rows
    cursor: dict[str, Any] = field(default_factory=dict)


class Connector(Protocol):
    source_key: str

    def check(self, credentials: dict[str, str], config: dict[str, Any]) -> HealthReport: ...

    def backfill(
        self,
        credentials: dict[str, str],
        config: dict[str, Any],
        window_from: str,
        window_to: str,
        tenant_id: str,
    ) -> Iterator[RawBatch]: ...

    def sync_incremental(
        self,
        credentials: dict[str, str],
        config: dict[str, Any],
        cursor: dict[str, Any],
        tenant_id: str,
    ) -> Iterator[RawBatch]: ...


_REGISTRY: dict[str, Connector] = {}


def register(connector: Connector) -> Connector:
    _REGISTRY[connector.source_key] = connector
    return connector


def get_connector(source_key: str) -> Connector:
    try:
        return _REGISTRY[source_key]
    except KeyError as err:
        raise KeyError(
            f"no connector implemented for source '{source_key}' "
            f"(available: {sorted(_REGISTRY)})"
        ) from err
