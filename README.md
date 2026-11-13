# Accord Cron Lab

A small, self-contained copy of the architecture for **"Accord cron health status view on the WMS dashboard"**.
Build and break it here, then port the same pieces into `ProdigybackendNew`.

## How the pieces fit

```
                         ┌──────────── registry.js (code = source of truth) ───────────┐
                         │   jobs, schedules, grace, maxDuration, retry, handler        │
                         └───────────────┬──────────────────────────────┬──────────────┘
                                         │ syncRegistry() at startup     │ handler lookup
                                         ▼                               ▼
 server crontab ──curl──► API process ──────────► runJob() ──► CronTracker.run() ──► job function
  (external jobs)         /api/accord-cron/:job     ▲                │                 (fetch Accord,
                                                    │                │                  stage, $merge)
 dashboard "Run now" ───► /api/health/crons/:job/run│                │
                                                    │                ▼
 worker process ── node-cron (internal jobs) ───────┘     cron_jobs  (registry copy + lock + lastRun)
   + retries + presence heartbeat                          cron_runs  (history, 90-day TTL)
                                                           cron_workers (is the scheduler alive?)
                                                                 │
 WMS dashboard ──poll 15s──► GET /api/health/crons ──► status.js (pure rules) ──► healthy / delayed / failing
```

| Process | Does | Never does |
|---|---|---|
| **API** (`src/api/server.js`) | serves the dashboard API, accepts crontab and manual triggers | schedule anything |
| **Worker** (`src/worker/worker.js`) | schedules `internal` jobs, retries, heartbeats its presence | serve HTTP. Run **exactly one** |
| **Mock Accord** (`mock-accord/server.js`) | fake feed that can fail, return empty files or respond slowly on demand | (lab only) |

## Folder map

```
src/
  config.js                 env -> constants
  db.js                     mongoose connection
  models/
    CronJob.js              cron_jobs: definition fields + runtime fields (lock, lastRun, counters)
    CronRun.js              cron_runs: one doc per execution, TTL 90 days
    CronWorker.js           cron_workers: scheduler presence
    accordFeeds.js          lab feed collections (staging + target)
  jobs/
    registry.js             ★ the list of jobs
    syncRegistry.js         validate + upsert registry into cron_jobs
    defineAccordJob.js      ★ factory for the standard fetch -> stage -> merge -> count pattern
    accordJobs.js           the jobs (config on top of the factory + one custom job)
    runJob.js               registry handler + tracker glue
  tracker/
    CronTracker.js          ★ lock, heartbeat, run, record, release
    schedule.js             prevSlot / nextSlot for several cron expressions
  health/
    status.js               ★ pure health rules
    service.js              reads Mongo, applies rules
  api/                      express app + routes
  worker/worker.js          ★ scheduler process
public/dashboard.html       the dashboard (no build step)
tests/status.test.js        unit tests for the rules
scripts/                    sync, tracker demo, crash child, e2e
ecosystem.config.js         PM2: mock + api + worker
```

## Run it

Needs Node 18+ and MongoDB on `127.0.0.1:27017` (database `accord_cron_lab`).

```bash
npm install
npm test                 # 15 unit tests for the health rules (no DB)
npm run demo:tracker     # tracker scenarios: success, failed, warning, overlap, crash, disabled
npm run e2e              # full system with real processes, ~4 min, 27 checks
```

Watch it live, either with PM2:
```bash
pm2 start ecosystem.config.js
pm2 logs
# stop + remove: pm2 delete ecosystem.config.js
```
or with three terminals: `npm run mock`, `npm run api`, `npm run worker`.

Open http://127.0.0.1:4000/dashboard and enter the token `lab-admin-token` (from `.env`).

**Break Accord while you watch** (open these in a browser or call them with curl):
```
http://127.0.0.1:4001/__chaos/set?file=Amc_mst&mode=fail      # next amc_master run fails, then retries
http://127.0.0.1:4001/__chaos/set?file=Currentnav&mode=empty  # Run now -> warning
http://127.0.0.1:4001/__chaos/set?file=all&mode=normal         # everything healthy
```
Other things to try:
- `pm2 stop lab-worker`: the Scheduler tile turns red, and after 1–2 minutes `amc_master` shows *missed*.
- Leave `sclass_mst` alone: it's `external` and nothing calls it, so it shows *missed (crontab did not call it)*.
- Simulate the crontab:
  ```
  curl -H "x-cron-secret: lab-cron-secret" http://127.0.0.1:4000/api/accord-cron/sclass_mst
  ```

