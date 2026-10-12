"""Validate the shared wire envelope, then publish or quarantine it."""

import json
import math
import re
from dataclasses import dataclass
from typing import Literal, Protocol

from fieldloop_common.signal import is_signal

MAX_SIGNAL_BYTES = 256 * 1024


class MessageTransport(Protocol):
    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str: ...


@dataclass(frozen=True)
class SignalPublishResult:
    outcome: Literal["published", "dead_lettered"]
    message_id: str


def _assert_json(value: object, depth: int = 0) -> None:
    if depth > 64:
        raise ValueError("Signal JSON exceeds the nesting limit")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float) and math.isfinite(value):
        return
    if isinstance(value, list):
        for item in value:
            _assert_json(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("Signal must use string keys")
            _assert_json(item, depth + 1)
        return
    raise TypeError("Signal must be JSON data")


class SignalPublisher:
    def __init__(
        self,
        transport: MessageTransport,
        *,
        environment: str,
        org_id: str,
        simulation_only: bool,
        signal_topic: str = "signals",
        dead_letter_topic: str = "fieldloop-v2-dead-letter",
    ) -> None:
        if (
            environment not in ("dev", "demo", "local")
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", org_id) is None
            or not isinstance(simulation_only, bool)
            or re.fullmatch(r"[A-Za-z][A-Za-z0-9._~+%-]{2,254}", signal_topic) is None
            or re.fullmatch(r"[A-Za-z][A-Za-z0-9._~+%-]{2,254}", dead_letter_topic) is None
            or signal_topic == dead_letter_topic
        ):
            raise ValueError("Invalid Signal publisher configuration")
        self._transport = transport
        self._environment = environment
        self._org_id = org_id
        self._simulation_only = simulation_only
        self._signal_topic = signal_topic
        self._dead_letter_topic = dead_letter_topic

    async def publish(self, input_value: object) -> SignalPublishResult:
        _assert_json(input_value)
        data = json.dumps(
            input_value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode()
        if len(data) > MAX_SIGNAL_BYTES:
            raise ValueError("Signal exceeds 256 KiB")
        signal = json.loads(data)
        failure_reason: str | None = None
        if not is_signal(signal):
            failure_reason = "validation_failed"
        elif signal["orgId"] != self._org_id:
            failure_reason = "org_mismatch"
        elif self._simulation_only and not signal["simulated"]:
            failure_reason = "simulation_required"
        attributes = {
            "environment": self._environment,
            "orgId": self._org_id,
            "schemaVersion": "signal.v1",
        }
        if failure_reason:
            attributes.update(failureReason=failure_reason, classification="HIGHLY_RESTRICTED")
        else:
            attributes.update(
                signalId=signal["id"],
                simulated="true" if signal["simulated"] else "false",
                classification=signal["classification"],
            )
        message_id = await self._transport.publish(
            self._dead_letter_topic if failure_reason else self._signal_topic, data, attributes
        )
        return SignalPublishResult("dead_lettered" if failure_reason else "published", message_id)
