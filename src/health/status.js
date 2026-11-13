// Health rules. PURE functions: (job document, now) -> status. No DB access, easy to unit test.
//
// Job status (worst wins):
//   failing  - last run failed / interrupted, or the running process died (lease expired)
//   delayed  - a schedule slot passed its grace period with no run   (missed)
//              a run is going longer than maxDurationMin             (stuck)
//              last run returned 0 rows                              (warning)
//   healthy  - none of the above
//   disabled - not evaluated, excluded from the summary
//
// Overall: failing if any CRITICAL job is failing; delayed if any job is failing/delayed; else healthy.
const { prevSlot, nextSlot } = require('../tracker/schedule');

const RANK = { healthy: 0, delayed: 1, failing: 2 };
// A run that starts up to this much BEFORE its slot still counts for it (clock skew between servers).
const EARLY_TOLERANCE_MS = 2 * 60 * 1000;

const fmt = (d, tz) => new Date(d).toLocaleString('en-IN', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const ms = (d) => (d ? new Date(d).getTime() : 0);

// "31 7 * * *" -> "07:31 daily"; anything else stays a cron expression.
function scheduleText(expr) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr.trim());
  return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')} daily` : expr;
}

function computeJobHealth(job, now = new Date()) {
  const tz = job.timezone || 'Asia/Kolkata';
  const out = {
    jobKey: job.jobKey,
    name: job.name,
    description: job.description,
    criticality: job.criticality,
    scheduler: job.scheduler,
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
  if (!job.enabled) return { ...out, status: 'disabled', reasons: ['disabled'] };

  const worse = (status, reason) => {
    if (RANK[status] > RANK[out.status]) out.status = status;
    out.reasons.push(reason);
  };

  // 1. Is something running right now?
  const lock = job.lock;
  if (lock && lock.runId) {
    if (ms(lock.expiresAt) <= now.getTime()) {
      worse('failing', `run started ${fmt(lock.acquiredAt, tz)} on ${lock.owner} stopped responding (process died)`);
    } else {
      out.running = { runId: lock.runId, owner: lock.owner, since: lock.acquiredAt };
      const minutes = (now.getTime() - ms(lock.acquiredAt)) / 60000;
      if (minutes > job.maxDurationMin) worse('delayed', `running for ${Math.round(minutes)} min (expected under ${job.maxDurationMin} min)`);
    }
  }

  // 2. What did the last run do?
  const lr = job.lastRun;
  if (lr) {
    if (lr.status === 'failed' || lr.status === 'interrupted') {
      const times = out.consecutiveFailures > 1 ? ` (${out.consecutiveFailures} times in a row)` : '';
      worse('failing', `last run ${lr.status}${times}: ${lr.errorMessage || 'no message'}`);
    } else if (lr.status === 'warning') {
      worse('delayed', `last run got 0 rows from Accord${lr.errorMessage ? ` - ${lr.errorMessage}` : ''}`);
    }
  }

  // 3. Was a slot missed? Look at the latest slot whose grace period has fully passed.
  const graceMs = (job.graceMin || 0) * 60000;
  const dueSlot = prevSlot(job.schedules, tz, new Date(now.getTime() - graceMs));
  const lastStart = Math.max(ms(lr && lr.startedAt), ms(lock && lock.acquiredAt));
  const trackedSince = ms(job.createdAt); // never blame slots from before tracking existed
  if (dueSlot.getTime() >= trackedSince && lastStart < dueSlot.getTime() - EARLY_TOLERANCE_MS) {
    const who = job.scheduler === 'external' ? 'crontab did not call it' : 'worker did not run it';
    worse('delayed', `missed run due ${fmt(dueSlot, tz)} (${who})`);
  }

  if (!lr && !out.running && out.reasons.length === 0) out.reasons.push('waiting for first run');
  return out;
}

function summarize(jobHealths, { schedulerOnline = true } = {}) {
  const active = jobHealths.filter((j) => j.status !== 'disabled');
  const counts = { healthy: 0, delayed: 0, failing: 0, disabled: jobHealths.length - active.length };
  for (const j of active) counts[j.status] += 1;

  const reasons = [];
  let overall = 'healthy';
  if (active.some((j) => j.status === 'failing' && j.criticality === 'critical')) {
    overall = 'failing';
    reasons.push('a critical job is failing');
  } else if (counts.failing || counts.delayed) {
    overall = 'delayed';
    reasons.push(`${counts.failing + counts.delayed} job(s) need attention`);
  }
  const hasInternal = active.some((j) => j.scheduler === 'internal');
  if (hasInternal && !schedulerOnline) {
    if (overall === 'healthy') overall = 'delayed';
    reasons.push('scheduler worker is offline - internal jobs will not run');
  }
  return { overall, counts, reasons };
}

module.exports = { computeJobHealth, summarize, scheduleText, RANK, EARLY_TOLERANCE_MS };
