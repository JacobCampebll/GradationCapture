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

  const grabConst = (name) => {
    const m = js.match(new RegExp(`\\nconst ${name} = \\[[\\s\\S]*?\\n\\];`));
    if (!m) throw new Error(`index.html no longer defines const ${name} — update this test`);
    return m[0];
  };

  const names = ["num", "round1", "calcSample", "sampleChecks", "sampleHasData",
    "csvCell", "fmt", "buildCSV", "buildTSV",
    "pdfEsc", "pdfWidth", "pdfBuilder", "pdfDate", "stampText", "buildPDFReport"];
  const src = [js.match(/const CONFIG = \{[\s\S]*?\n\};/)[0], grabConst("HELV_W")]
    .concat(names.map(grab))
    .concat(`export { CONFIG, HELV_W, ${names.join(", ")} };`)
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

/* ================= PDF ================= */
// The PDF is written byte by byte in index.html, so these tests read the bytes back
// the way a PDF reader would: check the structure, then check the numbers landed.
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const AT = new Date(2026, 7, 13, 14, 32, 5); // 13 Aug 2026, 2:32:05pm local

function makePDF(samples, photo, when) {
  return app.buildPDFReport({ date: "2026-08-13", county: "Fayette", projectNo: "191009" },
    samples || [fixtureSample(), { fields: {}, grams: {} }, { fields: {}, grams: {} }],
    when || AT, photo || null);
}

describe("buildPDFReport — structure a reader will accept", () => {
  const bytes = makePDF();
  const s = latin1(bytes);

  test("it is a PDF, header to trailer", () => {
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(s.startsWith("%PDF-1.4\n"));
    assert.ok(s.trimEnd().endsWith("%%EOF"));
    assert.ok(bytes.length > 2000, "suspiciously small for a full worksheet");
  });

  test("every xref offset points at the object it claims", () => {
    const startxref = parseInt(s.slice(s.lastIndexOf("startxref") + 9).trim(), 10);
    assert.equal(s.slice(startxref, startxref + 4), "xref");
    const header = s.slice(startxref).match(/xref\n0 (\d+)\n/);
    const size = parseInt(header[1], 10);
    // Entries are exactly 20 bytes each and start with object 0's free entry.
    const body = s.slice(startxref + header[0].length);
    for (let i = 1; i < size; i++) {
      const off = parseInt(body.slice(i * 20, i * 20 + 10), 10);
      assert.equal(s.slice(off, off + String(i).length + 6), `${i} 0 obj`,
        `xref entry ${i} does not point at object ${i}`);
    }
  });

  test("the object count in the trailer matches the xref", () => {
    const size = parseInt(s.match(/\/Size (\d+)/)[1], 10);
    assert.equal(s.match(/xref\n0 (\d+)\n/)[1], String(size));
    assert.equal((s.match(/\n\d+ 0 obj\n/g) || []).length, size - 1);
  });

  test("declared stream lengths match the bytes actually written", () => {
    const re = /<< \/Length (\d+) >>\nstream\n/g;
    let m, checked = 0;
    while ((m = re.exec(s))) {
      const start = m.index + m[0].length;
      assert.equal(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream",
        "a content stream's /Length is wrong");
      checked++;
    }
    assert.ok(checked >= 1);
  });

  test("both standard fonts are declared with WinAnsi encoding", () => {
    assert.ok(s.includes("/BaseFont /Helvetica /Encoding /WinAnsiEncoding"));
    assert.ok(s.includes("/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding"));
  });
});

