// Used by demo-tracker.js: starts a job that never finishes, then gets killed by the parent.
// Simulates a server restart / OOM / deploy in the middle of a run.
const { connectDB } = require('../src/db');
const tracker = require('../src/tracker/CronTracker');

(async () => {
  await connectDB('crash-child');
  await tracker.run('sclass_mst', () => new Promise(() => {}), { trigger: 'external' });
})();
