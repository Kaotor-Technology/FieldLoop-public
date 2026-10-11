import asyncio
from unittest.mock import create_autospec

import pytest
from fieldloop_common.google_pubsub import GooglePubSubTransport
from google.cloud.pubsub_v1 import PublisherClient


def test_sdk_topic_bytes_attributes_and_acknowledgement() -> None:
    client = create_autospec(PublisherClient, instance=True)
    client.topic_path.return_value = "projects/fieldloop-contract-test/topics/signals"
    client.publish.return_value.result.return_value = "sdk-message"
    transport = GooglePubSubTransport(client, project_id="fieldloop-contract-test")
    data = b'{"label":"SIMULATION"}'
    attributes = {"environment": "dev", "simulated": "true"}
    assert asyncio.run(transport.publish("signals", data, attributes)) == "sdk-message"
    client.topic_path.assert_called_once_with("fieldloop-contract-test", "signals")
    client.publish.assert_called_once_with(
        "projects/fieldloop-contract-test/topics/signals", data, **attributes
    )
    client.publish.return_value.result.assert_called_once_with(30)


@pytest.mark.parametrize("error", [TimeoutError("timeout"), RuntimeError("permission denied")])
def test_sdk_acknowledgement_failure_propagates(error: Exception) -> None:
    client = create_autospec(PublisherClient, instance=True)
    client.publish.return_value.result.side_effect = error
    transport = GooglePubSubTransport(client, project_id="fieldloop-contract-test", timeout=0.5)
    with pytest.raises(type(error), match=str(error)):
        asyncio.run(transport.publish("signals", b"{}", {}))
    client.publish.return_value.result.assert_called_once_with(0.5)


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf")])
def test_sdk_timeout_config(timeout: float) -> None:
    with pytest.raises(ValueError):
        GooglePubSubTransport(create_autospec(PublisherClient), project_id="test", timeout=timeout)
