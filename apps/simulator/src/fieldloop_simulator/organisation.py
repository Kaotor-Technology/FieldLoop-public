"""The Organisation that the mock sources and their Signals belong to."""

import re
from collections.abc import Mapping

DEMO_ORG_ID = "fieldloop-demo"
_ORG_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


def require_org_id(org_id: str) -> str:
    if _ORG_ID.fullmatch(org_id) is None:
        raise ValueError("Invalid Organisation ID")
    return org_id


def org_id_from_environment(environ: Mapping[str, str]) -> str:
    return require_org_id(environ.get("FIELDLOOP_ORG_ID", DEMO_ORG_ID))
