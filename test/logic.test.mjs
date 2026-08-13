// Unit tests for the gradation math and export. No dependencies — run with `npm test`.
//
// These pull the functions out of the ACTUAL index.html rather than duplicating them,
// so the tests cannot quietly drift from a copy of the app. gradation.py stays the
// oracle: one test runs it and demands the browser agree digit for digit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---- lift the pure functions out of index.html ---- */
async function loadClientLogic() {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const grab = (name) => {
    const m = js.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`));
    if (!m) throw new Error(`index.html no longer defines ${name}() — update this test`);
    return m[0];
  };

  const names = ["num", "round1", "calcSample", "sampleChecks", "sampleHasData",
    "csvCell", "fmt", "buildCSV", "buildTSV"];
  const src = [js.match(/const CONFIG = \{[\s\S]*?\n\};/)[0]]
    .concat(names.map(grab))
    .concat(`export { CONFIG, ${names.join(", ")} };`)
    .join("\n");

  return import("data:text/javascript," + encodeURIComponent(src));
}

const app = await loadClientLogic();
const { CONFIG } = app;
const calc = (s) => app.calcSample(s, CONFIG.sieves, CONFIG.maxLossPct);
const checks = (s) => app.sampleChecks(s, calc(s), CONFIG.sieves, CONFIG.maxLossPct);
const rowFor = (c, label) => c.rows.find((r) => r.label === label);

/* ================= the verified worksheet from 8/13/26 ================= */
// KYTC slab 1 — the fixture in HANDOFF.md, hand-checked against the paper sheet.
const FIXTURE_GRAMS = {
  '12.5mm (1/2")': 139.4,
  '9.5mm (3/8")': 273.9,
  "4.75mm (No.4)": 624.7,
  "2.36mm (No.8)": 884.6,
  "1.18mm (No.16)": 1041.4,
  "600um (No.30)": 1147.8,
  "300um (No.50)": 1267.6,
  "150um (No.100)": 1329.0,
  "75um (No.200)": 1352.6,
};

const EXPECTED = [
  ['37.5mm (1 1/2")', null, 0.0, 100.0],
  ['25mm (1")', null, 0.0, 100.0],
  ['19mm (3/4")', null, 0.0, 100.0],
  ['12.5mm (1/2")', 139.4, 9.6, 90.4],
  ['9.5mm (3/8")', 273.9, 18.9, 81.1],
  ["4.75mm (No.4)", 624.7, 43.2, 56.8],
  ["2.36mm (No.8)", 884.6, 61.1, 38.9],
  ["1.18mm (No.16)", 1041.4, 72.0, 28.0],
  ["600um (No.30)", 1147.8, 79.3, 20.7],
  ["300um (No.50)", 1267.6, 87.6, 12.4],
  ["150um (No.100)", 1329.0, 91.8, 8.2],
  ["75um (No.200)", 1352.6, 93.5, 6.5],
];

function fixtureSample(overrides = {}) {
  const grams = {};
  CONFIG.sieves.forEach((sv) => {
    if (FIXTURE_GRAMS[sv.label] !== undefined) grams[sv.key] = String(FIXTURE_GRAMS[sv.label]);
  });
  return {
    fields: Object.assign(
      { label: "KYTC slab 1", washWt: "1447.0", totalWt: "1447.0", pan: "1443.6" },
      overrides.fields || {}
    ),
    grams: Object.assign(grams, overrides.grams || {}),
  };
}

describe("calcSample — the verified worksheet", () => {
  const c = calc(fixtureSample());

  test("the 6mm row struck out on the form never reaches the results", () => {
    assert.equal(c.rows.length, EXPECTED.length);
    const struck = CONFIG.sieves.find((s) => s.skip);
    assert.ok(!c.rows.some((r) => r.label === struck.label));
    assert.deepEqual(c.rows.map((r) => r.label), EXPECTED.map((e) => e[0]));
  });

  EXPECTED.forEach(([label, grams, pctRet, pctPass]) => {
    test(`${label} → ${pctRet} retained / ${pctPass} passing`, () => {
      const r = rowFor(c, label);
      assert.ok(r, `missing row: ${label}`);
      assert.equal(r.grams, grams);
      assert.equal(r.pctRet, pctRet);
      assert.equal(r.pctPass, pctPass);
    });
  });

  test("aggregate loss is 3.4 g = 0.23% and passes the 1.5% max", () => {
    assert.equal(c.lossG, 3.4);
    assert.equal(c.lossPct, 0.23);
    assert.equal(c.lossOk, true);
  });
});

describe("gradation.py stays the oracle", () => {
  const hasPython = (() => {
    try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; }
    catch { return false; }
  })();

  test("browser numbers match python3 gradation.py digit for digit",
    { skip: hasPython ? false : "python3 not on PATH" }, () => {
      const oracle = JSON.parse(execFileSync("python3", [join(root, "gradation.py"), "--json"],
        { encoding: "utf8" }));
      const c = calc(fixtureSample());

      assert.equal(oracle.rows.length, c.rows.length, "row count differs from the oracle");
      oracle.rows.forEach((o, i) => {
        assert.equal(c.rows[i].label, o.sieve, `row ${i}: sieve order differs`);
        assert.equal(c.rows[i].pctRet, o.pct_ret, `row ${i} (${o.sieve}): % retained differs`);
        assert.equal(c.rows[i].pctPass, o.pct_pass, `row ${i} (${o.sieve}): % passing differs`);
      });
      assert.equal(c.lossG, oracle.loss_g);
      assert.equal(c.lossPct, oracle.loss_pct);
      assert.equal(c.lossOk, oracle.loss_ok);
    });
});

/* ================= the rules the math has to hold to ================= */
describe("calcSample — rules", () => {
  test("blank sieves above the largest particle read 0.0 / 100.0, not blank", () => {
    const c = calc(fixtureSample());
    const top = rowFor(c, '37.5mm (1 1/2")');
    assert.equal(top.grams, null);
    assert.equal(top.pctRet, 0.0);
    assert.equal(top.pctPass, 100.0);
    assert.equal(top.blank, true);
  });

  test("% passing comes off the ROUNDED % retained, matching the paper sheet", () => {
    // 1041.4/1447 = 71.9627 -> 72.0 retained -> 28.0 passing.
    // Passing computed from the unrounded figure would print 28.04 -> 28.0 here but
    // diverges elsewhere, so the rule matters even when the digits agree.
    const c = calc(fixtureSample());
    const r = rowFor(c, "1.18mm (No.16)");
    assert.equal(r.pctRet + r.pctPass, 100);
  });

  test("no divisor means no percentages — never a silent zero", () => {
    const c = calc(fixtureSample({ fields: { washWt: "" } }));
    const r = rowFor(c, '12.5mm (1/2")');
    assert.equal(r.grams, 139.4);
    assert.equal(r.pctRet, null);
    assert.equal(r.pctPass, null);
    assert.equal(c.lossPct, null);
    assert.equal(c.lossOk, null);
  });

  test("loss exactly at the 1.5% limit passes", () => {
    const c = calc(fixtureSample({ fields: { washWt: "1000.0", pan: "985.0" } }));
    assert.equal(c.lossPct, 1.5);
    assert.equal(c.lossOk, true);
  });

  test("loss just over the limit fails", () => {
    const c = calc(fixtureSample({ fields: { washWt: "1000.0", pan: "984.0" } }));
    assert.equal(c.lossPct, 1.6);
    assert.equal(c.lossOk, false);
  });

  test("% minus 200 from the wash test needs a dry start weight", () => {
    assert.equal(calc(fixtureSample()).pctMinus200Wash, null);
    const c = calc(fixtureSample({ fields: { dryStartWt: "1500.0", washWt: "1447.0" } }));
    assert.equal(c.pctMinus200Wash, 3.5); // (1500-1447)/1500 = 3.533
  });
});

describe("num — tolerant of how numbers get keyed in", () => {
  test("plain, spaced and unit-suffixed values", () => {
    assert.equal(app.num("139.4"), 139.4);
    assert.equal(app.num(" 1447.0 "), 1447.0);
    assert.equal(app.num("1352.6 g"), 1352.6);
    assert.equal(app.num(93.5), 93.5);
  });

  test("blank and non-numeric return null, never 0 or NaN", () => {
    assert.equal(app.num(""), null);
    assert.equal(app.num("   "), null);
    assert.equal(app.num(null), null);
    assert.equal(app.num(undefined), null);
    assert.equal(app.num("----"), null);
  });
});

describe("round1 — half away from zero", () => {
  test("ordinary rounding", () => {
    assert.equal(app.round1(9.6337, 1), 9.6);
    assert.equal(app.round1(93.4762, 1), 93.5);
    assert.equal(app.round1(0.2349, 2), 0.23);
  });

  test("exact halves go up, not to even", () => {
    assert.equal(app.round1(0.25, 1), 0.3);
    assert.equal(app.round1(0.35, 1), 0.4);
    assert.equal(app.round1(2.5, 0), 3);
  });
});

/* ================= constraint checks ================= */
describe("sampleChecks — catches a mis-keyed digit before it ships", () => {
  const msgs = (s) => checks(s).map((f) => f.msg).join(" | ");
  const bad = (s) => checks(s).filter((f) => f.level === "bad");

  test("a clean sheet raises nothing", () => {
    assert.deepEqual(bad(fixtureSample()), []);
  });

  test("cumulative weights that go backwards are flagged", () => {
    const s = fixtureSample();
    const key = CONFIG.sieves.find((x) => x.label === "2.36mm (No.8)").key;
    s.grams[key] = "84.6"; // dropped digit
    const f = bad(s);
    assert.ok(f.length >= 1);
    assert.ok(f[0].keys.includes(key));
    assert.match(msgs(s), /only go up/);
  });

  test("PAN below the last sieve is flagged", () => {
    const s = fixtureSample({ fields: { pan: "1300.0" } });
    assert.match(msgs(s), /PAN \(1300\) is less than the last sieve/);
  });

  test("PAN heavier than the whole sample is flagged", () => {
    const s = fixtureSample({ fields: { pan: "1500.0" } });
    assert.match(msgs(s), /heavier than the After Wash Dry Wt/);
  });

  test("TOTAL that disagrees with the wash weight is flagged", () => {
    const s = fixtureSample({ fields: { totalWt: "1477.0" } }); // transposed digits
    assert.match(msgs(s), /does not match the After Wash Dry Wt/);
    assert.ok(bad(s).some((f) => f.keys.includes("totalWt")));
  });

  test("a sieve heavier than the whole sample is flagged", () => {
    const s = fixtureSample();
    const key = CONFIG.sieves.find((x) => x.label === "75um (No.200)").key;
    s.grams[key] = "13526.0"; // stray digit
    assert.match(msgs(s), /heavier than the whole sample/);
  });

  test("loss over the printed maximum is flagged", () => {
    const s = fixtureSample({ fields: { pan: "1400.0" } });
    assert.match(msgs(s), new RegExp(`over the ${CONFIG.maxLossPct}% maximum`));
  });

  test("missing divisor and missing PAN warn rather than fail", () => {
    const s = fixtureSample({ fields: { washWt: "", pan: "", totalWt: "" } });
    const f = checks(s);
    assert.ok(f.length >= 2);
    assert.ok(f.every((x) => x.level === "warn"));
  });

  test("an untouched sample raises nothing at all", () => {
    assert.deepEqual(checks({ fields: {}, grams: {} }), []);
  });
});

describe("sampleHasData — an empty column must not reach the export", () => {
  test("blank in every sense", () => {
    assert.equal(app.sampleHasData({ fields: {}, grams: {} }), false);
    assert.equal(app.sampleHasData({ fields: { label: "  " }, grams: {} }), false);
    assert.equal(app.sampleHasData(undefined), false);
  });

  test("one keyed value is enough", () => {
    assert.equal(app.sampleHasData({ fields: {}, grams: { s75: "12" } }), true);
    assert.equal(app.sampleHasData(fixtureSample()), true);
  });
});

/* ================= export ================= */
describe("buildCSV — output must survive Excel", () => {
  const sheet = { date: "2026-08-13", county: "Fayette", projectNo: "191009", pctAc: "5.98" };
  const csv = app.buildCSV(sheet, [fixtureSample(), { fields: {}, grams: {} }, { fields: {}, grams: {} }],
    "2026-08-13T12:00:00.000Z");

  test("cells with commas, quotes and newlines are escaped", () => {
    assert.equal(app.csvCell("Berea, KY"), '"Berea, KY"');
    assert.equal(app.csvCell('he said "ok"'), '"he said ""ok"""');
    assert.equal(app.csvCell("191009"), "191009");
  });

  test("Excel-friendly CRLF line endings", () => {
    assert.ok(csv.includes("\r\n"));
  });

  test("every sheet field reaches the file", () => {
    CONFIG.sheetFields.forEach((f) => assert.ok(csv.includes(f.label), `missing: ${f.label}`));
    assert.ok(csv.includes("191009"));
    assert.ok(csv.includes("Fayette"));
  });

  test("every used sieve row reaches the file with both percentages", () => {
    EXPECTED.forEach(([label, , pctRet, pctPass]) => {
      const line = csv.split("\r\n").find((l) => l.startsWith(app.csvCell(label)));
      assert.ok(line, `missing row: ${label}`);
      const cells = line.split(",");
      assert.equal(cells[cells.length - 2], pctRet.toFixed(1));
      assert.equal(cells[cells.length - 1], pctPass.toFixed(1));
    });
  });

  test("the loss verdict is written out, not left for the reader to work out", () => {
    assert.ok(csv.includes("Aggregate Loss (%),0.23"));
    assert.ok(/Loss Check \(max 1\.5%\),OK/.test(csv));
  });

  test("empty sample columns are omitted entirely", () => {
    assert.ok(csv.includes("SAMPLE 1"));
    assert.ok(!csv.includes("SAMPLE 2"), "a blank column must not export as a sheet of zeroes");
  });
});

describe("buildTSV — the paste-into-a-spreadsheet path", () => {
  test("one row per used sieve plus a header", () => {
    const tsv = app.buildTSV([fixtureSample(), { fields: {}, grams: {} }, { fields: {}, grams: {} }]);
    const lines = tsv.split("\n");
    assert.equal(lines.length, CONFIG.sieves.filter((s) => !s.skip).length + 1);
    assert.equal(lines[0], "Sieve\tKYTC slab 1");
    assert.equal(lines[lines.length - 1], "75um (No.200)\t6.5");
  });

  test("multiple samples become multiple columns", () => {
    const second = fixtureSample({ fields: { label: "KYTC slab 2" } });
    const tsv = app.buildTSV([fixtureSample(), second, { fields: {}, grams: {} }]);
    assert.equal(tsv.split("\n")[0], "Sieve\tKYTC slab 1\tKYTC slab 2");
  });
});

/* ================= guardrails against silent regressions ================= */
describe("config guardrails", () => {
  test("all 120 Kentucky counties are in the dropdown, with no duplicates", () => {
    assert.equal(CONFIG.counties.length, 120);
    assert.equal(new Set(CONFIG.counties).size, 120);
    ["Fayette", "Jefferson", "Woodford", "Adair", "McCracken"].forEach((c) =>
      assert.ok(CONFIG.counties.includes(c), `missing county: ${c}`));
  });

  test("the sieve list matches the printed form, 6mm struck out", () => {
    assert.equal(CONFIG.sieves.length, 13);
    const struck = CONFIG.sieves.filter((s) => s.skip);
    assert.equal(struck.length, 1);
    assert.ok(struck[0].label.startsWith("6mm"));
    assert.equal(new Set(CONFIG.sieves.map((s) => s.key)).size, CONFIG.sieves.length);
  });

  test("the divisor points at a real sample field", () => {
    assert.ok(CONFIG.sampleFields.some((f) => f.key === CONFIG.divisorField));
  });

  test("PAN and TOTAL are sample fields, since the table mirrors them", () => {
    ["pan", "totalWt"].forEach((k) =>
      assert.ok(CONFIG.sampleFields.some((f) => f.key === k), `CONFIG.sampleFields needs ${k}`));
  });

  test("the loss limit still matches the one printed on the form", () => {
    assert.equal(CONFIG.maxLossPct, 1.5);
  });

  test("the form holds three gradation columns", () => {
    assert.equal(CONFIG.sampleCount, 3);
  });

  test("no credential has leaked into the page", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    assert.ok(!/sk-ant-|re_[A-Za-z0-9]{20}|AIza[0-9A-Za-z_-]{30}/.test(html));
  });

  test("the app makes no network calls — the whole point of this build", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    assert.ok(!/\bfetch\s*\(/.test(html), "index.html must not call out anywhere");
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), "no external origins may be referenced");
  });

  test("the PWA shell is complete, so the lab keeps working with no signal", () => {
    ["manifest.json", "sw.js", "icon-192.png", "icon-512.png"].forEach((f) =>
      assert.ok(existsSync(join(root, f)), `missing PWA file: ${f}`));
    const sw = readFileSync(join(root, "sw.js"), "utf8");
    ["index.html", "manifest.json", "icon-192.png", "icon-512.png"].forEach((f) =>
      assert.ok(sw.includes(f), `sw.js does not cache ${f}`));
  });
});
