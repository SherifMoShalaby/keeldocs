# E15 — async-messaging extraction (the N4 gate)

**Gate (doc 07/11 N4).** "E1-style labeled corpus; ≥90% recall / ≥98%
precision on declared topics before the data-flow recipe unlocks."

**Method.** A labeled corpus (`fixtures/messaging-scenario/GROUND_TRUTH.md`,
committed) covering the five transports the design names, across three
languages and both declaration styles — object-literal (kafkajs,
AWS SDK v3 command objects), positional (amqplib, redis, confluent-kafka),
and annotation (`@KafkaListener`). One topic is deliberately computed
(`dynamicTopic()`) and must be held as a gap, never named. The corpus is
asserted in every CI run: the harness parses the ground-truth table and
compares it to the extracted fact set, failing on either a miss or an
invention.

**Result: 10/10 declared channels — 100% recall, 100% precision, 1/1
expected gap held.** Well past the gate on this corpus, so the data-flow
recipe unlocks.

| transport | declared | found | invented |
|---|---|---|---|
| kafka (kafkajs, confluent-kafka, @KafkaListener) | 4 | 4 | 0 |
| sqs-sns (AWS SDK v3 commands) | 2 | 2 | 0 |
| rabbitmq (amqplib) | 1 | 1 | 0 |
| redis-pubsub (ioredis) | 1 | 1 | 0 |
| supabase-realtime | 2 | 2 | 0 |

**Real-repo probe.** The supabase-realtime provider run against the E9
production app found its single `.channel()` call site to be
`getSupabase().channel(name)` — a variable, opaque without dataflow
analysis. It emitted a named gap and zero invented channels, which is the
correct behavior and the honest half of the recall story: wrapper-function
indirection is a real pattern that costs recall and must never cost
precision.

**Design notes earned here.** (1) *Template literals are shape, not
guesswork*: `` `ride:${id}` `` now emits as the pattern `ride:{}` marked
`pattern: true` — the same honesty endpoints use when they keep `:id`
verbatim — while an opaque variable stays a gap. (2) *Transport is hashed,
sites are not*: moving a channel from redis to kafka IS an architecture
change worth flagging; adding a second publisher is not documentation
drift (the env-var rule). (3) *One capability, five providers*: all five
transports resolve into one `async-messaging` capability and union
cleanly — the ADR-003 machinery carrying its intended load.

**Honest limits.** The corpus is a fixture, not a large real-repo sample:
the ≥90%/≥98% numbers are exact on what is labeled, and field recall
(wrapper indirection, config-driven topic names, per-environment
prefixes) rides E9. Not covered: NestJS microservice decorators, Kafka
Streams topologies, Azure Service Bus, GCP Pub/Sub, and broker
introspection of any kind (the design forbids it — declarations only).
Channel facts are deliberately EXCLUDED from the coverage denominator,
which stays the owner's fixed set (endpoints, tables, env vars, services);
widening it to channels and client routes is an open owner question.
