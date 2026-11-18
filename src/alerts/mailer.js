// Emails the managers and devs every time a cron job fails (status 'failed' or 'interrupted').
//
// The tracker calls notifyRunResult() after it has saved a run. It never waits for it and it
// never throws: a broken mail server must not change a job's result.
const os = require('os');
const nodemailer = require('nodemailer');
const { ALERTS, TIMEZONE } = require('../config');
const { nextSlot } = require('../tracker/schedule');
const { scheduleText } = require('../health/status');

const FAILED = ['failed', 'interrupted'];

let transport = null;
let warnedOff = false;

function recipients() {
  return [...new Set([...ALERTS.MANAGER_EMAILS, ...ALERTS.DEV_EMAILS])];
}

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: ALERTS.SMTP_HOST,
      port: ALERTS.SMTP_PORT,
      secure: ALERTS.SMTP_SECURE,
      auth: ALERTS.SMTP_USER ? { user: ALERTS.SMTP_USER, pass: ALERTS.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

/**
 * @param {object} job  cron_jobs document after the update
 * @param {object} run  cron_runs document (runId, status, trigger, scheduledFor, startedAt, finishedAt,
 *                      durationMs, recordsFetched, recordsProcessed, error: {message, stack}, reason, host, pid)
 */
function notifyRunResult(job, run) {
  if (!FAILED.includes(run.status)) return Promise.resolve(null);

  const to = recipients();
  if (!ALERTS.SMTP_HOST || to.length === 0) {
    if (!warnedOff) console.log('[alerts] email alerts off (set SMTP_HOST and ALERT_MANAGER_EMAILS to enable)');
    warnedOff = true;
    return Promise.resolve(null);
  }

  let mail;
  try {
    mail = buildMail(job, run);
  } catch (e) {
    console.error(`[alerts] could not build failure email for ${job.jobKey}: ${e.message}`);
    return Promise.resolve(null);
  }

  return getTransport()
    .sendMail({
      from: ALERTS.FROM,
      to: to.join(', '),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      priority: job.criticality === 'critical' ? 'high' : 'normal',
    })
    .then((info) => {
      console.log(`[alerts] failure email for ${job.jobKey} sent (${info.messageId})`);
      return info;
    })
    .catch((e) => {
      console.error(`[alerts] could not send failure email for ${job.jobKey}: ${e.message}`);
      return null;
    });
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function showTime(d, tz = TIMEZONE) {
  if (!d) return '-';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';
}

// 61500 -> "1 min 1 s"
function showDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [d && `${d} d`, h && `${h} h`, m && `${m} min`, !d && !h && sec && `${sec} s`].filter(Boolean).join(' ') || '0 s';
}

const ordinal = (n) => {
  const v = n % 100;
  return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th');
};

// Plain-words hints based on what the error looks like.
function suggestedSteps(run) {
  const msg = `${run.error?.message || ''} ${run.reason || ''}`;
  const steps = [];
  if (run.status === 'interrupted') {
    steps.push(`The process running this job (${run.host || 'unknown host'}) stopped responding mid-run - check whether the API process crashed or was restarted (pm2 logs / server memory).`);
  } else if (/timeout/i.test(msg)) {
    steps.push('Accord did not respond in time. Check whether the Accord service is slow or down, and retry once it responds.');
  } else if (/HTTP 5\d\d/.test(msg)) {
    steps.push('Accord returned a server error. This is usually temporary on the Accord side - retry in a few minutes.');
  } else if (/HTTP 40[13]/.test(msg)) {
    steps.push('Accord rejected the request (unauthorised). Verify the Accord token / credentials.');
  } else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(msg)) {
    steps.push('Could not reach Accord over the network. Check connectivity / DNS from the application server.');
  } else if (/Mongo|E11000|duplicate key/i.test(msg)) {
    steps.push('The database step failed. Check MongoDB health and the error details below.');
  } else if (/no Table array/i.test(msg)) {
    steps.push('Accord responded but the file format was unexpected. Check whether the Accord file layout changed.');
  }
  steps.push('Once the cause is resolved, re-run the job using "Run now" on the cron dashboard, or wait for the next scheduled run.');
  steps.push('Review the application logs on the host for the full context of this run.');
  return steps;
}

