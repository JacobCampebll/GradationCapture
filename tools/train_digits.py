"""Train the offline digit classifier that pre-fills the grams column.

Phase 1 of the OCR plan in docs/HANDOFF.md: an MNIST baseline with heavy
augmentation. It is deliberately tiny — 8,778 parameters — so the weights ship
inside the PWA (35 KB) instead of being fetched, and so the forward pass can be
hand-written in JavaScript with no ONNX runtime and no CDN.

    python3 tools/train_digits.py --check     # gradient check only, ~10 seconds
    python3 tools/train_digits.py             # download, train, export

Writes:
    model.js                     weights + shapes, loaded by index.html
    test/fixtures/digits.json    held-out digits and this model's exact logits,
                                 so the JS engine can be proved to agree

Requires numpy only.
"""

import argparse
import base64
import gzip
import json
import os
import struct
import sys
import urllib.request

import numpy as np

MIRROR = "https://storage.googleapis.com/cvdf-datasets/mnist/"
FILES = {
    "train_x": "train-images-idx3-ubyte.gz",
    "train_y": "train-labels-idx1-ubyte.gz",
    "test_x": "t10k-images-idx3-ubyte.gz",
    "test_y": "t10k-labels-idx1-ubyte.gz",
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("MNIST_CACHE", "/tmp/mnist")

# conv(1->8) pool conv(8->16) pool conv(16->32) pool dense(288->10)
ARCH = [("conv", 1, 8), ("conv", 8, 16), ("conv", 16, 32)]
SEED = 1337


# --------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------
def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, FILES[name])
    if not os.path.exists(path):
        print(f"  downloading {FILES[name]}", flush=True)
        urllib.request.urlretrieve(MIRROR + FILES[name], path)
    with gzip.open(path, "rb") as f:
        data = f.read()
    magic, count = struct.unpack(">II", data[:8])
    if magic == 2051:
        rows, cols = struct.unpack(">II", data[8:16])
        return np.frombuffer(data, np.uint8, offset=16).reshape(count, rows, cols)
    return np.frombuffer(data, np.uint8, offset=8)


def load():
    x = fetch("train_x").astype(np.float32) / 255.0
    y = fetch("train_y").astype(np.int64)
    xt = fetch("test_x").astype(np.float32) / 255.0
    yt = fetch("test_y").astype(np.int64)
    return x, y, xt, yt


# --------------------------------------------------------------------------
# augmentation — the handoff is blunt that MNIST alone will not survive contact
# with real pens on a real form, so the training set is roughed up hard.
# --------------------------------------------------------------------------
def warp(batch, rng):
    """Random rotation / scale / shear / shift, bilinear sampled."""
    n = batch.shape[0]
    ang = rng.uniform(-15, 15, n) * np.pi / 180.0
    scale = rng.uniform(0.85, 1.15, n)
    shear = rng.uniform(-0.15, 0.15, n)
    tx = rng.uniform(-2.0, 2.0, n)
    ty = rng.uniform(-2.0, 2.0, n)

    ys, xs = np.mgrid[0:28, 0:28]
    xs = (xs - 13.5).ravel()
    ys = (ys - 13.5).ravel()

    cos, sin = np.cos(ang)[:, None], np.sin(ang)[:, None]
    sx = xs[None, :] + shear[:, None] * ys[None, :]
    sy = ys[None, :]
    src_x = (cos * sx - sin * sy) / scale[:, None] + 13.5 + tx[:, None]
    src_y = (sin * sx + cos * sy) / scale[:, None] + 13.5 + ty[:, None]

    x0 = np.floor(src_x).astype(np.int32)
    y0 = np.floor(src_y).astype(np.int32)
    fx = (src_x - x0).astype(np.float32)
    fy = (src_y - y0).astype(np.float32)

    def at(yy, xx):
        ok = (yy >= 0) & (yy < 28) & (xx >= 0) & (xx < 28)
        idx = np.clip(yy, 0, 27) * 28 + np.clip(xx, 0, 27)
        flat = batch.reshape(n, -1)
        return np.where(ok, np.take_along_axis(flat, idx, axis=1), 0.0)

    out = (at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x0 + 1) * fx * (1 - fy) +
           at(y0 + 1, x0) * (1 - fx) * fy + at(y0 + 1, x0 + 1) * fx * fy)
    return out.reshape(n, 28, 28).astype(np.float32)


