# Accord Cron Health: How It Works

A complete walkthrough of `D:\accord-cron-lab`: every moving part, why it exists, and how the parts work together. Read it top to bottom once; after that, use the section headings as a reference.

**Contents**
1. The big picture
2. The two processes: API and Worker
3. The data model
4. The registry and sync
5. CronTracker: the life of one run
6. Job functions
7. Health rules and the dashboard
8. Failure scenarios, one by one
9. The two bugs the end-to-end test caught
10. Running, testing and breaking the lab
11. Porting to ProdigybackendNew
12. Glossary

---

## 1. The big picture

### 1.1 The problem today (ProdigybackendNew)

```
 server crontab ──curl──► GET /api/accord-cron/accordcurrent_nav ──► accordcurrent_nav(req, res)
                                                                         │
                                                       fetch Accord ─► insertMany dump ─► $merge ─► res.json("Success")
```

Five things are wrong with this for monitoring:

| # | Problem | Consequence |
|---|---|---|
| 1 | The schedule lives only in the server's crontab | The app can't know when a job *should* have run, so it can't detect a missed run |
| 2 | Nothing is recorded | There's no last run time, duration, record count or history |
| 3 | `updateX()` helpers catch their own errors and return nothing | A failed merge still answers "Success" |
| 4 | Long jobs run inside an HTTP request | nginx or curl times out (504) while the job keeps running, so the caller never learns the real result |
| 5 | The trigger URLs are public and unauthenticated | Anyone can start heavy jobs |

### 1.2 The target architecture

```
                 ┌───────────── registry.js  (code = the single source of truth) ─────────────┐
                 │   which jobs exist · schedules · grace · max duration · retry · handler     │
                 └───────────────┬──────────────────────────────────────┬─────────────────────┘
                                 │ syncRegistry() at startup            │ handler lookup
                                 ▼                                      ▼
server crontab ──curl──► API process ─────────────────────────────► runJob(jobKey)
(external jobs)          GET /api/accord-cron/:jobKey                   │
                                                                         ▼
dashboard "Run now" ───► POST /api/health/crons/:jobKey/run      CronTracker.run()
                                                                         │  lock → record → run → finish
worker process ── node-cron (internal jobs) + retries ──────────────────┘
      │                                                                  ▼
      └─ presence heartbeat ──► cron_workers          cron_jobs (registry copy + lock + lastRun)
                                                       cron_runs (one doc per execution, 90-day TTL)
                                                                         │
WMS dashboard ──poll every 15s──► GET /api/health/crons ──► status.js ──► healthy / delayed / failing
```

The design rests on one idea: **keep what *should* happen separate from what *did* happen.**

- **Should:** `registry.js` → `cron_jobs` (schedules, grace period, and so on)
- **Did:** `cron_runs` (every execution with its result)
- **Health:** comparing the two at the moment someone asks. If the schedule says a run was due at 10:01, the grace period was 15 minutes, it's now 10:30 and no run exists, the job is *delayed: missed*.

---

## 2. The two processes: API and Worker

The system runs as **two Node processes** from the same codebase and the same MongoDB. A third process, the mock Accord server, exists only in the lab.

### 2.1 What each one does

| | API process (`src/api/server.js`) | Worker process (`src/worker/worker.js`) |
|---|---|---|
| **Job** | Answers HTTP: the dashboard API, crontab triggers, manual "Run now" | Owns the clock: schedules `internal` jobs, runs them, retries failures |
| **Scheduling** | Never schedules anything | Its only purpose |
| **How many** | Any number (PM2 cluster is fine) | **Exactly one** (fork mode, 1 instance) |
| **Can run jobs?** | Yes: crontab and manual triggers run inside the API | Yes: scheduled runs and retries |
| **On startup** | Connect → sync registry → listen on port 4000 | Connect → sync registry → schedule jobs → announce presence |
| **On shutdown** | Stop accepting → wait for running jobs → exit | Stop crons → cancel retries → wait for running jobs → remove presence → exit |

### 2.2 Why two processes and not one

Putting node-cron inside the API process (the way `crons/ordersCron.js` works today) has three problems:

1. **Load:** an Accord job pulls thousands of rows into memory and runs big aggregations. Inside the API, that slows down every user request at 07:31.
2. **Deploys:** every API deploy restarts the process. If a NAV load is halfway through, it dies.
3. **Duplicates:** in PM2 cluster mode every instance loads the cron file, so each job would run N times. You'd need "only instance 0" hacks (like the one in `accordFeedHealthCron.js`).

A separate worker solves all three: it's isolated, restarts on its own schedule, and there's only one of it.

### 2.3 How they cooperate: only through MongoDB

The two processes **never talk to each other directly**. There's no HTTP call between them and no message queue. Everything goes through three collections:

