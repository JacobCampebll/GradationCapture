# KYTC Gradation Capture

Phone app for the KYTC **Worksheet for Bituminous Mixtures**. Photograph the sheet, key the
cumulative grams-retained column while zooming the photo, and the app computes % retained,
% passing and the aggregate-loss check — then exports a timestamped PDF, a CSV, or a
paste-ready table.

Runs entirely on the phone. **No API, no key, no server, no network call of any kind.** It
installs to the home screen and works with no signal in the lab.

---

## Try it in 30 seconds

1. Open `index.html` in a browser (double-click works; nothing needs a server).
2. Set **After Wash Dry Wt.** to `1447.0`.
3. Key the grams column: `139.4, 273.9, 624.7, 884.6, 1041.4, 1147.8, 1267.6, 1329.0, 1352.6`
   starting at the 12.5mm row, then `1443.6` in PAN.
4. You should see `9.6 / 90.4` on the 12.5mm row, `93.5 / 6.5` on the No.200 row, and
   **Aggregate loss 3.4 g = 0.23% — OK**.
5. Press **Download PDF** — you get the whole worksheet, stamped with the current time.

That is the 8/13/26 "KYTC slab 1" sheet, hand-verified. If those numbers appear, the app is good.

---

## What it does

| | |
|---|---|
| **Photo** | Taken with the phone camera, downscaled to 1600px, stored on the device. Tap to open full screen with rotate and zoom, so you can read a cell while typing it. |
| **Three sample columns** | The paper form holds three gradations side by side. Tabs switch between them; a summary table compares % passing across all three. |
| **The math** | Cumulative grams ÷ After Wash Dry Wt. `% passing` is computed from the **rounded** % retained, matching the paper sheet. Blank sieves above the largest particle read 0.0 / 100.0. |
| **Loss check** | `After Wash Dry Wt. − PAN`, against the 1.5% maximum printed on the form. Pass/fail is shown, never left for the reader to work out. |
| **Constraint checks** | Cumulative weights that go backwards, PAN below the last sieve or above the sample weight, a TOTAL that disagrees with the wash weight, a sieve heavier than the whole sample, loss over the limit. Offending cells turn red with a plain-English reason. |
| **% Minus 200** | Both numbers are reported and labelled: the wash-test figure (needs Dry Start Wt.) and the gradation's % passing the No.200. They are different numbers and get mixed up on paper. |
| **PDF** | A printable copy of the worksheet with the photo inside it, built the moment you press the button and stamped with that time. See below. |
| **Export** | CSV download (Excel-safe, BOM + CRLF), "Copy Table" for pasting % passing straight into a spreadsheet, and a photo download so the record travels with the data. |
| **Offline** | PWA. Work in progress autosaves; up to 8 finished sheets can be parked on the phone. |

### The PDF

Press **Download PDF** and the file is assembled right then, stamped with that moment in both
the page footer and the PDF's own metadata, and handed straight to your downloads. It lays out
like the paper form — same sieve rows in the same order, including the struck-out 6mm row — with
the loss verdict as an OK/FAIL chip, any flagged rows spelled out underneath, and the original
photo on its own page at the end.

**It is never stored.** The bytes exist for the length of the button press: nothing is cached,
queued, or written to phone storage, and the object URL is released behind the download. Leave
the page and it is gone. Press it again and you get a current copy with a new timestamp — so
what you hand someone is always dated when you made it, never a stale file the app was sitting on.

The PDF is written byte by byte in `index.html` using the two fonts every reader already has.
There is no library and no CDN — same rule as the rest of the app, and it works in airplane mode.

### Header fields are typed, not read

Date, County, Project No., Producer, Type of Material, Percent Rap, Percent A.C., Temp. of Mix.
County is a dropdown of all 120 Kentucky counties. Free-text handwriting is the one thing a
local reader cannot do well, and typing beats correcting bad OCR.

---

## Reading the photo — where that stands

The goal is: photograph the sheet, the values arrive filled in, you glance and confirm, you get
a PDF. No typing. Four of the five pieces are built and tested. One is blocked.

| Piece | State |
|---|---|
| **Digit classifier** | **Done.** 8,778-parameter conv net, MNIST + heavy augmentation. 98.7% on clean test digits, 95.2% on augmented ones. Ships as `model.js` (46 KB) inside the app — no ONNX, no CDN, no fetch. |
| **Inference in the browser** | **Done.** Hand-written JS forward pass. A test replays 40 held-out digits through both Python and JS and fails if any logit disagrees by more than 2e-3. |
| **Glyph normalisation** | **Done.** `prepareGlyph` crops to the ink, scales the long side to 20px, and centres by centre of mass — the MNIST convention. Skipping this is the usual reason an MNIST net collapses on real input. |
| **Constraint solver** | **Done.** `cellCandidates` beams over the top digits per position; `solveCumulative` picks the combination that keeps the cumulative weights increasing. A leading digit misread so the row goes backwards gets repaired from the runner-up, and the cell is flagged as repaired. |
| **Finding the cells in a photo** | **In progress — 2 of 20 photos.** See below. |

### Where segmentation stands

20 real photos live in `test/fixtures/photos` — every orientation, several angles, glare, and
one low-resolution screenshot. `npm run seg` scores the segmenter against all of them.

**Currently 2 of 20.** It finds the page, corrects skew, tries all four quarter turns, and uses
the wide SPECIFICATION column to tell upright from upside-down. What it cannot yet do reliably
is string together all 16 row rules and all 10 column rules on a sheet photographed at an angle:
the detector finds 18-33 candidate rules but the uniform-pitch filter only chains 5-12 of them,
because perspective makes the row spacing change down the page faster than the tolerance allows.

