"""Publish simulated source observations as signal.v1 through the validating publisher (SIM-3).

A mock source reaches the platform the way a production connector does: as a signal.v1 message
on the ``signals`` topic. The source HTTP APIs are read-only, so there is no HTTP trigger; the
Scenario player calls the emitter in process.
"""

import json
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from fieldloop_common.google_pubsub import GooglePubSubTransport
from fieldloop_common.signal_publisher import SignalPublisher, SignalPublishResult

from fieldloop_simulator.organisation import org_id_from_environment
from fieldloop_simulator.timestamps import to_utc

# Fixed, so that replaying a Scenario run derives the same Signal IDs (consumer deduplication).
SIGNAL_ID_NAMESPACE = uuid.UUID("5a3f0c9e-2b6d-4c41-9a57-3f1d8e7b2c64")

Classification = Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"]
SignalValue = float | int | str | bool | None


@dataclass(frozen=True)
class Observation:
    tag: str
    value: SignalValue
    observed_at: datetime
    unit: str | None = None
    payload: Mapping[str, object] | None = None
    # What the observation is about, such as a finding or a report. It takes part in the
    # identity, so two findings of one kind at the same instant are not one Signal.
    subject: str | None = None


def utc_text(at: datetime) -> str:
    if at.tzinfo is None:
        raise ValueError("Observation time needs a timezone")
    return to_utc(at).isoformat().removesuffix("+00:00") + "Z"


def _canonical_value(value: SignalValue) -> str:
    # 0 and 0.0 are the same JSON number, so they must not derive different identities.
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return json.dumps(int(value))
    return json.dumps(value)


class SimulatedSignalEmitter:
    """Turn one source's observations into signal.v1 messages marked ``simulated: true``."""

    def __init__(
        self,
        publisher: SignalPublisher,
        *,
        org_id: str,
        source: str,
        classification: Classification,
    ) -> None:
        self._publisher = publisher
        self._org_id = org_id
        self._source = source
        self._classification = classification

    def build(self, observation: Observation, run_id: uuid.UUID | None = None) -> dict[str, object]:
        observed_at = utc_text(observation.observed_at)
        parts = [
            self._org_id,
            str(run_id) if run_id is not None else "-",
            self._source,
            observation.tag,
            observed_at,
            _canonical_value(observation.value),
        ]
        if observation.subject is not None:
            # Appended only when present, so a subject-less observation keeps its identity.
            parts.append(observation.subject)
        identity = "|".join(parts)
        signal: dict[str, object] = {
            "schemaVersion": "signal.v1",
            "id": str(uuid.uuid5(SIGNAL_ID_NAMESPACE, identity)),
            "orgId": self._org_id,
            "source": self._source,
            "tag": observation.tag,
            "value": observation.value,
            "observedAt": observed_at,
            "simulated": True,
            "classification": self._classification,
        }
        if observation.unit is not None:
            signal["unit"] = observation.unit
        if run_id is not None:
            signal["simulationRunId"] = str(run_id)
        if observation.payload is not None:
            signal["payload"] = dict(observation.payload)
        return signal

    async def emit(
        self, observation: Observation, run_id: uuid.UUID | None = None
    ) -> SignalPublishResult:
        return await self._publisher.publish(self.build(observation, run_id))


def signal_publisher_from_environment(
    environ: Mapping[str, str],
    *,
    client_factory: Callable[[], Any] | None = None,
) -> SignalPublisher:
    """Compose the simulation-only publisher; call it when a run starts, not at import.

    The Pub/Sub client is created here rather than at module import so that the service
    starts, and its read-only APIs answer, without cloud credentials.
    """
    project_id = environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if not project_id:
        raise ValueError("A Google Cloud project is required to publish Signals")
    if client_factory is None:
        from google.cloud.pubsub_v1 import PublisherClient  # type: ignore[import-untyped]

        client_factory = PublisherClient
    return SignalPublisher(
        GooglePubSubTransport(client_factory(), project_id=project_id),
        environment=environ.get("FIELDLOOP_ENV", "local"),
        org_id=org_id_from_environment(environ),
        # Mock mode: a real-labelled observation is quarantined, never sent to signals.
        simulation_only=True,
    )
