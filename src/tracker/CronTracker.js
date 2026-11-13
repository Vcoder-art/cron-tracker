// CronTracker: every job execution goes through run().
//
//   1. check enabled (T4)            -> skipped
//   2. take the lock (T1)            -> skipped if someone else holds it
//      (if the old holder's lease expired, its run is marked interrupted)
//   3. insert run {running}
//   4. heartbeat keeps the lease alive while jobFn works
//   5. jobFn() -> {fetched, processed} or throw   -> success / warning / failed
//   6. finish run, update job snapshot + release lock in ONE atomic update
//
// Job contract: async (ctx) => ({ fetched, processed }). Throw on any failure.
const os = require('os');
const { mongoose } = require('../db');
const CronJob = require('../models/CronJob');
const CronRun = require('../models/CronRun');
const { prevSlot } = require('./schedule');
const { TRACKER } = require('../config');

const OWNER = `${os.hostname()}:${process.pid}`;
const MAX_STACK = 2000;

const log = (jobKey, ...args) => console.log(`[tracker:${jobKey}]`, ...args);
const errInfo = (e) => ({
  message: String(e && e.message ? e.message : e).slice(0, 500),
  stack: String((e && e.stack) || '').slice(0, MAX_STACK),
});

async function recordSkipped(job, base, reason) {
  const run = await CronRun.create({ ...base, status: 'skipped', reason, finishedAt: base.startedAt, durationMs: 0 });
  log(job.jobKey, `skipped: ${reason}`);
  // T3: skipped runs are history only - lastRun keeps showing the real last result.
  return { runId: run._id, status: 'skipped', reason };
}

// A previous holder stopped heartbeating (crash / kill / restart). Close its run honestly.
async function markInterrupted(jobKey, oldLock, now) {
  const reason = `lease expired at ${oldLock.expiresAt.toISOString()} - owner ${oldLock.owner} stopped heartbeating`;
  const res = await CronRun.findOneAndUpdate(
    { _id: oldLock.runId, status: 'running' },
    { $set: { status: 'interrupted', reason, finishedAt: now } },
    { new: true }
  ).lean();
  if (!res) return;
  await CronJob.updateOne(
    { jobKey },
    {
      $set: {
        lastRun: {
          runId: res._id, status: 'interrupted', trigger: res.trigger, startedAt: res.startedAt,
          finishedAt: now, durationMs: null, recordsFetched: 0, recordsProcessed: 0, errorMessage: reason,
        },
      },
      $inc: { consecutiveFailures: 1 },
    }
  );
  log(jobKey, `previous run ${res._id} marked interrupted`);
}

// Runs currently executing in THIS process - lets the worker/API wait for them on shutdown.
const inFlight = new Set();

function run(jobKey, jobFn, opts) {
  const p = execute(jobKey, jobFn, opts);
  inFlight.add(p);
  p.finally(() => inFlight.delete(p)).catch(() => {});
  return p;
}

// Resolves when every in-flight run finished, or after timeoutMs (returns how many were still running).
async function waitForInFlight(timeoutMs) {
  if (inFlight.size === 0) return 0;
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(r, timeoutMs); });
  await Promise.race([Promise.allSettled([...inFlight]), timeout]);
  clearTimeout(timer);
  return inFlight.size;
}

