// The scheduler process (run ONE instance, separate from the API).
//
//   start: connect -> sync registry -> schedule every enabled `internal` job -> announce presence
//   tick : node-cron fires -> runJob(trigger 'schedule') -> on failed/warning schedule a retry
//   stop : SIGINT/SIGTERM/PM2 'shutdown' -> stop crons -> cancel retries -> wait for running jobs -> exit
//
// Why a separate process (option C): heavy jobs do not slow the API, and an API deploy
// does not kill a NAV load halfway.
const os = require('os');
const cron = require('node-cron');
const { connectDB, mongoose } = require('../db');
const CronJob = require('../models/CronJob');
const CronWorker = require('../models/CronWorker');
const { syncRegistry } = require('../jobs/syncRegistry');
const { runJob } = require('../jobs/runJob');
const { prevSlot } = require('../tracker/schedule');
const tracker = require('../tracker/CronTracker');
const { WORKER } = require('../config');

const log = (...a) => console.log('[worker]', ...a);
const tasks = [];
const retryTimers = new Set();
let presenceTimer = null;
let stopping = false;

async function fire(job, scheduledFor, attempt) {
  if (stopping) return;
  let result;
  try {
    result = await runJob(job.jobKey, { trigger: attempt === 1 ? 'schedule' : 'retry', scheduledFor, attempt });
  } catch (e) {
    // only tracker infrastructure errors land here (e.g. Mongo down); the job's own errors are already recorded
    log(`${job.jobKey}: could not run: ${e.message}`);
    return;
  }

  const retry = job.retry || {};
  const retryable = result.status === 'failed' || result.status === 'warning';
  if (retryable && attempt <= (retry.attempts || 0) && !stopping) {
    const delayMs = (retry.delayMin || 10) * 60 * 1000;
    log(`${job.jobKey}: ${result.status}, retry ${attempt}/${retry.attempts} in ${retry.delayMin} min`);
    const t = setTimeout(() => {
      retryTimers.delete(t);
      fire(job, scheduledFor, attempt + 1); // same slot: the retry belongs to the run it repeats
    }, delayMs);
    retryTimers.add(t);
  }
}

async function heartbeatPresence(jobKeys, startedAt) {
  await CronWorker.updateOne(
    { _id: tracker.OWNER },
    { $set: { host: os.hostname(), pid: process.pid, startedAt, lastSeenAt: new Date(), jobs: jobKeys } },
    { upsert: true }
  );
}

async function start() {
  await connectDB('worker');
  log('registry sync:', await syncRegistry());

  const jobs = await CronJob.find({ inRegistry: true, enabled: true, scheduler: 'internal' }).lean();
  for (const job of jobs) {
    job.schedules.forEach((expr, i) => {
      tasks.push(
        cron.schedule(
          expr,
          (ctx) => fire(job, prevSlot([expr], job.timezone, (ctx && ctx.date) || new Date()), 1),
          { timezone: job.timezone, name: `${job.jobKey}#${i}` }
        )
      );
    });
    log(`scheduled ${job.jobKey}: ${job.schedules.join(' | ')} (${job.timezone})`);
  }

  const startedAt = new Date();
  const keys = jobs.map((j) => j.jobKey);
  await heartbeatPresence(keys, startedAt);
  presenceTimer = setInterval(() => heartbeatPresence(keys, startedAt).catch((e) => log('presence failed:', e.message)), WORKER.PRESENCE_MS);
  log(`ready as ${tracker.OWNER}`);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received - stopping crons, waiting up to ${WORKER.SHUTDOWN_GRACE_MS}ms for running jobs`);
  for (const t of tasks) await t.stop();
  for (const t of retryTimers) clearTimeout(t);
  clearInterval(presenceTimer);

  const left = await tracker.waitForInFlight(WORKER.SHUTDOWN_GRACE_MS);
  if (left) log(`${left} job(s) still running - their lease will expire and the next run marks them interrupted`);

  await CronWorker.deleteOne({ _id: tracker.OWNER }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
  log('stopped');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// PM2 on Windows cannot send signals; with shutdown_with_message it sends this message instead.
process.on('message', (msg) => { if (msg === 'shutdown') shutdown('shutdown message'); });

start().catch((e) => {
  console.error('[worker] failed to start:', e);
  process.exit(1);
});
