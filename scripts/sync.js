// `npm run sync` - push registry.js into cron_jobs and print the result.
const { connectDB, mongoose } = require('../src/db');
const { syncRegistry } = require('../src/jobs/syncRegistry');

(async () => {
  try {
    await connectDB('sync');
    console.log('[sync]', await syncRegistry());
  } catch (e) {
    console.error('[sync] FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
