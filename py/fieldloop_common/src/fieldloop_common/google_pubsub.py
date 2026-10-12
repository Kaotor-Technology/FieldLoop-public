"""GCP queue adapter; the publisher port remains portable."""

import asyncio
import math

from google.cloud.pubsub_v1 import PublisherClient  # type: ignore[import-untyped]


class GooglePubSubTransport:
    def __init__(
        self, client: PublisherClient, *, project_id: str, timeout: float = 30
    ) -> None:
        if not project_id.strip() or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Invalid Pub/Sub transport configuration")
        self._client = client
        self._project_id = project_id
        self._timeout = timeout

    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str:
        topic_path = self._client.topic_path(self._project_id, topic)

        # Both queuing into a full batch and awaiting acknowledgement can block.
        def send() -> str:
            result = self._client.publish(topic_path, data, **attributes).result(self._timeout)
            if not isinstance(result, str) or not result:
                raise RuntimeError("Pub/Sub returned no message identity")
            return result

        return await asyncio.to_thread(send)
