const express = require('express');
const { runJob, hasJob } = require('../jobs/runJob');
const { getCronHealth, getRuns } = require('../health/service');
const { ADMIN_TOKEN, CRON_TRIGGER_SECRET } = require('../config');

const router = express.Router();

// ---- auth ----
// Lab stand-in for the WMS admin auth middleware. In the main app use the existing one.
function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}
// The crontab must send x-cron-secret. Replaces today's fully public trigger URLs.
function requireCronSecret(req, res, next) {
  if (CRON_TRIGGER_SECRET && req.get('x-cron-secret') !== CRON_TRIGGER_SECRET) return res.status(401).json({ error: 'bad cron secret' });
  next();
}

// Start a run. Default: answer 202 immediately (no nginx/curl timeout on long jobs);
// ?wait=1 waits for the result (handy for testing and manual curl).
async function trigger(req, res, triggerName) {
  const { jobKey } = req.params;
  if (!hasJob(jobKey)) return res.status(404).json({ error: `unknown job ${jobKey}` });

  const p = runJob(jobKey, { trigger: triggerName });
  if (req.query.wait === '1') {
    try {
      return res.json(await p);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  p.catch((e) => console.error(`[api] ${jobKey} ${triggerName} run error:`, e.message));
  return res.status(202).json({ accepted: true, jobKey, trigger: triggerName });
}

// ---- what the server crontab calls (replaces GET /api/accord-cron/accordcurrent_nav etc.) ----
router.get('/accord-cron/:jobKey', requireCronSecret, (req, res) => trigger(req, res, 'external'));

// ---- dashboard API ----
router.get('/health/crons', requireAdmin, async (req, res) => {
  try {
    res.json(await getCronHealth());
  } catch (e) {
    // Always answer: a broken health endpoint must not look like "no data"
    res.status(500).json({ overall: 'failing', reasons: [`health check error: ${e.message}`], jobs: [] });
  }
});

router.get('/health/crons/:jobKey/runs', requireAdmin, async (req, res) => {
  try {
    res.json(await getRuns(req.params.jobKey, req.query.limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/health/crons/:jobKey/run', requireAdmin, (req, res) => trigger(req, res, 'manual'));

module.exports = router;
