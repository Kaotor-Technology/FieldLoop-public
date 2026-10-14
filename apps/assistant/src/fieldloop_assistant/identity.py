"""Verification of the short-lived internal user token minted by web-api (architecture §4.3)."""

import json
from dataclasses import dataclass
from typing import Any

import jwt
from jwt import PyJWKSet

ALLOWED_ROLES = frozenset({"fieldloop.viewer", "fieldloop.operator", "fieldloop.manager"})
CLASSIFICATIONS = ("PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED")


class InvalidTokenError(Exception):
    """The token failed verification; callers answer 401 without detail."""


@dataclass(frozen=True)
class UserIdentity:
    sub: str
    org_id: str
    roles: tuple[str, ...]
    clearance: str


class InternalTokenVerifier:
    def __init__(self, jwks: str, issuer: str, audience: str, org_id: str) -> None:
        if not (issuer and audience and org_id):
            raise ValueError("Internal token issuer, audience and Organisation are required")
        self._keys = PyJWKSet.from_dict(json.loads(jwks))
        self._issuer = issuer
        self._audience = audience
        self._org_id = org_id

    def verify(self, token: str) -> UserIdentity:
        try:
            kid = jwt.get_unverified_header(token).get("kid")
            key = next(k for k in self._keys.keys if k.key_id == kid)
            claims: dict[str, Any] = jwt.decode(
                token, key.key, algorithms=["RS256"], issuer=self._issuer, audience=self._audience,
                leeway=5, options={"require": ["exp", "iat", "sub"]},
            )
        except (jwt.PyJWTError, StopIteration, ValueError) as error:
            raise InvalidTokenError from error
        iat = claims["iat"]
        if not isinstance(iat, int) or claims["exp"] - iat > 300:
            raise InvalidTokenError
        roles = claims.get("roles")
        clearance = claims.get("clearance")
        org = claims.get("org_id")
        if (
            not isinstance(claims["sub"], str) or not claims["sub"]
            or org != self._org_id
            or not isinstance(roles, list) or not all(isinstance(r, str) for r in roles)
            or not set(roles) & ALLOWED_ROLES
            or clearance not in CLASSIFICATIONS
        ):
            raise InvalidTokenError
        granted = tuple(r for r in roles if r in ALLOWED_ROLES)
        return UserIdentity(claims["sub"], org, granted, clearance)
