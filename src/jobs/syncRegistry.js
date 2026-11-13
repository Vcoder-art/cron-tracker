// Copies registry.js into cron_jobs. Runs at worker startup (and via `npm run sync`).
//
// Rules:
//   - Validate every definition first; one bad cron expression aborts the whole sync,
//     so a typo can never half-apply.
//   - Upsert only DEFINITION_FIELDS. lock / lastRun / counters are never overwritten.
//   - A job deleted from code is NOT deleted from Mongo: it is marked inRegistry=false
//     and disabled, so its history stays visible.
const cronParser = require('cron-parser');
const CronJob = require('../models/CronJob');
require('../models/CronRun');
require('../models/CronWorker');
const registry = require('./registry');
const { TIMEZONE } = require('../config');

function validate(defs) {
  const errors = [];
  const seen = new Set();
  for (const def of defs) {
    if (!def.jobKey) errors.push('job without jobKey');
    if (seen.has(def.jobKey)) errors.push(`duplicate jobKey ${def.jobKey}`);
    seen.add(def.jobKey);
    if (typeof def.handler !== 'function') errors.push(`${def.jobKey}: handler must be a function`);
    if (def.scheduler && !['internal', 'external'].includes(def.scheduler)) errors.push(`${def.jobKey}: scheduler must be internal|external`);
    if (!Array.isArray(def.schedules) || def.schedules.length === 0) {
      errors.push(`${def.jobKey}: schedules must be a non-empty array`);
      continue;
    }
    for (const expr of def.schedules) {
      try {
        cronParser.parseExpression(expr, { tz: def.timezone || TIMEZONE });
      } catch (e) {
        errors.push(`${def.jobKey}: invalid cron "${expr}" (${e.message})`);
      }
    }
  }
  if (errors.length) throw new Error('Registry invalid:\n  ' + errors.join('\n  '));
}

async function syncRegistry() {
  validate(registry);

  // Make sure every index exists before anything writes: unique jobKey, TTL on runs,
  // and the unique keys that $merge needs on the feed target collections.
  await Promise.all(Object.values(CronJob.db.models).map((m) => m.init()));

  const ops = registry.map((def) => {
    const set = { inRegistry: true };
    for (const f of CronJob.DEFINITION_FIELDS) if (def[f] !== undefined) set[f] = def[f];
    if (set.timezone === undefined) set.timezone = TIMEZONE;
    return {
      updateOne: {
        filter: { jobKey: def.jobKey },
        // createdAt is set by hand because timestamps are off (see below). The health rules use it
        // to avoid blaming slots that passed before the job was tracked.
        update: { $set: set, $setOnInsert: { jobKey: def.jobKey, createdAt: new Date() } },
        upsert: true,
        // Without this Mongoose adds updatedAt to every $set, so every job would look
        // "modified" on every sync and the count would lie.
        timestamps: false,
      },
    };
  });
  const result = await CronJob.bulkWrite(ops);

  const keys = registry.map((d) => d.jobKey);
  const retired = await CronJob.updateMany(
    { jobKey: { $nin: keys }, inRegistry: { $ne: false } },
    { $set: { inRegistry: false, enabled: false } }
  );

  return {
    inserted: result.upsertedCount,
    updated: result.modifiedCount,
    retired: retired.modifiedCount,
    total: keys.length,
  };
}

module.exports = { syncRegistry, validate };
