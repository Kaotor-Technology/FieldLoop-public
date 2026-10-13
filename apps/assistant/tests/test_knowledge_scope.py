import pytest
from fieldloop_assistant.knowledge import KnowledgeScope


@pytest.mark.parametrize(
    "org,folders,classes",
    [
        ("", ("Company Standards",), ("PUBLIC",)),
        ("demo", (), ("PUBLIC",)),
        ("demo", ("",), ("PUBLIC",)),
        ("demo", ("Company Standards",), ()),
        ("demo", ("Company Standards",), ("private",)),
    ],
)
def test_access_scope_requires_explicit_verified_permissions(
    org: str, folders: tuple[str, ...], classes: tuple[str, ...]
) -> None:
    with pytest.raises(ValueError):
        KnowledgeScope(org, folders, classes)
