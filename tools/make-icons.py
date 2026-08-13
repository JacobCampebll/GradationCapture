"""Generate the PWA icons — a stack of sieve screens with aggregate on top.

No image library required; writes PNGs directly. Rendered at 4x and box-filtered
down so the edges are smooth.

    python3 tools/make-icons.py
"""

import struct
import zlib

BG = (15, 23, 42)        # --bg   #0f172a
FG = (56, 189, 248)      # --accent #38bdf8
DOT = (226, 232, 240)    # --text #e2e8f0

SS = 4                   # supersampling factor


def rounded_bar(x, y, w, h, px, py):
    """Is (px,py) inside a bar with semicircular ends?"""
    r = h / 2.0
    if y <= py <= y + h:
        if x + r <= px <= x + w - r:
            return True
        for cx in (x + r, x + w - r):
            if (px - cx) ** 2 + (py - (y + r)) ** 2 <= r * r:
                return True
    return False


def in_circle(cx, cy, r, px, py):
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render(size):
    n = size * SS
    # Four sieve screens, each narrower than the one above it.
    bars = []
    top = 0.46 * n
    gap = 0.125 * n
    bar_h = 0.055 * n
    for i in range(4):
        w = (0.66 - 0.115 * i) * n
        bars.append(((n - w) / 2.0, top + i * gap, w, bar_h))

    # Aggregate resting on the top screen: three stones, coarse to fine.
    stones = [(0.40 * n, 0.335 * n, 0.085 * n),
              (0.585 * n, 0.365 * n, 0.055 * n),
              (0.50 * n, 0.255 * n, 0.038 * n)]

    px = bytearray(n * n * 3)
    for y in range(n):
        yc = y + 0.5
        for x in range(n):
            xc = x + 0.5
            c = BG
            for (bx, by, bw, bh) in bars:
                if rounded_bar(bx, by, bw, bh, xc, yc):
                    c = FG
                    break
            else:
                for (cx, cy, r) in stones:
                    if in_circle(cx, cy, r, xc, yc):
                        c = DOT
                        break
            o = (y * n + x) * 3
            px[o], px[o + 1], px[o + 2] = c

    # Box-filter down to the requested size.
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type 0 for this scanline
        for x in range(size):
            r = g = b = 0
            for dy in range(SS):
                for dx in range(SS):
                    o = (((y * SS + dy) * n) + (x * SS + dx)) * 3
                    r += px[o]; g += px[o + 1]; b += px[o + 2]
            k = SS * SS
            out += bytes((r // k, g // k, b // k))
    return bytes(out)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit truecolor
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size}, {len(png)} bytes)")


if __name__ == "__main__":
    for s in (192, 512):
        write_png(f"icon-{s}.png", s, render(s))
