"""Deterministic, read-only synthetic ILI report drop for Demo A (SIM-2).

The report is a vendor-style document. Terraform places this same file in the environment's
ILI drop bucket; this module serves it and describes its arrival as a Signal. It never reads
or writes the bucket, so the simulator needs no storage permission, and the document is a
package fixture because the simulator image does not carry ``data/``.
"""

import re
from datetime import datetime
from importlib.resources import files
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_ili import MockIliReport

from fieldloop_simulator.mock_http import app_state, problem
from fieldloop_simulator.mock_signals import Observation

SOURCE_ID = "mock-ili"
REPORT_PREFIX = "reports/"
# Cloud Storage names: 3 to 63 characters of lowercase letters, digits, dots, dashes, underscores.
_BUCKET = re.compile(r"[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]")


def _load_reports() -> dict[str, MockIliReport]:
    folder = files("fieldloop_simulator").joinpath("fixtures", "ili")
    reports = [
        MockIliReport.model_validate_json(item.read_text())
        for item in folder.iterdir()
        if item.name.endswith(".json")
    ]
    return {report.report_id: report for report in reports}


_REPORTS = _load_reports()


class SimulatedIliDrop:
    def __init__(self, *, bucket: str | None = None) -> None:
        if bucket is not None and _BUCKET.fullmatch(bucket) is None:
            raise ValueError("Invalid ILI drop bucket name")
        self.bucket = bucket

    def report(self, report_id: str) -> MockIliReport:
        return _REPORTS[report_id]

    def observe(self, report_id: str, at: datetime) -> Observation:
        """The Signal that announces the report; it locates the file, it does not copy it."""
        report = _REPORTS[report_id]
        payload: dict[str, object] = {
            "assetCode": report.asset_code,
            "reportId": report.report_id,
            "objectName": f"{REPORT_PREFIX}{report.report_id}.json",
            "contentType": "application/json",
            "anomalyCount": report.anomaly_count,
            "label": report.label,
        }
        if self.bucket is not None:
            payload["bucket"] = self.bucket
        return Observation(
            source=SOURCE_ID,
            classification=report.classification,
            tag="DL-01.ili.report.received",
            value=1,
            observed_at=at,
            unit="boolean",
            subject=report.report_id,
            payload=payload,
        )


router = APIRouter(prefix="/mock/ili", tags=["mock-ili"])


get_drop = app_state("ili", SimulatedIliDrop)


@router.get("/reports/{id}", response_model=MockIliReport)
def read_report(
    id: str, drop: Annotated[SimulatedIliDrop, Depends(get_drop)]
) -> MockIliReport | JSONResponse:
    try:
        return drop.report(id)
    except KeyError:
        return problem(404, "Unknown ILI report", "not_found")
