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

It needs the same `DATABASE_URL` and `STORAGE_*` env vars as file-service.

## Deploying (Render free tier)

Render's free tier has no Background Worker type, so the worker runs as a **free Docker Web Service**
(`apps/worker/Dockerfile`). When `PORT` is set it serves a read-only `GET /health` (job counters, no file data);
locally there is no `PORT` and no HTTP at all.

- **Create it once** from a terminal: `node scripts/render/createWorker.js`. It copies `DATABASE_URL` and
  `STORAGE_*` from the file-service through the Render API. The API key is read from `RENDER_API_KEY` or `~/.render/api_key`.
- **Deploys** run in `.github/workflows/deploy-worker.yml`: on a push to `main` that touches the worker, the
  worker tests run first, then that exact commit is deployed. Auto-deploy is off on Render, so this
  workflow is the only way code reaches the worker. It needs the secrets `RENDER_API_KEY` and
  `RENDER_WORKER_SERVICE_ID` and the variable `WORKER_HEALTH_URL`.
- **Keep-alive**: free Web Services sleep after ~15 idle minutes, and a sleeping worker drains no queue.
  `.github/workflows/worker-keepalive.yml` pings `/health` every 10 minutes. That uses almost all of the
  workspace's 750 free instance hours a month, which the other free services share. A paid Background
  Worker (no port, no pings) is the proper fix when there's budget.
