// cron_workers: presence of scheduler processes. The worker upserts its row every 30s.
// The dashboard uses it to show "scheduler online/offline" - if no worker is alive,
// every internal job is about to be missed, and we can say so before the grace period ends.
const { mongoose } = require('../db');

const cronWorkerSchema = new mongoose.Schema(
  {
    _id: String, // "host:pid"
    host: String,
    pid: Number,
    startedAt: Date,
    lastSeenAt: { type: Date, index: { expireAfterSeconds: 24 * 60 * 60 } }, // dead rows vanish after a day
    jobs: [String], // internal jobs this worker scheduled
  },
  { collection: 'cron_workers', versionKey: false }
);

module.exports = mongoose.model('CronWorker', cronWorkerSchema);
