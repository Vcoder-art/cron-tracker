// Unit tests for the health rules. No DB: build job documents by hand, fix "now".
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeJobHealth, summarize, scheduleText } = require('../src/health/status');

// 13 Nov 2026, 10:30 IST = 05:00 UTC
const NOW = new Date('2026-11-13T05:00:00Z');
const ist = (hhmm, day = '2026-11-13') => new Date(`${day}T${hhmm}:00+05:30`);

const baseJob = (over = {}) => ({
  jobKey: 'current_nav', name: 'Current NAV', enabled: true, criticality: 'critical',
  schedules: ['1 4 * * *', '31 7 * * *', '1 10 * * *', '31 12 * * *'],
  timezone: 'Asia/Kolkata', graceMin: 15, maxDurationMin: 10, createdAt: ist('00:00', '2026-11-01'),
  lock: null, lastRun: null, consecutiveFailures: 0, ...over,
});
const run = (status, startHHMM, over = {}) => ({ status, startedAt: ist(startHHMM), durationMs: 3000, recordsFetched: 10, recordsProcessed: 10, ...over });

test('healthy: last slot 10:01 ran and succeeded', () => {
  const h = computeJobHealth(baseJob({ lastRun: run('success', '10:01') }), NOW);
  assert.equal(h.status, 'healthy');
  assert.deepEqual(h.reasons, []);
  assert.equal(h.nextRunAt.toISOString(), ist('12:31').toISOString());
});

test('still inside grace: 10:01 slot not run yet at 10:10 -> healthy', () => {
  const h = computeJobHealth(baseJob({ lastRun: run('success', '07:31') }), new Date(ist('10:10')));
  assert.equal(h.status, 'healthy');
});

test('missed: 10:01 slot passed grace with no run -> delayed', () => {
  const h = computeJobHealth(baseJob({ lastRun: run('success', '07:31') }), NOW);
  assert.equal(h.status, 'delayed');
  assert.match(h.reasons[0], /missed run due 13 Nov, 10:01 \(crontab did not call it\)/);
});

test('slots from before tracking existed are not blamed', () => {
  const h = computeJobHealth(baseJob({ createdAt: ist('10:20') }), NOW);
  assert.equal(h.status, 'healthy');
  assert.deepEqual(h.reasons, ['waiting for first run']);
});

test('a run 1 min before its slot (clock skew) still counts', () => {
  const h = computeJobHealth(baseJob({ lastRun: run('success', '10:00') }), NOW);
  assert.equal(h.status, 'healthy');
});

test('failed -> failing, with repeat count', () => {
  const h = computeJobHealth(baseJob({ consecutiveFailures: 3, lastRun: run('failed', '10:01', { errorMessage: 'Accord Currentnav: HTTP 500' }) }), NOW);
  assert.equal(h.status, 'failing');
  assert.match(h.reasons[0], /failed \(3 times in a row\): Accord Currentnav: HTTP 500/);
});

test('interrupted -> failing', () => {
  assert.equal(computeJobHealth(baseJob({ lastRun: run('interrupted', '10:01') }), NOW).status, 'failing');
});

test('warning (0 rows) -> delayed', () => {
  const h = computeJobHealth(baseJob({ lastRun: run('warning', '10:01', { recordsFetched: 0 }) }), NOW);
  assert.equal(h.status, 'delayed');
  assert.match(h.reasons[0], /0 rows/);
});

test('running within maxDuration -> healthy + running info', () => {
  const lock = { runId: 'r1', owner: 'host:1', acquiredAt: ist('10:25'), expiresAt: new Date(NOW.getTime() + 60000) };
  const h = computeJobHealth(baseJob({ lock, lastRun: run('success', '07:31') }), NOW);
  assert.equal(h.status, 'healthy'); // a run that is in progress counts as "the 10:01 slot was picked up"
  assert.equal(h.running.owner, 'host:1');
});

test('running past maxDuration -> delayed (stuck)', () => {
  const lock = { runId: 'r1', owner: 'host:1', acquiredAt: ist('10:02'), expiresAt: new Date(NOW.getTime() + 60000) };
  const h = computeJobHealth(baseJob({ lock, lastRun: run('success', '07:31') }), NOW);
  assert.equal(h.status, 'delayed');
  assert.match(h.reasons[0], /running for 28 min/);
});

test('lock lease expired (process died) -> failing even before the next run cleans it up', () => {
  const lock = { runId: 'r1', owner: 'host:1', acquiredAt: ist('10:02'), expiresAt: ist('10:05') };
  const h = computeJobHealth(baseJob({ lock, lastRun: run('success', '07:31') }), NOW);
  assert.equal(h.status, 'failing');
  assert.match(h.reasons[0], /stopped responding/);
});

test('disabled jobs are not evaluated', () => {
  assert.equal(computeJobHealth(baseJob({ enabled: false }), NOW).status, 'disabled');
});

test('summary: critical failing -> failing; normal failing -> delayed', () => {
  const j = (status, criticality) => ({ status, criticality });
  assert.equal(summarize([j('failing', 'critical'), j('healthy', 'normal')]).overall, 'failing');
  assert.equal(summarize([j('failing', 'normal'), j('healthy', 'critical')]).overall, 'delayed');
  assert.equal(summarize([j('healthy', 'normal')]).overall, 'healthy');
  assert.deepEqual(summarize([j('healthy', 'normal'), j('disabled', 'normal')]).counts, { healthy: 1, delayed: 0, failing: 0, disabled: 1 });
});

test('scheduleText', () => {
  assert.equal(scheduleText('31 7 * * *'), '07:31 daily');
  assert.equal(scheduleText('*/2 * * * *'), '*/2 * * * *');
});
