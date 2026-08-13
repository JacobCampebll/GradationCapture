// Score the app's ACTUAL reading path against every photo whose true values are
// known. This drives readSheet() from index.html — the same function the
// Generate button calls — so the number it prints is the number the tech gets.
//
//   npm run read              all photos
//   npm run read slab2-07     one photo
//
// Requires a static server on :8412 serving the repo root.

import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const SLAB1 = ["", "", "", "139.4", "273.9", "", "624.7", "884.6", "1041.4",
  "1147.8", "1267.6", "1329.0", "1352.6", "1443.6", "1447.0"];
const SLAB2 = ["", "", "", "53.0", "145.4", "", "555.1", "874.8", "1079.1",
  "1200.6", "1273.0", "1315.0", "1342.2", "1475.5", "1476.6"];

const TRUTHS = {
  "slab1-rot90": SLAB1, "slab1-tilted": SLAB1,
};
["02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"]
  .forEach((n) => { TRUTHS["slab2-" + n] = SLAB2; });
TRUTHS["slab2-flat1"] = SLAB2;

const only = process.argv[2];
const photos = only ? only.split(",") : Object.keys(TRUTHS);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://127.0.0.1:8412/index.html");
await page.waitForSelector("#sieveBody tr");

const rows = await page.evaluate(async (args) => {
  const { photos, TRUTHS } = args;
  const out = [];
  for (const name of photos) {
    const truth = TRUTHS[name];
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = "test/fixtures/photos/" + name + ".jpg";
    });
    // Same path the Generate button takes: the two-scale ensemble.
    const t0 = performance.now();
    let r;
    try { r = readImageEnsemble(img, 0); }
    catch (e) { out.push({ name, err: "THREW " + e.message }); continue; }
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) { out.push({ name, err: r.reason, ms }); continue; }

    const got = r.results.map((x) => x.text || "");
    let cells = 0, dOK = 0, dTot = 0, lenOK = 0, lenTot = 0;
    truth.forEach((t, i) => {
      if (!t) return;
      lenTot++;
      const a = t.replace(".", ""), b = (got[i] || "").replace(".", "");
      if (b.length === a.length) lenOK++;
      if (got[i] === t) cells++;
      for (let k = 0; k < a.length; k++) {
        dTot++;
        if (b.length === a.length && b[k] === a[k]) dOK++;
      }
    });
    out.push({ name, cells, exp: truth.filter(Boolean).length, dOK, dTot,
      lenOK, lenTot, ms, got: got.map((x) => x || "-").join(" ") });
  }
  return out;
}, { photos, TRUTHS });

let tc = 0, te = 0, td = 0, tt = 0, tl = 0, tlt = 0;
rows.forEach((r) => {
  if (r.err) { console.log(`${r.name.padEnd(14)} ERR ${r.err}`); return; }
  tc += r.cells; te += r.exp; td += r.dOK; tt += r.dTot; tl += r.lenOK; tlt += r.lenTot;
  console.log(`${r.name.padEnd(14)} ${r.cells}/${r.exp} cells  ` +
    `${String(r.dOK).padStart(2)}/${r.dTot} digits  len ${r.lenOK}/${r.lenTot}  ` +
    `${r.ms}ms | ${r.got}`);
});
console.log(`\nTOTAL ${tc}/${te} cells   ${td}/${tt} digits   right-length ${tl}/${tlt}`);
await browser.close();