async function execute(jobKey, jobFn, { trigger = 'manual', scheduledFor = null, attempt = 1 } = {}) {
  const job = await CronJob.findOne({ jobKey }).lean();
  if (!job) throw new Error(`Unknown job "${jobKey}" - is it in registry.js and synced?`);

  const now = new Date();
  const runId = new mongoose.Types.ObjectId();
  if (!scheduledFor && trigger !== 'manual') scheduledFor = prevSlot(job.schedules, job.timezone, now);
  const base = { _id: runId, jobKey, trigger, attempt, scheduledFor, startedAt: now, host: os.hostname(), pid: process.pid };

  // ---- T4: automatic triggers respect enabled; manual always allowed ----
  if (!job.enabled && trigger !== 'manual') return recordSkipped(job, base, 'job is disabled');

  // ---- migration guard: once a job moved to the worker, a leftover crontab line must not run it twice ----
  if (trigger === 'external' && job.scheduler === 'internal') {
    return recordSkipped(job, base, 'job is scheduled by the worker - external trigger ignored (remove its crontab line)');
  }

  // ---- T1: atomic lock. Matches only if free or lease expired. ----
  // T5: if Mongo is down this throws - correct, the job could not write its data anyway.
  const before = await CronJob.findOneAndUpdate(
    { jobKey, $or: [{ lock: null }, { 'lock.expiresAt': { $lte: now } }] },
    { $set: { lock: { runId, owner: OWNER, acquiredAt: now, expiresAt: new Date(now.getTime() + TRACKER.LEASE_MS) } } },
    { new: false, timestamps: false } // new:false -> we see the OLD lock, to detect a takeover
  ).lean();

  if (!before) {
    const holder = (await CronJob.findOne({ jobKey }, { lock: 1 }).lean())?.lock;
    return recordSkipped(job, base, `already running (run ${holder?.runId} on ${holder?.owner})`);
  }
  if (before.lock && before.lock.runId) await markInterrupted(jobKey, before.lock, now);

  await CronRun.create({ ...base, status: 'running' });
  log(jobKey, `started run ${runId} (${trigger})`);

  // ---- heartbeat: keep the lease alive while the job works ----
  const heartbeat = setInterval(async () => {
    try {
      const r = await CronJob.updateOne(
        { jobKey, 'lock.runId': runId },
        { $set: { 'lock.expiresAt': new Date(Date.now() + TRACKER.LEASE_MS) } },
        { timestamps: false }
      );
      if (r.matchedCount === 0) log(jobKey, `WARNING: lost lock for run ${runId}`);
    } catch (e) {
      log(jobKey, 'heartbeat failed:', e.message);
    }
  }, TRACKER.HEARTBEAT_MS);
  heartbeat.unref(); // never keeps the process alive on its own

  // ---- run the job ----
  let status, error = null, fetched = 0, processed = 0;
  try {
    const result = await jobFn({ runId, jobKey, scheduledFor, startedAt: now, attempt, log: (...a) => log(jobKey, ...a) });
    fetched = Number(result?.fetched) || 0;
    processed = Number(result?.processed) || 0;
    status = fetched === 0 ? 'warning' : 'success';
  } catch (e) {
    status = 'failed';
    error = errInfo(e);
  } finally {
    clearInterval(heartbeat);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - now;
  const reason = status === 'warning' ? 'Accord returned 0 rows (file not ready?)' : undefined;
  const lastRun = {
    runId, status, trigger, attempt, startedAt: now, finishedAt, durationMs,
    recordsFetched: fetched, recordsProcessed: processed, errorMessage: error?.message || reason || null,
  };

  // ---- finish (T5: a failed write here is logged, never thrown) ----
  try {
    await CronRun.updateOne(
      { _id: runId },
      { $set: { status, finishedAt, durationMs, recordsFetched: fetched, recordsProcessed: processed, ...(error && { error }), ...(reason && { reason }) } }
    );
    // One atomic pipeline update: snapshot + counters + release lock only if it is still ours.
    await CronJob.updateOne(
      { jobKey },
      [
        {
          $set: {
            lastRun: { $literal: lastRun }, // $literal: error text may contain "$"
            lastSuccessAt: status === 'success' ? finishedAt : '$lastSuccessAt',
            consecutiveFailures:
              status === 'success' ? 0
              : status === 'failed' ? { $add: [{ $ifNull: ['$consecutiveFailures', 0] }, 1] }
              : '$consecutiveFailures', // warning: unchanged
            lock: { $cond: [{ $eq: ['$lock.runId', runId] }, null, '$lock'] },
          },
        },
      ],
      { timestamps: false }
    );
  } catch (e) {
    log(jobKey, `could not record finish of run ${runId}: ${e.message} (lease will expire on its own)`);
  }

  log(jobKey, `${status} in ${durationMs}ms fetched=${fetched} processed=${processed}${error ? ' error=' + error.message : ''}`);
  return { runId, status, durationMs, recordsFetched: fetched, recordsProcessed: processed, error: error?.message };
}

module.exports = { run, waitForInFlight, OWNER };
