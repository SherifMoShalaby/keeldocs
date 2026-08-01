# Labeled ground truth (the E1-style gate for async-messaging)

Every DECLARED channel in this fixture, hand-labeled. `keeldocs check` must
find all of them (recall) and invent none (precision). The one deliberately
computed topic (`dynamicTopic()`) must appear as a GAP, never as a name.

| transport | kind | name | role |
|---|---|---|---|
| kafka | topic | orders.created | both |
| kafka | topic | orders.cancelled | consumes |
| kafka | topic | payments.settled | consumes |
| kafka | topic | telemetry.raw | both |
| sqs-sns | queue | email-outbox | both |
| sqs-sns | topic | driver-alerts | produces |
| rabbitmq | queue | image-thumbnails | both |
| redis-pubsub | channel | presence | both |
| supabase-realtime | channel | ride-tracking | both |
| supabase-realtime | channel | driver-notes | both |

Total: 10 declared channels, 1 expected gap.
