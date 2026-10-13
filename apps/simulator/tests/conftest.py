"""Fixtures shared by the simulator tests."""

import pytest
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter

ORG_ID = "fieldloop-demo"


@pytest.fixture
def transport() -> InMemoryTransport:
    return InMemoryTransport()


@pytest.fixture
def publisher(transport: InMemoryTransport) -> SignalPublisher:
    return SignalPublisher(transport, environment="dev", org_id=ORG_ID, simulation_only=True)


@pytest.fixture
def emitter(publisher: SignalPublisher) -> SimulatedSignalEmitter:
    return SimulatedSignalEmitter(publisher, org_id=ORG_ID)
