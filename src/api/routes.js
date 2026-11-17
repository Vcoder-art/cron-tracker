const express = require('express');
const registry = require('../jobs/registry');
const tracker = require('../tracker/CronTracker');
const CronJob = require('../models/CronJob');
const CronRun = require('../models/CronRun');
const { computeJobHealth, summarize } = require('../health/status');
const { ADMIN_TOKEN, CRON_TRIGGER_SECRET } = require('../config');

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

// Dashboard users. (In the main app use the existing WMS admin middleware instead.)
function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// The server crontab sends the x-cron-secret header.
function requireCronSecret(req, res, next) {
  if (CRON_TRIGGER_SECRET && req.get('x-cron-secret') !== CRON_TRIGGER_SECRET) {
    return res.status(401).json({ error: 'bad cron secret' });
  }
  next();
}

// ---------------------------------------------------------------------------------------------
// GET /api/accord-cron/:jobKey  - called by the server crontab. The ONLY way a job runs.
//
// Answers 202 straight away so curl/nginx never time out on a long job.
// Add ?wait=1 to wait for the result instead (used by tests).
// ---------------------------------------------------------------------------------------------
router.get('/accord-cron/:jobKey', requireCronSecret, async (req, res) => {
  const { jobKey } = req.params;
  const def = registry.find((d) => d.jobKey === jobKey);
  if (!def) return res.status(404).json({ error: `unknown job ${jobKey}` });

  const running = tracker.run(jobKey, def.handler);

  if (req.query.wait === '1') {
    try {
      return res.json(await running);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  running.catch((e) => console.error(`[api] ${jobKey} could not run:`, e.message));
  res.status(202).json({ accepted: true, jobKey });
});

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

// Health of every job + an overall status. Worst jobs first.
const SORT_ORDER = { failing: 0, delayed: 1, healthy: 2, disabled: 3 };

router.get('/health/crons', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const jobs = await CronJob.find({ inRegistry: true }).lean();
    const healths = jobs
      .map((job) => computeJobHealth(job, now))
      .sort((a, b) => SORT_ORDER[a.status] - SORT_ORDER[b.status] || a.name.localeCompare(b.name));
    res.json({ checkedAt: now, ...summarize(healths), jobs: healths });
  } catch (e) {
    // Never answer "no data" when the check itself broke.
    res.status(500).json({ overall: 'failing', reasons: [`health check error: ${e.message}`], jobs: [] });
  }
});

// Last N runs of one job (default 20, max 100).
router.get('/health/crons/:jobKey/runs', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const runs = await CronRun.find({ jobKey: req.params.jobKey }).sort({ startedAt: -1 }).limit(limit).lean();
    res.json(runs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
