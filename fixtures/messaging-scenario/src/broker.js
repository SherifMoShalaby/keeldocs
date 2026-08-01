const amqp = require("amqplib");
const Redis = require("ioredis");

async function setup(conn) {
  const ch = await conn.createChannel();
  await ch.assertQueue("image-thumbnails");
  await ch.sendToQueue("image-thumbnails", Buffer.from("x"));
  await ch.consume("image-thumbnails", handler);
}

const redis = new Redis();
const redisSub = new Redis();
function live() {
  redis.publish("presence", "ping");
  redisSub.subscribe("presence");
}
