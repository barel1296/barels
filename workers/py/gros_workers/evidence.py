"""Evidence pipeline: every tool result that backs a claim becomes a frozen,
immutable artifact + a Postgres evidence row. Agents receive only the
evidence_id and a compact digest — never raw unattributed numbers.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import uuid4

from .artifacts import ArtifactStoreProtocol


@dataclass
class EvidenceRecord:
    id: str
    kind: str
    metric_key: str | None
    params: dict[str, Any]
    sql_hash: str
    result_digest: dict[str, Any]
    result_ref: str
    freshness_at: str | None
    executed_at: str


class EvidenceStore(Protocol):
    def record(
        self,
        kind: str,
        params: dict[str, Any],
        digest: dict[str, Any],
        snapshot: dict[str, Any],
        metric_key: str | None = None,
        metric_version: int | None = None,
        sql_hash: str = "",
        freshness_at: str | None = None,
    ) -> EvidenceRecord: ...

    def known_ids(self) -> set[str]: ...

    def get(self, evidence_id: str) -> EvidenceRecord: ...


def digest_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()


class InMemoryEvidenceStore:
    """Test/eval implementation with identical semantics."""

    def __init__(self) -> None:
        self.records: dict[str, EvidenceRecord] = {}

    def record(
        self,
        kind: str,
        params: dict[str, Any],
        digest: dict[str, Any],
        snapshot: dict[str, Any],
        metric_key: str | None = None,
        metric_version: int | None = None,
        sql_hash: str = "",
        freshness_at: str | None = None,
    ) -> EvidenceRecord:
        rec = EvidenceRecord(
            id=str(uuid4()),
            kind=kind,
            metric_key=metric_key,
            params=params,
            sql_hash=sql_hash or digest_hash(params),
            result_digest=digest,
            result_ref="memory://" + str(uuid4()),
            freshness_at=freshness_at,
            executed_at=datetime.now(UTC).isoformat(),
        )
        self.records[rec.id] = rec
        return rec

    def known_ids(self) -> set[str]:
        return set(self.records.keys())

    def get(self, evidence_id: str) -> EvidenceRecord:
        return self.records[evidence_id]


class PgEvidenceStore:
    """Production implementation: PG row + artifact snapshot, append-only."""

    def __init__(self, tenant_id: str, session_id: str | None, artifacts: ArtifactStoreProtocol):
        self.tenant_id = tenant_id
        self.session_id = session_id
        self.artifacts = artifacts
        self._cache: dict[str, EvidenceRecord] = {}

    def record(
        self,
        kind: str,
        params: dict[str, Any],
        digest: dict[str, Any],
        snapshot: dict[str, Any],
        metric_key: str | None = None,
        metric_version: int | None = None,
        sql_hash: str = "",
        freshness_at: str | None = None,
    ) -> EvidenceRecord:
        from .db import worker_conn

        ref = self.artifacts.write(self.tenant_id, "evidence", snapshot)
        with worker_conn(self.tenant_id) as conn:
            row = conn.execute(
                """INSERT INTO evidence
                   (tenant_id, session_id, kind, metric_key, metric_version, params,
                    sql_hash, result_ref, result_digest, freshness_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id, executed_at""",
                (
                    self.tenant_id,
                    self.session_id,
                    kind,
                    metric_key,
                    metric_version,
                    json.dumps(params, default=str),
                    sql_hash or digest_hash(params),
                    ref,
                    json.dumps(digest, default=str),
                    freshness_at,
                ),
            ).fetchone()
        assert row is not None
        rec = EvidenceRecord(
            id=str(row["id"]),
            kind=kind,
            metric_key=metric_key,
            params=params,
            sql_hash=sql_hash or digest_hash(params),
            result_digest=digest,
            result_ref=ref,
            freshness_at=freshness_at,
            executed_at=str(row["executed_at"]),
        )
        self._cache[rec.id] = rec
        return rec

    def known_ids(self) -> set[str]:
        return set(self._cache.keys())

    def get(self, evidence_id: str) -> EvidenceRecord:
        return self._cache[evidence_id]
