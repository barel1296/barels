"""Artifact store: frozen evidence snapshots and LLM transcripts.

Local filesystem layout (S3-compatible object store in production behind the
same interface):  {artifact_dir}/{tenant_id}/{kind}/{artifact_id}.json
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from .settings import get_settings


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