```
            API process                         MongoDB                        Worker process
            ───────────                         ───────                        ──────────────
 runs crontab/manual jobs ──writes──►  cron_jobs.lock      ◄──writes── runs scheduled jobs
                                       cron_jobs.lastRun
                                       cron_runs
 reads for the dashboard  ◄──reads───  cron_workers        ◄──writes── "I'm alive" every 30s
```

- **The lock on `cron_jobs`** stops them from running the same job at the same time. Whoever takes the lock first runs the job; the other records `skipped`.
- **`cron_runs` and `lastRun`** are written by whichever process ran the job. The dashboard doesn't care which.
- **`cron_workers`** is how the API knows whether the worker is alive. If the worker's heartbeat is older than 90 seconds, the dashboard shows "Scheduler offline".

### 2.4 Timeline: a normal day with both processes

```
time     worker                                API                              Mongo
07:31:00 node-cron fires current_nav#1
07:31:00 runJob(trigger=schedule) ───────────────────────────────────────────► lock taken (worker)
07:31:00                                                                        run inserted: running
07:31:20 heartbeat ──────────────────────────────────────────────────────────► lease +2 min
07:31:25                                       dashboard polls ───────────────► reads job: running
07:31:40 job returns {fetched 9800, processed 9800}
07:31:40 finish ─────────────────────────────────────────────────────────────► run: success
                                                                                job: lastRun, lock=null
07:31:42                                       crontab curl for current_nav
                                               (leftover line during migration)
07:31:42                                       migration guard ───────────────► run: skipped
                                                                                ("scheduled by the worker")
07:31:45                                       dashboard polls ───────────────► healthy, last 07:31 ✓
```

### 2.5 Timeline: both try to run the same job

```
10:00:00 worker: schedule fires amc_master  → lock acquired → running
10:00:05 API: support clicks "Run now"      → lock held, lease not expired → run recorded as skipped
                                              reason: "already running (run 6af… on host:1234)"
10:00:30 worker: job finishes               → success, lock released
10:00:35 API: support clicks "Run now" again → lock free → runs normally
```

Neither process needs to know the other exists. The atomic lock in Mongo is the only coordination.

### 2.6 Timeline: the worker dies

```
12:31:00 worker starts current_nav, takes lock (lease until 12:33:00)
12:31:30 heartbeat → lease until 12:33:30
12:31:45 worker process killed (OOM, server reboot, kill -9)
         - no more heartbeats, no more presence updates
12:32:30 dashboard: cron_workers.lastSeenAt is 45s old → still "online"
12:33:15 dashboard: lastSeenAt > 90s old → "Scheduler offline", overall at least delayed
12:33:30 lease expires
12:33:31 dashboard: lock expired but still set → current_nav "failing: stopped responding (process died)"
12:35:00 PM2 restarts the worker → presence back → "online"
         the next current_nav run takes over the expired lock and
         marks the 12:31 run as interrupted
```

---

## 3. The data model

Three collections for monitoring, plus two per Accord feed.

### 3.1 `cron_jobs`: the registry (one document per job)

Holds **two kinds of fields**, and each is written by a different owner:

**Definition fields.** These are copied from `registry.js` by the sync. Never edit them in the database, because the next sync overwrites them.

| Field | Example | Meaning |
|---|---|---|
| `jobKey` | `current_nav` | Stable unique ID used everywhere |
| `name`, `description` | `Current NAV` | Display text |
| `schedules` | `["1 4 * * *", "31 7 * * *", …]` | Cron expressions. **An array**, because current NAV runs at 7 irregular times that can't be written as one expression |
| `timezone` | `Asia/Kolkata` | All schedule maths happens in this timezone, whatever the server's own timezone is |
| `enabled` | `true` | `false` makes automatic triggers skip; manual runs still work |
| `scheduler` | `internal` / `external` | Who triggers it: the worker, or the server crontab |
| `criticality` | `critical` / `normal` | A failing critical job makes the overall status *failing* |
| `graceMin` | `15` | How late a run can start before it counts as *missed* |
| `maxDurationMin` | `10` | A run longer than this counts as *stuck* |
| `retry` | `{attempts: 2, delayMin: 10}` | Worker-only: re-run a failed or empty scheduled run |
| `inRegistry` | `true` | `false` = removed from code, kept for its history |

**Runtime fields.** These are written only by CronTracker. The sync never touches them.

