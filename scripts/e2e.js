// `npm run e2e` - full system test with real processes: mock Accord + API.
// Every run goes through the crontab URL (GET /api/accord-cron/:jobKey) - the only way a job starts.
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
const cronHeaders = { headers: { 'x-cron-secret': CRON_TRIGGER_SECRET } };
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
// What the server crontab does, but waiting for the result.
const cron = async (k) => (await axios.get(`${API}/api/accord-cron/${k}?wait=1`, cronHeaders)).data;
const runs = async (k) => (await axios.get(`${API}/api/health/crons/${k}/runs?limit=50`, admin)).data;

(async () => {
  // clean slate
  await mongoose.connect(MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();

  start('mock', 'mock-accord/server.js');
  start('api', 'src/api/server.js');
  await waitFor(() => axios.get(`${MOCK_URL}/__chaos`), 20000, 'mock');
  await waitFor(() => health(), 30000, 'api');
  await chaos('all', 'normal');

  step('A. crontab run, Accord healthy');
  let r = await cron('current_nav');
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
  r = await cron('current_nav');
  check('run failed', r.status === 'failed', r.error);
  let h = await health();
  check('current_nav failing', h.jobs.find((j) => j.jobKey === 'current_nav').status === 'failing');
  check('overall failing (critical job)', h.overall === 'failing', h.reasons.join('; '));

  step('C. Accord returns an empty file');
  await chaos('Currentnav', 'empty');
  r = await cron('current_nav');
  check('run warning', r.status === 'warning');
  h = await health();
  check('current_nav delayed', h.jobs.find((j) => j.jobKey === 'current_nav').status === 'delayed');
  check('overall delayed', h.overall === 'delayed');

  step('D. Accord recovers');
  await chaos('Currentnav', 'normal');
  r = await cron('current_nav');
  check('run success', r.status === 'success');
  check('current_nav healthy again', (await jobHealth('current_nav')).status === 'healthy');

  step('E. crontab call without waiting');
  const noSecret = await axios.get(`${API}/api/accord-cron/sclass_mst`, { validateStatus: () => true });
  check('without x-cron-secret -> 401', noSecret.status === 401);
  const ext = await axios.get(`${API}/api/accord-cron/sclass_mst`, cronHeaders);
  check('with secret -> 202 accepted immediately', ext.status === 202);
  const extRun = await waitFor(async () => (await runs('sclass_mst')).find((x) => x.status !== 'running'), 20000, 'sclass run');
  check('background run recorded with its slot', extRun.status === 'success' && !!extRun.scheduledFor, `${extRun.status}, slot ${extRun.scheduledFor}`);

  step('F. no other way to start a job');
  const oldManual = await axios.post(`${API}/api/health/crons/current_nav/run`, null, { ...admin, validateStatus: () => true });
  check('manual run route is gone -> 404', oldManual.status === 404);

  step('G. dashboard API needs the admin token');
  const unauth = await axios.get(`${API}/api/health/crons`, { validateStatus: () => true });
  check('no token -> 401', unauth.status === 401);
  const page = await axios.get(`${API}/dashboard`);
  check('dashboard page served', page.status === 200 && page.data.includes('Accord Cron Health'));

  step('Final dashboard state');
  h = await health();
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
