"""Message and request value types that ADK callbacks exchange (no model call is made here).

Provider SDK imports belong in adapters (GR-1). The assistant needs these dataclasses to build
the canned model response and the per-request headers in its callbacks; re-exporting only the
data types keeps `google.genai` out of application code and the boundary check strict.
"""

from google.genai.types import Content, HttpOptions, Part

__all__ = ["Content", "HttpOptions", "Part"]
