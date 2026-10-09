from importlib.metadata import version

import fieldloop_common


def test_shared_package_is_installed() -> None:
    assert fieldloop_common.__file__ is not None
    assert version("fieldloop-common") == "0.0.0"
