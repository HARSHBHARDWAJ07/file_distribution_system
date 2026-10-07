# worker

Background process that consumes `file.uploaded` jobs from pg-boss (a Postgres-backed queue in the same
database as everything else) and does post-upload work off the HTTP request path. It never opens a port.

For each job it reloads the file row and runs `planWork` (`lib/workPlan.js`) to decide what is still needed:

- **Replication** (first): the object is copied to `replica/<storage_key>`.
- **Thumbnail**: image uploads (`jpeg`/`png`/`webp`/`gif`) get a 200px-wide JPEG at `thumbnails/<fileId>.jpg`.

Replication runs first, so a problem with the preview never stops the durable copy. Each step writes its
result (`replicated_at`, `thumbnail_key`) only after it succeeds. Delivery is at-least-once, so a redelivered
job resumes from the first unfinished step, or does nothing if every step is done.

Failures come in two kinds:

- **Transient** (storage or database errors) are rethrown, so pg-boss retries them with backoff (3 retries).
- **Permanent**: an image sharp can't decode is recorded in `thumbnail_error`, and the job completes. Retrying
  wouldn't help, and `planWork` never schedules that thumbnail again.

If the file is deleted while a job is running, the step that notices (its `UPDATE` matches no rows) deletes
the object it just created. The file-service's delete removes the original, the thumbnail and the replica by
their deterministic keys (`packages/shared-types/storageKeys.js`). Together, these mean no orphaned objects are
left behind.

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
npm run dev:worker                      # long-running consumer (local / docker-compose)
node apps/worker/index.js --drain       # process everything queued, then exit
```

It needs the same `DATABASE_URL` and `STORAGE_*` env vars as file-service.

## Deploying: GitHub Actions, not a host

No free host keeps a long-running process alive: Render's free tier has no Background Worker type, and
free Web Services sleep. So production runs the worker in **drain mode** from
`.github/workflows/worker.yml`. Every 5 minutes (GitHub's minimum) a run starts, processes every job
that's ready, and exits. It also stops taking new jobs after 8 minutes, so a backlog is split across runs.
Because the repo is public, these runs are free.

- **Secrets**: `DATABASE_URL` and `STORAGE_*`, the same values the file-service uses.
- **Run it now**: `gh workflow run worker.yml`.
- **Trade-off**: a thumbnail lands within about one schedule interval of the upload, not within seconds.
  GitHub can also delay scheduled runs when it's busy. The client never waits either way; that's what the
  queue is for.
- **Retries**: a failed job goes back to pg-boss with `fail()`. A later run picks it up once its backoff
  has passed (3 retries). If a run dies mid-job, pg-boss expires the job and retries it.
- **Caveat**: GitHub disables scheduled workflows after 60 days with no commits to the repo, and then
  the queue stops draining. Re-enable the workflow in the Actions tab. A paid always-on worker avoids
  this when there's budget.
