// Reads Mongo, applies the pure rules. One query per collection - the dashboard stays cheap
// no matter how large cron_runs grows (D3: lastRun snapshot lives on the job document).
const CronJob = require('../models/CronJob');
const CronRun = require('../models/CronRun');
const CronWorker = require('../models/CronWorker');
const { computeJobHealth, summarize, RANK } = require('./status');
const { WORKER } = require('../config');

const STATUS_ORDER = { failing: 0, delayed: 1, healthy: 2, disabled: 3 };

async function getCronHealth(now = new Date()) {
  const [jobs, workers] = await Promise.all([
    CronJob.find({ inRegistry: true }).lean(),
    CronWorker.find().lean(),
  ]);

  const aliveAfter = now.getTime() - WORKER.PRESENCE_MS * 3;
  const workerList = workers.map((w) => ({ ...w, alive: new Date(w.lastSeenAt).getTime() >= aliveAfter }));
  const schedulerOnline = workerList.some((w) => w.alive);

  const healths = jobs
    .map((j) => computeJobHealth(j, now))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));

  return {
    checkedAt: now,
    ...summarize(healths, { schedulerOnline }),
    scheduler: { online: schedulerOnline, workers: workerList },
    jobs: healths,
  };
}

async function getRuns(jobKey, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return CronRun.find({ jobKey }).sort({ startedAt: -1 }).limit(n).lean();
}

module.exports = { getCronHealth, getRuns, RANK };