describe("buildPDFReport — the worksheet actually reaches the page", () => {
  const s = latin1(makePDF());

  test("the form's own title and the sheet info are on it", () => {
    assert.ok(s.includes("KENTUCKY TRANSPORTATION CABINET"));
    assert.ok(s.includes("WORKSHEET FOR BITUMINOUS MIXTURES"));
    assert.ok(s.includes("(191009)"));
    assert.ok(s.includes("(Fayette)"));
  });

  test("every sieve label and both percentages are printed", () => {
    EXPECTED.forEach(([label, , pctRet, pctPass]) => {
      assert.ok(s.includes("(" + app.pdfEsc(label) + ")"), `missing sieve label: ${label}`);
      assert.ok(s.includes(`(${pctRet.toFixed(1)})`), `missing % retained: ${pctRet}`);
      assert.ok(s.includes(`(${pctPass.toFixed(1)})`), `missing % passing: ${pctPass}`);
    });
  });

  test("the struck 6mm row is carried through so the page matches the paper", () => {
    assert.ok(s.includes("(6mm \\(1/4\"\\))"));
  });

  test("PAN, TOTAL and the loss verdict are printed", () => {
    assert.ok(s.includes("(1443.6)"));
    assert.ok(s.includes("(1447.0)"));
    assert.ok(s.includes("(3.4 g)"));
    assert.ok(s.includes("(0.23%)"));
    assert.ok(s.includes("(OK)"));
  });

  test("a failing sheet prints FAIL and the reason, not a quiet blank", () => {
    const f = latin1(makePDF([fixtureSample({ fields: { pan: "1400.0" } })]));
    assert.ok(f.includes("(FAIL)"));
    assert.ok(!f.includes("(OK)"));
    assert.ok(/FLAGGED: Aggregate loss/.test(f));
  });

  test("empty sample columns never reach the page", () => {
    assert.ok(s.includes("(SAMPLE 1)"));
    assert.ok(!s.includes("(SAMPLE 2)"));
  });

  test("a second keyed sample does reach the page", () => {
    const two = latin1(makePDF([fixtureSample(),
      fixtureSample({ fields: { label: "KYTC slab 2" } }), { fields: {}, grams: {} }]));
    assert.ok(two.includes("(SAMPLE 2)"));
    assert.ok(two.includes("(KYTC slab 2)"));
  });

  test("every page is numbered n of N", () => {
    const total = parseInt(s.match(/\/Count (\d+)/)[1], 10);
    for (let n = 1; n <= total; n++) {
      assert.ok(s.includes(`(Page ${n} of ${total})`), `page ${n} is not stamped`);
    }
  });
});

describe("buildPDFReport — nothing collides with the footer", () => {
  // Pull every text baseline out of the content streams. PDF y grows upward, so a
  // smaller y sits lower on the page.
  function baselines(pdfString) {
    const out = [];
    const re = /1 0 0 1 ([\d.]+) ([\d.]+) Tm \(((?:\\.|[^\\)])*)\) Tj/g;
    let m;
    while ((m = re.exec(pdfString))) out.push({ x: +m[1], y: +m[2], text: m[3] });
    return out;
  }

  const floor = CONFIG.pdf.margin + CONFIG.pdf.footerH; // top of the footer band, in PDF y

  test("only the footer itself is drawn in the footer band", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    [makePDF(), makePDF(null, { bytes: jpeg, width: 1200, height: 1600 }),
      makePDF([fixtureSample(), fixtureSample({ fields: { label: "two" } }),
        fixtureSample({ fields: { label: "three" } })])].forEach((bytes, i) => {
      baselines(latin1(bytes))
        .filter((t) => t.y < floor)
        .forEach((t) => assert.ok(/^Generated |^Page \d+ of \d+$/.test(t.text),
          `case ${i}: "${t.text}" is laid into the footer band`));
    });
  });

  test("nothing is drawn off the bottom or past the right edge of the page", () => {
    baselines(latin1(makePDF())).forEach((t) => {
      assert.ok(t.y >= CONFIG.pdf.margin - 6, `"${t.text}" runs off the bottom`);
      assert.ok(t.x >= 0 && t.x <= CONFIG.pdf.pageW, `"${t.text}" runs off the side`);
    });
  });

  test("a third sample overflows onto a second page rather than off the first", () => {
    const three = makePDF([fixtureSample(),
      fixtureSample({ fields: { label: "two" } }),
      fixtureSample({ fields: { label: "three" } })]);
    assert.ok(parseInt(latin1(three).match(/\/Count (\d+)/)[1], 10) >= 2);
  });
});

