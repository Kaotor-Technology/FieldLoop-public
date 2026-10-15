"""Fail a release before mutation when Terraform-owned simulator SQL config drifted."""

import json
import sys
from typing import Any


def validate(service: dict[str, Any], environment: str) -> list[str]:
    template = service.get("spec", {}).get("template", {})
    runtime = template.get("spec", {})
    containers = runtime.get("containers", [])
    values = {
        item.get("name"): item.get("value", "")
        for item in (containers[0].get("env", []) if containers else [])
    }
    errors = [
        name
        for name in ("FIELDLOOP_DB_CONNECTION_NAME", "FIELDLOOP_DB_NAME", "FIELDLOOP_DB_USER")
        if not values.get(name)
    ]
    if environment not in ("dev", "demo") or values.get("FIELDLOOP_ENV") != environment:
        errors.append("FIELDLOOP_ENV")
    if values.get("FIELDLOOP_DB_NAME") != f"fieldloop_{environment}":
        errors.append("environment-specific database")
    identity = runtime.get("serviceAccountName", "")
    if not identity.endswith(".gserviceaccount.com") or values.get(
        "FIELDLOOP_DB_USER"
    ) != identity.removesuffix(".gserviceaccount.com"):
        errors.append("runtime IAM SQL identity")
    if values.get("FIELDLOOP_DATABASE_URL"):
        errors.append("password database override")
    annotations = template.get("metadata", {}).get("annotations", {})
    try:
        interfaces = json.loads(annotations.get("run.googleapis.com/network-interfaces", "[]"))
    except (TypeError, ValueError):
        interfaces = []
    if not isinstance(interfaces, list) or not any(
        isinstance(item, dict) and item.get("network") and item.get("subnetwork")
        for item in interfaces
    ) or annotations.get("run.googleapis.com/vpc-access-egress") != "private-ranges-only":
        errors.append("private VPC connectivity")
    return errors


if __name__ == "__main__":
    try:
        failures = validate(json.load(sys.stdin), sys.argv[1])
    except (ValueError, TypeError, AttributeError, IndexError):
        failures = ["invalid service configuration"]
    if failures:
        # Report names only: never dump service configuration or credential values.
        print("Simulator runtime prerequisites missing: " + ", ".join(failures), file=sys.stderr)
        sys.exit(1)
    print("Simulator IAM SQL and private VPC prerequisites verified")
