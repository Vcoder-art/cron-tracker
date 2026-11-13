// THE source of truth for which jobs exist, when they run and what code they execute (D1).
// Change a schedule here -> PR review -> deploy -> syncRegistry copies it into cron_jobs.
//
//   scheduler: 'internal' -> the worker process schedules it (node-cron)
//              'external' -> something outside (server crontab + curl) triggers it
//   retry:     worker-only; re-run a failed/empty scheduled run `attempts` more times, `delayMin` apart
//   handler:   the job function (NOT synced to Mongo - code only)
//
// LAB NOTE: amc_master / sclass_mst use fast schedules so you can watch them in minutes.
// Production values are in the comments.
const jobs = require('./accordJobs');

module.exports = [
  {
    jobKey: 'current_nav',
    name: 'Current NAV',
    description: 'Latest NAV per scheme from Accord (Currentnav file).',
    schedules: ['1 4 * * *', '31 7 * * *', '31 8 * * *', '1 10 * * *', '31 12 * * *', '31 14 * * *', '55 23 * * *'],
    scheduler: 'internal',
    criticality: 'critical',
    graceMin: 15,
    maxDurationMin: 10,
    retry: { attempts: 2, delayMin: 10 },
    handler: jobs.currentNav,
  },
  {
    jobKey: 'amc_master',
    name: 'AMC Master',
    description: 'AMC list from Accord (Amc_mst file).',
    schedules: ['*/2 * * * *'], // PROD: '40 23 * * *'
    scheduler: 'internal',
    criticality: 'normal',
    graceMin: 1, // PROD: 30
    maxDurationMin: 1, // PROD: 5
    retry: { attempts: 1, delayMin: 1 }, // PROD: { attempts: 2, delayMin: 15 }
    handler: jobs.amcMaster,
  },
  {
    jobKey: 'sclass_mst',
    name: 'Scheme Classification',
    description: 'Scheme class master from Accord (Sclass_mst file). Still triggered by the server crontab.',
    schedules: ['*/3 * * * *'], // PROD: '39 23 * * *'
    scheduler: 'external',
    criticality: 'normal',
    graceMin: 1, // PROD: 30
    maxDurationMin: 1, // PROD: 5
    handler: jobs.sclassMst,
  },
  {
    jobKey: 'nav_sanity_check',
    name: 'NAV Sanity Check',
    description: 'Custom (non-factory) job: fails if any scheme has a non-positive NAV.',
    schedules: ['45 14 * * *'],
    scheduler: 'internal',
    criticality: 'normal',
    graceMin: 15,
    maxDurationMin: 2,
    handler: jobs.navSanityCheck,
  },
];
