// Runs one job and records what happened.
//
// The server crontab calls GET /api/accord-cron/:jobKey, which calls run(). Nothing else starts a job.
//
// What run() does, in order:
//   1. Job disabled?                  -> save a "skipped" run, stop.
//   2. Take the job's lock.           -> if another process holds it, save a "skipped" run, stop.
//   3. Save a "running" run.
//   4. Call the job function. While it works, keep extending the lock so nobody else takes it.
//   5. Save the result (success / warning / failed) and release the lock.
//
// A job function looks like:  async (ctx) => ({ fetched, processed })   - it throws on failure.
const os = require('os');
const { mongoose } = require('../db');
const CronJob = require('../models/CronJob');
const CronRun = require('../models/CronRun');
const { prevSlot } = require('./schedule');
const { TRACKER } = require('../config');

// Who we are, written into the lock: "host:pid".
const OWNER = `${os.hostname()}:${process.pid}`;

const log = (jobKey, ...args) => console.log(`[${jobKey}]`, ...args);

// ---------------------------------------------------------------------------------------------
// Keep track of jobs running in this process, so the API can wait for them before it shuts down.
// ---------------------------------------------------------------------------------------------
const runningNow = new Set();

// trigger: 'cron' (server crontab) or 'manual' (Run now button on the dashboard). Stored on the run.
function run(jobKey, jobFn, { trigger = 'cron' } = {}) {
  const promise = runTracked(jobKey, jobFn, trigger);
  runningNow.add(promise);
  promise.finally(() => runningNow.delete(promise)).catch(() => {});
  return promise;
}

// Wait until every running job is done, but at most `timeoutMs`. Returns how many are still running.
async function waitForRunningJobs(timeoutMs) {
  if (runningNow.size === 0) return 0;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([Promise.allSettled([...runningNow]), timeout]);
  clearTimeout(timer);
  return runningNow.size;
}

