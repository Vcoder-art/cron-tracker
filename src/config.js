// Single place that reads env vars, same idea as config/constants.js in the main app.
require('dotenv').config({ quiet: true });

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

module.exports = {
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/accord_cron_lab',
  API_PORT: num('API_PORT', 4000),
  TIMEZONE: 'Asia/Kolkata',
  ACCORD: {
    BASE_URL: process.env.ACCORD_BASE_URL || 'http://127.0.0.1:4001',
    TOKEN: 'lab-token',
    TIMEOUT_MS: num('ACCORD_TIMEOUT_MS', 60 * 1000), // J5
  },
  // Dashboard / admin API. In the main app this is the existing WMS auth middleware instead.
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  // Optional shared secret the crontab must send (x-cron-secret header) to trigger a job.
  CRON_TRIGGER_SECRET: process.env.CRON_TRIGGER_SECRET || '',
  WORKER: {
    PRESENCE_MS: num('WORKER_PRESENCE_MS', 30 * 1000),
    SHUTDOWN_GRACE_MS: num('WORKER_SHUTDOWN_GRACE_MS', 25 * 1000),
  },
  // T1: short lock lease kept alive by a heartbeat. A crashed process frees the lock within LEASE_MS.
  TRACKER: {
    LEASE_MS: num('TRACKER_LEASE_MS', 2 * 60 * 1000),
    HEARTBEAT_MS: num('TRACKER_HEARTBEAT_MS', 30 * 1000),
  },
  MOCK: {
    PORT: num('MOCK_ACCORD_PORT', 4001),
    FAIL_RATE: num('MOCK_FAIL_RATE', 0.15),
    EMPTY_RATE: num('MOCK_EMPTY_RATE', 0.1),
    MAX_DELAY_MS: num('MOCK_MAX_DELAY_MS', 3000),
  },
};
