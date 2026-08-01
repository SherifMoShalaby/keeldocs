from confluent_kafka import Producer, Consumer

producer = Producer({})
consumer = Consumer({})


def emit_metrics():
    producer.produce("telemetry.raw", b"{}")


def consume():
    consumer.subscribe(["telemetry.raw"])
