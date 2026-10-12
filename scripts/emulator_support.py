"""Guard shared by the scripts that exercise a Pub/Sub emulator."""

import os
import socket
import time


def require_loopback_emulator() -> None:
    """Refuse anything but a loopback emulator, then wait until it answers."""
    host = os.environ.get("PUBSUB_EMULATOR_HOST", "")
    if not host.startswith(("127.0.0.1:", "localhost:")):
        raise SystemExit(
            "Set PUBSUB_EMULATOR_HOST to a loopback emulator; real GCP is forbidden here"
        )
    address, port = host.rsplit(":", 1)
    for attempt in range(120):
        try:
            with socket.create_connection((address, int(port)), timeout=0.5):
                return
        except OSError:
            if attempt == 119:
                raise
            time.sleep(0.25)
