"""Deterministic, read-only synthetic patrol app for Demo A (SIM-2).

Fixed findings with no clock and no I/O. Each GPS fix sits a few metres beside the DL-01
route, as a device fix would; the platform snaps fixes to Chainage (GEO-9), so the source
supplies none. Coordinates were derived from ``data/synthetic/dl-01/route.geojson`` and a
test keeps them inside the right-of-way, because the simulator image does not carry ``data/``.
"""

from datetime import UTC, datetime
from typing import Annotated, Final

from fastapi import APIRouter, Depends
from fieldloop_common.generated_mock_patrol import MockPatrolPage, PatrolFinding

from fieldloop_simulator.mock_http import app_state
from fieldloop_simulator.mock_signals import Observation, utc_text
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id

SOURCE_ID = "mock-patrol"
CLASSIFICATION: Final = "HIGHLY_RESTRICTED"
GPS_ACCURACY_M = 5.0


def _finding(
    identifier: str,
    kind: str,
    severity: str,
    status: str,
    observed_at: datetime,
    summary: str,
    latitude: float,
    longitude: float,
) -> PatrolFinding:
    return PatrolFinding.model_validate(
        {
            "id": identifier,
            "orgId": DEMO_ORG_ID,  # replaced with the configured Organisation when served
            "assetCode": "DL-01",
            "kind": kind,
            "severity": severity,
            "status": status,
            "observedAt": observed_at,
            "summary": summary,
            "gps": {"latitude": latitude, "longitude": longitude, "accuracyM": GPS_ACCURACY_M},
            "label": "SYNTHETIC",
            "simulated": True,
            "classification": CLASSIFICATION,
        }
    )


# Authored values, not observations of a real asset. Chainage on DL-01 in metres: 005 at
# 23 100, 001 at 38 400, 002 at 61 700, 003 at 104 900, 004 at 142 300.
_FINDINGS = sorted(
    (
        _finding(
            "SYN-PATROL-005",
            "marker_damage",
            "low",
            "closed",
            datetime(2026, 10, 9, 8, 0, tzinfo=UTC),
            "Synthetic pipeline marker post replaced after damage",
            18.271529,
            99.323345,
        ),
        _finding(
            "SYN-PATROL-001",
            "encroachment",
            "high",
            "open",
            datetime(2026, 10, 11, 2, 15, tzinfo=UTC),
            "Synthetic excavation equipment inside the right-of-way",
            18.385671,
            99.404394,
        ),
        _finding(
            "SYN-PATROL-002",
            "marker_damage",
            "low",
            "open",
            datetime(2026, 10, 11, 3, 5, tzinfo=UTC),
            "Synthetic damaged pipeline marker post",
            18.561633,
            99.524194,
        ),
        _finding(
            "SYN-PATROL-003",
            "erosion",
            "medium",
            "open",
            datetime(2026, 10, 11, 4, 40, tzinfo=UTC),
            "Synthetic bank erosion beside a river crossing",
            18.891102,
            99.741773,
        ),
        _finding(
            "SYN-PATROL-004",
            "encroachment",
            "medium",
            "open",
            datetime(2026, 10, 11, 6, 20, tzinfo=UTC),
            "Synthetic fence construction at the right-of-way edge",
            19.168712,
            99.853037,
        ),
    ),
    key=lambda finding: (finding.observed_at, finding.id),
)
_FINDINGS_BY_ID = {finding.id: finding for finding in _FINDINGS}


class SimulatedPatrol:
    def __init__(self, *, org_id: str = DEMO_ORG_ID) -> None:
        self.org_id = require_org_id(org_id)

    def observe(self, finding_id: str, at: datetime) -> Observation:
        """Announce a finding as a Signal; the report itself travels in the payload.

        The flag is 1 while the finding is open and 0 once it is closed, so closing a finding
        clears the condition instead of raising it again. ``at`` is the Scenario time; when
        the patroller found it is in the payload as ``foundAt``.
        """
        if at.tzinfo is None:
            raise ValueError("Observation times need a timezone")
        finding = _FINDINGS_BY_ID[finding_id]
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            tag=f"DL-01.{finding.kind}.detected",
            value=1 if finding.status == "open" else 0,
            observed_at=at,
            unit="boolean",
            subject=finding.id,
            payload={
                "assetCode": finding.asset_code,
                "findingId": finding.id,
                "kind": finding.kind,
                "severity": finding.severity,
                "status": finding.status,
                "summary": finding.summary,
                "foundAt": utc_text(finding.observed_at),
                "gps": finding.gps.model_dump(by_alias=True),
                "label": finding.label,
            },
        )

    def page(self) -> MockPatrolPage:
        items = [finding.model_copy(update={"org_id": self.org_id}) for finding in _FINDINGS]
        return MockPatrolPage(
            items=items,
            total=len(items),
            label="SYNTHETIC",
            simulated=True,
            classification=CLASSIFICATION,
        )


router = APIRouter(prefix="/mock/patrol", tags=["mock-patrol"])

get_patrol = app_state("patrol", SimulatedPatrol)


@router.get("/findings", response_model=MockPatrolPage)
def list_findings(patrol: Annotated[SimulatedPatrol, Depends(get_patrol)]) -> MockPatrolPage:
    return patrol.page()
