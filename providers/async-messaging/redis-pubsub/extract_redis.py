#!/usr/bin/env python3
"""Redis pub/sub channel declarations (async-messaging)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from msgscan import emit  # noqa: E402

RULES = [
    ("publish", r"redis|pub|client", "channel", "produces", ["pos:0"]),
    ("subscribe", r"redis|sub|client", "channel", "consumes", ["pos:0"]),
    ("psubscribe", r"redis|sub|client", "channel", "consumes", ["pos:0"]),
]

if __name__ == "__main__":
    emit(sys.argv[1], "redis-pubsub", RULES)
