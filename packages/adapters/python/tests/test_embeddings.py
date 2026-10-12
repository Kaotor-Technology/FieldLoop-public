import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fieldloop_adapters.embeddings import VertexEmbeddings, validate_embedding
from google import genai
from google.auth.credentials import AnonymousCredentials
from google.genai import types


def test_vertex_batches_and_uses_retrieval_task_without_truncation() -> None:
    client = genai.Client(
        vertexai=True,
        project="fixture",
        location="asia-southeast1",
        credentials=AnonymousCredentials(),
    )
    response = types.EmbedContentResponse(
        embeddings=[types.ContentEmbedding(values=[1.0] * 768) for _ in range(5)]
    )
    with patch.object(client.aio.models, "embed_content", new_callable=AsyncMock) as embed:
        embed.side_effect = [
            response,
            types.EmbedContentResponse(embeddings=[response.embeddings[0]]),
        ]
        assert (
            len(asyncio.run(VertexEmbeddings(client).embed(["text"] * 6, "RETRIEVAL_DOCUMENT")))
            == 6
        )
        assert embed.call_count == 2
        config = embed.call_args.kwargs["config"]
        assert config.task_type == "RETRIEVAL_DOCUMENT"
        assert config.auto_truncate is False
        assert config.output_dimensionality == 768
    client.close()


@pytest.mark.parametrize(
    "response",
    [
        types.EmbedContentResponse(),
        types.EmbedContentResponse(embeddings=[]),
        types.EmbedContentResponse(embeddings=[types.ContentEmbedding(values=[1.0])]),
        types.EmbedContentResponse(
            embeddings=[
                types.ContentEmbedding(
                    values=[1.0] * 768, statistics=types.ContentEmbeddingStatistics(truncated=True)
                )
            ]
        ),
    ],
)
def test_vertex_fails_closed_on_bad_response(response: types.EmbedContentResponse) -> None:
    client = genai.Client(
        vertexai=True,
        project="fixture",
        location="asia-southeast1",
        credentials=AnonymousCredentials(),
    )
    with patch.object(client.aio.models, "embed_content", new_callable=AsyncMock) as embed:
        embed.return_value = response
        with pytest.raises((RuntimeError, ValueError)):
            asyncio.run(VertexEmbeddings(client).embed(["query"], "RETRIEVAL_QUERY"))
    client.close()


@pytest.mark.parametrize("vector", [[0.0] * 768, [float("nan")] * 768, [float("inf")] * 768])
def test_invalid_vectors_are_rejected(vector: list[float]) -> None:
    with pytest.raises(ValueError):
        validate_embedding(vector)
