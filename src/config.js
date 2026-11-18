// All settings in one place. Every value can be overridden with an env var (or a .env file).
require('dotenv').config({ quiet: true });

const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/accord_cron_lab',
  API_PORT: num('API_PORT', 4000),
  TIMEZONE: 'Asia/Kolkata',

  ACCORD: {
    BASE_URL: process.env.ACCORD_BASE_URL || 'http://127.0.0.1:4001',
    TOKEN: 'lab-token',
    TIMEOUT_MS: num('ACCORD_TIMEOUT_MS', 60 * 1000),
  },

  // Token for the dashboard API. (In the main app: the existing WMS admin auth.)
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  // Secret the crontab sends in the x-cron-secret header. Empty = not checked.
  CRON_TRIGGER_SECRET: process.env.CRON_TRIGGER_SECRET || '',

  // On shutdown, wait this long for running jobs to finish.
  SHUTDOWN_GRACE_MS: num('SHUTDOWN_GRACE_MS', 25 * 1000),

  // Job lock: it expires after LEASE_MS unless the running job extends it every HEARTBEAT_MS.
  // So if a process crashes, its jobs are free again within LEASE_MS.
  TRACKER: {
    LEASE_MS: num('TRACKER_LEASE_MS', 2 * 60 * 1000),
    HEARTBEAT_MS: num('TRACKER_HEARTBEAT_MS', 30 * 1000),
  },

  // Failure emails: every failed run emails ALERT_MANAGER_EMAILS + ALERT_DEV_EMAILS (comma-separated).
  // No SMTP_HOST or no recipients = alerts are off (logged once, never thrown).
  ALERTS: {
    SMTP_HOST: process.env.SMTP_HOST || '',
    SMTP_PORT: num('SMTP_PORT', 587),
    SMTP_SECURE: process.env.SMTP_SECURE === 'true', // true for port 465
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',
    FROM: process.env.ALERT_FROM || process.env.SMTP_USER || 'accord-cron@localhost',
    DEV_EMAILS: list(process.env.ALERT_DEV_EMAILS),
    MANAGER_EMAILS: list(process.env.ALERT_MANAGER_EMAILS),
    DASHBOARD_URL: process.env.ALERT_DASHBOARD_URL || '',
  },

  // Fake Accord server used in the lab.
  MOCK: {
    PORT: num('MOCK_ACCORD_PORT', 4001),
    FAIL_RATE: num('MOCK_FAIL_RATE', 0.15),
    EMPTY_RATE: num('MOCK_EMPTY_RATE', 0.1),
    MAX_DELAY_MS: num('MOCK_MAX_DELAY_MS', 3000),
  },
};
