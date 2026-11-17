// The list of jobs. This file is the source of truth: on every start it is copied into cron_jobs.
//
// Each job runs only when the server crontab calls:  GET /api/accord-cron/<jobKey>
// Keep schedules equal to the crontab lines - the dashboard uses them to spot missed calls.
// handler is the code that runs (it is not stored in Mongo).
//
// LAB: amc_master and sclass_mst use fast schedules so you can watch them. Production values are in comments.
const jobs = require('./accordJobs');

module.exports = [
  {
    jobKey: 'current_nav',
    name: 'Current NAV',
    description: 'Latest NAV per scheme from Accord (Currentnav file).',
    schedules: ['1 4 * * *', '31 7 * * *', '31 8 * * *', '1 10 * * *', '31 12 * * *', '31 14 * * *', '55 23 * * *'],
    criticality: 'critical',
    graceMin: 15,
    maxDurationMin: 10,
    handler: jobs.currentNav,
  },
  {
    jobKey: 'amc_master',
    name: 'AMC Master',
    description: 'AMC list from Accord (Amc_mst file).',
    schedules: ['*/2 * * * *'], // PROD: '40 23 * * *'
    criticality: 'normal',
    graceMin: 1, // PROD: 30
    maxDurationMin: 1, // PROD: 5
    handler: jobs.amcMaster,
  },
  {
    jobKey: 'sclass_mst',
    name: 'Scheme Classification',
    description: 'Scheme class master from Accord (Sclass_mst file).',
    schedules: ['*/3 * * * *'], // PROD: '39 23 * * *'
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
    criticality: 'normal',
    graceMin: 15,
    maxDurationMin: 2,
    handler: jobs.navSanityCheck,
  },
];