// ---------------------------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------------------------

function buildMail(job, run) {
  const tz = job.timezone || TIMEZONE;
  const critical = job.criticality === 'critical';
  const interrupted = run.status === 'interrupted';
  const failures = Number(job.consecutiveFailures) || 1;
  const failedAt = run.finishedAt || run.startedAt;
  const statusWord = interrupted ? 'INTERRUPTED' : 'FAILED';

  let next = null;
  try {
    if (job.enabled !== false && job.schedules?.length) next = nextSlot(job.schedules, tz, new Date());
  } catch { /* bad cron expression: leave blank */ }

  const subject = `${critical ? '[CRITICAL] ' : ''}[Accord Cron] ${statusWord}: ${job.name}`
    + (failures > 1 ? ` (${ordinal(failures)} consecutive failure)` : '');

  const errorMessage = run.error?.message || run.reason || 'No error message was recorded.';
  const stack = run.error?.stack || '';
  const lastSuccess = job.lastSuccessAt
    ? `${showTime(job.lastSuccessAt, tz)} (${showDuration(Date.now() - new Date(job.lastSuccessAt).getTime())} ago)`
    : 'No successful run on record';

  const summary = `The ${critical ? 'critical ' : ''}cron job "${job.name}" ${interrupted ? 'was interrupted' : 'failed'} at ${showTime(failedAt, tz)}. `
    + (failures > 1 ? `This is the ${ordinal(failures)} consecutive failure. ` : '')
    + `Last successful run: ${lastSuccess}.`;

  const impact = critical
    ? `This job is marked critical. Data loaded by "${job.name}" may be stale until the next successful run`
      + (next ? ` (next scheduled: ${showTime(next, tz)}).` : '.')
    : null;

  const jobRows = [
    ['Job', `${job.name} (${job.jobKey})`],
    job.description ? ['Description', job.description] : null,
    ['Criticality', critical ? 'Critical' : 'Normal'],
    job.schedules?.length ? ['Schedule', job.schedules.map(scheduleText).join(', ')] : null,
    ['Next scheduled run', next ? showTime(next, tz) : '-'],
  ].filter(Boolean);

  const runRows = [
    ['Status', interrupted ? 'Interrupted' : 'Failed'],
    ['Triggered by', run.trigger === 'manual' ? 'Manual ("Run now" on the dashboard)' : 'Scheduled (server crontab)'],
    run.scheduledFor ? ['Scheduled slot', showTime(run.scheduledFor, tz)] : null,
    ['Started', showTime(run.startedAt, tz)],
    ['Ended', showTime(run.finishedAt, tz)],
    ['Duration', showDuration(run.durationMs)],
    ['Records fetched / processed', `${run.recordsFetched ?? 0} / ${run.recordsProcessed ?? 0}`],
    ['Consecutive failures', String(failures)],
    ['Last successful run', lastSuccess],
    ['Host', `${run.host || os.hostname()}${run.pid ? ` (pid ${run.pid})` : ''}`],
    ['Run ID', String(run.runId || run._id || '-')],
  ].filter(Boolean);

  const steps = suggestedSteps(run);
  const link = ALERTS.DASHBOARD_URL;

  // ---- plain text ----
  const text = [
    subject,
    '='.repeat(Math.min(subject.length, 72)),
    '',
    summary,
    impact ? `\nIMPACT\n${impact}` : '',
    `\nERROR\n${errorMessage}`,
    '\nJOB DETAILS', ...jobRows.map(([k, v]) => `  ${k}: ${v}`),
    '\nRUN DETAILS', ...runRows.map(([k, v]) => `  ${k}: ${v}`),
    '\nSUGGESTED NEXT STEPS', ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    link ? `\nCron dashboard: ${link}` : '',
    stack ? `\nTECHNICAL DETAILS\n${stack}` : '',
    '\n--',
    'This is an automated alert from the Accord Cron Monitor. One email is sent for every failed run.',
  ].join('\n');

  // ---- HTML (table layout + inline styles so it renders in Outlook and Gmail) ----
  const accent = critical ? '#B42318' : '#D92D20';
  const font = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const section = (title) => `<tr><td style="padding:24px 32px 8px;${font}font-size:13px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#475467">${esc(title)}</td></tr>`;
  const detailTable = (rows) => `
    <tr><td style="padding:0 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #EAECF0">
        ${rows.map(([k, v], i) => `
        <tr style="background:${i % 2 ? '#FFFFFF' : '#F9FAFB'}">
          <td style="padding:8px 12px;${font}font-size:13px;color:#667085;width:38%;vertical-align:top;border-bottom:1px solid #EAECF0">${esc(k)}</td>
          <td style="padding:8px 12px;${font}font-size:13px;color:#101828;vertical-align:top;border-bottom:1px solid #EAECF0">${esc(v)}</td>
        </tr>`).join('')}
      </table>
    </td></tr>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F2F4F7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F7;padding:24px 0">
<tr><td align="center">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#FFFFFF;border:1px solid #EAECF0;border-radius:8px;overflow:hidden">

    <tr><td style="background:${accent};padding:20px 32px">
      <div style="${font}font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#FEE4E2">Accord Cron Monitor${critical ? ' &middot; Critical' : ''}</div>
      <div style="${font}font-size:22px;font-weight:600;color:#FFFFFF;margin-top:4px">Cron job ${interrupted ? 'interrupted' : 'failed'}: ${esc(job.name)}</div>
    </td></tr>

    <tr><td style="padding:24px 32px 0;${font}font-size:15px;line-height:22px;color:#344054">${esc(summary)}</td></tr>

    ${impact ? `<tr><td style="padding:16px 32px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="background:#FFFAEB;border-left:4px solid #F79009;padding:12px 16px;${font}font-size:14px;line-height:20px;color:#93370D"><b>Impact:</b> ${esc(impact)}</td>
      </tr></table>
    </td></tr>` : ''}

    ${section('Error')}
    <tr><td style="padding:0 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="background:#FEF3F2;border-left:4px solid ${accent};padding:12px 16px;font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:19px;color:#912018;word-break:break-word">${esc(errorMessage)}</td>
      </tr></table>
    </td></tr>

    ${section('Job details')}
    ${detailTable(jobRows)}

    ${section('Run details')}
    ${detailTable(runRows)}

    ${section('Suggested next steps')}
    <tr><td style="padding:0 32px">
      <ol style="margin:0;padding-left:20px;${font}font-size:14px;line-height:21px;color:#344054">
        ${steps.map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join('')}
      </ol>
    </td></tr>

    ${link ? `<tr><td style="padding:20px 32px 0">
      <a href="${esc(link)}" style="display:inline-block;background:#1D2939;color:#FFFFFF;text-decoration:none;${font}font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px">Open cron dashboard</a>
    </td></tr>` : ''}

    ${stack ? `${section('Technical details')}
    <tr><td style="padding:0 32px">
      <pre style="margin:0;background:#F9FAFB;border:1px solid #EAECF0;padding:12px;font-family:Consolas,'Courier New',monospace;font-size:11px;line-height:16px;color:#475467;white-space:pre-wrap;word-break:break-word">${esc(stack)}</pre>
    </td></tr>` : ''}

    <tr><td style="padding:28px 32px 24px">
      <div style="border-top:1px solid #EAECF0;padding-top:16px;${font}font-size:12px;line-height:18px;color:#98A2B3">
        This is an automated alert from the Accord Cron Monitor. One email is sent for every failed run.<br>
        Please do not reply to this email.
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

module.exports = { notifyRunResult, buildMail, showDuration, suggestedSteps };
