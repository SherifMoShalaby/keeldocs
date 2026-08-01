#!/usr/bin/env python3
"""SQS/SNS queue+topic declarations (async-messaging)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from msgscan import emit  # noqa: E402

RULES = [
    ("SendMessageCommand", None, "queue", "produces", ["obj:QueueUrl"]),
    ("SendMessageBatchCommand", None, "queue", "produces", ["obj:QueueUrl"]),
    ("ReceiveMessageCommand", None, "queue", "consumes", ["obj:QueueUrl"]),
    ("DeleteMessageCommand", None, "queue", "consumes", ["obj:QueueUrl"]),
    ("PublishCommand", None, "topic", "produces", ["obj:TopicArn"]),
    ("SubscribeCommand", None, "topic", "consumes", ["obj:TopicArn"]),
    ("send_message", None, "queue", "produces", ["obj:QueueUrl"]),
    ("receive_message", None, "queue", "consumes", ["obj:QueueUrl"]),
    ("publish", r"sns", "topic", "produces", ["obj:TopicArn"]),
]

if __name__ == "__main__":
    emit(sys.argv[1], "sqs-sns", RULES)
