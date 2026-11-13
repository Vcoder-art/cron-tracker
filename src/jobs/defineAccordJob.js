// J1: one factory for the standard Accord feed pattern.
//
//   fetch file -> validate -> stage rows tagged with runId -> $merge into target -> count -> clean staging
//
// Returns a job function that follows the tracker contract:
//   async (ctx) => ({ fetched, processed })   - or throws.
const axios = require('axios');
const { ACCORD, TIMEZONE } = require('../config');

// J4: Accord's file date must be the IST calendar date, whatever timezone the server runs in.
function accordDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.day}${parts.month}${parts.year}`; // DDMMYYYY
}

async function fetchAccordFile(file, section) {
  let res;
  try {
    res = await axios.get(`${ACCORD.BASE_URL}/RawData/GetTxtFile`, {
      params: { filename: file, date: accordDate(), section, sub: '', token: ACCORD.TOKEN },
      timeout: ACCORD.TIMEOUT_MS,
      validateStatus: (s) => s === 200,
    });
  } catch (e) {
    // J5: non-200, timeout, network error -> throw with a readable message
    const why = e.response ? `HTTP ${e.response.status}` : e.code === 'ECONNABORTED' ? `timeout after ${ACCORD.TIMEOUT_MS}ms` : e.code || e.message;
    throw new Error(`Accord ${file}: ${why}`);
  }
  if (!res.data || !Array.isArray(res.data.Table)) throw new Error(`Accord ${file}: response has no Table array`);
  return res.data.Table;
}

/**
 * @param {object} def
 * @param {string} def.file         Accord filename (e.g. "Currentnav")
 * @param {string} def.section      Accord section (e.g. "MFNav")
 * @param {Model}  def.dump         staging model
 * @param {Model}  def.target       target model (needs unique index on mergeOn)
 * @param {string} def.mergeOn      key field for $merge
 * @param {object} def.project      $project stage: how a staged row becomes a target row
 */
function defineAccordJob({ file, section, dump, target, mergeOn, project }) {
  return async function accordJob({ runId, log }) {
    const rows = await fetchAccordFile(file, section);
    log(`Accord ${file}: ${rows.length} rows`);
    if (rows.length === 0) return { fetched: 0, processed: 0 }; // tracker -> warning

    const stagedAt = new Date();
    try {
      // J2: stage only this run's rows, tagged so nothing else can be merged by mistake
      await dump.collection.insertMany(rows.map((r) => ({ ...r, runId, stagedAt })), { ordered: false });

      await dump.aggregate([
        { $match: { runId } },
        { $project: { _id: 0, ...project, crondate: '$$NOW', cronRunId: { $literal: runId } } },
        { $merge: { into: target.collection.collectionName, on: mergeOn, whenMatched: 'replace', whenNotMatched: 'insert' } },
      ]).allowDiskUse(true);

      // J3: what this run actually wrote
      const processed = await target.countDocuments({ cronRunId: runId });
      return { fetched: rows.length, processed };
    } finally {
      // runs on success AND failure; a hard crash is cleaned by the staging TTL index
      await dump.deleteMany({ runId }).catch((e) => log('staging cleanup failed:', e.message));
    }
  };
}

module.exports = { defineAccordJob, accordDate, fetchAccordFile };