| Field | Meaning |
|---|---|
| `lock` | `{runId, owner, acquiredAt, expiresAt}` while a run is in progress, otherwise `null` |
| `lastRun` | Copy of the newest finished run (status, times, counts, error) |
| `lastSuccessAt` | When the data was last loaded successfully |
| `consecutiveFailures` | Reset to 0 on success; +1 on failed or interrupted; unchanged on warning |
| `createdAt` | When tracking started for this job (see bug #2 in section 9) |

**Why keep a `lastRun` copy?** The dashboard needs "last run" for every job. Without the copy, it would have to aggregate `cron_runs` on every poll. With it, the dashboard reads about 35 small documents. The trade-off is one extra write per run. If the copy is ever lost, it can be rebuilt from `cron_runs`.

### 3.2 `cron_runs`: the history (one document per execution)

| Field | Meaning |
|---|---|
| `jobKey` | Which job |
| `status` | `running` · `success` · `warning` · `failed` · `skipped` · `interrupted` |
| `trigger` | `schedule` (worker) · `retry` (worker) · `external` (crontab) · `manual` (person) |
| `attempt` | 1 for the first try, 2+ for retries |
| `scheduledFor` | The schedule slot this run belongs to (07:31 for a run that started 07:33). `null` for manual runs |
| `startedAt`, `finishedAt`, `durationMs` | Timing |
| `recordsFetched` | Rows Accord returned |
| `recordsProcessed` | Rows actually written to the target collection |
| `reason` | Why it was skipped, interrupted or a warning, in plain words |
| `error.message`, `error.stack` | Why it failed (stack cut to 2000 characters) |
| `host`, `pid` | Which process ran it |

**Indexes:**
- `{jobKey: 1, startedAt: -1}`: "the last 20 runs of job X" (dashboard history)
- `{startedAt: 1}` with **TTL 90 days**: Mongo deletes old runs automatically

**What each run status means:**

| Status | Written when | Shown as |
|---|---|---|
| `running` | The run started and hasn't finished | yellow "running" chip |
| `success` | Finished with more than 0 rows | green |
| `warning` | Finished, but Accord returned 0 rows (file not ready) | yellow |
| `failed` | The job threw an error | red |
| `skipped` | Another run held the lock, the job is disabled, or the migration guard applied | yellow, history only |
| `interrupted` | Found still `running` after its lease expired, meaning the process died | red |

### 3.3 `cron_workers`: scheduler presence

One document per live worker: `{_id: "host:pid", startedAt, lastSeenAt, jobs[]}`. The worker updates `lastSeenAt` every 30 seconds and deletes its document on a clean shutdown. A TTL index removes documents left by crashed workers after a day. A worker counts as *alive* if `lastSeenAt` is within 3 × 30s = 90s.

### 3.4 Feed collections (staging and target)

Each Accord feed has two collections, as in the main app:

| | Example | Notes |
|---|---|---|
| **Staging (dump)** | `current_nav_dump` | Raw Accord rows **plus `runId` and `stagedAt`**. TTL on `stagedAt` (1 day) cleans up rows a crashed run left behind |
| **Target** | `current_nav` | Final data. **Unique index on the merge key** (`schemecode`), which `$merge` requires. Each document also carries `crondate` (kept for the PPR-567 feed check) and `cronRunId` (which run last wrote it) |

---

## 4. The registry and sync

### 4.1 Why the jobs are defined in code

`src/jobs/registry.js` is a plain array, and it is the **only** place where a job is defined:

```js
{
  jobKey: 'current_nav',
  name: 'Current NAV',
  schedules: ['1 4 * * *', '31 7 * * *', ...],
  scheduler: 'internal',
  criticality: 'critical',
  graceMin: 15,
  maxDurationMin: 10,
  retry: { attempts: 2, delayMin: 10 },
  handler: jobs.currentNav,        // the function that does the work, code only
}
```

Because it's code:
- a schedule change goes through **PR review** and appears in **git history**;
- UAT and production get the **same** definitions from the same release;
- the `handler` (a function) sits right next to its schedule. A function can't be stored in Mongo anyway.

### 4.2 What the sync does (`src/jobs/syncRegistry.js`)

Both processes call `syncRegistry()` at startup. You can also run it by hand with `npm run sync`.

```
1. validate every definition (all-or-nothing)
     - jobKey present and unique
     - handler is a function
     - scheduler is internal | external
     - every cron expression parses
   → one error anywhere = nothing written

2. create all indexes (unique jobKey, TTL on runs, unique merge keys on targets)

3. bulk upsert each job:
     $set          definition fields only
     $setOnInsert  jobKey, createdAt          (first time only)
   → lock / lastRun / counters are never touched

4. retire jobs that are in Mongo but no longer in code:
     inRegistry=false, enabled=false   (history stays visible)

5. return { inserted, updated, retired, total }
```

### 4.3 Properties worth knowing

- **Idempotent:** running it twice changes nothing the second time (`updated: 0`). That's why both processes can run it at startup without coordinating.
- **Honest counts:** `updated` counts only jobs whose definition actually changed (see bug #1 in section 9).
- **Nothing is deleted:** deleting a job from code keeps its history.

---

## 5. CronTracker: the life of one run

`src/tracker/CronTracker.js` is the heart of the system. **Every** execution goes through `tracker.run(jobKey, jobFn, {trigger, scheduledFor, attempt})`, whether it came from the worker, the crontab or a person.

### 5.1 The flow

```
          run(jobKey, jobFn, opts)
                  │
  ① load job doc  │  unknown jobKey → throw
                  ▼
  ② enabled? ─── no, and trigger ≠ manual ──► record SKIPPED "job is disabled"
                  │
  ③ migration guard: trigger = external AND job.scheduler = internal
                  │ ──────────────────────────► record SKIPPED "scheduled by the worker…"
                  ▼
  ④ take the lock (atomic) ── not taken ──────► record SKIPPED "already running (run X on host:pid)"
                  │
                  │ took over an EXPIRED lock? ─► mark the old run INTERRUPTED
                  ▼
  ⑤ insert run {status: running}
  ⑥ start the heartbeat (renews the lease every 30s)
                  ▼
  ⑦ await jobFn(ctx)
        ├─ throws               → FAILED  (error saved)
        ├─ returns fetched = 0  → WARNING
        └─ returns fetched > 0  → SUCCESS
                  ▼
  ⑧ stop the heartbeat
  ⑨ update the run (finishedAt, durationMs, counts, error)
  ⑩ ONE atomic update of the job doc:
        lastRun = snapshot
        lastSuccessAt = now            (success only)
        consecutiveFailures = 0 / +1 / unchanged
        lock = null    ONLY IF lock.runId is still mine
                  ▼
          return {runId, status, durationMs, recordsFetched, recordsProcessed, error}
```

### 5.2 The lock, in detail

Taking the lock is a single Mongo operation:

```
findOneAndUpdate(
  { jobKey, $or: [ {lock: null}, {'lock.expiresAt': {$lte: now}} ] },   ← free, or the holder is dead
  { $set: { lock: {runId, owner: "host:pid", acquiredAt: now, expiresAt: now + 2 min} } },
  { new: false }                                                        ← return the OLD document
)
```

- **Atomic:** Mongo applies the filter and the update as one step on one document. If two processes try at the same instant, exactly one matches; the other gets `null` and records `skipped`. This works across processes, PM2 instances and servers.
- **`new: false`** returns the document *before* the update, so we can see whether we replaced an expired lock. If we did, the previous holder died, and we mark its run `interrupted` and count it as a failure.
- **Lease and heartbeat:** the lock is valid for 2 minutes and is renewed every 30 seconds while the job runs.
  - A job running for 40 minutes keeps its lock the whole time.
  - A dead process stops renewing, and its lock frees itself within 2 minutes.
  - Without a heartbeat, you'd have to guess a fixed lease. Guess too short and a long job loses its lock, letting a second copy start. Guess too long and a crash blocks the job for that long.
- **Release only if still mine:** at the end, the lock is cleared only if `lock.runId` equals this run's ID. In the rare case another process took over (this run stalled past its lease), we don't clear *their* lock.

### 5.3 Why the finish is a single update

Step ⑩ uses an **aggregation-pipeline update** so all four changes (snapshot, `lastSuccessAt`, counter, conditional lock release) happen atomically:

```js
updateOne({ jobKey }, [{ $set: {
  lastRun:             { $literal: lastRun },            // $literal: error text may contain "$"
  lastSuccessAt:       success ? finishedAt : '$lastSuccessAt',
  consecutiveFailures: success ? 0 : failed ? { $add: ['$consecutiveFailures', 1] } : '$consecutiveFailures',
  lock:                { $cond: [{ $eq: ['$lock.runId', runId] }, null, '$lock'] },
}}])
```

Done as separate updates, a crash between them could leave a released lock with an old `lastRun`, or a new `lastRun` with the lock still held.

### 5.4 Write order and crash safety

- The run document is written **before** the job document. If the process dies between ⑨ and ⑩, the run already shows its true result, and the lock expires on its own.
- If writing the finish fails (Mongo briefly unavailable), the tracker **logs and moves on, without throwing**. The lease expires and the next run marks things correctly.
- If Mongo is down at the **start**, the tracker throws, which is correct: the job couldn't save its data anyway.

### 5.5 What `scheduledFor` is

Every run is linked to the schedule slot it belongs to:
- **Worker runs:** the exact slot node-cron fired for (`ctx.date`, normalised).
- **Crontab runs:** the most recent slot at or before now. A curl at 07:33 belongs to the 07:31 slot.
- **Retries:** the same slot as the run they repeat.
- **Manual runs:** `null`.

The history table shows it, which makes the question "was the 07:31 slot ever run, and how many attempts did it take?" easy to answer.

### 5.6 In-flight tracking and graceful shutdown

The tracker keeps a `Set` of runs currently executing in its own process. `waitForInFlight(25s)` resolves when they've all finished. Both processes call it on shutdown, so a `pm2 restart` doesn't cut a NAV load in half. The PM2 `kill_timeout` is 30s, longer than the 25s wait.

---

## 6. Job functions

### 6.1 The contract

A job is any function with this shape:

```
async (ctx) => ({ fetched, processed })     // or throw
```

`ctx` gives the job `runId`, `jobKey`, `scheduledFor`, `startedAt`, `attempt` and a `log()` function that prefixes messages with the job name.

These rules replace the main app's habit of catching errors and answering "Success":

| Situation | The job must… | Tracker records |
|---|---|---|
| Accord down, HTTP error, timeout, merge failure | **throw** | `failed` |
| Accord answered, but the file has 0 rows | return `{fetched: 0}` | `warning` |
| Data loaded | return real counts | `success` |

### 6.2 The factory (`src/jobs/defineAccordJob.js`)

About 30 of the main app's Accord functions are the same pattern with different names. The factory writes that pattern once:

```js
const currentNav = defineAccordJob({
  file: 'Currentnav',          // Accord filename
  section: 'MFNav',            // Accord section
  dump: CurrentNavDump,        // staging model
  target: CurrentNav,          // target model
  mergeOn: 'schemecode',       // $merge key (needs a unique index)
  project: {                   // how a staged row becomes a target row
    schemecode: 1,
    navdate: { $dateFromString: { dateString: '$navdate' } },
    navrs: 1,
    prevnav: 1,
  },
});
```

What the generated function does:

```
1. fetch    GET {ACCORD}/RawData/GetTxtFile?filename=…&date=<IST DDMMYYYY>&section=…
            timeout 60s, only HTTP 200 accepted
            → error message like "Accord Currentnav: HTTP 500" / "timeout after 60000ms"
2. validate response must contain a Table array, else throw
3. empty?   Table.length === 0 → return {fetched: 0, processed: 0}   (→ warning)
4. stage    insertMany(rows + {runId, stagedAt}) into the dump collection
5. merge    aggregate on dump:
              $match   {runId}                          ← only THIS run's rows
              $project {...project, crondate: $$NOW, cronRunId: runId}
              $merge   into target on mergeOn, replace / insert
6. count    processed = target.countDocuments({cronRunId: runId})
7. cleanup  dump.deleteMany({runId})     ← in `finally`, so it also runs on failure
8. return   {fetched: rows.length, processed}
```

A fix like "throw instead of swallowing errors" or "add a timeout" is now made in **one** place instead of 30.

### 6.3 Why rows are staged by `runId`

The main app uses one shared dump collection and wipes it with `deleteMany({})`, sometimes before the merge and sometimes after. If a run crashes after `insertMany`, its rows stay in the dump, and the **next** run merges them too.

Tagging each staged row with `runId` means:
- the merge reads only `{runId: mine}`, so other runs' leftovers can never get in;
- cleanup deletes only `{runId: mine}`, so it never removes another run's rows;
- a hard crash's leftovers are removed by the TTL index within a day.

### 6.4 How `recordsProcessed` is counted

`$merge` doesn't report how many documents it wrote. The obvious workaround, counting target documents with `crondate >= run start`, breaks when the app server's clock and the Mongo server's clock differ, because `$$NOW` is Mongo's time. Instead, every merged row gets `cronRunId: runId`, and we count exactly those. That number is precise and independent of clocks.

Comparing it with `recordsFetched` catches lost rows: Accord sent 500, only 470 merged, so 30 rows failed a transform.

### 6.5 Why the Accord date is computed in IST

The main app builds the file date as `DDMMYYYY` from `new Date()` in the **server's** timezone. If the server runs on UTC, the 04:01 IST run happens at 22:31 UTC on the **previous day**, and asks Accord for yesterday's file. `accordDate()` always formats the date in Asia/Kolkata.

### 6.6 Custom jobs

Jobs that don't fit the pattern are ordinary functions with the same contract. The lab's example is `navSanityCheck`, which throws if any NAV is zero or negative. In the main app, `updateSchemeStatus`, `updateSchemename` and `accordhistory_nav` would be written this way.

---

## 7. Health rules and the dashboard

### 7.1 Job status (`src/health/status.js`)

The rules are **pure functions**: a job document and the current time go in, a status comes out. There's no database access, which is why they're easy to unit-test (15 tests).

Three checks run in order, and the **worst** result wins (`failing` > `delayed` > `healthy`):

**Check 1: is something running right now?** (looks at `lock`)

| Condition | Result |
|---|---|
| Lock set and lease expired | **failing**: "stopped responding (process died)" |
| Lock set, running longer than `maxDurationMin` | **delayed**: "running for 28 min (expected under 10 min)" |
| Lock set, within limits | adds `running` info only |

**Check 2: what did the last run do?** (looks at `lastRun`)

| Last run | Result |
|---|---|
| `failed` / `interrupted` | **failing**: "last run failed (3 times in a row): Accord Currentnav: HTTP 500" |
| `warning` | **delayed**: "last run got 0 rows from Accord" |
| `success` | nothing |

**Check 3: was a slot missed?**

```
dueSlot   = latest schedule slot at or before (now − graceMin)
            i.e. the newest slot whose grace period has fully passed
lastStart = latest of lastRun.startedAt and lock.acquiredAt

missed if: dueSlot ≥ job.createdAt                 (don't blame slots from before tracking)
       and lastStart < dueSlot − 2 min             (2 min tolerance for clock skew)
```

Worked example. Current NAV has slots at 07:31 and 10:01, with grace 15 min:

| Now | dueSlot | Last run started | Result |
|---|---|---|---|
| 10:10 | 07:31 (10:01 is still within grace) | 07:31 | healthy |
| 10:30 | 10:01 | 07:31 | **delayed: missed run due 10:01 (worker did not run it)** |
| 10:30 | 10:01 | 10:00 (1 min early) | healthy (inside the tolerance) |
| 10:30 | 10:01 | 10:25 (still running) | healthy (the run is in progress) |

For `external` jobs the message says "crontab did not call it" instead. That points support at the server crontab, not at the app.

**Disabled jobs** aren't evaluated; they show `disabled`.

### 7.2 Overall summary

```
failing  if any CRITICAL job is failing
delayed  else if any job is failing or delayed
         or the worker is offline while internal jobs exist
healthy  otherwise
```

A failing *normal* job makes the overall status only *delayed*: it needs attention, but it isn't an emergency like current NAV.

### 7.3 The API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/accord-cron/:jobKey` | `x-cron-secret` header | **What the crontab calls.** Returns 202 immediately and runs the job in the background, so long jobs can't hit nginx timeouts. `?wait=1` waits for the result instead |
| `GET /api/health/crons` | Bearer admin token | Summary, scheduler status and every job's health. What the dashboard polls |
| `GET /api/health/crons/:jobKey/runs?limit=20` | Bearer admin token | Run history (max 100) |
| `POST /api/health/crons/:jobKey/run` | Bearer admin token | Manual "Run now" (allowed even for disabled jobs) |
| `GET /dashboard` | none (the page asks for the token) | The HTML page |

`GET /api/health/crons` returns:

```json
{
  "checkedAt": "2026-11-13T13:11:16Z",
  "overall": "delayed",
  "counts": { "healthy": 3, "delayed": 1, "failing": 0, "disabled": 0 },
  "reasons": ["1 job(s) need attention"],
  "scheduler": { "online": true, "workers": [{ "_id": "host:24988", "alive": true }] },
  "jobs": [
    {
      "jobKey": "current_nav", "name": "Current NAV", "criticality": "critical",
      "scheduler": "internal", "scheduleText": ["04:01 daily", "07:31 daily", "…"],
      "status": "healthy", "reasons": [],
      "lastRun": { "status": "success", "startedAt": "…", "durationMs": 1007,
                   "recordsFetched": 249, "recordsProcessed": 249 },
      "nextRunAt": "…", "running": null, "consecutiveFailures": 0
    }
  ]
}
```

If the health check itself fails, it still answers, with `overall: failing` and the error. A broken health endpoint must never look like "no data".

### 7.4 The dashboard page (`public/dashboard.html`)

- **Summary tiles:** Overall, Healthy, Delayed, Failing, Disabled, Scheduler (online or offline, with the worker ID).
- **Reasons bar:** why the overall status is what it is.
- **Job table:** every field the ticket asks for, which is name, schedule, last run time and status, duration, records (fetched and processed), next run and health status. Each row also shows its reasons and has **History** and **Run now** buttons.
- **History panel:** the last 20 runs with trigger, attempt, slot, status, duration, counts and error.
- Polls every **15 seconds**. Error text is rendered with `textContent`, so a malicious message from Accord can't inject HTML.
- No build step and no libraries. In the main app this becomes a page in the WMS frontend that calls the same API.

---

## 8. Failure scenarios, one by one

| # | What happens | What the system does | Dashboard shows |
|---|---|---|---|
| 1 | Accord returns HTTP 500 | Job throws → `failed`. The worker schedules a retry after `delayMin` | **failing** "last run failed: Accord Currentnav: HTTP 500". Overall failing if critical |
| 2 | Accord file not published yet (empty Table) | `warning`, retried like a failure | **delayed** "last run got 0 rows from Accord" |
| 3 | Accord is slow (more than 60s) | Axios timeout → throws → `failed` | **failing** "Accord Currentnav: timeout after 60000ms" |
| 4 | Retry succeeds | Run with `trigger: retry`, `attempt: 2`, same slot. Counter resets | **healthy** again. History shows both attempts |
| 5 | Worker process crashes mid-run | Heartbeat stops → lease expires → the next run marks it `interrupted` | Scheduler **offline** after 90s. The job is **failing** "process died" after the lease expires |
| 6 | Worker down for hours | Nothing runs internal jobs | Scheduler **offline**, then each internal job turns **delayed: missed** as its slots pass |
| 7 | Crontab line deleted or the server is down (external job) | No call arrives | **delayed** "missed run due 23:39 (crontab did not call it)" |
| 8 | Two triggers at once (crontab + Run now) | Lock: the first runs, the second is `skipped` | History shows the skip and why |
| 9 | Leftover crontab line after moving a job to the worker | Migration guard → `skipped` | History shows "remove its crontab line" |
| 10 | Job runs much longer than usual | Heartbeat keeps the lock (no duplicate run) | **delayed** "running for 28 min (expected under 10)" |
| 11 | Merge partially fails (bad dates) | `processed < fetched`, or throws | The difference is visible in the Fetched and Processed columns |
| 12 | Mongo briefly down at finish | Finish write logged, not thrown. The lease expires on its own | The next run marks the stale one `interrupted` |
| 13 | `pm2 restart` during a run | Graceful shutdown waits up to 25s for the run | Normally nothing; if it takes longer, scenario 5 |

---

## 9. The two bugs the end-to-end test caught

Both passed every individual check but showed up when the whole system ran together. Both would also have happened in the main app.

### Bug 1: every sync reported every job as "updated"

**Symptom:** running `npm run sync` twice without changing anything reported `updated: 3` the second time.

**Cause:** the `CronJob` schema has `timestamps: true`. Mongoose then adds `updatedAt: now` to **every** update. Because `updatedAt` always changes, Mongo always reports the document as modified.

**Why it matters:** the sync count is supposed to tell you whether a deploy changed any schedule. With this bug, it always said yes. The same effect would make heartbeat writes (every 30s) churn `updatedAt` for no reason.

**Fix:** pass `{ timestamps: false }` on sync, lock, heartbeat and finish writes.

### Bug 2: jobs blamed for runs missed before tracking existed

**Symptom:** after a fresh start at about 18:30, "NAV Sanity Check" showed **delayed: missed run due 14:45**, even though the job had only existed for a few minutes.

**Cause:** this one came *from the fix for bug 1*. With timestamps off, Mongoose no longer set `createdAt` on the upserted document either. The missed-slot rule compares against `createdAt` to ignore slots from before tracking started. With no `createdAt`, the comparison used 0 (1970), so every past slot counted.

**Why it matters:** on the first deploy to UAT or production, every job would turn yellow right away, and people would learn to ignore the dashboard.

**Fix:** set it explicitly in the sync with `$setOnInsert: { createdAt: new Date() }`.

**Lesson:** a change made to fix one thing (switching timestamps off) silently removed something another part relied on (`createdAt`). Only the end-to-end run, with real time passing and real schedules, exposed it. This is why the e2e script exists.

---

## 10. Running, testing and breaking the lab

### 10.1 Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run sync` | Push `registry.js` into `cron_jobs` and print the counts |
| `npm test` | 15 unit tests for the health rules (no database) |
| `npm run demo:tracker` | Tracker scenarios: success, failed, warning, overlap, crash, disabled |
| `npm run e2e` | Full system with real processes, about 4 minutes, 27 checks |
| `npm run mock` / `api` / `worker` | Start one process in the foreground |
| `pm2 start ecosystem.config.js` | Start all three under PM2 |
| `pm2 logs` | Watch the logs |
| `pm2 delete ecosystem.config.js` | Stop and remove them |

### 10.2 Open the dashboard

http://127.0.0.1:4000/dashboard, using the token `lab-admin-token` from `.env`.

### 10.3 Break things on purpose

| Do this | Then watch |
|---|---|
| Open `http://127.0.0.1:4001/__chaos/set?file=Amc_mst&mode=fail` | Within 2 min AMC Master **fails**, a minute later it retries. Set `mode=normal` and the retry succeeds |
| Open `…/__chaos/set?file=Currentnav&mode=empty`, then **Run now** on Current NAV | **warning**, the job is delayed and the overall status is delayed |
| Open `…/__chaos/set?file=Currentnav&mode=fail`, then **Run now** | **failing**, and the overall status is failing because current NAV is critical |
| Open `…/__chaos/set?file=all&mode=slow`, then Run now | Long durations |
| `pm2 stop lab-worker` | Scheduler offline in about 90s, then AMC Master turns **missed** |
| Do nothing for a few minutes | Scheme Classification (external, nobody curls it) turns **missed: crontab did not call it** |
| `curl -H "x-cron-secret: lab-cron-secret" http://127.0.0.1:4000/api/accord-cron/sclass_mst` | Acts as the crontab, and Scheme Classification goes back to healthy |
| The same curl for `amc_master` | **skipped** by the migration guard (see its History) |

Chaos modes: `fail`, `empty`, `slow`, `normal` (always succeeds) and `random` (default; uses the `MOCK_*_RATE` values in `.env`).

### 10.4 Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/accord_cron_lab` | Lab database |
| `API_PORT` | 4000 | API and dashboard port |
| `ADMIN_TOKEN` | `lab-admin-token` | Dashboard and API token (the main app uses WMS auth instead) |
| `CRON_TRIGGER_SECRET` | `lab-cron-secret` | Header the crontab must send |
| `TRACKER_LEASE_MS` / `TRACKER_HEARTBEAT_MS` | 120000 / 30000 | Lock lease and renewal interval |
| `ACCORD_TIMEOUT_MS` | 60000 | Accord request timeout |
| `WORKER_PRESENCE_MS` / `WORKER_SHUTDOWN_GRACE_MS` | 30000 / 25000 | Presence heartbeat and shutdown wait |
| `MOCK_FAIL_RATE` / `MOCK_EMPTY_RATE` / `MOCK_MAX_DELAY_MS` | 0.15 / 0.10 / 3000 | Random behaviour of the fake feed |

---

## 11. Porting to ProdigybackendNew

### 11.1 File mapping

| Lab | Main app |
|---|---|
| `models/CronJob.js`, `CronRun.js`, `CronWorker.js` | New files in `models/`, same schemas |
| `jobs/registry.js` | New `config/accordCronRegistry.js`. Copy the schedules from the **real** server crontab (ask DevOps), not from the docs |
| `jobs/defineAccordJob.js` | New `services/accordJobFactory.js` |
| `jobs/accordJobs.js` | Replaces the ~30 copied `accordX` + `updateX` pairs in `controller/accord_cron-controller.js`. Keep the existing `$project` pipelines; move them into factory config |
| Custom jobs | `updateSchemeStatus`, `updateSchemename`, `accordhistory_nav`… rewritten to return `{fetched, processed}` or throw |
| `tracker/*` | New `services/cronTracker/` |
| `health/*` | New `services/cronHealth/` plus a controller. Include `getAccordFeedHealth()` (PPR-567) in the response, so the dashboard shows both "did the job run?" and "is the data fresh?" |
| `api/routes.js` | `routes/accord_cron-routes.js`: keep the old URLs, but point each at `runJob(jobKey, {trigger: 'external'})`. Put the health routes behind the **existing WMS admin auth middleware** |
| `public/dashboard.html` | A page in the WMS frontend using the same API |
| `worker/worker.js` + `ecosystem.config.js` | New `workers/accordCronWorker.js` and a PM2 app entry (fork mode, 1 instance, `kill_timeout: 30000`) |
| `crons/accordFeedHealthCron.js` | Extend it to email when a critical job is failing or missed |

### 11.2 Rollout order

1. **Tracking only.** Add the models, tracker and health API. Point the existing routes at `runJob`, with every job set to `scheduler: 'external'`. The crontab keeps working, and the dashboard fills with real runs. **This alone meets the acceptance criterion on UAT**, if UAT's crontab runs the jobs (confirm with DevOps).
2. **Factory.** Move the jobs onto the factory one at a time, critical ones first (current NAV, scheme master, ISIN master, MF return).
3. **Worker.** Deploy it. Switch jobs to `internal` one at a time, removing each crontab line in the same release. The migration guard catches any leftover line.
4. **Lock down.** When nothing external is left, require the secret on, or remove, the public trigger URLs.

### 11.3 Gotchas checklist

- [ ] `timestamps: false` on sync and tracker writes, plus an explicit `createdAt` (section 9)
- [ ] Unique index on every `$merge` key in production (`current_nav.schemecode`, …), checked **before** switching
- [ ] `updateX()` functions throw instead of swallowing errors
- [ ] The Accord file date is computed in IST
- [ ] Staging rows tagged with `runId`; no more `deleteMany({})` on shared dump collections
- [ ] PM2 on Windows needs `shutdown_with_message: true` (Linux uses signals as usual)
- [ ] The `x-cron-secret` header is added to the crontab lines in the same release

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **Registry** | `registry.js`, the code list of jobs. Its copy in Mongo is `cron_jobs` |
| **Sync** | Copying registry definitions into `cron_jobs` |
| **Run** | One execution of a job (one `cron_runs` document) |
| **Slot** | One scheduled fire time (for example, today 07:31) |
| **`scheduledFor`** | The slot a run belongs to |
| **Grace** | How long after a slot a run may start before it counts as missed |
| **Lock / lease** | Ownership of a job while it runs; it expires unless renewed |
| **Heartbeat** | Renewing the lease every 30s while a job runs |
| **Presence** | The worker's "I'm alive" record in `cron_workers` |
| **Internal / external** | Triggered by the worker / by the server crontab |
| **Migration guard** | Skips crontab calls for jobs the worker now owns |
| **Staging (dump)** | Temporary collection of raw Accord rows for one run |
| **Factory** | `defineAccordJob`, which generates a standard Accord job from config |
| **Missed** | A slot passed its grace period with no run |
| **Stuck** | A run going longer than `maxDurationMin` |
| **Interrupted** | A run whose process died; detected when its lease expired |
