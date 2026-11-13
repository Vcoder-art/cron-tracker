// `npm run e2e` - full system test with real processes: mock Accord + API + worker.
// Takes ~3-4 minutes because it waits for the worker's real */2 schedule and a 1-min retry.
// Process logs go to e2e.log; this script prints only the checks.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { mongoose } = require('../src/db');
const { MONGO_URI, API_PORT, MOCK, ADMIN_TOKEN, CRON_TRIGGER_SECRET } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const API = `http://127.0.0.1:${API_PORT}`;
const MOCK_URL = `http://127.0.0.1:${MOCK.PORT}`;
const admin = { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};
const step = (t) => console.log(`\n=== ${t} ===`);

const log = fs.openSync(path.join(ROOT, 'e2e.log'), 'w');
const procs = {};
const start = (name, script) => {
  procs[name] = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', log, log, 'ipc'] });
};
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* not ready yet */ }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const health = async () => (await axios.get(`${API}/api/health/crons`, admin)).data;
const jobHealth = async (k) => (await health()).jobs.find((j) => j.jobKey === k);
const chaos = (file, mode) => axios.get(`${MOCK_URL}/__chaos/set`, { params: { file, mode } });
const manual = async (k) => (await axios.post(`${API}/api/health/crons/${k}/run?wait=1`, null, admin)).data;
const runs = async (k) => (await axios.get(`${API}/api/health/crons/${k}/runs?limit=50`, admin)).data;

(async () => {
  // clean slate
  await mongoose.connect(MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();

  start('mock', 'mock-accord/server.js');
  start('api', 'src/api/server.js');
  start('worker', 'src/worker/worker.js');
  await waitFor(() => axios.get(`${MOCK_URL}/__chaos`), 20000, 'mock');
  await waitFor(async () => (await health()).scheduler.online, 30000, 'api + worker');
  await chaos('all', 'normal');

  step('A. manual run, Accord healthy');
  let r = await manual('current_nav');
  check('run succeeded', r.status === 'success', `${r.status} fetched=${r.recordsFetched} processed=${r.recordsProcessed}`);
  check('processed == fetched (J3)', r.recordsProcessed === r.recordsFetched);
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const navCount = await db.collection('current_nav').countDocuments();
  check('current_nav collection filled', navCount === r.recordsProcessed, `${navCount} docs`);
  check('staging cleaned up (J2)', (await db.collection('current_nav_dump').countDocuments()) === 0);
  check('crondate kept for PPR-567 feed check', !!(await db.collection('current_nav').findOne({ crondate: { $exists: true } })));
  check('job healthy', (await jobHealth('current_nav')).status === 'healthy');

  step('B. Accord returns HTTP 500');
  await chaos('Currentnav', 'fail');
  r = await manual('current_nav');
  check('run failed', r.status === 'failed', r.error);
  let h = await health();
  check('current_nav failing', h.jobs.find((j) => j.jobKey === 'current_nav').status === 'failing');
  check('overall failing (critical job)', h.overall === 'failing', h.reasons.join('; '));

  step('C. Accord returns an empty file');
  await chaos('Currentnav', 'empty');
  r = await manual('current_nav');
  check('run warning', r.status === 'warning');
  h = await health();
  check('current_nav delayed', h.jobs.find((j) => j.jobKey === 'current_nav').status === 'delayed');
  check('overall delayed', h.overall === 'delayed');

  step('D. Accord recovers');
  await chaos('Currentnav', 'normal');
  r = await manual('current_nav');
  check('run success', r.status === 'success');
  check('current_nav healthy again', (await jobHealth('current_nav')).status === 'healthy');

  step('E. crontab trigger (external job)');
  const noSecret = await axios.get(`${API}/api/accord-cron/sclass_mst`, { validateStatus: () => true });
  check('without x-cron-secret -> 401', noSecret.status === 401);
  const ext = await axios.get(`${API}/api/accord-cron/sclass_mst`, { headers: { 'x-cron-secret': CRON_TRIGGER_SECRET } });
  check('with secret -> 202 accepted immediately', ext.status === 202);
  const extRun = await waitFor(async () => (await runs('sclass_mst')).find((x) => x.status !== 'running'), 20000, 'sclass run');
  check('background run recorded', extRun.status === 'success' && extRun.trigger === 'external', `${extRun.status}, slot ${extRun.scheduledFor}`);

  step('F. crontab hits a job that moved to the worker (migration guard)');
  await axios.get(`${API}/api/accord-cron/amc_master`, { headers: { 'x-cron-secret': CRON_TRIGGER_SECRET } });
  const guard = await waitFor(async () => (await runs('amc_master')).find((x) => x.trigger === 'external'), 10000, 'guard run');
  check('external run skipped, not executed', guard.status === 'skipped', guard.reason);

  step('G. dashboard API needs the admin token');
  const unauth = await axios.get(`${API}/api/health/crons`, { validateStatus: () => true });
  check('no token -> 401', unauth.status === 401);
  const page = await axios.get(`${API}/dashboard`);
  check('dashboard page served', page.status === 200 && page.data.includes('Accord Cron Health'));

  step('H. worker schedule + retry (amc_master every 2 min, 1 retry after 1 min)');
  await chaos('Amc_mst', 'fail');
  const since = new Date();
  console.log('  waiting for the next */2 slot (up to 2 min)...');
  const sched = await waitFor(async () => (await runs('amc_master')).find((x) => x.trigger === 'schedule' && new Date(x.startedAt) > since && x.status !== 'running'), 140000, 'scheduled run');
  check('worker fired on schedule', true, `slot ${new Date(sched.scheduledFor).toISOString()}`);
  check('scheduled run failed (Accord down)', sched.status === 'failed', sched.error && sched.error.message);
  await chaos('Amc_mst', 'normal');
  console.log('  Accord fixed - waiting for the retry (1 min)...');
  const retry = await waitFor(async () => (await runs('amc_master')).find((x) => x.trigger === 'retry' && x.status !== 'running'), 90000, 'retry run');
  check('retry ran as attempt 2 for the same slot', retry.attempt === 2 && retry.scheduledFor === sched.scheduledFor);
  check('retry succeeded', retry.status === 'success', `${retry.recordsProcessed} rows`);
  check('amc_master healthy', (await jobHealth('amc_master')).status === 'healthy');

  step('I. graceful worker shutdown');
  procs.worker.send('shutdown');
  await waitFor(() => procs.worker.exitCode !== null, 35000, 'worker exit');
  check('worker exited cleanly', procs.worker.exitCode === 0, `exit code ${procs.worker.exitCode}`);
  h = await health();
  check('dashboard shows scheduler offline', !h.scheduler.online, h.reasons.join('; '));

  step('Final dashboard state');
  for (const j of h.jobs) {
    console.log(`  ${j.name.padEnd(22)} ${j.status.padEnd(9)} last=${(j.lastRun && j.lastRun.status) || '-'} next=${j.nextRunAt ? new Date(j.nextRunAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-'}  ${j.reasons.join('; ')}`);
  }
  console.log(`  overall: ${h.overall} (${JSON.stringify(h.counts)})`);
})()
  .catch((e) => { fail++; console.error('\nE2E ERROR:', e.message); })
  .finally(async () => {
    for (const p of Object.values(procs)) if (p.exitCode === null) { try { p.send('shutdown'); } catch (e) {} }
    await sleep(3000);
    for (const p of Object.values(procs)) if (p.exitCode === null) p.kill();
    await mongoose.disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed (process logs: e2e.log)`);
    process.exit(fail ? 1 : 0);
  });
