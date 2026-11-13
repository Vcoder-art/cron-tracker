// Fake Accord content API.
// Same URL shape as the real one:
//   GET /RawData/GetTxtFile?filename=Currentnav&date=DDMMYYYY&section=MFNav&sub=&token=...
// Responds like Accord: { Table: [ ...rows ] }
//
// To exercise every dashboard status it randomly:
//   - waits up to MOCK_MAX_DELAY_MS        (slow feed      -> long duration)
//   - returns HTTP 500 at MOCK_FAIL_RATE   (Accord down    -> failed run)
//   - returns an empty Table at EMPTY_RATE (file not ready -> warning run)
// You can force one of these with ?force=fail | empty | slow
const express = require('express');
const { MOCK } = require('../src/config');

const app = express();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Row generators, one per feed file. Shapes are cut-down versions of the real files.
const FEEDS = {
  Currentnav: (i) => ({
    schemecode: 1000 + i,
    navdate: new Date().toISOString().slice(0, 10),
    navrs: +(10 + Math.random() * 90).toFixed(4),
    prevnav: +(10 + Math.random() * 90).toFixed(4),
  }),
  Amc_mst: (i) => ({ amc_code: 100 + i, amc: `Lab AMC ${i}` }),
  Sclass_mst: (i) => ({ classcode: i, classname: `Class ${i}` }),
};

// Runtime switch per file, so you can "break Accord" while watching the dashboard:
//   GET /__chaos                                 -> current modes
//   GET /__chaos/set?file=Currentnav&mode=fail   -> fail | empty | slow | normal | random
// normal = always succeed, random = use the MOCK_*_RATE knobs (default).
const MODES = ['fail', 'empty', 'slow', 'normal', 'random'];
const chaos = Object.fromEntries(Object.keys(FEEDS).map((f) => [f, 'random']));
app.get('/__chaos', (req, res) => res.json(chaos));
app.get('/__chaos/set', (req, res) => {
  const { file, mode } = req.query;
  const files = file === 'all' ? Object.keys(FEEDS) : [file];
  if (!MODES.includes(mode) || !files.every((f) => FEEDS[f])) return res.status(400).json({ error: `file must be one of ${Object.keys(FEEDS)} or all, mode one of ${MODES}` });
  files.forEach((f) => { chaos[f] = mode; });
  console.log(`[mock-accord] chaos ${files.join(',')} -> ${mode}`);
  res.json(chaos);
});

app.get('/RawData/GetTxtFile', async (req, res) => {
  const { filename } = req.query;
  const mode = req.query.force || chaos[filename];
  const force = mode === 'random' ? undefined : mode === 'normal' ? 'normal' : mode;
  const make = FEEDS[filename];
  if (!make) return res.status(404).json({ error: `unknown file ${filename}` });

  const delay = force === 'slow' ? MOCK.MAX_DELAY_MS * 3 : force === 'normal' ? 100 : Math.random() * MOCK.MAX_DELAY_MS;
  await sleep(delay);

  if (force === 'fail' || (!force && Math.random() < MOCK.FAIL_RATE)) {
    console.log(`[mock-accord] ${filename} -> 500`);
    return res.status(500).json({ error: 'Accord internal error (simulated)' });
  }
  if (force === 'empty' || (!force && Math.random() < MOCK.EMPTY_RATE)) {
    console.log(`[mock-accord] ${filename} -> empty Table`);
    return res.json({ Table: [] });
  }

  const count = 200 + Math.floor(Math.random() * 300);
  console.log(`[mock-accord] ${filename} -> ${count} rows after ${Math.round(delay)}ms`);
  res.json({ Table: Array.from({ length: count }, (_, i) => make(i)) });
});

app.listen(MOCK.PORT, () => console.log(`[mock-accord] listening on :${MOCK.PORT}`));
