"""LLM provider adapters: Anthropic (primary), OpenAI (failover), Scripted.

REST adapters via httpx — no SDK dependency churn. The ScriptedProvider exists
ONLY for tests and the golden-incident eval harness; the gateway refuses to
use it outside eval mode (no fake intelligence in production paths).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

import httpx


@dataclass
class LLMResult:
    text: str
    tokens_in: int
    tokens_out: int
    model: str
    provider: str


class LLMProviderError(Exception):
    pass


class LLMNotConfigured(LLMProviderError):
    pass


class LLMProvider(Protocol):
    name: str

    def complete(
        self, model: str, system: str, messages: list[dict[str, str]], max_tokens: int
    ) -> LLMResult: ...


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, base_url: str = "https://api.anthropic.com"):
        if not api_key:
            raise LLMNotConfigured("ANTHROPIC_API_KEY is not set")
        self.api_key = api_key
        self.base_url = base_url

    def complete(
        self, model: str, system: str, messages: list[dict[str, str]], max_tokens: int
    ) -> LLMResult:
        resp = httpx.post(
            f"{self.base_url}/v1/messages",
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": messages,
            },
            timeout=120,
        )
        if resp.status_code != 200:
            raise LLMProviderError(f"anthropic {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        text = "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        )
        usage = data.get("usage", {})
        return LLMResult(
            text=text,
            tokens_in=int(usage.get("input_tokens", 0)),
            tokens_out=int(usage.get("output_tokens", 0)),
            model=model,
            provider=self.name,
        )


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com"):
        if not api_key:
            raise LLMNotConfigured("OPENAI_API_KEY is not set")
        self.api_key = api_key
        self.base_url = base_url

    def complete(
        self, model: str, system: str, messages: list[dict[str, str]], max_tokens: int
    ) -> LLMResult:
        resp = httpx.post(
            f"{self.base_url}/v1/chat/completions",
            headers={"authorization": f"Bearer {self.api_key}"},
            json={
                "model": model,
                "max_tokens": max_tokens,
                "messages": [{"role": "system", "content": system}, *messages],
            },
            timeout=120,
        )
        if resp.status_code != 200:
            raise LLMProviderError(f"openai {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        choice = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        return LLMResult(
            text=choice,
            tokens_in=int(usage.get("prompt_tokens", 0)),
            tokens_out=int(usage.get("completion_tokens", 0)),
            model=model,
            provider=self.name,
        )


class ScriptedProvider:
    """Deterministic provider for tests/evals: responses keyed by a routing
    hint embedded in the system prompt (`[script:<key>]`)."""

    name = "scripted"

    def __init__(self, script: dict[str, list[dict[str, Any]]]):
        self.script = script
        self.calls: list[str] = []

    def complete(
        self, model: str, system: str, messages: list[dict[str, str]], max_tokens: int
    ) -> LLMResult:
        key = None
        for line in system.splitlines():
            if line.startswith("[script:"):
                key = line.removeprefix("[script:").removesuffix("]").strip()
                break
        if key is None or key not in self.script:
            raise LLMProviderError(f"scripted provider has no entry for key={key!r}")
        self.calls.append(key)
        queue = self.script[key]
        if not queue:
            raise LLMProviderError(f"scripted provider exhausted for key={key!r}")
        payload = queue.pop(0)
        text = json.dumps(payload)
        return LLMResult(
            text=text,
            tokens_in=len(system) // 4,
            tokens_out=len(text) // 4,
            model=model,
            provider=self.name,
        )
