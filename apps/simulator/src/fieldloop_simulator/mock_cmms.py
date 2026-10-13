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
# The Scenario time a read uses when it names none: the start of the DL-01 simulation, so a
# bare read is reproducible (SIM-5).
DEFAULT_AS_OF: Final = datetime(2026, 10, 12, tzinfo=UTC)


def _work_order(
    identifier: str,
    barrier_id: str,
    title: str,
    kind: str,
    due_at: datetime,
    *,
    completed_at: datetime | None = None,
) -> WorkOrder:
    return WorkOrder.model_validate(
        {
            "id": identifier,
            "orgId": DEMO_ORG_ID,  # replaced with the configured Organisation when served
            "assetCode": "DL-01",
            "barrierId": barrier_id,
            "title": title,
            "kind": kind,
            "status": "open" if completed_at is None else "completed",
            "dueAt": due_at,
            "completedAt": completed_at,
            "label": "SYNTHETIC",
            "simulated": True,
            "classification": CLASSIFICATION,
        }
    )


# Authored values, not records of a real asset. Each names a Barrier of the DL-01 Bowtie in
# ``data/synthetic/dl-01/bowtie-a.json``; a test keeps them in step, because the simulator image
# does not carry ``data/``. SYN-CMMS-001 falls due when the 12-month evidence interval of the
# cathodic protection Barrier ends, one day into the simulation (PRD Demo A step 5).
_WORK_ORDERS = (
    _work_order(
        "SYN-CMMS-001",
        "cathodic-protection",
        "Synthetic cathodic protection survey",
        "preventive",
        datetime(2026, 10, 13, tzinfo=UTC),
    ),
    _work_order(
        "SYN-CMMS-002",
        "remote-automatic-valve-closure",
        "Synthetic valve actuator preventive service",
        "preventive",
        datetime(2026, 10, 10, tzinfo=UTC),
    ),
    _work_order(
        "SYN-CMMS-003",
        "coating",
        "Synthetic coating repair",
        "corrective",
        datetime(2026, 10, 20, tzinfo=UTC),
    ),
    _work_order(
        "SYN-CMMS-004",
        "depth-of-cover-and-markers",
        "Synthetic depth of cover survey",
        "preventive",
        datetime(2026, 9, 30, tzinfo=UTC),
        completed_at=datetime(2026, 9, 15, tzinfo=UTC),
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


# An open work order has no completedAt; the contract forbids writing it as null.
@router.get("/work-orders", response_model=MockCmmsPage, response_model_exclude_none=True)
def list_work_orders(
    cmms: Annotated[SimulatedCmms, Depends(get_cmms)],
    pm_due: Annotated[bool, Query(alias="pmDue")] = False,
    as_of: Annotated[Rfc3339, Query(alias="asOf")] = DEFAULT_AS_OF,
) -> MockCmmsPage:
    return cmms.page(pm_due=pm_due, as_of=as_of)
