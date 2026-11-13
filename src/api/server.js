// The API process (in the main app: the existing Express app in index.js).
// It never schedules anything - it serves the dashboard and accepts crontab/manual triggers.
const path = require('path');
const express = require('express');
const { connectDB, mongoose } = require('../db');
const { syncRegistry } = require('../jobs/syncRegistry');
const tracker = require('../tracker/CronTracker');
const { API_PORT, WORKER } = require('../config');

const app = express();
app.use(express.json());
app.use('/api', require('./routes'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'dashboard.html')));
app.get('/', (req, res) => res.redirect('/dashboard'));

let server;
async function start() {
  await connectDB('api');
  // Idempotent - safe even when the worker syncs at the same moment.
  console.log('[api] registry sync:', await syncRegistry());
  server = app.listen(API_PORT, () => console.log(`[api] listening on :${API_PORT} - dashboard http://127.0.0.1:${API_PORT}/dashboard`));
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[api] ${signal} - closing`);
  if (server) server.close();
  await tracker.waitForInFlight(WORKER.SHUTDOWN_GRACE_MS); // let crontab/manual runs finish
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (msg) => { if (msg === 'shutdown') shutdown('shutdown message'); });

start().catch((e) => {
  console.error('[api] failed to start:', e);
  process.exit(1);
});
