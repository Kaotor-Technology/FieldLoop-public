"""Per-turn limits (architecture §7.5). Hitting one returns a partial answer, never an error."""

import time
from dataclasses import dataclass, field

from .catalog import MAX_HANDOFFS, MAX_TOKENS, MAX_TOOL_CALLS, MAX_WALL_SECONDS, AgentDefinition


@dataclass
class TurnBudget:
    max_tool_calls: int = MAX_TOOL_CALLS
    max_handoffs: int = MAX_HANDOFFS
    max_seconds: float = MAX_WALL_SECONDS
    max_tokens: int = MAX_TOKENS
    tool_calls: int = 0
    handoffs: int = 0
    tokens: int = 0
    exhausted: str | None = None
    _started: float = field(default_factory=time.monotonic)

    @classmethod
    def for_agent(cls, definition: AgentDefinition) -> "TurnBudget":
        return cls(
            max_tool_calls=min(MAX_TOOL_CALLS, definition.max_steps),
            max_tokens=min(MAX_TOKENS, definition.max_tokens),
        )

    def elapsed(self) -> float:
        return time.monotonic() - self._started

    def _hit(self, reason: str) -> str:
        self.exhausted = self.exhausted or reason
        return reason

    def check_time(self) -> str | None:
        return self._hit("wall_clock") if self.elapsed() >= self.max_seconds else self.exhausted

    def charge_tokens(self, count: int) -> str | None:
        self.tokens += max(0, count)
        return self._hit("token_budget") if self.tokens >= self.max_tokens else self.exhausted

    def take_tool_call(self) -> str | None:
        """Reserve one tool call; returns the exhausted limit instead of consuming past it."""
        if self.exhausted or self.check_time():
            return self.exhausted
        if self.tool_calls >= self.max_tool_calls:
            return self._hit("tool_calls")
        self.tool_calls += 1
        return None

    def take_handoff(self) -> str | None:
        if self.exhausted or self.check_time():
            return self.exhausted
        if self.handoffs >= self.max_handoffs:
            return self._hit("handoffs")
        self.handoffs += 1
        return None
