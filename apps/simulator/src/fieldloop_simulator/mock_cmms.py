"""Read-only synthetic CMMS data; no CMMS connector, publisher or write operation."""

import re
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Query
from fieldloop_common.generated_mock_cmms import MockCmmsPage, WorkOrder
from pydantic import AwareDatetime, BeforeValidator

router = APIRouter(prefix="/mock/cmms", tags=["mock-cmms"])


def require_rfc3339(value: object) -> object:
    # FastAPI validates the trusted datetime default too; HTTP query input is a string.
    if isinstance(value, datetime):
        return value
    # Pydantic also accepts numeric epoch strings; the wire contract does not.
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})", value
    ):
        raise ValueError("asOf must be a timezone-aware RFC 3339 string.")
    return value


def fixture_orders() -> list[WorkOrder]:
    # Every value below is an authored fixture, not an observation of a real asset.
    templates = (
        (
            "SYN-CMMS-001",
            "Synthetic rectifier preventive check",
            "preventive",
            "open",
            "2026-10-09T00:00:00Z",
        ),
        (
            "SYN-CMMS-002",
            "Synthetic valve preventive check",
            "preventive",
            "open",
            "2026-10-10T00:00:00Z",
        ),
        (
            "SYN-CMMS-003",
            "Synthetic coating corrective work",
            "corrective",
            "open",
            "2026-10-11T00:00:00Z",
        ),
        (
            "SYN-CMMS-004",
            "Synthetic completed preventive check",
            "preventive",
            "completed",
            "2026-10-08T00:00:00Z",
        ),
    )
    return [
        WorkOrder.model_validate(
            {
                "id": identifier,
                "title": title,
                "kind": kind,
                "status": status,
                "dueAt": due_at,
                "orgId": "fieldloop-demo",
                "assetCode": "DL-01",
                "label": "SYNTHETIC",
                "simulated": True,
                "classification": "INTERNAL",
            }
        )
        for identifier, title, kind, status, due_at in templates
    ]


@router.get("/work-orders", response_model=MockCmmsPage)
def work_orders(
    pm_due: Annotated[bool, Query(alias="pmDue")] = False,
    as_of: Annotated[
        AwareDatetime, BeforeValidator(require_rfc3339), Query(alias="asOf")
    ] = datetime(2026, 10, 10, tzinfo=UTC),
) -> MockCmmsPage:
    orders = fixture_orders()
    if pm_due:
        orders = [
            order
            for order in orders
            if order.kind == "preventive" and order.status == "open" and order.due_at <= as_of
        ]
    return MockCmmsPage.model_validate(
        {
            "items": [order.model_dump(mode="json", by_alias=True) for order in orders],
            "total": len(orders),
            "asOf": as_of.isoformat(),
            "label": "SYNTHETIC",
            "simulated": True,
            "classification": "INTERNAL",
        }
    )
