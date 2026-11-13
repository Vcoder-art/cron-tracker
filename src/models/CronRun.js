// cron_runs: the HISTORY. One document per execution. "What DID happen."
const { mongoose } = require('../db');

const RETENTION_DAYS = 90;

const RUN_STATUSES = [
  'running',     // started, not finished yet
  'success',     // finished, recordsProcessed > 0
  'warning',     // finished, but Accord returned 0 rows (file not ready)
  'failed',      // threw an error
  'skipped',     // lock was held by another run, did nothing
  'interrupted', // found still 'running' after its lease expired (process died)
];

const cronRunSchema = new mongoose.Schema(
  {
    jobKey: { type: String, required: true },
    status: { type: String, enum: RUN_STATUSES, required: true },
    // schedule = worker cron, retry = worker retry, external = crontab/curl, manual = dashboard/API user
    trigger: { type: String, enum: ['schedule', 'retry', 'external', 'manual'], required: true },
    attempt: { type: Number, default: 1 },
    scheduledFor: Date, // which schedule slot this run belongs to (null for manual runs)

    startedAt: { type: Date, required: true },
    finishedAt: Date,
    durationMs: Number,

    recordsFetched: { type: Number, default: 0 },   // rows Accord returned
    recordsProcessed: { type: Number, default: 0 }, // rows merged into the target collection

    reason: String, // why a run was skipped / interrupted, in plain words

    error: {
      message: String,
      stack: String, // truncated by the tracker
    },

    host: String,
    pid: Number,
  },
  { collection: 'cron_runs', versionKey: false }
);

// "Last N runs of job X" - the dashboard drill-down query.
cronRunSchema.index({ jobKey: 1, startedAt: -1 });
// Mongo deletes runs automatically RETENTION_DAYS after they started.
cronRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

cronRunSchema.statics.RUN_STATUSES = RUN_STATUSES;

module.exports = mongoose.model('CronRun', cronRunSchema);
