import { Kafka } from "kafkajs";
const kafka = new Kafka({ brokers: [] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "g" });

export async function publishOrder() {
  await producer.send({ topic: "orders.created", messages: [] });
  await producer.send({ topic: dynamicTopic(), messages: [] }); // gap, never guessed
}

export async function listen() {
  await consumer.subscribe({ topics: ["orders.created", "orders.cancelled"] });
  await consumer.subscribe({ topic: "payments.settled" });
}