def thickness(batch, rng):
    """Fatten or thin the stroke — ballpoint vs fine liner vs worn pencil."""
    out = batch.copy()
    pick = rng.random(batch.shape[0])
    pad = np.pad(batch, ((0, 0), (1, 1), (1, 1)))
    win = np.lib.stride_tricks.sliding_window_view(pad, (3, 3), axis=(1, 2))
    fat = win.max(axis=(-2, -1))
    thin = win.min(axis=(-2, -1))
    out[pick < 0.25] = fat[pick < 0.25]
    out[pick > 0.85] = thin[pick > 0.85]
    return out


def augment(batch, rng):
    out = warp(batch, rng)
    out = thickness(out, rng)
    gain = rng.uniform(0.6, 1.3, (out.shape[0], 1, 1)).astype(np.float32)
    bias = rng.uniform(-0.08, 0.08, (out.shape[0], 1, 1)).astype(np.float32)
    out = out * gain + bias
    out += rng.normal(0, 0.05, out.shape).astype(np.float32)
    return np.clip(out, 0.0, 1.0)


# --------------------------------------------------------------------------
# layers
# --------------------------------------------------------------------------
def im2col_idx(h, w, k, pad):
    out_h, out_w = h + 2 * pad - k + 1, w + 2 * pad - k + 1
    i0 = np.repeat(np.arange(k), k)
    j0 = np.tile(np.arange(k), k)
    i1 = np.repeat(np.arange(out_h), out_w)
    j1 = np.tile(np.arange(out_w), out_h)
    return (i0[:, None] + i1[None, :]), (j0[:, None] + j1[None, :]), out_h, out_w


class Conv:
    """3x3, stride 1, pad 1 — keeps the map size so pooling alone shrinks it."""

    def __init__(self, cin, cout, rng):
        self.k, self.pad = 3, 1
        fan_in = cin * 9
        self.W = (rng.normal(0, np.sqrt(2.0 / fan_in), (cout, fan_in))).astype(np.float32)
        self.b = np.zeros(cout, np.float32)
        self.cin, self.cout = cin, cout

    def forward(self, x):
        n, c, h, w = x.shape
        ii, jj, oh, ow = im2col_idx(h, w, self.k, self.pad)
        xp = np.pad(x, ((0, 0), (0, 0), (self.pad,) * 2, (self.pad,) * 2))
        col = xp[:, :, ii, jj].reshape(n, c * self.k * self.k, oh * ow)
        self.cache = (x.shape, col, ii, jj, oh, ow)
        out = np.einsum("fk,nkp->nfp", self.W, col) + self.b[None, :, None]
        return out.reshape(n, self.cout, oh, ow)

    def backward(self, dout):
        (shape, col, ii, jj, oh, ow) = self.cache
        n, c, h, w = shape
        d = dout.reshape(n, self.cout, oh * ow)
        self.dW = np.einsum("nfp,nkp->fk", d, col)
        self.db = d.sum(axis=(0, 2))
        dcol = np.einsum("fk,nfp->nkp", self.W, d)
        dcol = dcol.reshape(n, c, self.k * self.k, oh * ow)
        dxp = np.zeros((n, c, h + 2 * self.pad, w + 2 * self.pad), dcol.dtype)
        np.add.at(dxp, (slice(None), slice(None), ii, jj), dcol)
        return dxp[:, :, self.pad:self.pad + h, self.pad:self.pad + w]

    def params(self):
        return [(self.W, "dW"), (self.b, "db")]


class Dense:
    def __init__(self, nin, nout, rng):
        self.W = (rng.normal(0, np.sqrt(2.0 / nin), (nin, nout))).astype(np.float32)
        self.b = np.zeros(nout, np.float32)

    def forward(self, x):
        self.x = x
        return x @ self.W + self.b

    def backward(self, dout):
        self.dW = self.x.T @ dout
        self.db = dout.sum(axis=0)
        return dout @ self.W.T

    def params(self):
        return [(self.W, "dW"), (self.b, "db")]


def relu_f(x):
    return np.maximum(x, 0)


def pool_f(x):
    """2x2 max pool, floor — odd sizes drop the last row/col, same as the JS."""
    n, c, h, w = x.shape
    h2, w2 = h // 2, w // 2
    xr = x[:, :, :h2 * 2, :w2 * 2].reshape(n, c, h2, 2, w2, 2)
    out = xr.max(axis=(3, 5))
    mask = (xr == out[:, :, :, None, :, None])
    return out, mask, (h, w)


