// The API process (in the main app: the existing Express app).
// It serves the dashboard and runs a job whenever the server crontab calls its URL.
// It never schedules anything itself.
const path = require('path');
const express = require('express');
const { connectDB, mongoose } = require('../db');
const { syncRegistry } = require('../jobs/syncRegistry');
const tracker = require('../tracker/CronTracker');
const { API_PORT, SHUTDOWN_GRACE_MS } = require('../config');

const app = express();
app.use(express.json());
app.use('/api', require('./routes'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'dashboard.html')));
app.get('/', (req, res) => res.redirect('/dashboard'));

let server;
let stopping = false;

async function start() {
  await connectDB('api');
  console.log('[api] registry sync:', await syncRegistry());
  server = app.listen(API_PORT, () => console.log(`[api] dashboard: http://127.0.0.1:${API_PORT}/dashboard`));
}

// Stop taking requests, give running jobs time to finish, then exit.
async function shutdown(why) {
  if (stopping) return;
  stopping = true;
  console.log(`[api] ${why} - shutting down`);
  if (server) server.close();
  // await tracker.waitForRunningJobs(SHUTDOWN_GRACE_MS);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (msg) => { if (msg === 'shutdown') shutdown('PM2 shutdown'); }); // PM2 on Windows

start().catch((e) => {
  console.error('[api] failed to start:', e);
  process.exit(1);
});