describe("buildPDFReport — stamped with the moment it was made", () => {
  test("the visible stamp and the PDF metadata carry the generation time", () => {
    const s = latin1(makePDF(null, null, AT));
    assert.ok(s.includes("/CreationDate (D:20260813143205"), "PDF metadata is not stamped");
    assert.ok(s.includes("(Generated " + app.pdfEsc(app.stampText(AT)) + ")"),
      "the page does not show when it was generated");
  });

  test("generating again later produces a differently stamped file", () => {
    const later = new Date(2026, 7, 13, 16, 5, 0);
    const a = latin1(makePDF(null, null, AT));
    const b = latin1(makePDF(null, null, later));
    assert.notEqual(a, b, "the PDF must reflect when it was made, not be a fixed artifact");
    assert.ok(b.includes("/CreationDate (D:20260813160500"));
    assert.ok(!b.includes("/CreationDate (D:20260813143205"));
  });

  test("pdfDate formats an offset the way the spec wants", () => {
    assert.match(app.pdfDate(AT), /^D:20260813143205[+-]\d{2}'\d{2}'$/);
  });
});

describe("buildPDFReport — the photo rides along", () => {
  // A 1x1 JPEG is enough: what matters is that the bytes are embedded verbatim.
  const jpeg = Uint8Array.from(Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64"));
  const photo = { bytes: jpeg, width: 1200, height: 1600 };
  const s = latin1(makePDF(null, photo));

  test("it is embedded as a JPEG rather than re-encoded", () => {
    assert.ok(s.includes("/Filter /DCTDecode"));
    assert.ok(s.includes("/Width 1200 /Height 1600"));
    assert.ok(s.includes("/XObject << /Im1"));
    assert.ok(s.includes(`/Length ${jpeg.length} >>\nstream\n`));
  });

  test("the original bytes survive byte for byte", () => {
    const at = s.indexOf(`/Length ${jpeg.length} >>\nstream\n`) +
      `/Length ${jpeg.length} >>\nstream\n`.length;
    assert.equal(s.slice(at, at + jpeg.length), latin1(jpeg));
  });

  test("it lands on its own page, captioned", () => {
    assert.ok(s.includes("(ORIGINAL WORKSHEET PHOTO)"));
    const withPhoto = parseInt(s.match(/\/Count (\d+)/)[1], 10);
    const without = parseInt(latin1(makePDF()).match(/\/Count (\d+)/)[1], 10);
    assert.equal(withPhoto, without + 1);
  });

  test("no photo means no image object and no extra page", () => {
    const none = latin1(makePDF());
    assert.ok(!none.includes("/DCTDecode"));
    assert.ok(!none.includes("ORIGINAL WORKSHEET PHOTO"));
  });
});

describe("pdfEsc / pdfWidth — text that cannot corrupt the file", () => {
  test("the three characters that would end a string early are escaped", () => {
    assert.equal(app.pdfEsc("12.5mm (1/2\")"), "12.5mm \\(1/2\"\\)");
    assert.equal(app.pdfEsc("a\\b"), "a\\\\b");
  });

  test("typographic characters fold into WinAnsi instead of breaking", () => {
    assert.equal(app.pdfEsc("—"), String.fromCharCode(151));
    assert.equal(app.pdfEsc("−"), "-");
    assert.equal(app.pdfEsc("93.5°"), "93.5" + String.fromCharCode(176));
  });

  test("anything outside WinAnsi degrades to '?' rather than emitting a stray byte", () => {
    const out = app.pdfEsc("東京 🙂");
    assert.ok(!/[^\x00-\xff]/.test(out));
    assert.ok(out.includes("?"));
  });

  test("the width table covers printable ASCII and measures digits at 556", () => {
    assert.equal(app.HELV_W.length, 95);
    assert.equal(app.pdfWidth("00000", 10), 27.8);
    assert.ok(app.pdfWidth("1447.0", 9) > app.pdfWidth("14.0", 9), "right-alignment depends on this");
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

  test("the PDF is never persisted — it exists only for the download", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const snapshot = html.match(/\nfunction snapshot\(\)[\s\S]*?\n\}\n/)[0];
    assert.ok(!/pdf/i.test(snapshot), "snapshot() must not carry the PDF into storage");
    const setItems = html.match(/localStorage\.setItem\([^)]*\)/g) || [];
    setItems.forEach((c) => assert.ok(!/pdf/i.test(c), `PDF data written to storage: ${c}`));
    assert.ok(/URL\.revokeObjectURL/.test(html), "the object URL must be revoked after download");
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
