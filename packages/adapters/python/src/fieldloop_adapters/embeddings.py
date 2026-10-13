"""Embedding port. Generation and agent tool calls belong to the Guardrail."""

import math
from collections.abc import Sequence
from typing import Literal, Protocol

from google import genai
from google.genai import types

EmbeddingTask = Literal["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]
DIMENSIONS = 768


def validate_embedding(values: Sequence[float]) -> list[float]:
    if len(values) != DIMENSIONS or any(not math.isfinite(v) for v in values):
        raise ValueError("Expected a finite 768-dimensional embedding")
    if not any(values):
        raise ValueError("An embedding cannot be a zero vector")
    return list(values)


class Embeddings(Protocol):
    @property
    def model(self) -> str: ...

    async def embed(self, texts: Sequence[str], task: EmbeddingTask) -> list[list[float]]: ...


class VertexEmbeddings:
    """Multilingual document/query embeddings, with truncation explicitly disabled."""

    def __init__(self, client: genai.Client) -> None:
        self._client = client

    @property
    def model(self) -> str:
        return "text-multilingual-embedding-002"

    async def embed(self, texts: Sequence[str], task: EmbeddingTask) -> list[list[float]]:
        if not texts or any(not text.strip() for text in texts):
            raise ValueError("Embedding inputs must be non-empty")
        vectors: list[list[float]] = []
        # Vertex accepts at most five texts per request for this model.
        for start in range(0, len(texts), 5):
            batch = list(texts[start : start + 5])
            response = await self._client.aio.models.embed_content(
                model=self.model,
                contents=batch,
                config=types.EmbedContentConfig(
                    task_type=task, output_dimensionality=DIMENSIONS, auto_truncate=False
                ),
            )
            if response.embeddings is None or len(response.embeddings) != len(batch):
                raise RuntimeError("Embedding response count mismatch")
            for embedding in response.embeddings:
                if embedding.statistics and embedding.statistics.truncated:
                    raise RuntimeError("Vertex truncated an embedding input")
                vectors.append(validate_embedding(embedding.values or []))
        return vectors


def vertex_embeddings(project: str, location: str = "asia-southeast1") -> VertexEmbeddings:
    if not project.strip() or not location.strip():
        raise ValueError("Vertex project and location are required")
    return VertexEmbeddings(
        genai.Client(
            vertexai=True,
            project=project,
            location=location,
            http_options=types.HttpOptions(
                timeout=1500, retry_options=types.HttpRetryOptions(attempts=1)
            ),
        )
    )
