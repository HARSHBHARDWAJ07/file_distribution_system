# worker

Background process that consumes `file.uploaded` jobs from pg-boss (a Postgres-backed queue in the same
database as everything else) and does post-upload work off the HTTP request path. It never opens a port.

For each job it reloads the file row and runs `planWork` (`lib/workPlan.js`) to decide what is still needed:

- **Thumbnail**: image uploads (`jpeg`/`png`/`webp`/`gif`) get a 200px-wide JPEG at `thumbnails/<fileId>.jpg`.
- **Replication**: the object is copied to `replica/<storage_key>`.

Each step writes its result (`thumbnail_key`, `replicated_at`) only after it succeeds. Delivery is
at-least-once, so a redelivered job resumes from the first unfinished step, or does nothing if every step is done.
Failures are rethrown so pg-boss retries them with backoff (3 retries).

## Why pg-boss, not BullMQ + Redis

At this scale a Redis instance dedicated to queueing is one more service to run and keep alive, and it buys nothing
the project needs. Postgres already gives durable, at-least-once delivery. Worth revisiting only if throughput
ever needs Redis-grade queue performance.

## Replication is simulated

Real cross-region replication costs money, and this project runs at $0. The worker copies each object to a
`replica/` prefix, or to `STORAGE_REPLICA_BUCKET` if one is set. That shows the same durability pattern
(a second copy, recorded only after it lands) without the bill. With a budget, this would be a bucket-level
cross-region replication rule instead of application code.

## Running

```
npm run dev:worker
```

It needs the same `DATABASE_URL` and `STORAGE_*` env vars as file-service. On Render, deploy it as a
**Background Worker** (root `apps/worker`, start `node index.js`), not a Web Service. It has no public URL.
