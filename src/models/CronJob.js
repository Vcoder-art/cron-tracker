// cron_jobs: the REGISTRY. One document per job. "What SHOULD happen."
//
// Two kinds of fields live here:
//   1. Definition fields - copied from src/jobs/registry.js on every sync (code is the source of truth, D1).
//   2. Runtime fields    - written only by the CronTracker (lock, lastRun, ...). Sync never touches them.
const { mongoose } = require('../db');

// Small copy of the newest run, so the dashboard never has to aggregate cron_runs (D3).
const lastRunSchema = new mongoose.Schema(
  {
    runId: mongoose.Schema.Types.ObjectId,
    status: String,
    trigger: String,
    attempt: Number,
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    recordsFetched: Number,
    recordsProcessed: Number,
    errorMessage: String,
  },
  { _id: false }
);

// Who is running the job right now (D2). null = free.
const lockSchema = new mongoose.Schema(
  {
    runId: mongoose.Schema.Types.ObjectId,
    owner: String, // "host:pid" of the process holding it
    acquiredAt: Date,
    expiresAt: Date, // lease: after this, anyone may take the lock (crashed holder)
  },
  { _id: false }
);

const cronJobSchema = new mongoose.Schema(
  {
    // ---- definition fields (from registry.js) ----
    jobKey: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    schedules: { type: [String], required: true }, // array: current NAV has 7 different times
    timezone: { type: String, default: 'Asia/Kolkata' },
    enabled: { type: Boolean, default: true },
    scheduler: { type: String, enum: ['external', 'internal'], default: 'external' },
    criticality: { type: String, enum: ['critical', 'normal'], default: 'normal' },
    graceMin: { type: Number, default: 15 },
    maxDurationMin: { type: Number, default: 10 },
    retry: {
      attempts: { type: Number, default: 0 }, // extra attempts after a failed/empty scheduled run
      delayMin: { type: Number, default: 10 },
    },
    inRegistry: { type: Boolean, default: true }, // false = removed from code, kept for its history

    // ---- runtime fields (CronTracker only) ----
    lock: { type: lockSchema, default: null },
    lastRun: { type: lastRunSchema, default: null },
    lastSuccessAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },
  },
  { collection: 'cron_jobs', timestamps: true }
);

// Fields sync is allowed to overwrite. Everything else belongs to the tracker.
cronJobSchema.statics.DEFINITION_FIELDS = [
  'name', 'description', 'schedules', 'timezone', 'enabled',
  'scheduler', 'criticality', 'graceMin', 'maxDurationMin', 'retry',
];

module.exports = mongoose.model('CronJob', cronJobSchema);