## Life of one run

1. **Enabled?** Automatic triggers on a disabled job are recorded as `skipped`. A manual run is always allowed.
2. **Migration guard.** A crontab call for a job that moved to the worker is `skipped`, so the job doesn't run twice.
3. **Lock.** An atomic `findOneAndUpdate` on the job doc matches only if the lock is free or its lease has expired. If someone else holds it, the run is `skipped`. If an expired lease was taken over, the old run is marked `interrupted`.
4. A `running` run doc is inserted, and a heartbeat extends the lease every 30s (the lease is 2 min).
5. The job function returns `{fetched, processed}` or throws. That maps to `success`, `warning` (0 rows) or `failed`.
6. The run doc is finished. Then **one atomic pipeline update** on the job doc sets the lastRun snapshot, `lastSuccessAt` and `consecutiveFailures`, and releases the lock only if it's still ours.

## Health rules (`src/health/status.js`)

| Job status | When |
|---|---|
| failing | last run failed or was interrupted · the running process stopped heartbeating |
| delayed | a slot passed its grace period with no run (**missed**) · running longer than `maxDurationMin` (**stuck**) · last run got 0 rows |
| healthy | none of the above |
| disabled | not evaluated |

Overall: **failing** if a *critical* job is failing. Otherwise **delayed** if anything is failing or delayed, or the worker is offline while internal jobs exist. Otherwise **healthy**.

---

## Porting to ProdigybackendNew

| Lab | Main app |
|---|---|
| `models/CronJob.js`, `CronRun.js`, `CronWorker.js` | new files in `models/` (same schemas) |
| `jobs/registry.js` | new `config/accordCronRegistry.js`. Copy the schedules from the **real** server crontab (ask DevOps), not from the docs |
| `jobs/defineAccordJob.js` | new `services/accordJobFactory.js` |
| `jobs/accordJobs.js` | replaces the ~30 copied `accordX` + `updateX` pairs in `controller/accord_cron-controller.js`. Keep the existing `$project` pipelines, just move them into the factory config |
| custom jobs (`navSanityCheck`) | `updateSchemeStatus`, `updateSchemename`, `accordhistory_nav`… rewritten to `return {fetched, processed}` / throw |
| `tracker/*` | new `services/cronTracker/` |
| `health/*` | new `services/cronHealth/` + controller. Also embed `getAccordFeedHealth()` (PPR-567) in the response |
| `api/routes.js` | `routes/accord_cron-routes.js`: keep the old URLs but point each at `runJob(jobKey, {trigger:'external'})`. Health routes go behind the **existing WMS admin auth middleware** |
| `public/dashboard.html` | the WMS frontend page: same API, same layout ideas |
| `worker/worker.js` + `ecosystem.config.js` | new `workers/accordCronWorker.js` + a new PM2 app entry (fork mode, 1 instance) |
| `crons/accordFeedHealthCron.js` | extend it to also email on critical failing or missed jobs |

### Gotchas this lab already ran into

1. **`timestamps: true` makes every update look modified.** Pass `timestamps: false` on sync and tracker writes, and set `createdAt` by hand with `$setOnInsert`. Without `createdAt`, every job gets blamed for slots that passed before tracking started.
2. **`$merge` needs a unique index on the `on` field** of the target collection. Check `current_nav.schemecode` etc. in production before switching.
3. **`updateX()` functions swallow errors** in the main app. They must throw, or failures show as "Success".
4. **Accord file date.** The main app builds `DDMMYYYY` in server-local time. Compute it in IST (`accordDate()`), or a UTC server asks for yesterday's file at 04:01 IST.
5. **Shared dump collections + `deleteMany({})`.** Tag staged rows with `runId` and merge or delete only your own. A TTL index on `stagedAt` cleans up after crashes.
6. **PM2 on Windows** can't send SIGINT. Use `shutdown_with_message: true`, which the lab already handles. On Linux, SIGINT works as usual.
7. **The trigger URLs are public today.** Add the `x-cron-secret` header to the crontab lines at the same time.

### Rollout order
1. Add the models, tracker and health API. Point the existing routes at `runJob` with every job set to `scheduler: 'external'`. The crontab keeps working and the dashboard fills with real runs (this meets the acceptance criterion on UAT).
2. Move the jobs to the factory one at a time, critical ones first.
3. Deploy the worker. Switch jobs to `internal` one at a time, removing each crontab line in the same release. The migration guard skips any leftover crontab call.
4. Lock down or remove the public trigger URLs once nothing external is left.
