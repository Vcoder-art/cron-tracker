// `npm run demo:tracker` - exercises every CronTracker path against the local lab DB.
// Uses a 3s lease / 1s heartbeat so the crash scenario does not take 2 minutes.
process.env.TRACKER_LEASE_MS = '3000';
process.env.TRACKER_HEARTBEAT_MS = '1000';

const path = require('path');
const { spawn } = require('child_process');
const { connectDB, mongoose } = require('../src/db');
const CronJob = require('../src/models/CronJob');
const CronRun = require('../src/models/CronRun');
const { syncRegistry } = require('../src/jobs/syncRegistry');
const tracker = require('../src/tracker/CronTracker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = (t) => console.log(`\n=== ${t} ===`);
const job = (k) => CronJob.findOne({ jobKey: k }, { _id: 0, lock: 1, lastRun: 1, consecutiveFailures: 1, lastSuccessAt: 1 }).lean();
const show = async (k) => {
  const j = await job(k);
  console.log('  job ->', JSON.stringify({ lastRun: j.lastRun && { status: j.lastRun.status, fetched: j.lastRun.recordsFetched, err: j.lastRun.errorMessage }, consecutiveFailures: j.consecutiveFailures, lock: j.lock ? 'HELD' : null }));
};

const fakeJob = (fetched, ms = 200) => async ({ log }) => { await sleep(ms); log(`fake work done`); return { fetched, processed: fetched }; };

(async () => {
  await connectDB('demo');
  await syncRegistry();
  await CronRun.deleteMany({});
  await CronJob.updateMany({}, { $set: { lock: null, lastRun: null, lastSuccessAt: null, consecutiveFailures: 0, enabled: true } });

  title('1. normal run -> success');
  await tracker.run('current_nav', fakeJob(242));
  await show('current_nav');

  title('2. job throws -> failed, consecutiveFailures 1');
  await tracker.run('current_nav', async () => { throw new Error('Accord returned HTTP 500'); });
  await show('current_nav');

  title('3. Accord returns 0 rows -> warning (failures unchanged)');
  await tracker.run('current_nav', fakeJob(0));
  await show('current_nav');

  title('4. overlap: A runs 5s (longer than the 3s lease), B starts at 4s -> B skipped');
  const a = tracker.run('amc_master', fakeJob(120, 5000));
  await sleep(4000); // lease would have expired without the heartbeat
  const b = await tracker.run('amc_master', fakeJob(999));
  console.log('  B ->', b.status, '|', b.reason);
  console.log('  A ->', (await a).status);
  await show('amc_master');

  title('5. crash: child process starts a run and is killed mid-run');
  const child = spawn(process.execPath, [path.join(__dirname, 'crash-child.js')], { stdio: 'inherit' });
  while (!(await CronRun.exists({ jobKey: 'sclass_mst', status: 'running' }))) await sleep(200);
  child.kill(); // abrupt, like a server crash
  console.log('  child killed, lock still HELD:', !!(await job('sclass_mst')).lock);
  const early = await tracker.run('sclass_mst', fakeJob(50));
  console.log('  immediate retry ->', early.status, '(lease not expired yet)');
  await sleep(3500);
  const late = await tracker.run('sclass_mst', fakeJob(50));
  console.log('  retry after lease ->', late.status);

  title('6. disabled job -> skipped');
  await CronJob.updateOne({ jobKey: 'amc_master' }, { $set: { enabled: false } });
  console.log('  disabled ->', (await tracker.run('amc_master', fakeJob(10))).status);
  await CronJob.updateOne({ jobKey: 'amc_master' }, { $set: { enabled: true } });

  title('cron_runs history');
  for (const r of await CronRun.find().sort({ startedAt: 1 }).lean()) {
    console.log(' ', r.jobKey.padEnd(12), r.status.padEnd(11),
      'slot', r.scheduledFor ? r.scheduledFor.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-'.padEnd(10),
      String(r.durationMs ?? '').padStart(5) + 'ms', 'rows', r.recordsFetched, r.reason || r.error?.message || '');
  }
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
