"""Deterministic, read-only synthetic CMMS for Demo A (SIM-2).

Fixed work orders with no wall clock and no I/O: no CMMS connector, publisher or write
operation. "PM due" is a question asked of the Scenario time ``asOf``, never of the wall clock.
"""

from datetime import UTC, datetime
from typing import Annotated, Final

from fastapi import APIRouter, Depends, Query
from fieldloop_common.generated_mock_cmms import MockCmmsPage, WorkOrder

from fieldloop_simulator.mock_http import Rfc3339, app_state
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id

CLASSIFICATION: Final = "INTERNAL"
# The Scenario time a read uses when it names none, so a bare read is reproducible (SIM-5).
DEFAULT_AS_OF: Final = datetime(2026, 10, 10, tzinfo=UTC)


def _work_order(identifier: str, title: str, kind: str, status: str, due_at: datetime) -> WorkOrder:
    return WorkOrder.model_validate(
        {
            "id": identifier,
            "orgId": DEMO_ORG_ID,  # replaced with the configured Organisation when served
            "assetCode": "DL-01",
            "title": title,
            "kind": kind,
            "status": status,
            "dueAt": due_at,
            "label": "SYNTHETIC",
            "simulated": True,
            "classification": CLASSIFICATION,
        }
    )


# Authored values, not observations of a real asset.
_WORK_ORDERS = (
    _work_order(
        "SYN-CMMS-001",
        "Synthetic rectifier preventive check",
        "preventive",
        "open",
        datetime(2026, 10, 9, tzinfo=UTC),
    ),
    _work_order(
        "SYN-CMMS-002",
        "Synthetic valve preventive check",
        "preventive",
        "open",
        datetime(2026, 10, 10, tzinfo=UTC),
    ),
    _work_order(
        "SYN-CMMS-003",
        "Synthetic coating corrective work",
        "corrective",
        "open",
        datetime(2026, 10, 11, tzinfo=UTC),
    ),
    _work_order(
        "SYN-CMMS-004",
        "Synthetic completed preventive check",
        "preventive",
        "completed",
        datetime(2026, 10, 8, tzinfo=UTC),
    ),
)


class SimulatedCmms:
    def __init__(self, *, org_id: str = DEMO_ORG_ID) -> None:
        self.org_id = require_org_id(org_id)

    def page(self, *, pm_due: bool, as_of: datetime) -> MockCmmsPage:
        """Every work order, or with ``pm_due`` the open preventive ones due by ``as_of``."""
        orders = [
            order
            for order in _WORK_ORDERS
            if not pm_due
            or (order.kind == "preventive" and order.status == "open" and order.due_at <= as_of)
        ]
        items = [order.model_copy(update={"org_id": self.org_id}) for order in orders]
        return MockCmmsPage.model_validate(
            {
                "items": items,
                "total": len(items),
                "asOf": as_of,
                "label": "SYNTHETIC",
                "simulated": True,
                "classification": CLASSIFICATION,
            }
        )


router = APIRouter(prefix="/mock/cmms", tags=["mock-cmms"])

get_cmms = app_state("cmms", SimulatedCmms)


@router.get("/work-orders", response_model=MockCmmsPage)
def list_work_orders(
    cmms: Annotated[SimulatedCmms, Depends(get_cmms)],
    pm_due: Annotated[bool, Query(alias="pmDue")] = False,
    as_of: Annotated[Rfc3339, Query(alias="asOf")] = DEFAULT_AS_OF,
) -> MockCmmsPage:
    return cmms.page(pm_due=pm_due, as_of=as_of)
