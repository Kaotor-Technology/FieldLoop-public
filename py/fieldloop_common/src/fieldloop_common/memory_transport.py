"""An in-process MessageTransport that records what it is given, for local runs and tests."""

from dataclasses import dataclass, field


@dataclass
class InMemoryTransport:
    messages: list[tuple[str, bytes, dict[str, str]]] = field(default_factory=list)

    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str:
        self.messages.append((topic, data, dict(attributes)))
        return f"memory-{len(self.messages)}"
