// Accord feed collections: a staging ("dump") collection and a real collection per feed.
// In the main app these already exist; the additions are:
//   - staging rows get runId + stagedAt (stagedAt has a TTL, so crash leftovers disappear)
//   - real rows get cronRunId (so a run can count what it wrote)
//   - $merge needs a UNIQUE index on the key field of the real collection
const { mongoose } = require('../db');

const STAGING_TTL_SECONDS = 24 * 60 * 60;

function dumpModel(name, collection) {
  const schema = new mongoose.Schema(
    {
      runId: { type: mongoose.Schema.Types.ObjectId, index: true },
      stagedAt: { type: Date, index: { expireAfterSeconds: STAGING_TTL_SECONDS } },
    },
    { collection, strict: false, versionKey: false }
  );
  return mongoose.model(name, schema);
}

function targetModel(name, collection, keyField, extra = {}) {
  const schema = new mongoose.Schema(
    {
      [keyField]: { type: Number, required: true, unique: true }, // required by $merge `on`
      cronRunId: { type: mongoose.Schema.Types.ObjectId, index: true },
      crondate: Date, // kept: the existing feed-health check (PPR-567) reads it
      ...extra,
    },
    { collection, strict: false, versionKey: false }
  );
  return mongoose.model(name, schema);
}

module.exports = {
  CurrentNavDump: dumpModel('CurrentNavDump', 'current_nav_dump'),
  CurrentNav: targetModel('CurrentNav', 'current_nav', 'schemecode'),
  AmcMstDump: dumpModel('AmcMstDump', 'amc_mst_dump'),
  AmcMst: targetModel('AmcMst', 'amc_mst', 'amc_code'),
  SclassMstDump: dumpModel('SclassMstDump', 'sclass_mst_dump'),
  SclassMst: targetModel('SclassMst', 'sclass_mst', 'classcode'),
};