def pool_b(dout, mask, shape, orig):
    n, c, h2, w2 = dout.shape
    h, w = orig
    d = mask * dout[:, :, :, None, :, None]
    # ties would double-count; normalise so the gradient still sums correctly
    d = d / np.maximum(mask.sum(axis=(3, 5), keepdims=True), 1)
    out = np.zeros((n, c, h, w), d.dtype)
    out[:, :, :h2 * 2, :w2 * 2] = d.reshape(n, c, h2 * 2, w2 * 2)
    return out


class Net:
    def __init__(self, rng):
        self.convs = [Conv(cin, cout, rng) for (_, cin, cout) in ARCH]
        self.fc = Dense(32 * 3 * 3, 10, rng)

    def forward(self, x):
        self.masks, self.shapes, self.relus = [], [], []
        h = x[:, None, :, :]
        for conv in self.convs:
            h = conv.forward(h)
            self.relus.append(h > 0)
            h = relu_f(h)
            h, mask, shape = pool_f(h)
            self.masks.append(mask)
            self.shapes.append(shape)
        self.flat_shape = h.shape
        return self.fc.forward(h.reshape(h.shape[0], -1))

    def backward(self, dlogits):
        d = self.fc.backward(dlogits).reshape(self.flat_shape)
        for i in range(len(self.convs) - 1, -1, -1):
            d = pool_b(d, self.masks[i], None, self.shapes[i])
            d = d * self.relus[i]
            d = self.convs[i].backward(d)

    def params(self):
        out = []
        for conv in self.convs:
            out += [(conv, "W", "dW"), (conv, "b", "db")]
        out += [(self.fc, "W", "dW"), (self.fc, "b", "db")]
        return out


def softmax_ce(logits, y):
    z = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(z)
    p = e / e.sum(axis=1, keepdims=True)
    loss = -np.log(np.maximum(p[np.arange(len(y)), y], 1e-12)).mean()
    d = p.copy()
    d[np.arange(len(y)), y] -= 1
    return loss, d / len(y), p


# --------------------------------------------------------------------------
# gradient check — cheap insurance against a silently wrong backward pass
# --------------------------------------------------------------------------
def gradient_check(eps=1e-6):
    """Compare the analytical gradient against finite differences.

    Two things this has to get right or it cries wolf. Run in float64: at float32
    precision the difference of two losses is buried in rounding. And keep eps
    small: ReLU and max-pool are piecewise linear, so a large step straddles a
    kink and the finite difference measures the average of two different slopes.
    At eps=1e-3 this reported 73% error on a network whose backward pass is
    correct to 2e-7.
    """
    rng = np.random.default_rng(0)
    net = Net(rng)
    for obj, pname, _ in net.params():
        setattr(obj, pname, getattr(obj, pname).astype(np.float64))
    x = rng.random((4, 28, 28)).astype(np.float64)
    y = rng.integers(0, 10, 4)

    net.backward(softmax_ce(net.forward(x), y)[1])

    worst = 0.0
    for obj, pname, gname in net.params():
        P = getattr(obj, pname)
        G = getattr(obj, gname)
        flat = P.ravel()
        for idx in rng.choice(flat.size, min(12, flat.size), replace=False):
            old = flat[idx]
            flat[idx] = old + eps
            lp = softmax_ce(net.forward(x), y)[0]
            flat[idx] = old - eps
            lm = softmax_ce(net.forward(x), y)[0]
            flat[idx] = old
            num = (lp - lm) / (2 * eps)
            ana = G.ravel()[idx]
            scale = max(abs(num), abs(ana))
            if scale < 1e-7:
                continue          # a gradient this flat tells us nothing
            worst = max(worst, abs(num - ana) / scale)
    print(f"gradient check: worst relative error {worst:.2e}", flush=True)
    return worst


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------
def export(net, xt, yt, epochs, clean_acc, aug_acc):
    tensors = []
    shapes = []
    for i, conv in enumerate(net.convs):
        tensors += [conv.W.astype(np.float32).ravel(), conv.b.astype(np.float32).ravel()]
        shapes.append({"type": "conv", "name": f"conv{i + 1}",
                       "cin": conv.cin, "cout": conv.cout, "k": 3, "pad": 1})
    tensors += [net.fc.W.astype(np.float32).ravel(order="C"),
                net.fc.b.astype(np.float32).ravel()]
    shapes.append({"type": "dense", "name": "fc",
                   "nin": int(net.fc.W.shape[0]), "nout": int(net.fc.W.shape[1])})

    blob = np.concatenate(tensors).astype("<f4").tobytes()
    b64 = base64.b64encode(blob).decode("ascii")
    meta = {
        "layers": shapes,
        "params": int(sum(t.size for t in tensors)),
        "input": [28, 28],
        "trainedOn": "MNIST + augmentation (rotation, scale, shear, shift, thickness, contrast, noise)",
        "epochs": epochs,
        "accuracyClean": round(float(clean_acc), 4),
        "accuracyAugmented": round(float(aug_acc), 4),
    }

    js = ("/* Digit classifier weights. GENERATED by tools/train_digits.py — do not\n"
          "   hand-edit. Ships inside the app so recognition works with no signal and\n"
          "   no network call, same rule as everything else here. */\n"
          f"const MODEL_META = {json.dumps(meta, indent=2)};\n"
          f'const MODEL_WEIGHTS_B64 = "{b64}";\n')
    with open(os.path.join(ROOT, "model.js"), "w") as f:
        f.write(js)
    print(f"wrote model.js — {meta['params']} params, {len(b64) / 1024:.1f} KB base64")

    # Parity fixture: the JS engine has to reproduce these logits exactly enough.
    rng = np.random.default_rng(7)
    pick = rng.choice(len(xt), 40, replace=False)
    logits = net.forward(xt[pick])
    fixture = {
        "note": "Held-out MNIST digits and this model's logits. tools/train_digits.py "
                "wrote them; test/logic.test.mjs proves the JS forward pass agrees.",
        "images": [(xt[i] * 255).astype(np.uint8).ravel().tolist() for i in pick],
        "labels": [int(yt[i]) for i in pick],
        "logits": [[round(float(v), 6) for v in row] for row in logits],
    }
    os.makedirs(os.path.join(ROOT, "test", "fixtures"), exist_ok=True)
    with open(os.path.join(ROOT, "test", "fixtures", "digits.json"), "w") as f:
        json.dump(fixture, f)
    print("wrote test/fixtures/digits.json — 40 held-out digits + expected logits")


