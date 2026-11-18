// Unit tests for the failure email. No SMTP, no DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyRunResult, buildMail, showDuration, suggestedSteps } = require('../src/alerts/mailer');

const job = {
  jobKey: 'current_nav', name: 'Current NAV', description: 'Latest NAV', criticality: 'critical',
  schedules: ['31 7 * * *'], timezone: 'Asia/Kolkata', consecutiveFailures: 3, lastSuccessAt: null,
};
const run = {
  runId: 'r1', status: 'failed', trigger: 'cron', startedAt: new Date(), finishedAt: new Date(), durationMs: 1200,
  host: 'app-1', pid: 42, error: { message: 'Accord <Currentnav>: HTTP 500', stack: 'Error: x' },
};

test('non-failed runs never email', async () => {
  for (const status of ['success', 'warning', 'skipped']) {
    assert.equal(await notifyRunResult({ jobKey: 'x' }, { status }), null);
  }
});

test('subject: critical tag, status, job, consecutive count', () => {
  assert.equal(buildMail(job, run).subject, '[CRITICAL] [Accord Cron] FAILED: Current NAV (3rd consecutive failure)');
  assert.equal(buildMail({ ...job, criticality: 'normal', consecutiveFailures: 1 }, { ...run, status: 'interrupted' }).subject,
    '[Accord Cron] INTERRUPTED: Current NAV');
});

test('body has details, impact and escapes HTML', () => {
  const mail = buildMail(job, run);
  assert.match(mail.text, /Consecutive failures: 3/);
  assert.match(mail.text, /Accord <Currentnav>: HTTP 500/);
  assert.match(mail.text, /IMPACT/);
  assert.match(mail.text, /No successful run on record/);
  assert.match(mail.html, /Accord &lt;Currentnav&gt;: HTTP 500/);
  assert.doesNotMatch(mail.html, /<Currentnav>/);
});

test('suggested steps follow the error type', () => {
  assert.match(suggestedSteps({ status: 'failed', error: { message: 'timeout after 60000ms' } })[0], /did not respond in time/);
  assert.match(suggestedSteps({ status: 'failed', error: { message: 'HTTP 503' } })[0], /server error/);
  assert.match(suggestedSteps({ status: 'interrupted', host: 'h' })[0], /stopped responding/);
});

test('showDuration', () => {
  assert.equal(showDuration(450), '450 ms');
  assert.equal(showDuration(61000), '1 min 1 s');
  assert.equal(showDuration(5.5 * 3600 * 1000), '5 h 30 min');
});
