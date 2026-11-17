// cron_runs - one document per crontab call. The history.
const { mongoose } = require('../db');

const KEEP_DAYS = 90; // Mongo deletes older runs automatically

const cronRunSchema = new mongoose.Schema(
  {
    jobKey: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: [
        'running',     // started, not finished yet
        'success',     // finished with rows
        'warning',     // finished, but Accord returned 0 rows (file not ready)
        'failed',      // threw an error
        'skipped',     // did nothing: job disabled or already running
        'interrupted', // the process died while it was running
      ],
    },
    scheduledFor: Date, // the crontab time this call belongs to

    startedAt: { type: Date, required: true },
    finishedAt: Date,
    durationMs: Number,

    recordsFetched: { type: Number, default: 0 },   // rows Accord returned
    recordsProcessed: { type: Number, default: 0 }, // rows written to the target collection

    reason: String, // plain-words reason for skipped / warning / interrupted
    error: { message: String, stack: String },

    host: String,
    pid: Number,
  },
  { collection: 'cron_runs', versionKey: false }
);

cronRunSchema.index({ jobKey: 1, startedAt: -1 }); // "last N runs of job X"
cronRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('CronRun', cronRunSchema);
