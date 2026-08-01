#!/usr/bin/env python3
"""kafka topic declarations (async-messaging). Rules only - see _runtime/msgscan.py."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from msgscan import emit  # noqa: E402

RULES = [
    # kafkajs: producer.send({topic}), sendBatch({topicMessages}), consumer.subscribe({topic|topics})
    ("send", r"producer|kafka|template", "topic", "produces", ["obj:topic", "pos:0"]),
    ("subscribe", r"consumer|kafka", "topic", "consumes", ["obj:topic", "obj:topics", "pos:0"]),
    # kafka-python / confluent-kafka: producer.produce("t", ...), consumer.subscribe(["t"])
    ("produce", None, "topic", "produces", ["pos:0", "obj:topic"]),
]
ANNOTATIONS = [("KafkaListener", "topics", "topic", "consumes")]

if __name__ == "__main__":
    emit(sys.argv[1], "kafka", RULES, ANNOTATIONS)
