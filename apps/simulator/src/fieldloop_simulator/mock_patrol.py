"""Deterministic, read-only synthetic patrol app for Demo A (SIM-2).

Fixed findings with no clock and no I/O. Each GPS fix sits a few metres beside the DL-01
route, as a device fix would; the platform snaps fixes to Chainage (GEO-9), so the source
supplies none. Coordinates were derived from ``data/synthetic/dl-01/route.geojson`` and a
test keeps them inside the right-of-way, because the simulator image does not carry ``data/``.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import Depends, Query, Request
from fieldloop_common.generated_mock_patrol import MockPatrolPage

from fieldloop_simulator.mock_http import ReadOnlyRouter, Rfc3339
from fieldloop_simulator.mock_signals import Observation, utc_text
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id

Kind = Literal["encroachment", "marker_damage", "erosion"]
GPS_ACCURACY_M = 5.0


@dataclass(frozen=True)
class _Finding:
    id: str
    kind: Kind
    severity: Literal["low", "medium", "high"]
    status: Literal["open", "closed"]
    observed_at: datetime
    summary: str
    latitude: float
    longitude: float


def _utc(year: int, month: int, day: int, hour: int, minute: int) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


# Chainage on DL-01 in metres: 005 at 23 100, 001 at 38 400, 002 at 61 700, 003 at 104 900,
# 004 at 142 300. Authored values, not observations of a real asset.
_FINDINGS = sorted(
    (
        _Finding(
            "SYN-PATROL-005",
            "marker_damage",
            "low",
            "closed",
            _utc(2026, 10, 9, 8, 0),
            "Synthetic pipeline marker post replaced after damage",
            18.271529,
            99.323345,
        ),
        _Finding(
            "SYN-PATROL-001",
            "encroachment",
            "high",
            "open",
            _utc(2026, 10, 11, 2, 15),
            "Synthetic excavation equipment inside the right-of-way",
            18.385671,
            99.404394,
        ),
        _Finding(
            "SYN-PATROL-002",
            "marker_damage",
            "low",
            "open",
            _utc(2026, 10, 11, 3, 5),
            "Synthetic damaged pipeline marker post",
            18.561633,
            99.524194,
        ),
        _Finding(
            "SYN-PATROL-003",
            "erosion",
            "medium",
            "open",
            _utc(2026, 10, 11, 4, 40),
            "Synthetic bank erosion beside a river crossing",
            18.891102,
            99.741773,
        ),
        _Finding(
            "SYN-PATROL-004",
            "encroachment",
            "medium",
            "open",
            _utc(2026, 10, 11, 6, 20),
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
            tag=f"DL-01.{finding.kind}.detected",
            value=1 if finding.status == "open" else 0,
            observed_at=at,
            unit="boolean",
            subject=finding.id,
            payload={
                "assetCode": "DL-01",
                "findingId": finding.id,
                "kind": finding.kind,
                "severity": finding.severity,
                "status": finding.status,
                "summary": finding.summary,
                "foundAt": utc_text(finding.observed_at),
                "gps": {
                    "latitude": finding.latitude,
                    "longitude": finding.longitude,
                    "accuracyM": GPS_ACCURACY_M,
                },
                "label": "SYNTHETIC",
            },
        )

    def page(self, kind: Kind | None = None, since: datetime | None = None) -> MockPatrolPage:
        selected = [
            finding
            for finding in _FINDINGS
            if (kind is None or finding.kind == kind)
            and (since is None or finding.observed_at >= since)
        ]
        return MockPatrolPage.model_validate(
            {
                "items": [
                    {
                        "id": finding.id,
                        "orgId": self.org_id,
                        "assetCode": "DL-01",
                        "kind": finding.kind,
                        "severity": finding.severity,
                        "status": finding.status,
                        "observedAt": finding.observed_at,
                        "summary": finding.summary,
                        "gps": {
                            "latitude": finding.latitude,
                            "longitude": finding.longitude,
                            "accuracyM": GPS_ACCURACY_M,
                        },
                        "label": "SYNTHETIC",
                        "simulated": True,
                        "classification": "HIGHLY_RESTRICTED",
                    }
                    for finding in selected
                ],
                "total": len(selected),
                "label": "SYNTHETIC",
                "simulated": True,
                "classification": "HIGHLY_RESTRICTED",
            }
        )


router = ReadOnlyRouter(prefix="/mock/patrol", tag="mock-patrol")


def get_patrol(request: Request) -> SimulatedPatrol:
    patrol = request.app.state.patrol
    if not isinstance(patrol, SimulatedPatrol):
        raise RuntimeError("The simulator has no patrol app configured")
    return patrol


@router.read("/findings", response_model=MockPatrolPage)
def list_findings(
    patrol: Annotated[SimulatedPatrol, Depends(get_patrol)],
    kind: Annotated[Kind | None, Query()] = None,
    since: Annotated[Rfc3339 | None, Query()] = None,
) -> MockPatrolPage:
    return patrol.page(kind, since)
