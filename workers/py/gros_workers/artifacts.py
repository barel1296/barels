"""Artifact store: frozen evidence snapshots and LLM transcripts.

Two implementations behind one interface:
  - FsArtifactStore (default): {artifact_dir}/{tenant}/{kind}/{id}.json
  - S3ArtifactStore: any S3-compatible object store, selected when
    ARTIFACT_S3_BUCKET is set (requires the `s3` extra: boto3)

`ArtifactStore` remains the filesystem implementation's name for backward
compatibility; use `make_artifact_store()` to get the configured one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from .settings import get_settings


class ArtifactStoreProtocol(Protocol):
    def write(self, tenant_id: str, kind: str, content: dict[str, Any]) -> str: ...

    def read(self, ref: str) -> dict[str, Any]: ...


class S3ArtifactStore:
    """S3-compatible store. Refs: s3://{bucket}/{tenant}/{kind}/{id}.json"""

    def __init__(self, bucket: str, endpoint_url: str | None = None):
        try:
            import boto3
        except ImportError as err:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "S3 artifact store requires the 's3' extra: uv sync --extra s3"
            ) from err
        self.bucket = bucket
        self.client = boto3.client("s3", endpoint_url=endpoint_url)

    def write(self, tenant_id: str, kind: str, content: dict[str, Any]) -> str:
        key = f"{tenant_id}/{kind}/{uuid4()}.json"
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=json.dumps(content, indent=2, default=str).encode(),
            ContentType="application/json",
        )
        return f"s3://{self.bucket}/{key}"

    def read(self, ref: str) -> dict[str, Any]:
        if not ref.startswith("s3://"):
            raise ValueError(f"not an s3 ref: {ref}")
        _, _, rest = ref.partition("s3://")
        bucket, _, key = rest.partition("/")
        body = self.client.get_object(Bucket=bucket, Key=key)["Body"].read()
        result: dict[str, Any] = json.loads(body.decode())
        return result


def make_artifact_store() -> ArtifactStoreProtocol:
    s = get_settings()
    if s.artifact_s3_bucket:
        return S3ArtifactStore(s.artifact_s3_bucket, s.artifact_s3_endpoint or None)
    return ArtifactStore()


class ArtifactStore:
    def __init__(self, base_dir: str | None = None):
        self.base = Path(base_dir or get_settings().artifact_dir)

    def write(self, tenant_id: str, kind: str, content: dict[str, Any]) -> str:
        artifact_id = str(uuid4())
        path = self.base / tenant_id / kind / f"{artifact_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, indent=2, default=str), encoding="utf-8")
        return f"artifact://{tenant_id}/{kind}/{artifact_id}"

    def read(self, ref: str) -> dict[str, Any]:
        if not ref.startswith("artifact://"):
            raise ValueError(f"not an artifact ref: {ref}")
        rel = ref.removeprefix("artifact://")
        path = self.base / f"{rel}.json"
        result: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return result
