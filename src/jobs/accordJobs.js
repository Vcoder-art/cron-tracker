// The Accord jobs. Most are just a few settings passed to defineAccordJob.
const { defineAccordJob } = require('./defineAccordJob');
const m = require('../models/accordFeeds');

const currentNav = defineAccordJob({
  file: 'Currentnav',
  section: 'MFNav',
  dump: m.CurrentNavDump,
  target: m.CurrentNav,
  mergeOn: 'schemecode',
  project: {
    schemecode: 1,
    navdate: { $dateFromString: { dateString: '$navdate' } },
    navrs: 1,
    prevnav: 1,
  },
});

const amcMaster = defineAccordJob({
  file: 'Amc_mst',
  section: 'MFMaster',
  dump: m.AmcMstDump,
  target: m.AmcMst,
  mergeOn: 'amc_code',
  project: { amc_code: 1, amc: 1 },
});

const sclassMst = defineAccordJob({
  file: 'Sclass_mst',
  section: 'MFMaster',
  dump: m.SclassMstDump,
  target: m.SclassMst,
  mergeOn: 'classcode',
  project: { classcode: 1, classname: 1 },
});

// A job that does not fit the pattern is just a normal function with the same rule:
// async (ctx) => ({ fetched, processed }), throw on failure.
async function navSanityCheck({ log }) {
  const total = await m.CurrentNav.estimatedDocumentCount();
  const bad = await m.CurrentNav.countDocuments({ $or: [{ navrs: { $lte: 0 } }, { navrs: null }] });
  log(`checked ${total} NAVs, ${bad} invalid`);
  if (bad > 0) throw new Error(`${bad} schemes have a non-positive NAV`);
  return { fetched: total, processed: total };
}

module.exports = { currentNav, amcMaster, sclassMst, navSanityCheck };
