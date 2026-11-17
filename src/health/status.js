// Health rules. Plain functions: (job document, now) -> status. No database, easy to test.
//
// A job is:
//   failing  - its last run failed or was interrupted, or the process running it died
//   delayed  - the crontab missed a call, a run is stuck, or Accord returned 0 rows
//   healthy  - none of the above
//   disabled - not checked
//
// Overall: failing if a CRITICAL job is failing, delayed if any job needs attention, else healthy.
const { prevSlot, nextSlot } = require('../tracker/schedule');

const SEVERITY = { healthy: 0, delayed: 1, failing: 2 };

// A call up to 2 minutes BEFORE its schedule time still counts (server clocks are never exact).
const EARLY_OK_MS = 2 * 60 * 1000;

const toMs = (date) => (date ? new Date(date).getTime() : 0);
const showTime = (date, tz) => new Date(date).toLocaleString('en-IN', {
  timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

// "31 7 * * *" -> "07:31 daily". Anything else is shown as-is.
function scheduleText(expr) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr.trim());
  return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')} daily` : expr;
}

function computeJobHealth(job, now = new Date()) {
  const tz = job.timezone || 'Asia/Kolkata';
  const health = {
    jobKey: job.jobKey,
    name: job.name,
    description: job.description,
    criticality: job.criticality,
    schedules: job.schedules,
    scheduleText: job.schedules.map(scheduleText),
    enabled: job.enabled,
    lastRun: job.lastRun || null,
    lastSuccessAt: job.lastSuccessAt || null,
    consecutiveFailures: job.consecutiveFailures || 0,
    nextRunAt: job.enabled ? nextSlot(job.schedules, tz, now) : null,
    running: null,
    status: 'healthy',
    reasons: [],
  };

  if (!job.enabled) return { ...health, status: 'disabled', reasons: ['disabled'] };

  // Record a problem. The worst problem decides the status.
  const problem = (status, reason) => {
    if (SEVERITY[status] > SEVERITY[health.status]) health.status = status;
    health.reasons.push(reason);
  };

  // 1. Is it running right now?
  const lock = job.lock;
  if (lock && lock.runId) {
    if (toMs(lock.expiresAt) <= now.getTime()) {
      problem('failing', `run started ${showTime(lock.acquiredAt, tz)} on ${lock.owner} stopped responding (process died)`);
    } else {
      health.running = { runId: lock.runId, owner: lock.owner, since: lock.acquiredAt };
      const minutes = (now.getTime() - toMs(lock.acquiredAt)) / 60000;
      if (minutes > job.maxDurationMin) {
        problem('delayed', `running for ${Math.round(minutes)} min (expected under ${job.maxDurationMin} min)`);
      }
    }
  }

  // 2. How did the last run end?
  const last = job.lastRun;
  if (last && (last.status === 'failed' || last.status === 'interrupted')) {
    const times = health.consecutiveFailures > 1 ? ` (${health.consecutiveFailures} times in a row)` : '';
    problem('failing', `last run ${last.status}${times}: ${last.errorMessage || 'no message'}`);
  }
  if (last && last.status === 'warning') {
    problem('delayed', `last run got 0 rows from Accord${last.errorMessage ? ` - ${last.errorMessage}` : ''}`);
  }

  // 3. Did the crontab miss a call?
  //    Take the latest schedule time whose grace period is over, and check a run started for it.
  const dueAt = prevSlot(job.schedules, tz, new Date(now.getTime() - (job.graceMin || 0) * 60000));
  const lastStartAt = Math.max(toMs(last && last.startedAt), toMs(lock && lock.acquiredAt));
  const trackedSince = toMs(job.createdAt); // do not blame times from before the job existed
  if (dueAt.getTime() >= trackedSince && lastStartAt < dueAt.getTime() - EARLY_OK_MS) {
    problem('delayed', `missed run due ${showTime(dueAt, tz)} (crontab did not call it)`);
  }

  if (!last && !health.running && health.reasons.length === 0) health.reasons.push('waiting for first run');
  return health;
}

function summarize(jobHealths) {
  const active = jobHealths.filter((j) => j.status !== 'disabled');
  const counts = { healthy: 0, delayed: 0, failing: 0, disabled: jobHealths.length - active.length };
  for (const j of active) counts[j.status] += 1;

  if (active.some((j) => j.status === 'failing' && j.criticality === 'critical')) {
    return { overall: 'failing', counts, reasons: ['a critical job is failing'] };
  }
  if (counts.failing + counts.delayed > 0) {
    return { overall: 'delayed', counts, reasons: [`${counts.failing + counts.delayed} job(s) need attention`] };
  }
  return { overall: 'healthy', counts, reasons: [] };
}

module.exports = { computeJobHealth, summarize, scheduleText };
