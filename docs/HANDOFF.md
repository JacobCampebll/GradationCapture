# Handoff: KYTC Gradation Scan → Fill → Upload app

## Hard constraint
**No LLM API. No API keys of any kind.** All recognition runs locally in
client-side code. This rules out Claude vision, GPT vision, Grok, Google Cloud
Vision, and Azure Read. Everything below is offline-capable.

## What this is
A mobile web app that photographs a KYTC "Worksheet for Bituminous Mixtures"
(handwritten), reads the grams-retained column with a local digit classifier,
makes the tech review/correct every value on screen, computes % retained and
% passing, then exports/uploads the result.

## Recommended architecture (no API)

The form is a **fixed printed template** and the data cells contain **only
digits**. That turns an open-ended handwriting problem into a constrained
digit-classification problem, which is solvable in plain code.

Pipeline, all in the browser:

1. **Capture** — `<input type="file" capture="environment">` or getUserMedia.
2. **Deskew / rectify** — OpenCV.js. Find the outer table border (largest
   quadrilateral contour), perspective-warp to a canonical flat rectangle of
   fixed pixel dimensions.
3. **Segment cells** — because step 2 produced canonical coordinates, every
   cell's location is a hardcoded constant. Crop the grams-retained column,
   row by row. No table detection needed.
4. **Clean each cell** — grayscale, adaptive threshold, remove the printed
   grid lines (morphological open with long horizontal + vertical kernels,
   subtract), deskew the glyph.
5. **Split digits** — connected-component labeling, filter by area to drop
   speckle, sort components left→right. Handle touching digits by vertical
   projection-profile splitting when a component is unusually wide.
6. **Classify** — small CNN, 28x28 input, 10 classes. Run via ONNX Runtime Web
   or TensorFlow.js. Keep the full softmax vector per digit, not just argmax.
7. **Assemble** — see "Decimal shortcut" below.
8. **Constraint-solve** — see "Free error correction" below.
9. **Review screen** — show the cropped cell image beside each editable value.
   Mandatory human confirm. This is the whole point of the app.
10. **Calculate + export.**

