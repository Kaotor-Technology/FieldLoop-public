"""The Organisation that the mock sources and their Signals belong to."""

from collections.abc import Mapping

from fieldloop_common.signal_publisher import ORG_ID_PATTERN

DEMO_ORG_ID = "fieldloop-demo"


def require_org_id(org_id: str) -> str:
    if ORG_ID_PATTERN.fullmatch(org_id) is None:
        raise ValueError("Invalid Organisation ID")
    return org_id


def org_id_from_environment(environ: Mapping[str, str]) -> str:
    return require_org_id(environ.get("FIELDLOOP_ORG_ID", DEMO_ORG_ID))
