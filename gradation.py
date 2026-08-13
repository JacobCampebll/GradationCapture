"""
KYTC gradation calculator — cumulative sieve method.

Input:  cumulative grams retained per sieve + after-wash dry weight.
Output: % retained and % passing per sieve (rounded to 0.1),
        plus an aggregate-loss check against the 1.5% max.

This file is the TEST ORACLE for the JavaScript in index.html. When the math
changes, change it here first, run `python3 gradation.py`, then port it across —
`npm test` compares the browser's numbers against this file's output.

Edit the two values below and run:  python3 gradation.py
Machine-readable output for the test harness:  python3 gradation.py --json
"""

import json
import sys

# ------------- EDIT THESE -------------
AFTER_WASH_DRY_WT = 1447.0   # the weight you divide everything by

GRAMS_RETAINED = {           # cumulative grams retained, top sieve down
    '37.5mm (1 1/2")': None,
    '25mm (1")':       None,
    '19mm (3/4")':     None,
    '12.5mm (1/2")':   139.4,
    '9.5mm (3/8")':    273.9,
    '4.75mm (No.4)':   624.7,
    '2.36mm (No.8)':   884.6,
    '1.18mm (No.16)':  1041.4,
    '600um (No.30)':   1147.8,
    '300um (No.50)':   1267.6,
    '150um (No.100)':  1329.0,
    '75um (No.200)':   1352.6,
}
PAN = 1443.6                 # cumulative weight including pan
# ---------------------------------------


def _round(x, places=1):
    """Round half away from zero — what the lab does on paper.

    Python's built-in round() breaks ties to even (round(0.05, 1) == 0.0), which
    silently disagrees with the worksheet and with the browser. Ties are vanishingly
    rare on real data, but the two implementations must not differ by rule.
    """
    factor = 10 ** places
    scaled = x * factor
    frac = abs(scaled) - int(abs(scaled))
    n = int(abs(scaled)) + (1 if frac >= 0.5 - 1e-9 else 0)
    return (n if scaled >= 0 else -n) / factor


def calculate(grams_retained, wash_wt, pan=None):
    """Return list of (sieve, grams, %retained, %passing)."""
    rows = []
    for sieve, grams in grams_retained.items():
        if grams is None:                      # sieve not used / 100% passing
            rows.append((sieve, None, 0.0, 100.0))
            continue
        pct_ret = _round(grams / wash_wt * 100, 1)
        rows.append((sieve, grams, pct_ret, _round(100 - pct_ret, 1)))
    result = {'rows': rows}
    if pan is not None:
        loss = wash_wt - pan
        result['loss_g'] = _round(loss, 1)
        result['loss_pct'] = _round(loss / wash_wt * 100, 2)
        result['loss_ok'] = result['loss_pct'] <= 1.5
    return result


if __name__ == '__main__':
    r = calculate(GRAMS_RETAINED, AFTER_WASH_DRY_WT, PAN)

    if '--json' in sys.argv:
        print(json.dumps({
            'wash_wt': AFTER_WASH_DRY_WT,
            'pan': PAN,
            'rows': [
                {'sieve': s, 'grams': g, 'pct_ret': ret, 'pct_pass': ps}
                for s, g, ret, ps in r['rows']
            ],
            'loss_g': r.get('loss_g'),
            'loss_pct': r.get('loss_pct'),
            'loss_ok': r.get('loss_ok'),
        }, indent=2))
        sys.exit(0)

    print(f'{"Sieve":18s} {"Grams":>8s} {"% Ret":>6s} {"% Pass":>7s}')
    for sieve, g, ret, ps in r['rows']:
        g_str = f'{g:8.1f}' if g is not None else '    ----'
        print(f'{sieve:18s} {g_str} {ret:6.1f} {ps:7.1f}')
    if 'loss_pct' in r:
        status = 'OK' if r['loss_ok'] else 'FAIL (max 1.5%)'
        print(f'\nAggregate loss: {r["loss_g"]} g = {r["loss_pct"]}%  -> {status}')
