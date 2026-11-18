// Builds a job function for the usual Accord feed:
//
//   1. download the file from Accord
//   2. put the rows in a staging collection, tagged with this run's id
//   3. copy them into the real collection ($merge on a key field)
//   4. count how many rows this run wrote
//   5. empty the staging rows (also when something failed)
//
// The returned function follows the tracker's rule:  async (ctx) => ({ fetched, processed }), throws on failure.
const axios = require('axios');
const { ACCORD, TIMEZONE } = require('../config');

// Accord wants today's date in India as DDMMYYYY, whatever timezone the server runs in.
function accordDate(now = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return `${parts.day}${parts.month}${parts.year}`;
}

async function fetchAccordFile(file, section) {
  let res;
  try {
    res = await axios.get(`${ACCORD.BASE_URL}/RawData/GetTxtFile`, {
      params: { filename: file, date: accordDate(), section, sub: '', token: ACCORD.TOKEN },
      timeout: ACCORD.TIMEOUT_MS,
      validateStatus: (status) => status === 200,
    });
  } catch (e) {
    // Turn any HTTP / timeout / network error into one readable message.
    let why = e.code || e.message;
    if (e.response) why = `HTTP ${e.response.status}`;
    else if (e.code === 'ECONNABORTED') why = `timeout after ${ACCORD.TIMEOUT_MS}ms`;
    throw new Error(`Accord ${file}: ${why}`);
  }
  if (!res.data || !Array.isArray(res.data.Table)) throw new Error(`Accord ${file}: response has no Table array`);
  return res.data.Table;
}

/**
 * @param {string} file      Accord file name, e.g. "Currentnav"
 * @param {string} section   Accord section, e.g. "MFNav"
 * @param {Model}  dump      staging model
 * @param {Model}  target    real model (needs a unique index on mergeOn)
 * @param {string} mergeOn   key field used to match rows
 * @param {object} project   how a staged row becomes a target row ($project stage)
 */
function defineAccordJob({ file, section, dump, target, mergeOn, project }) {
  return async function accordJob({ runId, log }) {
    const rows = await fetchAccordFile(file, section);
    log(`Accord ${file}: ${rows.length} rows`);
    if (rows.length === 0) return { fetched: 0, processed: 0 }; // the tracker records this as a warning

    try {
      const stagedAt = new Date();
      await dump.collection.insertMany(rows.map((r) => ({ ...r, runId, stagedAt })), { ordered: false });

      await dump.aggregate([
        { $match: { runId } }, // only this run's rows
        { $project: { _id: 0, ...project, crondate: '$$NOW', cronRunId: { $literal: runId } } },
        { $merge: { into: target.collection.collectionName, on: mergeOn, whenMatched: 'replace', whenNotMatched: 'insert' } },
      ]).allowDiskUse(true);

      const processed = await target.countDocuments({ cronRunId: runId });
      return { fetched: rows.length, processed };
    } finally {
      // If the process crashes before this, a TTL index removes the staging rows after a day.
      await dump.deleteMany({ runId }).catch((e) => log('staging cleanup failed:', e.message));
    }
  };
}

module.exports = { defineAccordJob, accordDate, fetchAccordFile };
