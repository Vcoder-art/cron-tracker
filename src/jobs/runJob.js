// Glue between the registry (code) and the tracker: look up the handler, run it tracked.
// Used by the worker (schedule/retry), the API trigger route (external) and the dashboard (manual).
const registry = require('./registry');
const tracker = require('../tracker/CronTracker');

const handlers = new Map(registry.map((d) => [d.jobKey, d.handler]));

const hasJob = (jobKey) => handlers.has(jobKey);

function runJob(jobKey, opts) {
  const handler = handlers.get(jobKey);
  if (!handler) throw new Error(`No handler for job "${jobKey}"`);
  return tracker.run(jobKey, handler, opts);
}

module.exports = { runJob, hasJob };