def evaluate(net, x, y, rng=None, batch=1000):
    correct = 0
    for i in range(0, len(x), batch):
        xb = x[i:i + batch]
        if rng is not None:
            xb = augment(xb, rng)
        correct += (net.forward(xb).argmax(axis=1) == y[i:i + batch]).sum()
    return correct / len(x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="gradient check and exit")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-3)
    args = ap.parse_args()

    err = gradient_check()
    if err > 1e-3:
        print("BACKWARD PASS IS WRONG — refusing to train", file=sys.stderr)
        return 1
    if args.check:
        return 0

    print("loading MNIST", flush=True)
    x, y, xt, yt = load()
    rng = np.random.default_rng(SEED)
    net = Net(rng)

    state = {}
    for obj, pname, gname in net.params():
        state[id(getattr(obj, pname))] = [np.zeros_like(getattr(obj, pname)),
                                          np.zeros_like(getattr(obj, pname))]
    step = 0
    for epoch in range(args.epochs):
        order = rng.permutation(len(x))
        total = 0.0
        for bi in range(0, len(order), args.batch):
            idx = order[bi:bi + args.batch]
            xb = augment(x[idx], rng)
            yb = y[idx]
            loss, dl, _ = softmax_ce(net.forward(xb), yb)
            net.backward(dl)
            step += 1
            for obj, pname, gname in net.params():
                P = getattr(obj, pname)
                G = getattr(obj, gname)
                m, v = state[id(P)]
                m *= 0.9; m += 0.1 * G
                v *= 0.999; v += 0.001 * (G * G)
                mh = m / (1 - 0.9 ** step)
                vh = v / (1 - 0.999 ** step)
                P -= args.lr * mh / (np.sqrt(vh) + 1e-8)
            total += loss
        acc = evaluate(net, xt, yt)
        print(f"epoch {epoch + 1}/{args.epochs}  loss {total / (len(order) / args.batch):.4f}  "
              f"test acc {acc * 100:.2f}%", flush=True)

    clean = evaluate(net, xt, yt)
    aug = evaluate(net, xt, yt, rng=np.random.default_rng(99))
    print(f"\nfinal: clean {clean * 100:.2f}%   augmented {aug * 100:.2f}%")
    export(net, xt, yt, args.epochs, clean, aug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