### Decimal shortcut
Every value in this column has **exactly one decimal place** (139.4, 1352.6,
1443.6). Do not try to detect the decimal point — strip it during
segmentation (it's a tiny low component, filter it out by area+position) and
insert it before the last digit programmatically. Removes an entire error class.

### Free error correction
The math constrains the answer hard. Use it before showing anything to a human:

1. **Monotonic** — cumulative grams only increase down the sheet. Any row less
   than the row above it is wrong.
2. **Checksum** — TOTAL must equal After Wash Dry Wt.
3. **Loss bound** — After Wash Dry Wt. minus PAN must be ≤ 1.5% of the wash wt.
4. **Digit count** — values are 3 or 4 digits before the decimal, in a
   predictable ascending range.

When a reading violates a constraint, walk the softmax: swap in the 2nd-choice
digit at the lowest-confidence position and re-test. A beam search over the top
2 candidates per digit fixes most single-digit misreads automatically. Raw
per-digit accuracy of 95% is poor on a 5-digit number, but after constraint
solving the effective row accuracy is far higher.

Flag anything the solver cannot reconcile for hard human review, highlighted red.

### Training data — the part that decides whether this works
An MNIST-trained model is the starting point, not the finish line. MNIST is
1990s US Census handwriting and underperforms on real pens, real forms, real
lab techs.

Plan:
- **Phase 1 baseline** — MNIST + heavy augmentation (rotation ±15°, elastic
  distortion, thickness dilation/erosion, contrast jitter). Expect roughly
  85–90% per-digit on real sheets. Usable only because of the constraint solver
  and the review screen.
- **Phase 2 self-improving** — every human correction on the review screen
  saves `(cell image, correct digit)` as a labeled sample. After ~30–50 sheets
  you have thousands of labeled digits **in your own techs' handwriting**, from
  the same form, same pens, same lighting. Fine-tune on that. This is a small
  closed domain with maybe 3–5 people writing on these sheets — it should get
  very accurate, very fast.
- Build the correction-logging in from day one, even before it's used.

### Header fields — different problem
Date, County, Project No., Producer, Type of Material, Percent Rap,
Percent A.C., Temp. of Mix, plus the handwritten corner label
(e.g. "KYTC slab 1  8/13/26").

These are free-text handwriting, not digits, and are **much** harder without an
LLM. Recommendation: **do not OCR them.** Make them typed/dropdown fields on the
review screen. County is a dropdown of 120 Kentucky counties. Project No. and
Producer can be dropdowns/autocomplete from a local list. Percent A.C. and
Temp. are numeric keypad. This is faster for the tech than correcting bad OCR.

## The form
KYTC Transportation Cabinet, Division of Materials — WORKSHEET FOR BITUMINOUS
MIXTURES. One sheet holds THREE gradation columns (three samples side by side),
each with Grams Retained / Percent Retained / Percent Passing.

### Sieve rows, in order (top to bottom)
```
37.5mm (1 1/2")
25mm (1")
19mm (3/4")
12.5mm (1/2")
9.5mm (3/8")
6mm (1/4")        <- pre-struck-out on the form, always skip
4.75mm (No.4)
2.36mm (No.8)
1.18mm (No.16)
600um (No.30)
300um (No.50)
150um (No.100)
75um (No.200)
PAN
TOTAL
```

### Wash Tests block (bottom right)
Dry Start Wt. / After Wash Dry Wt. / Start Wt. - After Dry Wt. /
% Minus 200 Results. **After Wash Dry Wt. is the divisor** for all percentages.
Three columns here too, one per sample.

## The math

Grams retained on this sheet are **CUMULATIVE** (each row includes everything
above it). Do not treat them as individual.

```
pct_retained = grams_retained / after_wash_dry_wt * 100      (round 0.1)
pct_passing  = 100 - pct_retained                            (round 0.1)
```

Blank sieve rows above the largest particle = 0.0 retained / 100.0 passing.

Aggregate loss = After Wash Dry Wt. - PAN.
loss_pct = loss / after_wash_dry_wt * 100. **Max 1.5%** (printed on the form).
Show pass/fail.

## Worked example (verified, use as a test fixture)

After Wash Dry Wt. = 1447.0, PAN = 1443.6, Percent A.C. = 5.98%

| Sieve | Grams Ret. | % Ret | % Pass |
|---|---|---|---|
| 12.5mm (1/2") | 139.4 | 9.6 | 90.4 |
| 9.5mm (3/8") | 273.9 | 18.9 | 81.1 |
| 4.75mm (No.4) | 624.7 | 43.2 | 56.8 |
| 2.36mm (No.8) | 884.6 | 61.1 | 38.9 |
| 1.18mm (No.16) | 1041.4 | 72.0 | 28.0 |
| 600um (No.30) | 1147.8 | 79.3 | 20.7 |
| 300um (No.50) | 1267.6 | 87.6 | 12.4 |
| 150um (No.100) | 1329.0 | 91.8 | 8.2 |
| 75um (No.200) | 1352.6 | 93.5 | 6.5 |

Loss = 3.4 g = 0.23% → OK (under 1.5%)

## Build convention
Single-file HTML + CONFIG block at top, per the `netlify-app-scaffold` skill.
No Netlify Function needed now — there's no key to hide, so this is a pure
static deploy. Convert to PWA so it works offline in the lab.
Model weights ship as a static `.onnx` file (a small digit CNN is well under
1 MB) and are cached by the service worker.

The `worksheet-capture-app` skill still applies for the review-before-commit
flow — just swap its vision-API step for the local pipeline above.

## Suggested build order
1. Static page: upload photo → OpenCV.js rectify → draw cell overlay boxes.
   Prove the segmentation lands on the right cells before touching ML.
2. Manual-entry review screen + the full math + export. **Ship this.** It is
   already useful without any OCR.
3. Add MNIST baseline classifier to pre-fill the fields.
4. Add constraint solver.
5. Add correction logging → fine-tune on real lab handwriting.

Steps 1–2 are the real deliverable. Steps 3–5 make it faster.

## Reference implementation
`gradation.py` in this folder holds the calculation + loss check. Port the
`calculate()` logic to JS; keep the Python as the test oracle.

## Open questions to resolve with Jake
1. Where does the data ultimately land? (data entry site — what does it
   accept: CSV, form POST, API, paste?)
2. Should the app handle all three sample columns per sheet, or one at a time?
3. Does he want % Minus 200 auto-computed, or is that entered separately?
4. Is the form template always identical, or do older/newer revisions differ?
   (Cell coordinates are hardcoded — a different form revision breaks step 3.)
