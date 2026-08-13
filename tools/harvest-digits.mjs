// Harvest labelled digit glyphs from the photo corpus.
//
// Runs the app's own extraction over every photo whose true values are known.
// Wherever a cell yields exactly as many glyphs as its true value has digits,
// each glyph gets that positional label — real training data in this lab's own
// handwriting, which is precisely what the MNIST-trained classifier lacks.
//
//   node tools/harvest-digits.mjs             -> test/fixtures/real-digits.json
//
// Requires a static server on :8412 serving the repo root.

import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SLAB1 = ["", "", "", "139.4", "273.9", "", "624.7", "884.6", "1041.4",
  "1147.8", "1267.6", "1329.0", "1352.6", "1443.6", "1447.0"];
const SLAB2 = ["", "", "", "53.0", "145.4", "", "555.1", "874.8", "1079.1",
  "1200.6", "1273.0", "1315.0", "1342.2", "1475.5", "1476.6"];
const TRUTHS = { "slab1-rot90": SLAB1, "slab1-tilted": SLAB1 };
["02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"]
  .forEach((n) => { TRUTHS["slab2-" + n] = SLAB2; });
TRUTHS["slab2-flat1"] = SLAB2;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://127.0.0.1:8412/index.html");
await page.waitForSelector("#sieveBody tr");

const samples = await page.evaluate(async (TRUTHS) => {
  const layers = decodeModel(MODEL_WEIGHTS_B64, MODEL_META);
  const out = [];
  for (const name of Object.keys(TRUTHS)) {
    const truth = TRUTHS[name];
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = "test/fixtures/photos/" + name + ".jpg";
    });
    const W = Math.min(1800, img.naturalWidth);
    const H = Math.round(img.naturalHeight * W / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const raw = toGrayscale(ctx.getImageData(0, 0, W, H).data, W, H);
    const flat = rectifyPage(raw, W, H, 2400);
    if (!flat) continue;
    let g = flat.gray, gw = flat.w, gh = flat.h;
    if (gh > gw) { const r = rotate90(g, gw, gh, 1); g = r.gray; gw = r.w; gh = r.h; }
    let snap = null, turn = 0, best = -Infinity;
    for (const t of [0, 2]) {
      const r = rotate90(g, gw, gh, t);
      const s = snapTemplate(r.gray, r.w, r.h, 0, CONFIG.sieves);
      const sc = uprightScore(s, r.w, r.h);
      if (sc > best) { best = sc; snap = s; turn = t; }
    }
    if (turn) { const r = rotate90(g, gw, gh, turn); g = r.gray; gw = r.w; gh = r.h; }
    const cells = snappedCells(snap, CONFIG.sieves);

    // the same offset probe readSheet uses
    const deltas = [];
    cells.forEach((cell) => {
      if (cell.skip) return;
      const probe = readCell(g, gw, gh, cell, layers);
      (probe.lines || []).forEach((d) => { if (Math.abs(d) <= cell.h * 0.9) deltas.push(d); });
    });
    let yOffset = 0;
    if (deltas.length >= 3) { deltas.sort((a, b) => a - b); yOffset = deltas[deltas.length >> 1]; }

    cells.forEach((cell, i) => {
      const want = (truth[i] || "").replace(".", "");
      if (cell.skip || !want) return;
      const read = readCell(g, gw, gh, Object.assign({ yOffset }, cell), layers);
      if (!read.glyphPx || read.glyphPx.length !== want.length) return;
      read.glyphPx.forEach((px, k) => {
        out.push({
          photo: name, cell: cell.key, pos: k, label: Number(want[k]),
          px: Array.from(px, (v) => Math.round(v * 255)),
        });
      });
    });
  }
  return out;
}, TRUTHS);

const byLabel = {};
samples.forEach((s) => { byLabel[s.label] = (byLabel[s.label] || 0) + 1; });
console.log(`harvested ${samples.length} labelled glyphs`);
console.log("per digit:", JSON.stringify(byLabel));
writeFileSync(join(root, "test", "fixtures", "real-digits.json"),
  JSON.stringify({ note: "labelled glyphs harvested from the photo corpus by tools/harvest-digits.mjs", samples }));
console.log("wrote test/fixtures/real-digits.json");
await browser.close();