// ---------------------------------------------------------------------------------------------
// The main flow
// ---------------------------------------------------------------------------------------------
async function runTracked(jobKey, jobFn, trigger) {
  const job = await CronJob.findOne({ jobKey }).lean();
  if (!job) throw new Error(`Unknown job "${jobKey}" - is it in registry.js?`);

  const startedAt = new Date();
  const runId = new mongoose.Types.ObjectId();
  const runDoc = {
    _id: runId,
    jobKey,
    scheduledFor: prevSlot(job.schedules, job.timezone, startedAt), // the crontab time this call belongs to
    trigger,
    startedAt,
    host: os.hostname(),
    pid: process.pid,
  };

  // 1. Disabled?
  if (!job.enabled) return saveSkipped(runDoc, 'job is disabled');

  // 2. Lock
  const gotLock = await takeLock(jobKey, runId, startedAt);
  if (!gotLock) {
    const holder = (await CronJob.findOne({ jobKey }, { lock: 1 }).lean())?.lock;
    return saveSkipped(runDoc, `already running (run ${holder?.runId} on ${holder?.owner})`);
  }

  // 3. Running
  await CronRun.create({ ...runDoc, status: 'running' });
  log(jobKey, `started run ${runId}${trigger === 'manual' ? ' (manual)' : ''}`);

  // 4. Do the work
  const stopHeartbeat = startHeartbeat(jobKey, runId);
  let result;
  try {
    const out = await jobFn({ runId, jobKey, scheduledFor: runDoc.scheduledFor, startedAt, log: (...a) => log(jobKey, ...a) });
    const fetched = Number(out?.fetched) || 0;
    const processed = Number(out?.processed) || 0;
    result = fetched === 0
      ? { status: 'warning', fetched, processed, reason: 'Accord returned 0 rows (file not ready?)' }
      : { status: 'success', fetched, processed };
  } catch (e) {
    result = { status: 'failed', fetched: 0, processed: 0, error: errorInfo(e) };
  } finally {
    stopHeartbeat();
  }

  // 5. Save the result
  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;
  await saveResult(jobKey, runId, startedAt, finishedAt, durationMs, result);

  log(jobKey, `${result.status} in ${durationMs}ms, fetched=${result.fetched}, processed=${result.processed}`
    + (result.error ? `, error=${result.error.message}` : ''));
  return {
    runId,
    status: result.status,
    durationMs,
    recordsFetched: result.fetched,
    recordsProcessed: result.processed,
    error: result.error?.message,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

// A skipped run is history only: the job's lastRun keeps showing the last real result.
async function saveSkipped(runDoc, reason) {
  await CronRun.create({ ...runDoc, status: 'skipped', reason, finishedAt: runDoc.startedAt, durationMs: 0 });
  log(runDoc.jobKey, `skipped: ${reason}`);
  return { runId: runDoc._id, status: 'skipped', reason };
}

// The lock is free when it is null OR when it has expired (its owner crashed and stopped extending it).
// Taking it is one atomic Mongo update, so two processes can never both get it.
// Returns false if someone else holds it.
async function takeLock(jobKey, runId, now) {
  const expiresAt = new Date(now.getTime() + TRACKER.LEASE_MS);
  const before = await CronJob.findOneAndUpdate(
    { jobKey, $or: [{ lock: null }, { 'lock.expiresAt': { $lte: now } }] },
    { $set: { lock: { runId, owner: OWNER, acquiredAt: now, expiresAt } } },
    { new: false, timestamps: false } // new:false returns the document BEFORE the update -> we see the old lock
  ).lean();

  if (!before) return false;

  // We took over an expired lock: the previous run died half way. Close it as "interrupted".
  if (before.lock && before.lock.runId) await markInterrupted(jobKey, before.lock, now);
  return true;
}

async function markInterrupted(jobKey, oldLock, now) {
  const reason = `process ${oldLock.owner} stopped responding (lock expired ${oldLock.expiresAt.toISOString()})`;
  const deadRun = await CronRun.findOneAndUpdate(
    { _id: oldLock.runId, status: 'running' },
    { $set: { status: 'interrupted', reason, finishedAt: now } },
    { new: true }
  ).lean();
  if (!deadRun) return;

  await CronJob.updateOne({ jobKey }, {
    $set: {
      lastRun: {
        runId: deadRun._id, status: 'interrupted', startedAt: deadRun.startedAt, finishedAt: now,
        durationMs: null, recordsFetched: 0, recordsProcessed: 0, errorMessage: reason,
      },
    },
    $inc: { consecutiveFailures: 1 },
  });
  log(jobKey, `previous run ${deadRun._id} marked interrupted`);
}

// Every HEARTBEAT_MS push the lock's expiry forward, so a long job keeps its lock.
// If this process dies, the heartbeat stops and the lock expires on its own.
function startHeartbeat(jobKey, runId) {
  const timer = setInterval(async () => {
    try {
      await CronJob.updateOne(
        { jobKey, 'lock.runId': runId },
        { $set: { 'lock.expiresAt': new Date(Date.now() + TRACKER.LEASE_MS) } },
        { timestamps: false }
      );
    } catch (e) {
      log(jobKey, 'heartbeat failed:', e.message);
    }
  }, TRACKER.HEARTBEAT_MS);
  timer.unref(); // the timer alone must not keep the process alive
  return () => clearInterval(timer);
}

// Update the run, then update the job (lastRun, counters, release lock).
// Never throws: if Mongo is down here, the lock simply expires on its own.
async function saveResult(jobKey, runId, startedAt, finishedAt, durationMs, { status, fetched, processed, reason, error }) {
  try {
    await CronRun.updateOne({ _id: runId }, {
      $set: { status, finishedAt, durationMs, recordsFetched: fetched, recordsProcessed: processed, reason, error },
    });

    const lastRun = {
      runId, status, startedAt, finishedAt, durationMs,
      recordsFetched: fetched, recordsProcessed: processed,
      errorMessage: error?.message || reason || null,
    };
    let jobUpdate;
    if (status === 'success') jobUpdate = { $set: { lastRun, lastSuccessAt: finishedAt, consecutiveFailures: 0 } };
    else if (status === 'failed') jobUpdate = { $set: { lastRun }, $inc: { consecutiveFailures: 1 } };
    else jobUpdate = { $set: { lastRun } }; // warning: failure counter unchanged
    await CronJob.updateOne({ jobKey }, jobUpdate, { timestamps: false });

    // Release the lock - but only if it is still ours.
    await CronJob.updateOne({ jobKey, 'lock.runId': runId }, { $set: { lock: null } }, { timestamps: false });
  } catch (e) {
    log(jobKey, `could not save result of run ${runId}: ${e.message}`);
  }
}

function errorInfo(e) {
  return {
    message: String(e?.message || e).slice(0, 500),
    stack: String(e?.stack || '').slice(0, 2000),
  };
}

module.exports = { run, waitForRunningJobs, OWNER };
