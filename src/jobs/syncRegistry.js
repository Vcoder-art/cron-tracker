// Copies the job list from registry.js into the cron_jobs collection.
// Runs when the API starts (and with `npm run sync`).
//
//   - Checks every job first. One bad cron expression stops the whole sync.
//   - Only overwrites the definition fields (name, schedules, ...). Never lock / lastRun / counters.
//   - A job removed from registry.js is not deleted: it is disabled and hidden, its history stays.
const cronParser = require('cron-parser');
const CronJob = require('../models/CronJob');
require('../models/CronRun');
require('../models/accordFeeds');
const registry = require('./registry');
const { TIMEZONE } = require('../config');

// Fields that come from registry.js. Everything else on a job is written by the tracker.
const DEFINITION_FIELDS = ['name', 'description', 'schedules', 'timezone', 'enabled', 'criticality', 'graceMin', 'maxDurationMin'];

function validate(defs) {
  const errors = [];
  const seen = new Set();

  for (const def of defs) {
    if (!def.jobKey) errors.push('job without jobKey');
    if (seen.has(def.jobKey)) errors.push(`duplicate jobKey ${def.jobKey}`);
    seen.add(def.jobKey);

    if (typeof def.handler !== 'function') errors.push(`${def.jobKey}: handler must be a function`);

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

  // Create all indexes first (unique jobKey, 90-day TTL on runs, unique keys on the feed collections).
  await Promise.all(Object.values(CronJob.db.models).map((model) => model.init()));

  const ops = registry.map((def) => {
    const fields = { inRegistry: true, timezone: TIMEZONE };
    for (const f of DEFINITION_FIELDS) if (def[f] !== undefined) fields[f] = def[f];
    return {
      updateOne: {
        filter: { jobKey: def.jobKey },
        // createdAt: the health check ignores schedule times from before the job was tracked.
        update: { $set: fields, $setOnInsert: { jobKey: def.jobKey, createdAt: new Date() } },
        upsert: true,
        timestamps: false, // otherwise every job looks "updated" on every sync
      },
    };
  });
  const result = await CronJob.bulkWrite(ops);

  const keys = registry.map((d) => d.jobKey);
  const retired = await CronJob.updateMany(
    { jobKey: { $nin: keys }, inRegistry: { $ne: false } },
    { $set: { inRegistry: false, enabled: false } }
  );

  return { inserted: result.upsertedCount, updated: result.modifiedCount, retired: retired.modifiedCount, total: keys.length };
}

module.exports = { syncRegistry, validate };
