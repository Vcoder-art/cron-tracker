// cron_jobs - one document per job.
//
//   Definition fields : copied from src/jobs/registry.js on every start. Code is the source of truth.
//   Runtime fields    : written only by the tracker while jobs run.
const { mongoose } = require('../db');

// Short copy of the latest run, so the dashboard does not have to search cron_runs.
const lastRunSchema = new mongoose.Schema(
  {
    runId: mongoose.Schema.Types.ObjectId,
    status: String,
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    recordsFetched: Number,
    recordsProcessed: Number,
    errorMessage: String,
  },
  { _id: false }
);

// Who is running the job right now. null = nobody.
const lockSchema = new mongoose.Schema(
  {
    runId: mongoose.Schema.Types.ObjectId,
    owner: String,     // "host:pid" of the process running it
    acquiredAt: Date,
    expiresAt: Date,   // extended while the job runs; if it passes, the owner died and the lock is free
  },
  { _id: false }
);

const cronJobSchema = new mongoose.Schema(
  {
    // ---- definition (from registry.js) ----
    jobKey: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    schedules: { type: [String], required: true }, // cron expressions; must match the crontab lines
    timezone: { type: String, default: 'Asia/Kolkata' },
    enabled: { type: Boolean, default: true },
    criticality: { type: String, enum: ['critical', 'normal'], default: 'normal' },
    graceMin: { type: Number, default: 15 },       // minutes after a schedule time before it counts as missed
    maxDurationMin: { type: Number, default: 10 }, // longer than this = stuck
    inRegistry: { type: Boolean, default: true },  // false = removed from registry.js, kept for its history

    // ---- runtime (tracker) ----
    lock: { type: lockSchema, default: null },
    lastRun: { type: lastRunSchema, default: null },
    lastSuccessAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },
  },
  { collection: 'cron_jobs', timestamps: true }
);

module.exports = mongoose.model('CronJob', cronJobSchema);
