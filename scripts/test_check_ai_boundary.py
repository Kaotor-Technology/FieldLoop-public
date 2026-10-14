import pytest

from scripts.check_ai_boundary import EMBEDDING_ADAPTER, check_python_boundary


@pytest.mark.parametrize("source", [
    "from google import genai as sdk",
    "import vertexai.generative_models as models",
    "from google.cloud import aiplatform",
    "client.models.generate_content(model='flash', contents='hello')",
    "requests.post(f'https://{region}-aiplatform.googleapis.com/v1/chat/completions')",
])
def test_service_provider_bypass_is_rejected(source: str) -> None:
    assert check_python_boundary("apps/assistant/src/caller.py", source)


def test_embedding_adapter_cannot_generate() -> None:
    assert check_python_boundary(
        EMBEDDING_ADAPTER,
        "from google import genai\nclient.models.embed_content(model='embedding')"
    ) == []
    assert check_python_boundary(
        EMBEDDING_ADAPTER, "client.models.generate_content(contents='hello')"
    )


def test_guardrail_client_and_comments_are_allowed() -> None:
    assert check_python_boundary("apps/assistant/src/caller.py", """
# client.models.generate_content() bypasses Guardrail
import httpx
httpx.post(f'{guardrail_url}/guardrail/v1/chat/completions')
""") == []
