// Sends one sample "cron failed" email using the settings in .env. Use it to check SMTP / SES.
//   npm run test:mail            -> send it
//   npm run test:mail -- --html  -> only print the HTML (nothing is sent)
const { notifyRunResult, buildMail } = require('../src/alerts/mailer');

const now = Date.now();
const job = {
  jobKey: 'test_mail', name: 'Test alert (please ignore)', description: 'Sample job used to test the failure email. No real job failed.',
  criticality: 'critical', schedules: ['1 4 * * *', '31 7 * * *', '1 10 * * *'], timezone: 'Asia/Kolkata',
  consecutiveFailures: 2, lastSuccessAt: new Date(now - 5.5 * 3600 * 1000),
};
const run = {
  runId: '000000000000000000000000', status: 'failed', trigger: 'manual',
  scheduledFor: new Date(now - 62 * 1000), startedAt: new Date(now - 61 * 1000), finishedAt: new Date(now), durationMs: 61000,
  recordsFetched: 0, recordsProcessed: 0,
  error: { message: 'Accord Currentnav: timeout after 60000ms (TEST - no job actually failed)', stack: 'Error: Accord Currentnav: timeout after 60000ms\n    at fetchAccordFile (src/jobs/defineAccordJob.js:38:11)' },
};

if (process.argv.includes('--html')) {
  process.stdout.write(buildMail(job, run).html);
} else {
  notifyRunResult(job, run).then((info) => process.exit(info ? 0 : 1));
}
