#!/usr/bin/env python3
"""RabbitMQ queue/exchange declarations (async-messaging)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from msgscan import emit  # noqa: E402

RULES = [
    ("assertQueue", None, "queue", "produces", ["pos:0"]),
    ("sendToQueue", None, "queue", "produces", ["pos:0"]),
    ("queue_declare", None, "queue", "produces", ["obj:queue", "pos:0"]),
    ("basic_publish", None, "exchange", "produces", ["obj:exchange", "pos:0"]),
    ("assertExchange", None, "exchange", "produces", ["pos:0"]),
    ("consume", None, "queue", "consumes", ["pos:0"]),
    ("basic_consume", None, "queue", "consumes", ["obj:queue", "pos:0"]),
]

if __name__ == "__main__":
    emit(sys.argv[1], "rabbitmq", RULES)
