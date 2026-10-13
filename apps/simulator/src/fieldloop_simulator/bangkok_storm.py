"""What the Demo B sources of the Bangkok storm Scenario share (PRD §8.1 Demo B)."""

from datetime import UTC, datetime
from typing import Final

# The ``simulationStartsAt`` of ``data/synthetic/bangkok/bowtie-d.json``. A read that names no
# Scenario time uses it, so a bare read is reproducible (SIM-5). A test keeps it in step,
# because the simulator image does not carry ``data/``.
SIMULATION_STARTS_AT: Final = datetime(2026, 10, 12, tzinfo=UTC)
# The storm is simulated, not synthetic reference data, so its records say so (SIM-6).
LABEL: Final = "SIMULATION"