The honest read is that rotation and skew correction are not enough — this needs explicit
detection of the page quadrilateral and a proper perspective warp, so the table is square before
any line finding happens. That is the next piece of work.

**It refuses rather than guesses.** Every one of the 18 failures returns `ok:false` with a
reason. A misplaced cell would produce confident nonsense in the grams column that the downstream
arithmetic cannot distinguish from an odd sheet.

### What to expect when it works

The classifier's honest starting accuracy on real handwriting is the handoff's own estimate:
85–90% per digit. The constraint solver lifts that a long way at the row level — the sheet's
arithmetic pins most misreads — but it will not be perfect on day one. That is what the review
screen is for, and why every value carries where it came from:

- **unmarked** — you typed it
- **yellow** — read, but the classifier was unsure
- **purple** — read, and the maths overrode what the classifier said. Look at these hardest.
- **red** — read, and nothing could reconcile it
- **green** — you corrected it

Every correction is logged (`recordCorrection`) as a labelled sample in your own techs' writing.
After 30–50 sheets that becomes a fine-tuning set, and accuracy climbs fast because this is a
tiny closed domain: one form, a few pens, a few people.

### Still not built

- **Nothing is uploaded anywhere.** Export is PDF, CSV or clipboard. Where the data ultimately
  lands is open question 1 below.

---

## Files

```
index.html          the whole app — CONFIG block at the top, logic below the line
model.js            GENERATED digit-classifier weights (tools/train_digits.py)
gradation.py        the calculation, in Python. THE TEST ORACLE — change math here first
test/logic.test.mjs 128 tests; lifts the functions out of index.html, compares to gradation.py
tools/make-icons.py regenerates the PWA icons
tools/train_digits.py trains the digit classifier and writes model.js + the parity fixture
manifest.json       home-screen install
sw.js               offline shell cache — BUMP THE CACHE NAME ON EVERY DEPLOY
netlify.toml        static publish + no-cache header on sw.js
icon-192.png
icon-512.png
docs/HANDOFF.md     the original build brief, including the OCR plan for steps 3–5
```

### Editing it

Everything editable lives in the `CONFIG` block at the top of `index.html`: sieve rows, header
fields, per-sample fields, the 1.5% loss limit, the county list, photo quality. Nothing below the
`LOGIC` line needs touching to change content.

If the form revision ever changes, edit `CONFIG.sieves` and the guardrail tests will tell you
what else moved.

---

## Tests

```
npm test            # 128 tests, no dependencies
python3 gradation.py            # print the oracle's table for the verified sheet
python3 tools/train_digits.py --check   # gradient-check the trainer, ~10 seconds
python3 tools/train_digits.py           # retrain the classifier and rewrite model.js
```

The trainer gradient-checks itself before it will train, in float64 with a small epsilon —
ReLU and max-pool are piecewise linear, so a large step straddles a kink and reports a huge
error on a network that is perfectly correct.

`gradation.py` is the source of truth for the math. One test shells out to it and demands the
browser agree digit for digit, so the two implementations cannot drift. Change the math in the
Python first, then port it across.

---

## Deploy

### Windows folder

```
C:\Users\jake\Documents\apps\gradation-capture\
├── index.html
├── manifest.json
├── sw.js
├── netlify.toml
├── icon-192.png
└── icon-512.png
```

(`gradation.py`, `test\` and `tools\` are for the repo — they do no harm if deployed, but they
are not needed on the site.)

### Drag-and-drop

1. Open <https://app.netlify.com/drop>.
2. Drag the whole `gradation-capture` folder onto the page.
3. Netlify gives back a URL like `https://cheerful-marzipan-1a2b3c.netlify.app`.
4. Rename the site under **Site configuration → Change site name** to something a tech can type.

No environment variables. No functions. There is no key to hide, which is the whole point of
the local-only design.

### CLI, if you prefer

```
cd C:\Users\jake\Documents\apps\gradation-capture
netlify deploy --prod
```

### Install on the phone

- **iPhone / Safari:** Share → Add to Home Screen.
- **Android / Chrome:** ⋮ → Install app.

After installing, put the phone in airplane mode and reopen it. It should work fully. If it does
not, the service worker did not register — reload the page once with signal and try again.

### On every redeploy

Bump `CACHE` in `sw.js` (`kytc-gradation-v1` → `-v2`). Phones will serve the old app forever
otherwise. This is the trap that eats an hour.

---

## Smoke test that actually proves something

Do not test with a clean sheet — clean sheets always work and prove nothing.

1. Fill out a worksheet **by hand**, with one digit written ambiguously and one cumulative value
   deliberately keyed lower than the row above it.
2. Photograph it in the app and key the column in.
3. The backwards row must turn red with the reason spelled out, and the loss check must show a
   verdict rather than a blank.

If it silently accepts the backwards value, something in the constraint checks got lost.

---

## Open questions for Jake

Built with a default for each; say the word and any of them changes in under an hour.

1. **Where does the data land?** Currently CSV download + clipboard. A POST into the data-entry
   site, a SharePoint drop, or an email is a small change — but the payload shape stays the same
   either way, which is why exporting is separated from computing.
2. **Three columns or one at a time?** Built for three, matching the paper form. Only the
   columns you actually key in reach the export.
3. **% Minus 200 auto-computed?** Both figures are computed and labelled separately. If the
   wash-test figure is entered by hand from another sheet, it becomes a field instead.
4. **Is the form template always identical?** Assumed yes. It matters for OCR later — the cell
   coordinates in step 3 are hardcoded, and an older revision would break segmentation.
