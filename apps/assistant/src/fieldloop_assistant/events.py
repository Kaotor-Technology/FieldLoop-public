"""Server-sent events of one agent turn (architecture §7.4; DESIGN Screen 8)."""

import json
from dataclasses import dataclass, field
from typing import Any, Literal

EventName = Literal[
    "agent.step", "tool.call", "tool.result", "guardrail.decision",
    "answer.partial", "answer.final", "answer.incomplete", "answer.error",
]


@dataclass(frozen=True)
class StreamEvent:
    name: EventName
    data: dict[str, Any] = field(default_factory=dict)
    seq: int = 0

    def encode(self) -> str:
        body = json.dumps(self.data, separators=(",", ":"), default=str, ensure_ascii=False)
        return f"id: {self.seq}\nevent: {self.name}\ndata: {body}\n\n"
