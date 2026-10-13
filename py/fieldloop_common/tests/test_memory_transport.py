import asyncio

from fieldloop_common.memory_transport import InMemoryTransport


def test_records_what_it_is_given_and_returns_distinct_ids() -> None:
    transport = InMemoryTransport()
    attributes = {"environment": "dev"}
    first = asyncio.run(transport.publish("signals", b"{}", attributes))
    second = asyncio.run(transport.publish("fieldloop-v2-dead-letter", b"[]", {}))
    assert first != second
    assert transport.messages == [
        ("signals", b"{}", {"environment": "dev"}),
        ("fieldloop-v2-dead-letter", b"[]", {}),
    ]
    # The record keeps its own copy of the attributes.
    attributes["environment"] = "demo"
    assert transport.messages[0][2] == {"environment": "dev"}
