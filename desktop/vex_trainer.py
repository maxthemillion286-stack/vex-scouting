# VEX Trainer — the desktop half of the robot tracker on vex-scouting.
#
# The website's tracker watches matches by playing them in a browser tab, which
# tops out at a few matches at 2x. This program reads video FILES, so it goes
# as fast as the computer can decode, and it can retrain the robot finder on
# the graphics card. It talks to the website through the same shared storage
# the website uses, with the same admin key:
#
#   1. The website says what to watch ("Send to the app" in the Robot tracker
#      box): which matches, in which video, at which second.
#   2. This program watches them and saves each recording to the website, in
#      exactly the format the website's own tracker saves.
#   3. The website brings those in and works out the reports.
#
# It also collects frames while it watches. You correct a few hundred of them
# in a review page (it opens in your browser), it trains a new finder from
# them, measures it against the current one on frames it never trained on,
# and — only if you say so — publishes it to the website.
#
# Everything that decides what a box IS (letterbox, decode, colour, look,
# plate) is a line-for-line port of the website's JavaScript, so a recording
# made here and one made in the browser mean the same thing.

import base64, hashlib, json, math, os, random, re, shutil, subprocess, sys, threading, time
import urllib.request, urllib.error, urllib.parse
from concurrent.futures import ProcessPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '2.18'
INTERACTIVE = True                # False when a button started this, not a person at the console
HERE = os.path.dirname(os.path.abspath(__file__))
DIRS = {k: os.path.join(HERE, k) for k in ('models', 'videos', 'data', 'build')}
FRAMES, PROPS, LABELS = (os.path.join(HERE, 'data', k) for k in ('frames', 'prop', 'labels'))
CONFIG = os.path.join(HERE, 'config.json')
DEFAULT_SITE = 'https://vex-scouting-by-max.vercel.app'

SIZE = 640
CONF, IOU = 0.45, 0.5            # the website's VT_CONF, VT_IOU
PROPOSE = 0.25                   # boxes this sure are kept as suggestions for review
LOOKS_PER_SEC = 6                # looks per second of VIDEO (the website manages about 3)
LEAD, WINDOW, WINDOW_WIDE = 3, 150, 330
GIVE_UP_SEC, MIN_FRAMES = 25, 30
LOOKALIKE = ['0ODQ', '1IL', '8B', '5S', '2Z', '6G']


# ── small things ────────────────────────────────────────────────────────────
def say(*a):
    print(*a, flush=True)

_PROG = {'hold': False}
def progress(stage='', done=0, total=0, wait=0, minor=False):
    """How far along, for the window's bar and its countdown. A line only the
    window reads (it is started with VEX_UI set); the console never sees it.
    `minor` is something going on behind the main work (the next video coming
    down while this one is tracked) and must not take the bar over."""
    if not os.environ.get('VEX_UI') or (minor and _PROG['hold']):
        return
    try:
        print('@@P ' + json.dumps({'s': stage, 'd': done, 't': total, 'w': wait}), flush=True)
    except Exception:
        pass

def jround(v):
    """JavaScript's Math.round: halves go up."""
    return int(math.floor(v + 0.5))

def load_config():
    cfg = {'site': DEFAULT_SITE, 'key': '', 'workers': 4, 'keep_videos': False, 'files': {}, 'hw_decode': True}
    try:
        with open(CONFIG, encoding='utf-8') as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    # Until the owner picks a number, use what the processor can carry: one
    # match for every two threads, eight at most (an 8-core/16-thread chip: 8).
    if not cfg.get('workers_chosen'):
        cfg['workers'] = max(2, min(8, (os.cpu_count() or 8) // 2))
    return cfg

def save_config(cfg):
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=1)

def video_id(text):
    """A YouTube link or a bare id → the 11-character id, or None."""
    t = str(text or '').strip()
    m = re.search(r'(?:v=|youtu\.be/|/live/|/embed/|/shorts/)([A-Za-z0-9_-]{11})', t)
    if m:
        return m.group(1)
    return t if re.fullmatch(r'[A-Za-z0-9_-]{11}', t) else None


# ── the website ─────────────────────────────────────────────────────────────
class Site:
    def __init__(self, cfg):
        self.base = cfg['site'].rstrip('/')
        self.key = cfg.get('key', '')

    def _open(self, url, data=None, timeout=60):
        req = urllib.request.Request(url, data=data, headers={'User-Agent': 'vex-trainer/' + VERSION, 'Content-Type': 'application/json'})
        return urllib.request.urlopen(req, timeout=timeout)

    def get(self, query):
        try:
            with self._open(self.base + '/api/tracker' + query) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            return {'error': 'HTTP %d' % e.code, 'status': e.code}
        except Exception as e:
            return {'error': str(e)}

    def post(self, body, tries=3):
        body = dict(body, passcode=self.key)
        data = json.dumps(body, separators=(',', ':')).encode('utf-8')
        last = None
        for i in range(tries):
            try:
                with self._open(self.base + '/api/tracker', data) as r:
                    return json.loads(r.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                try:
                    last = json.loads(e.read().decode('utf-8'))
                except Exception:
                    last = {}
                last['status'] = e.code
                last.setdefault('error', 'HTTP %d' % e.code)
                if e.code < 500:
                    return last             # refused: asking again will not help
            except Exception as e:
                last = {'error': str(e)}
            time.sleep(1.5 * (i + 1))
        return last or {'error': 'no answer'}

    def fetch_file(self, path, dest):
        with self._open(self.base + path, timeout=300) as r, open(dest + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(dest + '.part', dest)


def ensure_models(site):
    """The three models and the reader's alphabet, straight from the website."""
    os.makedirs(DIRS['models'], exist_ok=True)
    for name in ('robot_detector.onnx', 'plate_reader.onnx', 'text_finder.onnx'):
        dest = os.path.join(DIRS['models'], name)
        if not os.path.exists(dest) or os.path.getsize(dest) < 100000:
            say('  getting', name, '…')
            site.fetch_file('/models/' + name, dest)
    chars = os.path.join(DIRS['models'], 'plate_chars.json')
    if not os.path.exists(chars):
        tmp = os.path.join(DIRS['models'], 'vt-worker.js')
        site.fetch_file('/vendor/vt-worker.js', tmp)
        with open(tmp, encoding='utf-8') as f:
            m = re.search(r'const PLATE_CHARS = (\{.*?\});', f.read(), re.S)
        if not m:
            raise RuntimeError('The website did not have the plate alphabet where it was expected.')
        with open(chars, 'w', encoding='utf-8') as f:
            f.write(m.group(1))
        os.remove(tmp)

def detector_path():
    mine = os.path.join(DIRS['models'], 'trained_current.onnx')
    return mine if os.path.exists(mine) else os.path.join(DIRS['models'], 'robot_detector.onnx')


# ── what a box is: the website's arithmetic, ported ─────────────────────────
def letterbox(w, h):
    s = SIZE / max(w, h)
    nw, nh = jround(w * s), jround(h * s)
    return {'s': s, 'nw': nw, 'nh': nh, 'px': (SIZE - nw) // 2, 'py': (SIZE - nh) // 2}

def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / ((a[2] * a[3] + b[2] * b[3] - inter) or 1)

def nms(boxes, thr):
    keep = []
    for b in sorted(boxes, key=lambda b: -b[4]):
        if all(iou(k, b) <= thr for k in keep):
            keep.append(b)
    return keep

def decode(out, lb, w, h, conf):
    """out: (5, N) — cx, cy, w, h, score in the square's pixels → boxes in the frame's."""
    import numpy as np
    idx = np.nonzero(out[4] >= conf)[0]
    boxes = []
    for i in idx:
        bw, bh = out[2, i] / lb['s'], out[3, i] / lb['s']
        x = (out[0, i] - lb['px']) / lb['s'] - bw / 2
        y = (out[1, i] - lb['py']) / lb['s'] - bh / 2
        x0, y0, x1, y1 = max(0, x), max(0, y), min(w, x + bw), min(h, y + bh)
        if x1 - x0 >= 6 and y1 - y0 >= 6:
            boxes.append([float(x0), float(y0), float(x1 - x0), float(y1 - y0), float(out[4, i]), 0, None, 0])
    return boxes

def _grid(img, x0, x1, y0, y1, sx, sy):
    import numpy as np
    H, W = img.shape[:2]
    ys = np.arange(max(0, y0), min(H, y1), sy).astype(int)
    xs = np.arange(max(0, x0), min(W, x1), sx).astype(int)
    if not len(ys) or not len(xs):
        return None
    return img[np.ix_(ys, xs)].reshape(-1, 3).astype(np.float64)

def color_of(img, box):
    """1 red, 2 blue, 0 cannot tell: strongly red and strongly blue pixels on a grid."""
    import numpy as np
    px = _grid(img, math.floor(box[0]), box[0] + box[2], math.floor(box[1]), box[1] + box[3],
               max(1, int(box[2] // 20)), max(1, int(box[3] // 20)))
    if px is None:
        return 0
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    mx, mn = px.max(1), px.min(1)
    strong = (mx >= 90) & ((mx - mn) >= 0.45 * mx)
    red = strong & (r == mx) & (g < 0.55 * r) & (b < 0.6 * r)
    blue = strong & ~red & (b == mx) & (r < 0.55 * b)
    nr, nb, need = int(red.sum()), int(blue.sum()), max(3, 0.02 * len(px))
    if nr >= need and nr > 1.5 * nb:
        return 1
    if nb >= need and nb > 1.5 * nr:
        return 2
    return 0

def sig_of(img, box, col):
    """What a robot looks like: twelve numbers, its own plate colour left out."""
    import numpy as np
    x0, x1 = math.floor(box[0] + box[2] * 0.2), math.ceil(box[0] + box[2] * 0.8)
    y0, y1 = math.floor(box[1] + box[3] * 0.15), math.ceil(box[1] + box[3] * 0.85)
    px = _grid(img, x0, x1, y0, y1, max(1, (x1 - x0) // 16), max(1, (y1 - y0) // 16))
    if px is None:
        return None
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    mx, mn = px.max(1), px.min(1)
    d = mx - mn
    coloured = (mx >= 70) & (d >= 0.35 * mx)
    ds = np.where(d == 0, 1, d)
    h = np.where(mx == r, np.mod((g - b) / ds + 6, 6), np.where(mx == g, (b - r) / ds + 2, (r - g) / ds + 4))
    hb = np.floor(h / 6 * 8).astype(int) % 8
    own = coloured & (d > 0.5 * mx) & ((((hb == 0) | (hb == 7)) & (col == 1)) | ((hb == 5) & (col == 2)))
    bins = [0] * 12
    for k in range(8):
        bins[k] = int((coloured & ~own & (hb == k)).sum())
    grey = np.minimum(3, np.floor(mx / 64)).astype(int)
    for k in range(4):
        bins[8 + k] = int((~coloured & (grey == k)).sum())
    n = int((~own).sum())
    if n < 12:
        return None
    return [min(15, jround(v / n * 30)) for v in bins]

def sig_pack(g):
    if not g:
        return [0, 0, 0]
    return [g[o] | g[o + 1] << 4 | g[o + 2] << 8 | g[o + 3] << 12 for o in (0, 4, 8)]

def robot_like(b):
    tall = b[3] / max(1, b[2])
    if tall > 2:
        return False
    if not b[5]:
        return tall <= 1.4 and b[4] >= 0.6
    return True

def pack_frame(t, boxes, src_w):
    k = SIZE / src_w
    fr = [jround(t * 10), len(boxes)]
    for b in boxes:
        fr += [jround(b[0] * k), jround(b[1] * k), jround(b[2] * k), jround(b[3] * k), jround(b[4] * 100), b[5] or 0] + sig_pack(b[6]) + [b[7] or 0]
    return fr

PIN_W, PIN_MAX_INTS, PIN_MAX_BLOBS = 960, 36000, 60

def pin_blobs(frame, boxes):
    """Every red, blue or yellow patch of about a pin's size that is not on a
    robot. The website's vtPinBlobs, same tests and limits.
    → (W, H, [[x, bottom y, w, h, area, colour], …]) in a picture W wide."""
    import cv2, numpy as np
    h0, w0 = frame.shape[:2]
    W, H = PIN_W, max(2, jround(h0 * PIN_W / w0))
    k = W / w0
    img = cv2.resize(frame, (W, H), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR).astype(np.float32)
    b, g, r = img[..., 0], img[..., 1], img[..., 2]
    mx, mn = img.max(2), img.min(2)
    strong = (mx >= 90) & ((mx - mn) >= 0.45 * mx)
    yellow = strong & (r >= 140) & (g >= 105) & (b < 0.55 * np.minimum(r, g)) & (np.abs(r - g) < 0.32 * mx)
    red = strong & ~yellow & (r == mx) & (g < 0.55 * r) & (b < 0.6 * r)
    blue = strong & ~yellow & ~red & (b == mx) & (r < 0.55 * b)
    cls = np.zeros((H, W), np.uint8)
    cls[red], cls[blue], cls[yellow] = 1, 2, 3
    for bx in boxes or []:
        x, y, bw, bh = bx[0] * k, bx[1] * k, bx[2] * k, bx[3] * k
        cls[max(0, int(math.floor(y - bh * 0.06))):min(H, int(math.ceil(y + bh * 1.06))), max(0, int(math.floor(x - bw * 0.06))):min(W, int(math.ceil(x + bw * 1.06)))] = 0
    out = []
    for c in (1, 2, 3):
        n, _, stats, _ = cv2.connectedComponentsWithStats((cls == c).astype(np.uint8), connectivity=4)
        for i in range(1, n):
            x0, y0, bw, bh, area = (int(v) for v in stats[i])
            if area < 10 or bw > W * 0.08 or bh > H * 0.2:
                continue
            out.append([jround((2 * x0 + bw) / 2), y0 + bh, bw, bh, area, c])
    out.sort(key=lambda q: -q[4])
    return W, H, out[:PIN_MAX_BLOBS]

TOG_ALONG, TOG_LIFTS, TOG_N = 0.09, (0.035, 0.0475, 0.06, 0.0725, 0.085), 24
WALL_MID = ((0.5, 0), (1, 0.5), (0.5, 1), (0, 0.5))

def quad_fwd(q):
    """Unit square → picture, for four corners in any order (the website's vtHomographyFwd)."""
    cx, cy = (q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4
    p = sorted(((q[i], q[i + 1]) for i in range(0, 8, 2)), key=lambda t: math.atan2(t[1] - cy, t[0] - cx))
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = p
    dx1, dx2, sx, dy1, dy2, sy = x1 - x2, x3 - x2, x0 - x1 + x2 - x3, y1 - y2, y3 - y2, y0 - y1 + y2 - y3
    den = dx1 * dy2 - dx2 * dy1
    if abs(den) < 1e-9:
        return None
    g, h = (sx * dy2 - dx2 * sy) / den, (dx1 * sy - sx * dy1) / den
    a, b, c, d, e, f = x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0
    def fwd(u, v):
        w = g * u + h * v + 1
        return (a * u + b * v + c) / w, (d * u + e * v + f) / w
    return fwd

def toggle_look(frame, q):
    """How red and how blue the top of each wall's middle is: [red%, blue%] × 4.
    The website's vtToggleLook: same points, same colour test."""
    fwd = quad_fwd(q)
    if not fwd:
        return None
    H, W = frame.shape[:2]
    aspect = W / H
    out = []
    for mu, mv in WALL_MID:
        along = (1, 0) if mv in (0, 1) else (0, 1)
        inward = ((0.5 > mu) - (0.5 < mu), (0.5 > mv) - (0.5 < mv))
        M, A, I = fwd(mu, mv), fwd(mu + along[0] * 0.05, mv + along[1] * 0.05), fwd(mu + inward[0] * 0.05, mv + inward[1] * 0.05)
        scale = max(math.hypot(A[0] - M[0], (A[1] - M[1]) / aspect), math.hypot(I[0] - M[0], (I[1] - M[1]) / aspect)) / 0.05
        r = b = n = 0
        for i in range(TOG_N):
            t = (i / (TOG_N - 1) * 2 - 1) * TOG_ALONG
            P = fwd(mu + along[0] * t, mv + along[1] * t)
            for lift in TOG_LIFTS:
                x, y = jround(P[0] * W), jround((P[1] - lift * scale * aspect) * H)
                if x < 0 or y < 0 or x >= W or y >= H:
                    continue
                n += 1
                bb, gg, rr = (float(v) for v in frame[y, x])
                mx, mn = max(rr, gg, bb), min(rr, gg, bb)
                if mx < 90 or mx - mn < 0.45 * mx:
                    continue
                if rr >= 140 and gg >= 105 and bb < 0.55 * min(rr, gg) and abs(rr - gg) < 0.32 * mx:
                    continue                          # yellow: neither
                if rr == mx and gg < 0.55 * rr and bb < 0.6 * rr:
                    r += 1
                elif bb == mx and rr < 0.55 * bb:
                    b += 1
        out += [jround(100 * r / n) if n else 0, jround(100 * b / n) if n else 0]
    return out

def plate_box(img, col):
    """Where the plate is inside a robot's box: the widest band of its colour."""
    import numpy as np
    px = img.astype(np.float64)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    mx, mn = px.max(2), px.min(2)
    strong = (mx >= 90) & ((mx - mn) >= 0.45 * mx)
    hit = strong & ((r == mx) & (g < 0.55 * r) & (b < 0.6 * r) if col == 1 else (b == mx) & (r < 0.55 * b))
    H, W = hit.shape

    def run(arr, floor):
        best, s = (0, -1), -1
        for i in range(len(arr) + 1):
            if i < len(arr) and arr[i] >= floor:
                if s < 0:
                    s = i
            elif s >= 0:
                if i - s > best[1] - best[0] + 1:
                    best = (s, i - 1)
                s = -1
        return best

    rows = hit.sum(1)
    top = int(rows.max()) if H else 0
    if top < 12:
        return None
    y0, y1 = run(rows, top * 0.45)
    if y1 < y0:
        return None
    cols = hit[y0:y1 + 1].sum(0)
    wide = [max(int(cols[x]), int(cols[x - 1]) if x else 0, int(cols[x + 1]) if x + 1 < W else 0) for x in range(W)]
    x0, x1 = run(wide, (y1 - y0 + 1) * 0.3)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    if h < 9 or w < 2 * h or w > 9 * h:
        return None
    return x0, y0, w, h

def plate_tilts(img, col):
    """Plates that are not level. A camera above a corner of the field sees
    most plates at a slant, and the reader only reads level writing (the
    first real frame the owner sent: four robots, no plate read; straightened,
    one read). Each solid patch of the plate's colour, with the way it lies:
    → up to two of [cx, cy, angle, length, height], biggest first."""
    import numpy as np, cv2
    px = img.astype(np.float64)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    mx, mn = px.max(2), px.min(2)
    strong = (mx >= 90) & ((mx - mn) >= 0.45 * mx)
    hit = strong & ((r == mx) & (g < 0.55 * r) & (b < 0.6 * r) if col == 1 else (b == mx) & (r < 0.55 * b))
    n, lab = cv2.connectedComponents(hit.astype(np.uint8), connectivity=8)
    out = []
    for k in range(1, n):
        ys, xs = np.nonzero(lab == k)
        cnt = len(xs)
        if cnt < 120:
            continue
        ax, ay = float(xs.mean()), float(ys.mean())
        dx, dy = xs - ax, ys - ay
        # The way it lies: the turn at which a box round it is smallest. (Seen
        # from the side a plate is a slanted parallelogram; its long edges, and
        # the writing, run along that box.) Every 3 degrees.
        best = None
        for step in range(60):
            ang = step * math.pi / 60
            c, sn = math.cos(ang), math.sin(ang)
            u, v = dx * c + dy * sn, dy * c - dx * sn
            u0, u1, v0, v1 = float(u.min()), float(u.max()), float(v.min()), float(v.max())
            area = (u1 - u0 + 1) * (v1 - v0 + 1)
            if best is None or area < best[0] - 1e-9:
                best = (area, ang, u0, u1, v0, v1)
        _, ang, u0, u1, v0, v1 = best
        L, Hh = u1 - u0 + 1, v1 - v0 + 1
        mu, mv = (u0 + u1) / 2, (v0 + v1) / 2
        c, sn = math.cos(ang), math.sin(ang)
        cx, cy = ax + mu * c - mv * sn, ay + mu * sn + mv * c
        if L < Hh:                       # the long side is the other one
            L, Hh, ang = Hh, L, ang + math.pi / 2
        # A plate: longer than tall, big enough to hold letters, mostly filled.
        if Hh < 9 or L < 1.3 * Hh or L > 7 * Hh or cnt < 0.4 * L * Hh:
            continue
        out.append((cnt, [cx, cy, ang, L, Hh]))
    out.sort(key=lambda t: -t[0])
    return [t[1] for t in out[:2]]

# How much of the plate's surroundings to take, along it. Measured on the real
# frame at three sizes: a little extra length and none in height read best
# ("8449A" at 0.8 for 66449A, where 1.1 × 1.15 read "A49").
PLATE_PADS = (1.3, 1.15)
def plate_strip(img, tilt, flip, pad=1.3):
    """The plate turned level: a 48-high strip for the reader, and how much of
    its 160 columns the plate fills. `flip` reads it the other way up."""
    import numpy as np
    cx, cy, ang, L, Hh = tilt
    Lp, Hp = L * pad, Hh
    used = min(160, max(8, jround(Lp * 48 / Hp)))
    c, sn = math.cos(ang), math.sin(ang)
    u = ((np.arange(used) + 0.5) / used * Lp - Lp / 2)[None, :]
    v = ((np.arange(48) + 0.5) / 48 * Hp - Hp / 2)[:, None]
    if flip:
        u, v = -u, -v
    H, W = img.shape[:2]
    x = np.clip(cx + u * c - v * sn, 0, W - 1)
    y = np.clip(cy + u * sn + v * c, 0, H - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, W - 1), np.minimum(y0 + 1, H - 1)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    f = img.astype(np.float64)
    val = (f[y0, x0] * (1 - fx) + f[y0, x1] * fx) * (1 - fy) + (f[y1, x0] * (1 - fx) + f[y1, x1] * fx) * fy
    strip = np.zeros((48, 160, 3), np.uint8)
    strip[:, :used] = np.floor(val + 0.5).astype(np.uint8)
    return strip, used

def edit(a, b):
    def same(x, y):
        return 0 if x == y else 0.5 if any(x in g and y in g for g in LOOKALIKE) else 1
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + same(a[i - 1], b[j - 1])))
        prev = cur
    return prev[len(b)]

def near_team(t, team):
    T = str(team or '').upper()
    if not T:
        return 99
    best = edit(t, T)
    for L in (len(T) - 1, len(T), len(T) + 1):
        s = 0
        while L > 2 and s + L <= len(t):
            best = min(best, edit(t[s:s + L], T))
            s += 1
    return best

def who_from_text(text, teams):
    """Which of the match's four teams does this text name? 1–4, or 0."""
    t = re.sub(r'[^A-Z0-9]', '', str(text or '').upper())
    teams = [x for x in teams]
    if len(t) < 3 or len(teams) < 2:
        return 0
    ds = [near_team(t, team) for team in teams]
    order = sorted(range(len(ds)), key=lambda i: ds[i])
    lo, hi = ds[order[0]], ds[order[1]]
    return order[0] + 1 if lo <= 0.34 * len(str(teams[order[0]] or '')) and hi - lo >= 1 else 0

def match_label(text):
    T = re.sub(r'\s+', ' ', str(text or '').upper()).strip()
    if len(T) < 2 or len(T) > 28:
        return None
    m = re.match(r'^(?:Q|QUAL|QUALS|QUALIFIER|QUALIFICATION|QUALIFICATIONS)\s*#?\s*(\d{1,3})$', T)
    if m:
        return {'round': 2, 'num': int(m.group(1))}
    m = re.match(r'^(R16|QF|SF|F|FINAL|FINALS)\s*#?\s*(\d{1,2})\s*-\s*(\d)$', T)
    if m:
        return {'round': {'R16': 6, 'QF': 3, 'SF': 4}.get(m.group(1), 5), 'num': int(m.group(2))}
    m = re.match(r'^(?:P|PRACTICE)\s*#?\s*(\d{1,3})$', T)
    if m:
        return {'round': 1, 'num': int(m.group(1))}
    return None

def timer_text(text):
    m = re.match(r'^([0-2]):([0-5]\d)$', str(text or '').strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None

def label_of(texts):
    other = None
    for t in texts:
        l = match_label(t['text'])
        if l and l['round'] == 2:
            return l
        if l and not other:
            other = l
    return other


# ── the eyes: three models ──────────────────────────────────────────────────
class Eyes:
    def __init__(self, detector=None, quiet=False, threads=0):
        import numpy as np, onnxruntime as ort
        self.np, self.ort = np, ort
        have = ort.get_available_providers()
        prov = [p for p in ('DmlExecutionProvider', 'CUDAExecutionProvider') if p in have] + ['CPUExecutionProvider']
        so = ort.SessionOptions()
        so.log_severity_level = 3
        # Several of these run side by side, one per worker. Left alone, each
        # would start a thread for every core and they would fight over them.
        if threads:
            so.intra_op_num_threads = threads
            try:
                import cv2
                cv2.setNumThreads(threads)
            except Exception:
                pass
        self.det = ort.InferenceSession(detector or detector_path(), so, providers=prov)
        self.backend = self.det.get_providers()[0].replace('ExecutionProvider', '')
        cpu = ['CPUExecutionProvider']
        # Reading plates and the clock was most of a match's time when it ran
        # on the processor (measured: 12 of 17 seconds). On the graphics card
        # when there is one; back to the processor if the card will not take
        # the model, checked with one real read of each width it is asked for.
        self.reader = None
        if prov[0] != 'CPUExecutionProvider':
            try:
                r = ort.InferenceSession(os.path.join(DIRS['models'], 'plate_reader.onnx'), so, providers=prov)
                for wd in (160, 320):
                    r.run(None, {r.get_inputs()[0].name: np.zeros((1, 3, 48, wd), np.float32)})
                self.reader = r
            except Exception:
                self.reader = None
        if self.reader is None:
            self.reader = ort.InferenceSession(os.path.join(DIRS['models'], 'plate_reader.onnx'), so, providers=cpu)
        self.finder = ort.InferenceSession(os.path.join(DIRS['models'], 'text_finder.onnx'), so, providers=cpu)
        with open(os.path.join(DIRS['models'], 'plate_chars.json'), encoding='utf-8') as f:
            self.chars = {int(k): v for k, v in json.load(f).items()}
        if not quiet:
            say('  robot finder running on:', 'the graphics card' if self.backend != 'CPU' else 'the processor', '(%s)' % self.backend)

    def detect(self, frame, conf=CONF):
        """frame: BGR picture. → boxes [x, y, w, h, conf, colour, look, who] in its pixels."""
        import cv2
        np = self.np
        h, w = frame.shape[:2]
        lb = letterbox(w, h)
        sq = np.full((SIZE, SIZE, 3), 114, np.uint8)
        small = cv2.resize(frame, (lb['nw'], lb['nh']), interpolation=cv2.INTER_LINEAR)
        sq[lb['py']:lb['py'] + lb['nh'], lb['px']:lb['px'] + lb['nw']] = small[:, :, ::-1]
        x = (sq.astype(np.float32) / 255).transpose(2, 0, 1)[None]
        out = self.det.run(None, {self.det.get_inputs()[0].name: x})[0][0]
        boxes = nms(decode(out, lb, w, h, conf), IOU)
        for b in boxes:
            s = [b[0] * lb['s'] + lb['px'], b[1] * lb['s'] + lb['py'], b[2] * lb['s'], b[3] * lb['s']]
            b[5] = color_of(sq, s)
            b[6] = sig_of(sq, s, b[5]) if b[5] else None
        return boxes

    def read(self, strip, used):
        """strip: RGB, 48 high; its first `used` columns hold the writing."""
        np = self.np
        f = np.zeros((1, 3, 48, strip.shape[1]), np.float32)
        f[0, :, :, :used] = ((strip[:, :used].astype(np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)
        out = self.reader.run(None, {self.reader.get_inputs()[0].name: f})[0][0]
        text, total, cnt, last = '', 0.0, 0, 0
        for i, v in zip(out.argmax(1), out.max(1)):
            i = int(i)
            if i != 0 and i != last:
                ch = self.chars.get(i)
                if ch:
                    text += ch
                    total += float(v)
                    cnt += 1
            last = i
        return text, (total / cnt if cnt else 0)

    def plate(self, frame, box, four):
        """Read the plate on one robot. → 1–4 (which of the match's teams) or 0."""
        import cv2
        np = self.np
        if box[2] < 40:
            return 0
        x, y, w, h = (int(round(v)) for v in box[:4])
        crop = frame[max(0, y):y + h, max(0, x):x + w]
        if crop.size == 0:
            return 0
        cw = min(240, max(1, int(round(box[2]))))
        ch = max(8, int(round(box[3] * cw / box[2])))
        crop = cv2.resize(crop, (cw, ch), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]
        pr, pb = plate_box(crop, 1), plate_box(crop, 2)
        p = (pr if pr[2] * pr[3] >= pb[2] * pb[3] else pb) if pr and pb else (pr or pb)
        if p:
            used = min(160, max(8, jround(p[2] * 48 / p[3])))
            strip = np.zeros((48, 160, 3), np.uint8)
            strip[:, :used] = cv2.resize(np.ascontiguousarray(crop[p[1]:p[1] + p[3], p[0]:p[0] + p[2]]), (used, 48), interpolation=cv2.INTER_LINEAR)
            text, conf = self.read(strip, used)
            who = who_from_text(text, four) if conf >= 0.5 else 0
            if who:
                return who
        # Not level, or not read: each patch of plate colour straightened and
        # read both ways up. The patch's colour says which alliance, so the
        # writing only has to tell that alliance's two teams apart.
        tw = min(400, max(1, int(round(box[2]))))
        crop = np.ascontiguousarray(cv2.resize(frame[max(0, y):y + h, max(0, x):x + w], (tw, max(8, int(round(box[3] * tw / box[2])))), interpolation=cv2.INTER_LINEAR)[:, :, ::-1])
        for col in ((int(box[5]),) if len(box) > 5 and box[5] in (1, 2) else (1, 2)):
            pair = list(four[(col - 1) * 2:(col - 1) * 2 + 2])
            for tilt in plate_tilts(crop, col):
                for flip in (0, 1):
                    for pad in PLATE_PADS:
                        strip, used = plate_strip(crop, tilt, flip, pad)
                        text, conf = self.read(strip, used)
                        who = who_from_text(text, pair) if conf >= 0.5 else 0
                        if who:
                            return who + (col - 1) * 2
        return 0

    def scan(self, frame):
        """Every line of writing in the picture, read. → [{text, conf, box}]"""
        import cv2
        np = self.np
        h, w = frame.shape[:2]
        k = min(640 / w, 352 / h)
        pic = np.zeros((352, 640, 3), np.uint8)
        nw, nh = max(1, int(w * k)), max(1, int(h * k))
        pic[:nh, :nw] = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]
        f = ((pic.astype(np.float32) / 255 - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)).transpose(2, 0, 1)[None]
        prob = self.finder.run(None, {self.finder.get_inputs()[0].name: f})[0][0, 0]
        n, _, stats, _ = cv2.connectedComponentsWithStats((prob > 0.3).astype(np.uint8), connectivity=4)
        found = []
        for i in range(1, n):
            x0, y0, bw, bh = (int(v) for v in stats[i][:4])
            if bw < 8 or bh < 4:
                continue
            gx, gy = bh * 0.9, bh * 0.55
            found.append([max(0, x0 - gx), max(0, y0 - gy), bw + 2 * gx, bh + 2 * gy])
        found.sort(key=lambda b: -b[2] * b[3])
        out = []
        for b in found[:14]:
            bx, by, bw, bh = b[0] / k, b[1] / k, b[2] / k, b[3] / k
            if bh < 6:
                continue
            got = self._line(frame, bx, by, bw, bh)
            if got and got[1] >= 0.5 and got[0]:
                out.append({'text': got[0], 'conf': got[1], 'box': [bx / w, by / h, bw / w, bh / h]})
        return out

    def _line(self, frame, bx, by, bw, bh):
        import cv2
        np = self.np
        h, w = frame.shape[:2]
        x0, y0, x1, y1 = max(0, int(bx)), max(0, int(by)), min(w, int(math.ceil(bx + bw))), min(h, int(math.ceil(by + bh)))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        used = min(320, max(8, jround(bw * 48 / bh)))
        strip = np.zeros((48, 320, 3), np.uint8)
        strip[:, :used] = cv2.resize(frame[y0:y1, x0:x1], (used, 48), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]
        return self.read(strip, used)

    def clock_at(self, frame, box):
        h, w = frame.shape[:2]
        got = self._line(frame, box[0] * w, box[1] * h, box[2] * w, box[3] * h)
        return timer_text(got[0]) if got and got[1] >= 0.5 else None


class CutWatch:
    """Is the picture in the middle of changing to something else?

    The owner sent a frame from a broadcast fading from one field to another:
    two scenes on top of each other, robots from both, a crowd over the field.
    A look taken then is of nothing real. Between two looks of the same scene
    only the robots change, a small part of the picture; across a cut or
    through a fade the whole picture changes. So: the picture shrunk to 64×36
    grey, compared with the last look and one a second back; a mean change above CUT means the scene
    is changing, and looks are passed over for a second after it.
    """
    CUT, HOLD = 20.0, 1.0

    def __init__(self):
        self.past, self.until, self.cuts = [], -1e9, 0

    def changing(self, frame, t):
        import cv2, numpy as np
        small = cv2.cvtColor(cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.int16)
        # Against the last look (a cut) and against one about a second back
        # (a fade changes too little from one look to the next to notice).
        self.past = [(pt, p) for pt, p in self.past if 0 <= t - pt <= 1.2]
        if self.past:
            last, old = self.past[-1][1], self.past[0][1]
            if max(float(np.abs(small - last).mean()), float(np.abs(small - old).mean())) > self.CUT:
                if t > self.until:
                    self.cuts += 1
                self.until = t + self.HOLD
        self.past.append((t, small))
        return t <= self.until


def attend(att, boxes, t, w, n):
    """Follow every robot from look to look; pick the n whose plates are least known."""
    used, pairs = set(), []
    for b in boxes:
        if not b[5] or not robot_like(b):
            continue
        x, y = (b[0] + b[2] / 2) / w, (b[1] + b[3] / 2) / w
        best, bd = None, 0.12
        for tr in att:
            if id(tr) in used:
                continue
            d = math.hypot(tr['x'] - x, tr['y'] - y)
            if d < bd:
                bd, best = d, tr
        if best is None:
            best = {'hits': 0, 'tries': 0}
            att.append(best)
        used.add(id(best))
        best.update(x=x, y=y, t=t)
        pairs.append((b, best))
    att[:] = [tr for tr in att if not (t - tr['t'] > 4 or t < tr['t'] - 1)]
    # A person who has read a robot's plate three times does not keep reading
    # it every instant: a glance every few seconds confirms it is still the
    # same robot. Likewise one whose plate has not shown in a dozen tries is
    # looked at once a second, not six times. This is where most of the
    # reading went, and it bought nothing.
    def due(tr):
        gap = t - tr.get('read', -1e9)
        if tr['hits'] >= 3:
            return gap >= 3
        if tr['hits'] == 0 and tr['tries'] >= 12:
            return gap >= 1
        return True
    pairs = [p for p in pairs if p[0][2] >= 40 and due(p[1])]
    pairs.sort(key=lambda p: (p[1]['hits'], p[1]['tries'], -p[0][2] * p[0][3]))
    return pairs[:n]


# ── frames kept for training ────────────────────────────────────────────────
def keep_frame(frame, boxes, tag, hard):
    """Save a picture with the finder's suggestions, for review later."""
    import cv2
    for d in (FRAMES, PROPS, LABELS):
        os.makedirs(d, exist_ok=True)
    name = tag + '_' + hashlib.md5(frame[::16, ::16].tobytes()).hexdigest()[:10]
    path = os.path.join(FRAMES, name + '.jpg')
    if os.path.exists(path):
        return
    cv2.imwrite(path, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    h, w = frame.shape[:2]
    with open(os.path.join(PROPS, name + '.json'), 'w') as f:
        json.dump({'w': w, 'h': h, 'hard': hard, 'boxes': [[round(b[0], 1), round(b[1], 1), round(b[2], 1), round(b[3], 1), round(b[4], 3)] for b in boxes]}, f)

def hardness(boxes):
    """How much a person's look would teach: unsure boxes, or not four robots."""
    unsure = sum(1 for b in boxes if b[4] < 0.5)
    sure = sum(1 for b in boxes if b[4] >= CONF and b[5])
    return unsure * 2 + (0 if sure == 4 else 1 + abs(sure - 4))


# ── one match ───────────────────────────────────────────────────────────────
class Video:
    """A video file, read forwards from wherever it is pointed."""
    def __init__(self, path, hw=True):
        import cv2
        self.cv2 = cv2
        self.cap, self.hw = None, False
        # Decoding on the graphics card, when OpenCV and the card will do it:
        # reading the video is most of what is left once the finder is fast.
        # Trusted only after it has really produced a picture, and again after
        # a jump, because a decoder that opens and then returns nothing (or
        # cannot seek) is worse than a slow one.
        if hw and hasattr(cv2, 'CAP_PROP_HW_ACCELERATION'):
            try:
                cap = cv2.VideoCapture(path, cv2.CAP_FFMPEG, [cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_ANY])
                good = cap.isOpened() and cap.read()[0]
                if good:
                    cap.set(cv2.CAP_PROP_POS_MSEC, 5000)
                    ok, fr = cap.read()
                    at = cap.get(cv2.CAP_PROP_POS_MSEC)
                    good = bool(ok) and fr is not None and fr.size > 0 and 3000 <= at <= 9000
                if good:
                    self.cap = cap
                    self.hw = bool(cap.get(cv2.CAP_PROP_HW_ACCELERATION))
                else:
                    cap.release()
            except Exception:
                self.cap = None
        # A file fetched in part holds some stretches of the stream, one after
        # another. `spans` says which. Inside the file time runs on without
        # the gaps, so a place in the stream has to be turned into a place in
        # the file to go to it; and the reader reports time counted from the
        # first stretch's start, so that is added back.
        self.spans = None
        try:
            with open(path + '.have.json') as f:
                self.spans = [[float(a), float(b)] for a, b in json.load(f)['spans']] or None
        except Exception:
            self.spans = None
        if self.spans:
            hw = False                                    # the jump test below assumes a whole file
            self.cap = None
        if self.cap is None:
            self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise RuntimeError('That video could not be opened: ' + path)
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        if not (5 <= self.fps <= 130):
            self.fps = 30
        frames = self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        self.length = frames / self.fps if frames > 0 else 0
        self.pos = 0.0
        self.out = False                                  # pointed at a stretch this file does not hold
        if self.spans:
            self.length = self.spans[-1][1]               # the stream's own length, for "past the end"

    def seek(self, sec):
        sec = max(0, sec)
        self.pos = sec
        if not self.spans:
            self.cap.set(self.cv2.CAP_PROP_POS_MSEC, sec * 1000)
            return
        before = 0.0
        for a, b in self.spans:
            if a <= sec < b:
                self.out = False
                self.cap.set(self.cv2.CAP_PROP_POS_MSEC, (before + sec - a) * 1000)
                return
            before += b - a
        self.out = True

    def read_at_step(self, step):
        """Skip step-1 frames, return the next. → (seconds, frame) or (None, None) at the end."""
        if self.out:
            return None, None
        for _ in range(step - 1):
            if not self.cap.grab():
                return None, None
        ok, frame = self.cap.read()
        if not ok:
            return None, None
        ms = self.cap.get(self.cv2.CAP_PROP_POS_MSEC)
        self.pos = (ms / 1000 + (self.spans[0][0] if self.spans else 0)) if ms > 0 else self.pos + step / self.fps
        return self.pos, frame

    def frame_at(self, sec):
        self.seek(sec)
        if self.out:
            return None
        ok, frame = self.cap.read()
        return frame if ok else None

    def close(self):
        self.cap.release()


def find_match(video, eyes, job, spacing, around):
    """The stream shows another qualification match. Go to where the right one
    should be, read the name again, and repeat; then back up to where its name
    first appears. → the second it starts at, or None."""
    pos = around
    for _ in range(8):
        label = None
        for extra in (0, 20, 45):
            fr = video.frame_at(pos + extra)
            if fr is None:
                return None
            label = label_of(eyes.scan(fr))
            if label and label['round'] == 2:
                pos += extra
                break
        if not label or label['round'] != 2:
            return None
        if label['num'] == job.get('num'):
            first = pos
            for _ in range(20):                      # back up while it is still this match
                fr = video.frame_at(first - 20)
                l = label_of(eyes.scan(fr)) if fr is not None and first - 20 >= 0 else None
                if not l or l['round'] != 2 or l['num'] != job.get('num'):
                    break
                first -= 20
            return max(0, first - 15)
        pos = max(0, pos + (job.get('num', 0) - label['num']) * spacing)
    return None


def track_match(video, eyes, job, shift=0, spacing=300, harvest=True, learn=None, quad=None):
    """Watch one match. → (recording or None, why, shift found)"""
    learn = learn if learn is not None else {}
    four = [(job['red'] + ['', ''])[0], (job['red'] + ['', ''])[1], (job['blue'] + ['', ''])[0], (job['blue'] + ['', ''])[1]]
    off0 = job['off']
    off = max(0, off0 + shift)
    step = max(1, int(round(video.fps / LOOKS_PER_SEC)))
    reads = 2 if eyes.backend != 'CPU' else 1
    wide, tried_find = False, False

    def fresh():
        return {'v': 2, 'name': str(job.get('name', ''))[:60], 'round': job.get('round'), 'num': job.get('num'), 'red': job['red'], 'blue': job['blue'],
                'rs': job.get('rs'), 'bs': job.get('bs'), 'vid': job['vid'], 'off': int(round(off)), 'rate': 4, 'w': SIZE, 'h': 0,
                'model': 'det1', 'at': int(time.time() * 1000), 'f': [], 'tm': [], 'pn': [], 'tg': []}

    while True:
        rec = fresh()
        if wide:
            rec['wide'] = 1
        start = max(0, off - (0 if wide else LEAD))
        end = start + (WINDOW_WIDE if wide else WINDOW)
        if video.length and start > video.length - 20:
            return None, 'past the end of the video', 0
        video.seek(start)
        att, robot_looks, clock_at, checked, kept, next_keep, misses, pin_at = [], 0, -1e9, False, 0, start + 6, 0, -1e9
        cuts = CutWatch()
        redo = None
        while True:
            t, frame = video.read_at_step(step)
            if frame is None or t >= end:
                break
            h, w = frame.shape[:2]
            if cuts.changing(frame, t):                 # mid-cut or mid-fade: not a picture of anything
                continue
            every = eyes.detect(frame, PROPOSE)
            boxes = [b for b in every if b[4] >= learn.get('conf', CONF) and robot_like(b)]
            rec['h'] = jround(h * SIZE / w)
            for b, tr in attend(att, boxes, t, w, reads):
                tr['tries'] += 1
                tr['read'] = t
                who = eyes.plate(frame, b, four)
                if who:
                    b[7] = who
                    b[5] = 1 if who <= 2 else 2
                    tr['hits'] += 1
            rec['f'].append(pack_frame(t - rec['off'], boxes, w))
            if any(b[5] for b in boxes):
                robot_looks += 1
            # The pins, every two seconds: by colour and size, off the robots.
            if t >= pin_at + 2 and len(rec['pn']) < PIN_MAX_INTS:
                pin_at = t
                pw, ph_, blobs = pin_blobs(frame, boxes)
                rec['pw'], rec['ph'] = pw, ph_
                rec['pn'] += [jround((t - rec['off']) * 10), len(blobs)] + [v for bl in blobs for v in bl]
                if quad and len(rec['tg']) < 1800:      # the toggles, where the field's corners put them
                    tg = toggle_look(frame, quad)
                    if tg:
                        rec['tg'] += [jround((t - rec['off']) * 10)] + tg
            # The match clock: from its known place every second, else searched for every five.
            if t >= clock_at + (1 if learn.get('clock') else 5) and len(rec['tm']) < 320:
                clock_at = t
                c = None
                if learn.get('clock'):
                    c = eyes.clock_at(frame, learn['clock'])
                    misses = 0 if c is not None else misses + 1
                    if misses >= 8:
                        learn['clock'], misses = None, 0
                else:
                    hit = next((x for x in eyes.scan(frame) if timer_text(x['text']) is not None), None)
                    if hit:
                        learn['clock'] = [round(v, 3) for v in hit['box']]
                        c = timer_text(hit['text'])
                if c is not None:
                    rec['tm'] += [jround((t - rec['off']) * 10), c]
            # Is this the match it came for? Once, a few seconds in.
            if not checked and not wide and t >= start + 8:
                checked = True
                label = label_of(eyes.scan(frame))
                if label and label['round'] == 2 and job.get('round') == 2 and label['num'] != job.get('num') and not tried_find:
                    redo = t + (job.get('num', 0) - label['num']) * spacing
                    break
            # No robots for a while: a break, or the wrong place.
            if not wide and t - start >= GIVE_UP_SEC and robot_looks < 5:
                if not tried_find and job.get('round') == 2:
                    redo = t
                break
            if harvest and kept < 10 and t >= next_keep and every:
                hard = hardness(every)
                if hard or kept < 4:
                    keep_frame(frame, every, job['vid'], hard)
                    kept += 1
                    next_keep = t + (6 if hard else 14)
        if redo is not None:
            tried_find = True
            found = find_match(video, eyes, job, spacing, redo)
            if found is None:
                return None, 'no robots there, and the match name could not be found on the stream', 0
            off, wide = found, True
            continue
        break
    with_robot = sum(1 for fr in rec['f'] if any(fr[2 + 10 * i + 5] for i in range(fr[1])))
    red = sum(1 for fr in rec['f'] if any(fr[2 + 10 * i + 5] == 1 for i in range(fr[1])))
    blue = sum(1 for fr in rec['f'] if any(fr[2 + 10 * i + 5] == 2 for i in range(fr[1])))
    if with_robot < MIN_FRAMES or red < 10 or blue < 10:
        return None, 'robots of both alliances were not seen (a break, a slate, or the wrong place)', 0
    if len(rec['f']) > 2000:                         # the website's ceiling
        keep = len(rec['f']) / 2000
        rec['f'] = [rec['f'][int(i * keep)] for i in range(2000)]
    return rec, 'ok', (rec['off'] - off0) if wide else shift


def spacing_of(jobs):
    """Seconds between one qualification match and the next, from the schedule."""
    q = sorted((j for j in jobs if j.get('round') == 2 and j.get('num') is not None), key=lambda j: j['num'])
    gaps = [(b['off'] - a['off']) / (b['num'] - a['num']) for a, b in zip(q, q[1:]) if b['num'] > a['num'] and 60 < (b['off'] - a['off']) / (b['num'] - a['num']) < 1500]
    gaps.sort()
    return gaps[len(gaps) // 2] if gaps else 300


_EYES = None
def work_chunk(args):
    """One worker: a run of consecutive matches from one video."""
    global _EYES
    cfg, ev, path, jobs, spacing = args
    site = Site(cfg)
    if _EYES is None:
        _EYES = Eyes(quiet=True, threads=max(1, (os.cpu_count() or 8) // max(1, int(cfg.get('workers', 4)))))
    video = Video(path, hw=bool(cfg.get('hw_decode', True)))
    out, shift, learn = [], 0, {}
    quads = {}                                        # the field's corners for each video, as marked on the website
    try:
        for job in jobs:
            t0 = time.time()
            try:
                if job['vid'] not in quads:
                    fld = (site.get('?field=' + job['vid']) or {}).get('field') or {}
                    q = fld.get('q')
                    quads[job['vid']] = q if isinstance(q, list) and len(q) == 8 else None
                rec, why, shift = track_match(video, _EYES, job, shift, spacing, True, learn, quads[job['vid']])
            except Exception as e:
                rec, why = None, 'error: ' + str(e)
            saved = None
            if rec is not None:
                r = site.post({'ev': str(ev), 'id': str(job['id']), 'rec': rec})
                saved = bool(r and r.get('ok'))
                if not saved:
                    why = 'the website refused it: ' + str((r or {}).get('error'))
            plates = sum(1 for fr in (rec['f'] if rec else []) for i in range(fr[1]) if fr[2 + 10 * i + 9])
            pins = 0
            if rec:
                i = 0
                while i + 1 < len(rec['pn']):
                    pins += rec['pn'][i + 1]
                    i += 2 + 6 * rec['pn'][i + 1]
            out.append({'id': job['id'], 'name': job.get('name'), 'ok': bool(saved), 'why': why, 'sec': time.time() - t0, 'hw': video.hw,
                        'looks': len(rec['f']) if rec else 0, 'plates': plates, 'pins': pins, 'clock': len(rec['tm']) // 2 if rec else 0})
    finally:
        video.close()
    return out


# ── getting the video ───────────────────────────────────────────────────────
def find_video(cfg, vid, windows=None):
    mapped = cfg.get('files', {}).get(vid)
    if mapped and os.path.exists(mapped):
        return mapped
    os.makedirs(DIRS['videos'], exist_ok=True)
    for name in os.listdir(DIRS['videos']):
        if name.startswith(vid + '.') and not name.endswith(('.part', '.ytdl', '.json')):
            path = os.path.join(DIRS['videos'], name)
            have = path + '.have.json'
            if os.path.exists(have):
                # Fetched in part. Good only for stretches it has; otherwise it is fetched again.
                try:
                    with open(have) as f:
                        got = json.load(f).get('windows', [])
                except Exception:
                    got = []
                if not windows or not all(any(g0 <= w0 and g1 >= w1 for g0, g1 in got) for w0, w1 in windows):
                    for junk in (path, have):
                        try:
                            os.remove(junk)
                        except OSError:
                            pass
                    continue
            return path
    return None

def ensure_downloader():
    """What YouTube downloads need now, fetched once.

    Reported: "why does it download so slow even though i have fast internet".
    Since late 2025 yt-dlp needs two more things for YouTube: its yt-dlp-ejs
    component and a JavaScript runtime (Deno is the one it uses by default).
    Without them it still works, on a path its authors call deprecated, with
    fewer formats to choose from — and the launcher installed neither. Both
    are put in place here, so nobody needs a new launcher.
    """
    tools = os.path.join(HERE, 'tools')
    os.makedirs(tools, exist_ok=True)
    if tools not in os.environ.get('PATH', ''):
        os.environ['PATH'] = tools + os.pathsep + os.environ.get('PATH', '')
    try:
        import yt_dlp_ejs  # noqa
    except ImportError:
        say('  setting up the downloader (once)…')
        pip('-U', 'yt-dlp[default]')
    if not shutil.which('deno') and os.name == 'nt':
        try:
            import zipfile
            say('  getting the JavaScript runtime the downloader needs (once, about 40 MB)…')
            z = os.path.join(tools, 'deno.zip')
            req = urllib.request.Request('https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip', headers={'User-Agent': 'vex-trainer/' + VERSION})
            with urllib.request.urlopen(req, timeout=120) as r, open(z, 'wb') as f:
                shutil.copyfileobj(r, f)
            with zipfile.ZipFile(z) as zf:
                zf.extract('deno.exe', tools)
            os.remove(z)
        except Exception as e:
            say('  could not get it (%s); downloading the slower way.' % str(e)[:100])
    return bool(shutil.which('deno'))

def parse_index(head):
    """The segment index (sidx) at the start of a DASH video file.
    → (where the first segment starts, [(start second, seconds, first byte, bytes), …]) or None."""
    import struct
    pos = 0
    while pos + 8 <= len(head):
        size, typ = struct.unpack('>I4s', head[pos:pos + 8])
        hdr = 8
        if size == 1:
            if pos + 16 > len(head):
                return None
            size, hdr = struct.unpack('>Q', head[pos + 8:pos + 16])[0], 16
        if size < hdr:
            return None
        if typ == b'sidx':
            if pos + size > len(head):
                return None
            b = head[pos + hdr:pos + size]
            ver = b[0]
            timescale = struct.unpack('>I', b[8:12])[0]
            if ver == 0:
                ept, first = struct.unpack('>II', b[12:20]); o = 20
            else:
                ept, first = struct.unpack('>QQ', b[12:28]); o = 28
            count = struct.unpack('>H', b[o + 2:o + 4])[0]; o += 4
            if not timescale or count < 1 or o + 12 * count > len(b):
                return None
            anchor = pos + size + first
            segs, t, off = [], ept / timescale, anchor
            for i in range(count):
                ref, dur = struct.unpack('>II', b[o + 12 * i:o + 12 * i + 8])
                if ref >> 31:
                    return None                       # an index of indexes: not handled
                sz = ref & 0x7fffffff
                segs.append((t, dur / timescale, off, sz))
                t += dur / timescale
                off += sz
            return anchor, segs
        pos += size
    return None

def needed_ranges(index, windows, total):
    """Which bytes hold these stretches of time. Asked for as: fetch only the
    minutes of a stream that have matches in them, not all eight hours.
    → ([(first byte, last byte), …], [[from second, to second], …]) — the bytes
    to fetch, and the stretches of time they hold, both in order."""
    anchor, segs = index
    keep, spans = [], []
    for t, dur, off, sz in segs:
        if off >= total or not any(t < w1 and t + dur > w0 for w0, w1 in windows):
            continue
        if keep and off == keep[-1][1] + 1:               # carries straight on from the last one
            keep[-1] = (keep[-1][0], min(total, off + sz) - 1)
            spans[-1][1] = t + dur
        else:
            keep.append((off, min(total, off + sz) - 1))
            spans.append([t, t + dur])
    return keep, spans

def strip_index(head, anchor):
    """The file's opening without its segment index: the index points at
    places in the whole file, and would be wrong for the shorter one."""
    import struct
    out, pos = b'', 0
    while pos + 8 <= anchor:
        size, typ = struct.unpack('>I4s', head[pos:pos + 8])
        if size < 8:
            break
        if typ != b'sidx':
            out += head[pos:pos + size]
        pos += size
    return out

def fetch_parallel(url, dest, headers=None, total=0, conns=32, piece=8 * 1024 * 1024, report=None, max_mbps=0, ranges=None, head=None):
    """One file over many connections at once, each asking for its own range.

    Reported, with a gigabit line: "downloading: 13% of 6232 MB at 11.6 MB/s".
    YouTube gives each connection about that much and no more, however fast
    the line is. The file it serves is an ordinary one that can be asked for
    in ranges, so it is asked for in 8 MB pieces over 32 connections at once
    and each piece is written where it belongs. → True when the whole file is
    there; False (and nothing left behind) if any piece could not be had.
    """
    import queue
    headers = dict(headers or {})
    headers.setdefault('User-Agent', 'Mozilla/5.0')
    if not total:
        try:
            req = urllib.request.Request(url, headers=dict(headers, Range='bytes=0-0'))
            with urllib.request.urlopen(req, timeout=30) as r:
                total = int((r.headers.get('Content-Range') or '/0').split('/')[-1] or 0)
        except Exception:
            total = 0
    if total <= 0:
        return False
    part = dest + '.part'
    todo = queue.Queue()
    # The whole file, or only the stretches asked for (see needed_ranges). The
    # stretches are written one after another behind the file's opening (its
    # header, already in hand): a shorter file that is still a proper video.
    # (Leaving them at their own places with gaps between was tried first; the
    # video reader could not find its way across the gaps.)
    want, npieces, at = 0, 0, len(head or b'')
    for r0, r1 in (ranges or [(0, total - 1)]):
        for a in range(r0, min(total, r1 + 1), piece):
            b = min(total, r1 + 1, a + piece) - 1
            todo.put((a, b, at if ranges else a))
            at += b - a + 1
            want += b - a + 1
            npieces += 1
    with open(part, 'wb') as f:
        f.truncate(at if ranges else total)
        if head and ranges:
            f.seek(0)
            f.write(head)
    state = {'done': 0, 'failed': False, 't0': time.time(), 'said': 0.0, 'got': 0}
    lock = threading.Lock()
    # A ceiling on speed, when one is set. Reported: "the download is affecting
    # my ping in games significantly" — a download that fills the whole line
    # leaves nothing for anything else. With a ceiling, every connection reads
    # in small blocks and waits whenever the total is ahead of what the
    # ceiling allows so far; fewer connections are opened, too.
    cap = max(0.0, float(max_mbps or 0)) * 1e6
    if cap:
        conns = max(2, min(conns, int(max_mbps // 3) or 2))

    def pace(nbytes):
        if not cap:
            return
        with lock:
            state['got'] += nbytes
            ahead = state['got'] / cap - (time.time() - state['t0'])
        if ahead > 0:
            time.sleep(min(ahead, 2.0))

    def work():
        with open(part, 'r+b') as f:
            while not state['failed']:
                try:
                    a, b, where = todo.get_nowait()
                except queue.Empty:
                    return
                for attempt in range(5):
                    try:
                        req = urllib.request.Request(url, headers=dict(headers, Range='bytes=%d-%d' % (a, b)))
                        with urllib.request.urlopen(req, timeout=60) as r:
                            if cap:
                                blocks = []
                                while True:
                                    blk = r.read(128 * 1024)
                                    if not blk:
                                        break
                                    blocks.append(blk)
                                    pace(len(blk))
                                data = b''.join(blocks)
                            else:
                                data = r.read()
                        if len(data) != b - a + 1:
                            raise IOError('short piece')
                        with lock:
                            f.seek(where)
                            f.write(data)
                            state['done'] += len(data)
                            now = time.time()
                            if report and now - state['said'] > 5:
                                state['said'] = now
                                report(state['done'], want, state['done'] / max(0.1, now - state['t0']))
                        break
                    except Exception:
                        if attempt == 4:
                            state['failed'] = True
                        else:
                            time.sleep(1 + attempt)

    threads = [threading.Thread(target=work, daemon=True) for _ in range(max(1, min(conns, npieces)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if state['failed'] or state['done'] != want:
        try:
            os.remove(part)
        except OSError:
            pass
        return False
    os.replace(part, dest)
    return True

def download(vid_or_url, dest_stem, windows=None):
    """Fetch a stream's recording as a file: 720p, 30 frames a second at most.
    Robots and plates are as readable as at 60, and the file is half the size."""
    ensure_downloader()
    try:
        import yt_dlp
    except ImportError:
        say('  The downloader is not installed. Close this, run VEX_Trainer.bat again and it will be.')
        return None
    limit = float(load_config().get('max_mbps') or 0)          # MB a second; 0 is as fast as it will go
    url = vid_or_url if '://' in vid_or_url else 'https://www.youtube.com/watch?v=' + vid_or_url
    last = {'at': 0}
    def hook(d):
        if d.get('status') == 'downloading' and time.time() - last['at'] > 5:
            last['at'] = time.time()
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            done, speed = d.get('downloaded_bytes') or 0, d.get('speed') or 0
            say('  downloading: %s%.0f MB at %.1f MB/s' % (('%d%% of ' % (100 * done / total)) if total else '', (total or done) / 1e6, speed / 1e6))
            if total:
                progress('Downloading the video', done, total, minor=True)
    opts = {'format': 'bv*[height<=720][fps<=30][vcodec^=avc1]/bv*[height<=720][fps<=30]/bv*[height<=720]/b[height<=720]/b',
            'outtmpl': dest_stem + '.%(ext)s', 'quiet': True, 'no_warnings': True, 'noprogress': True, 'progress_hooks': [hook],
            # Many pieces at once, and asked for in 10 MB ranges: a single plain
            # connection is what YouTube slows down.
            'concurrent_fragment_downloads': 4 if limit else 16, 'http_chunk_size': 10 * 1024 * 1024, 'retries': 5, 'fragment_retries': 5}
    if limit:
        opts['ratelimit'] = int(limit * 1e6)
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            # Many connections at once when the stream is one plain file (see
            # fetch_parallel). Anything else — a stream served in fragments,
            # a refusal part-way — goes the ordinary way below.
            try:
                info = y.extract_info(url, download=False)
                if info.get('url') and str(info.get('protocol', '')).startswith('http') and 'dash' not in str(info.get('protocol', '')) and not info.get('fragments'):
                    dest = y.prepare_filename(info)
                    t0 = time.time()
                    total_bytes = int(info.get('filesize') or 0)
                    ranges, head = None, None
                    if windows and total_bytes:
                        # Only the stretches with matches in them, where the file says where they are.
                        try:
                            req = urllib.request.Request(info['url'], headers=dict(info.get('http_headers') or {}, Range='bytes=0-%d' % (min(total_bytes, 2 * 1024 * 1024) - 1)))
                            with urllib.request.urlopen(req, timeout=60) as r:
                                first = r.read()
                            idx = parse_index(first)
                            if idx:
                                rs, spans = needed_ranges(idx, windows, total_bytes)
                                need = sum(b - a + 1 for a, b in rs) + idx[0]
                                if rs and need < 0.8 * total_bytes:
                                    ranges, head = rs, strip_index(first, idx[0])
                                    say('  only the parts with matches in them: %.0f MB of %.0f MB.' % (need / 1e6, total_bytes / 1e6))
                        except Exception:
                            ranges, head = None, None
                    ok = fetch_parallel(info['url'], dest, info.get('http_headers'), total_bytes, max_mbps=limit, ranges=ranges, head=head,
                                        report=lambda done, total, speed: (say('  downloading: %d%% of %.0f MB at %.1f MB/s' % (100 * done / total, total / 1e6, speed / 1e6)), progress('Downloading the video', done, total, minor=True)))
                    if ok:
                        say('  downloaded in %.0f s.' % (time.time() - t0))
                        if ranges:                        # remember which stretches of time this file holds
                            with open(dest + '.have.json', 'w') as f:
                                json.dump({'windows': windows, 'spans': spans}, f)
                        return dest
                    say('  the fast way was refused; downloading the ordinary way.')
            except Exception:
                pass
            info = y.extract_info(url, download=True)
            return y.prepare_filename(info)
    except Exception as e:
        say('  Could not download it:', str(e)[:300])
        return None


# ── menu: track what the website asked for ──────────────────────────────────
def do_jobs(cfg):
    site = Site(cfg)
    if not need_key(cfg, site):
        return
    r = site.get('?jobs=1')
    events = r.get('events') or []
    if not events:
        say('\nThe website has not asked for anything. On the website, open an event in the Jumper, and in the\n'
            'Robot tracker box press "Send this event to the app" or "Send these teams\' earlier matches to the app".')
        return
    todo = {}                                         # vid → [(ev, job)]
    asked = done_already = 0
    for ev in events:
        jobs = site.get('?jobs=' + str(ev)).get('list') or []
        have = set(str(i) for i in (site.get('?event=' + str(ev)).get('ids') or []))
        asked += len(jobs)
        for j in jobs:
            if str(j['id']) in have:
                done_already += 1
            else:
                todo.setdefault(j['vid'], []).append((ev, j))
    left = sum(len(v) for v in todo.values())
    say('\nThe website asked for %d matches in %d events. %d are already tracked; %d to go, in %d videos.' % (asked, len(events), done_already, left, len(todo)))
    if not left:
        say('Nothing left to do. Open the Robot tracker box on the website and it brings them in.')
        return
    workers = max(1, int(cfg.get('workers', 4)))
    totals = {'ok': 0, 'no': 0, 'plates': 0, 'clock': 0, 'looks': 0}
    t_all = time.time()
    # The next video is fetched while this one is being tracked: downloading
    # uses the network and tracking the processor and graphics card, so neither
    # waits for the other.
    order = sorted(todo.items(), key=lambda kv: -len(kv[1]))
    fetched = {}
    def windows_of(vid):
        # Each match with room either side: the Jumper's place for it can be a minute or two out.
        ws = sorted((max(0, j['off'] - 120), j['off'] + WINDOW_WIDE + 120) for _, j in todo[vid])
        merged = []
        for a, b in ws:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        return merged
    def fetch(vid):
        try:
            ws = windows_of(vid)
            fetched[vid] = find_video(cfg, vid, ws) or download(vid, os.path.join(DIRS['videos'], vid), ws)
        except Exception as e:
            say('  could not get %s: %s' % (vid, str(e)[:120]))
            fetched[vid] = None
    ahead = None
    done_all = 0
    for n, (vid, pairs) in enumerate(order, 1):
        say('\nVideo %d of %d (%s): %d matches' % (n, len(order), vid, len(pairs)))
        if ahead and ahead[0] == vid:
            if ahead[1].is_alive():
                say('  finishing its download…')
            ahead[1].join()
        else:
            say('  getting the video…')
            fetch(vid)
        path = fetched.get(vid)
        ahead = None
        if n < len(order):
            nxt = order[n][0]
            ahead = (nxt, threading.Thread(target=fetch, args=(nxt,), daemon=True))
            ahead[1].start()
        if not path or not os.path.exists(path):
            say('  no video, skipped. If you have the file, choose "Use a video file I already have" and point it at this stream.')
            totals['no'] += len(pairs)
            done_all += len(pairs)
            progress('Tracking matches', done_all, left)
            continue
        by_ev = {}
        for ev, j in pairs:
            by_ev.setdefault(ev, []).append(j)
        chunks = []
        for ev, jobs in by_ev.items():
            jobs.sort(key=lambda j: j['off'])
            sp = spacing_of(jobs)
            size = max(4, math.ceil(len(jobs) / workers))
            for i in range(0, len(jobs), size):
                chunks.append((cfg, ev, path, jobs[i:i + size], sp))
        done = 0
        _PROG['hold'] = True
        progress('Tracking matches', done_all, left)
        with ProcessPoolExecutor(max_workers=min(workers, len(chunks))) as pool:
            for fut in as_completed([pool.submit(work_chunk, c) for c in chunks]):
                try:
                    results = fut.result()
                except Exception as e:
                    say('  a worker stopped:', str(e)[:200])
                    continue
                for res in results:
                    done += 1
                    done_all += 1
                    progress('Tracking matches', done_all, left)
                    totals['ok' if res['ok'] else 'no'] += 1
                    totals['plates'] += res['plates']
                    totals['clock'] += res['clock']
                    totals['looks'] += res['looks']
                    totals['hw'] = totals.get('hw') or res.get('hw')
                    say('  %3d/%d  %-22s %s' % (done, len(pairs), str(res['name'])[:22],
                        ('saved · %d looks · %d plates · %d pin sightings · clock %d · %.0fs' % (res['looks'], res['plates'], res.get('pins', 0), res['clock'], res['sec'])) if res['ok'] else 'not saved: ' + res['why']))
        _PROG['hold'] = False
        if not cfg.get('keep_videos') and path.startswith(DIRS['videos']):
            for junk in (path, path + '.have.json'):
                try:
                    os.remove(junk)
                except OSError:
                    pass
    mins = (time.time() - t_all) / 60
    say('\nDone in %.1f minutes: %d matches saved to the website, %d not. %d plates read, the clock read %d times.%s' % (mins, totals['ok'], totals['no'], totals['plates'], totals['clock'], ' Video was decoded on the graphics card.' if totals.get('hw') else ''))
    say('Now open the Robot tracker box on the website (any event). It brings these in and builds the reports by itself.')
    say('Frames were kept for training as it went: review them when you have a few minutes.')
    return totals['ok']


def key_problem(r, cfg):
    """Why the website turned a key down, said so it can be acted on."""
    r = r or {}
    why, status = str(r.get('error') or ''), r.get('status')
    if status == 403 and 'no passcode is set' in why:
        return ('The website has no admin key of its own yet, so no key can match. In Vercel: Settings, Environment Variables, '
                'add TRACKER_PASSCODE (8 or more characters) for Production, then redeploy the site.')
    if status == 403:
        return 'That does not match the key saved in Vercel (TRACKER_PASSCODE). Capitals matter.'
    if status == 404:
        return 'The website at %s has no tracker on it (it answered 404). Is that the right address?' % cfg.get('site')
    if status:
        return 'The website answered %s: %s' % (status, why[:120])
    return 'Could not reach the website (%s). Check the internet connection.' % why[:120]

def need_key(cfg, site):
    if cfg.get('key'):
        return True
    if not INTERACTIVE:
        say('The admin key is not saved yet. Enter it at the top of the window.')
        return False
    say('\nThe admin key is the one saved in the website\'s Settings. It is kept in config.json in this folder\n'
        'and sent only to ' + cfg['site'] + '.')
    key = input('Admin key: ').strip()
    if not key:
        return False
    site.key = key
    r = site.post({'check': True}, tries=1)
    if not (r and r.get('ok')):
        say(key_problem(r, cfg))
        return False
    cfg['key'] = key
    save_config(cfg)
    say('Accepted.')
    return True


# ── menu: frames for training from any video ────────────────────────────────
def harvest_video(path, tag, live=False, every_sec=2.0, limit=3000):
    """Go through a video and keep the frames worth a person's look."""
    import cv2
    eyes = Eyes()
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        say('That could not be opened.')
        return
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    if not (5 <= fps <= 130):
        fps = 30
    step = max(1, int(round(fps * every_sec)))
    seen = kept = 0
    looks = 0 if live else int((cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / step)
    cuts = CutWatch()
    say('Reading it. Press Ctrl+C to stop; what is kept so far stays.' if live else 'Reading it…')
    try:
        while kept < limit:
            ok = True
            for _ in range(step - 1):
                ok = cap.grab()
                if not ok:
                    break
            if not ok:
                break
            ok, frame = cap.read()
            if not ok:
                break
            seen += 1
            if looks and seen % 10 == 0:
                progress('Reading the video', min(seen, looks), looks)
            if cuts.changing(frame, seen * every_sec):  # never keep a frame from the middle of a fade
                continue
            every = eyes.detect(frame, PROPOSE)
            coloured = [b for b in every if b[5]]
            if len(coloured) >= 2:                    # a view of the field, not a crowd or a slate
                hard = hardness(every)
                if hard or seen % 4 == 0:
                    keep_frame(frame, every, tag, hard)
                    kept += 1
            if seen % 50 == 0:
                say('  looked at %d frames, kept %d' % (seen, kept))
    except KeyboardInterrupt:
        pass
    cap.release()
    say('Kept %d frames for review.' % kept)

def do_add_video(cfg):
    say('\nPaste a link to a stream or video, or the path of a video file (you can drag the file onto this window).')
    src = input('Link or file: ').strip().strip('"')
    if not src:
        return
    ensure_models(Site(cfg))
    if os.path.exists(src):
        harvest_video(src, 'file' + hashlib.md5(src.encode()).hexdigest()[:6])
        return
    vid = video_id(src)
    path = find_video(cfg, vid) if vid else None
    if not path:
        say('Downloading it…')
        path = download(src, os.path.join(DIRS['videos'], vid or ('v' + hashlib.md5(src.encode()).hexdigest()[:10])))
    if path:
        harvest_video(path, vid or 'link')
        if not cfg.get('keep_videos'):
            try:
                os.remove(path)
            except OSError:
                pass

def do_live(cfg):
    say('\nPaste the link of a stream that is live now. It is watched as it plays, and frames are kept for\n'
        'training until you press Ctrl+C. (To have live matches tracked into reports, use "Track live" on the website.)')
    src = input('Link: ').strip()
    if not src:
        return
    try:
        import yt_dlp
    except ImportError:
        say('The downloader is not installed. Run VEX_Trainer.bat again.')
        return
    ensure_models(Site(cfg))
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'format': 'b[height<=720]/b'}) as y:
            info = y.extract_info(src, download=False)
        url = info.get('url') or (info.get('formats') or [{}])[-1].get('url')
    except Exception as e:
        say('Could not open that stream:', str(e)[:300])
        return
    if not url:
        say('Could not find a playable address for that stream.')
        return
    harvest_video(url, video_id(src) or 'live', live=True, every_sec=3.0, limit=100000)

def do_map_file(cfg):
    say('\nIf you already have the recording of a stream as a file, it is used instead of downloading.\n'
        'Paste the stream\'s YouTube link (the one the Jumper uses for the event), then the file.')
    vid = video_id(input('Stream link: '))
    if not vid:
        say('That is not a YouTube link.')
        return
    path = input('Video file (drag it onto this window): ').strip().strip('"')
    if not os.path.exists(path):
        say('That file was not found.')
        return
    cfg.setdefault('files', {})[vid] = path
    save_config(cfg)
    say('Saved. Matches in that stream will be read from your file. The file must be the whole stream, from its start,\n'
        'or every match will be looked for in the wrong place.')


# ── menu: review ────────────────────────────────────────────────────────────
REVIEW_HTML = r"""<!doctype html><meta charset="utf-8"><title>Review frames</title>
<style>
 body{margin:0;background:#14161a;color:#e8e8e8;font:15px/1.5 system-ui,sans-serif}
 header{padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #2a2e36}
 header b{font-size:17px} .keys span{background:#262a33;border-radius:5px;padding:2px 7px;margin-right:4px;font-family:ui-monospace,monospace}
 #wrap{padding:12px 16px} canvas{max-width:100%;background:#000;cursor:crosshair;display:block;border-radius:6px}
 button{font:inherit;background:#2d6cdf;color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer} button.sec{background:#30343d}
 #msg{color:#9aa3b2}
</style>
<header><b>Review frames</b><span id="left"></span>
 <span class="keys"><span>click a box</span>remove it &nbsp; <span>drag</span>draw a missing robot &nbsp; <span>Enter</span>save, next &nbsp; <span>S</span>skip (not a field view) &nbsp; <span>Z</span>undo &nbsp; <span>B</span>back</span>
 <button onclick="save(false)">Save, next</button><button class="sec" onclick="save(true)">Skip</button><span id="msg"></span></header>
<div id="wrap"><canvas id="c"></canvas></div>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');let cur=null,img=new Image(),boxes=[],hist=[],drag=null,back=[];
async function next(id){const r=await fetch('/api/next'+(id?'?id='+id:''));cur=await r.json();document.getElementById('left').textContent=cur.id?cur.done+' done · 150 in all is enough to train':'';
 if(!cur.id){document.getElementById('wrap').innerHTML='<p style="padding:30px;font-size:18px">Nothing left to review. You can close this tab; in the app, choose Train.</p>';return;}
 boxes=cur.boxes.map(b=>b.slice(0,4));hist=[];img=new Image();img.onload=()=>{c.width=cur.w;c.height=cur.h;draw()};img.src='/img/'+cur.id+'.jpg';}
function draw(){x.drawImage(img,0,0);x.lineWidth=Math.max(2,c.width/500);boxes.forEach(b=>{x.strokeStyle='#39ff88';x.strokeRect(b[0],b[1],b[2],b[3])});
 if(drag&&drag.w){x.strokeStyle='#ffd23f';x.strokeRect(drag.x,drag.y,drag.w,drag.h)}}
function pos(e){const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]}
c.onmousedown=e=>{const[px,py]=pos(e);drag={x0:px,y0:py,x:px,y:py,w:0,h:0}};
c.onmousemove=e=>{if(!drag)return;const[px,py]=pos(e);drag.x=Math.min(px,drag.x0);drag.y=Math.min(py,drag.y0);drag.w=Math.abs(px-drag.x0);drag.h=Math.abs(py-drag.y0);draw()};
window.onmouseup=e=>{if(!drag)return;const d=drag;drag=null;hist.push(boxes.map(b=>b.slice()));
 if(d.w>8&&d.h>8)boxes.push([d.x,d.y,d.w,d.h]);
 else{let k=-1,a=1e12;boxes.forEach((b,i)=>{if(d.x0>=b[0]&&d.x0<=b[0]+b[2]&&d.y0>=b[1]&&d.y0<=b[1]+b[3]&&b[2]*b[3]<a){a=b[2]*b[3];k=i}});if(k>=0)boxes.splice(k,1);else hist.pop()}
 draw()};
async function save(skip){if(!cur||!cur.id)return;back.push(cur.id);await fetch('/api/save',{method:'POST',body:JSON.stringify({id:cur.id,skip,boxes})});next()}
window.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();save(false)}else if(e.key==='s'||e.key==='S')save(true);
 else if(e.key==='z'||e.key==='Z'){if(hist.length){boxes=hist.pop();draw()}}else if(e.key==='b'||e.key==='B'){if(back.length)next(back.pop())}};
next();
</script>"""

def layout_of(p):
    """Where the robots are in a frame, as fractions of the picture, sorted."""
    w, h = float(p.get('w') or 1), float(p.get('h') or 1)
    return sorted(((b[0] + b[2] / 2) / w, (b[1] + b[3] / 2) / h) for b in p.get('boxes', []) if b[4] >= 0.35)

def same_layout(a, b, tol=0.06):
    """Two frames show the robots in the same places: nothing new to teach."""
    if len(a) != len(b):
        return False
    left = list(b)
    for x, y in a:
        k = next((i for i, (u, v) in enumerate(left) if abs(u - x) <= tol and abs(v - y) <= tol), None)
        if k is None:
            return False
        left.pop(k)
    return True

def review_queue():
    """Frames not yet reviewed: the ones that teach most first, and no two
    alike in a row.

    Reported: "i keep getting the same frames if not a little different". The
    queue was sorted by how unsure the finder was and nothing else, and the
    frames it is unsure about come in runs — the same moment of the same
    match, a third of a second apart. Reviewing the second of those teaches
    almost nothing. So a frame whose robots stand where they stood in one
    already reviewed, or already ahead of it in the queue, goes to the back;
    and the front of the queue takes turns between videos.
    """
    if not os.path.isdir(PROPS):
        return [], 0
    done = set(n[:-5] for n in os.listdir(LABELS)) if os.path.isdir(LABELS) else set()
    todo, seen = [], []
    for n in os.listdir(PROPS):
        name = n[:-5]
        if not os.path.exists(os.path.join(FRAMES, name + '.jpg')):
            continue
        try:
            with open(os.path.join(PROPS, n)) as f:
                p = json.load(f)
        except Exception:
            continue
        vid = name.rsplit('_', 1)[0]
        if name in done:
            seen.append((vid, layout_of(p)))
            continue
        todo.append((-p.get('hard', 0), hashlib.md5(name.encode()).hexdigest(), name, vid, layout_of(p)))
    todo.sort()
    fresh, alike = {}, []
    for _, _, name, vid, lay in todo:
        if any(v == vid and same_layout(lay, l) for v, l in seen[-600:]):
            alike.append(name)
            continue
        seen.append((vid, lay))
        fresh.setdefault(vid, []).append(name)
    # Take turns between videos, each video's hardest first.
    front, lists = [], list(fresh.values())
    while lists:
        lists = [l for l in lists if l]
        for l in lists:
            front.append(l.pop(0))
    return front + alike, len(done)

def do_review(cfg, port=8765, open_browser=True):
    queue, _ = review_queue()
    if not queue:
        say('\nThere are no frames to review yet. Track some matches or add a video first.')
        return None
    state = {'queue': queue}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass
        def _send(self, code, body, ctype='application/json'):
            body = body if isinstance(body, bytes) else body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == '/':
                return self._send(200, REVIEW_HTML, 'text/html; charset=utf-8')
            if u.path.startswith('/img/'):
                name = os.path.basename(u.path)
                if not re.fullmatch(r'[A-Za-z0-9_-]+\.jpg', name):
                    return self._send(404, '{}')
                try:
                    with open(os.path.join(FRAMES, name), 'rb') as f:
                        return self._send(200, f.read(), 'image/jpeg')
                except OSError:
                    return self._send(404, '{}')
            if u.path == '/api/next':
                want = urllib.parse.parse_qs(u.query).get('id', [None])[0]
                done = len(os.listdir(LABELS)) if os.path.isdir(LABELS) else 0
                if want and re.fullmatch(r'[A-Za-z0-9_-]+', want) and os.path.exists(os.path.join(PROPS, want + '.json')):
                    name = want
                    if name not in state['queue']:
                        state['queue'].insert(0, name)
                else:
                    name = state['queue'][0] if state['queue'] else None
                if not name:
                    return self._send(200, json.dumps({'id': None, 'done': done}))
                with open(os.path.join(PROPS, name + '.json')) as f:
                    p = json.load(f)
                boxes = p['boxes']
                lab = os.path.join(LABELS, name + '.json')
                if os.path.exists(lab):                 # going back: show what was saved
                    with open(lab) as f:
                        boxes = json.load(f).get('boxes', boxes)
                else:
                    boxes = [b for b in boxes if b[4] >= 0.35]
                return self._send(200, json.dumps({'id': name, 'w': p['w'], 'h': p['h'], 'boxes': boxes, 'left': len(state['queue']), 'done': done}))
            self._send(404, '{}')
        def do_POST(self):
            if self.path != '/api/save':
                return self._send(404, '{}')
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf-8'))
                name = str(body['id'])
                if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
                    raise ValueError('bad id')
                boxes = [[float(v) for v in b[:4]] for b in body.get('boxes', []) if len(b) >= 4]
                os.makedirs(LABELS, exist_ok=True)
                with open(os.path.join(LABELS, name + '.json'), 'w') as f:
                    json.dump({'skip': bool(body.get('skip')), 'boxes': boxes}, f)
                if name in state['queue']:
                    state['queue'].remove(name)
                self._send(200, '{"ok":true}')
            except Exception as e:
                self._send(400, json.dumps({'error': str(e)}))

    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % port
    if open_browser:
        say('\n%d frames to review, the most useful first. The review page is opening in your browser:\n  %s' % (len(queue), url))
        say('Green boxes are what the finder thinks are robots. Click a wrong one to remove it, drag to draw a missing one,\n'
            'Enter to save and go on. Box every robot you can see, even partly hidden ones. Press S for a picture that is\n'
            'not a view of the field. 300 frames is a good first session; more is better.\n')
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass
        input('Press Enter here when you have finished reviewing… ')
        srv.shutdown()
        _, done = review_queue()
        say('%d frames reviewed in total.' % done)
    return srv


# ── menu: train ─────────────────────────────────────────────────────────────
def reviewed():
    out = []
    if not os.path.isdir(LABELS):
        return out
    for n in sorted(os.listdir(LABELS)):
        name = n[:-5]
        try:
            with open(os.path.join(LABELS, n)) as f:
                lab = json.load(f)
            with open(os.path.join(PROPS, name + '.json')) as f:
                p = json.load(f)
        except Exception:
            continue
        if lab.get('skip') or not os.path.exists(os.path.join(FRAMES, name + '.jpg')):
            continue
        out.append((name, p['w'], p['h'], lab.get('boxes', [])))
    return out

def is_val(name):
    return int(hashlib.md5(name.encode()).hexdigest(), 16) % 100 < 15

def build_dataset():
    """Reviewed frames are the truth. Frames nobody looked at join the training
    side only when the finder was sure of exactly four robots on them."""
    root = os.path.join(DIRS['build'], 'dataset')
    shutil.rmtree(root, ignore_errors=True)
    for part in ('train', 'val'):
        os.makedirs(os.path.join(root, 'images', part))
        os.makedirs(os.path.join(root, 'labels', part))
    def put(name, w, h, boxes, part):
        shutil.copyfile(os.path.join(FRAMES, name + '.jpg'), os.path.join(root, 'images', part, name + '.jpg'))
        with open(os.path.join(root, 'labels', part, name + '.txt'), 'w') as f:
            for b in boxes:
                x, y, bw, bh = max(0, b[0]), max(0, b[1]), b[2], b[3]
                bw, bh = min(bw, w - x), min(bh, h - y)
                if bw > 2 and bh > 2:
                    f.write('0 %.6f %.6f %.6f %.6f\n' % ((x + bw / 2) / w, (y + bh / 2) / h, bw / w, bh / h))
    gold = reviewed()
    counts = {'train': 0, 'val': 0, 'pseudo': 0}
    names = set()
    for name, w, h, boxes in gold:
        part = 'val' if is_val(name) else 'train'
        put(name, w, h, boxes, part)
        counts[part] += 1
        names.add(name)
    pseudo = []
    for n in os.listdir(PROPS):
        name = n[:-5]
        if name in names or os.path.exists(os.path.join(LABELS, n)) or not os.path.exists(os.path.join(FRAMES, name + '.jpg')):
            continue
        try:
            with open(os.path.join(PROPS, n)) as f:
                p = json.load(f)
        except Exception:
            continue
        if len(p['boxes']) == 4 and all(b[4] >= 0.6 for b in p['boxes']):
            pseudo.append((name, p['w'], p['h'], p['boxes']))
    random.Random(7).shuffle(pseudo)
    for name, w, h, boxes in pseudo[:2 * max(1, counts['train'])]:
        put(name, w, h, boxes, 'train')
        counts['pseudo'] += 1
    with open(os.path.join(root, 'data.yaml'), 'w') as f:
        f.write('path: %s\ntrain: images/train\nval: images/val\nnames:\n  0: robot\n' % root.replace('\\', '/'))
    return root, counts

def score_finder(model_path, val):
    """How a finder does on reviewed frames it never trained on. → precision, recall, F1"""
    import cv2
    eyes = Eyes(model_path, quiet=True)
    tp = fp = fn = 0
    for name, w, h, truth in val:
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        found = [b for b in eyes.detect(frame, CONF)]
        used = set()
        for b in found:
            best, bi = 0, -1
            for i, t in enumerate(truth):
                if i in used:
                    continue
                v = iou(b, t)
                if v > best:
                    best, bi = v, i
            if best >= 0.5:
                used.add(bi)
                tp += 1
            else:
                fp += 1
        fn += len(truth) - len(used)
    p = tp / (tp + fp) if tp + fp else 0
    r = tp / (tp + fn) if tp + fn else 0
    return p, r, (2 * p * r / (p + r) if p + r else 0)

def pip(*args):
    return subprocess.call([sys.executable, '-m', 'pip', 'install', '-q'] + list(args)) == 0

def ensure_training_tools():
    try:
        import torch, ultralytics  # noqa
        if torch.cuda.is_available():
            return True
        say('The training tools are installed but cannot see the graphics card; reinstalling the graphics-card build…')
    except ImportError:
        say('\nInstalling the training tools (about 3 GB, once)…')
    # RTX 50-series cards need the CUDA 12.8 build.
    if not pip('torch', 'torchvision', '--index-url', 'https://download.pytorch.org/whl/cu128', '--upgrade'):
        say('That did not install. Check the internet connection and try again.')
        return False
    if not pip('ultralytics', 'onnx', 'onnxslim'):
        return False
    return True

def do_train(cfg):
    gold = reviewed()
    val = [g for g in gold if is_val(g[0])]
    say('\n%d reviewed frames (%d held back for testing).' % (len(gold), len(val)))
    if len(gold) < 150:
        say('That is too few to train on: review at least 150, and 300 or more to expect a real improvement.')
        return
    if len(val) < 20:
        say('Too few test frames yet to measure a new finder fairly; review some more.')
        return
    ensure_models(Site(cfg))
    if not ensure_training_tools():
        return
    import torch
    from ultralytics import YOLO
    root, counts = build_dataset()
    say('Training on %d reviewed frames and %d the finder was sure of; testing on %d.' % (counts['train'], counts['pseudo'], counts['val']))
    device = 0 if torch.cuda.is_available() else 'cpu'
    if device == 'cpu':
        say('The graphics card is not being used (PyTorch cannot see it), so this will be slow.')
    tag = 'u' + time.strftime('%y%m%d%H%M')
    runs = os.path.join(DIRS['build'], 'runs')
    model = YOLO('yolov8n.pt')                        # the same size as the website's finder, so it stays fast in a browser
    # A line each round, so the window's bar moves and "is it still going?"
    # has an answer. (Asked: "how do i know if it finished training?")
    total_rounds = int(cfg.get('epochs', 80))
    rounds = {'n': 0}
    def each_round(trainer):
        rounds['n'] = int(getattr(trainer, 'epoch', rounds['n'])) + 1
        say('  training: round %d/%d' % (rounds['n'], total_rounds))
        progress('Training', rounds['n'], total_rounds)
    try:
        model.add_callback('on_fit_epoch_end', each_round)
    except Exception:
        pass
    say('Training started. It stops early by itself if it stops getting better.')
    model.train(data=os.path.join(root, 'data.yaml'), epochs=int(cfg.get('epochs', 80)), imgsz=SIZE, batch=int(cfg.get('batch', 32)), device=device,
                workers=4, patience=20, project=runs, name=tag, exist_ok=True, single_cls=True, verbose=False, plots=False)
    best = os.path.join(runs, tag, 'weights', 'best.pt')
    onnx_path = YOLO(best).export(format='onnx', imgsz=SIZE, opset=12, simplify=True, dynamic=False)
    out = os.path.join(DIRS['models'], 'trained_%s.onnx' % tag)
    shutil.copyfile(onnx_path, out)
    # Does it answer in the shape the website expects?
    import onnxruntime as ort
    shape = ort.InferenceSession(out, providers=['CPUExecutionProvider']).get_outputs()[0].shape
    if list(shape) != [1, 5, 8400]:
        say('The new finder answers in a shape the website cannot read (%s), so it will not be offered for publishing.' % shape)
        return
    say('\nMeasuring both finders on the %d test frames (ones neither trained on)…' % len(val))
    old = score_finder(os.path.join(DIRS['models'], 'robot_detector.onnx'), val)
    new = score_finder(out, val)
    say('                    right when it says robot   robots it finds   overall')
    say('  current finder          %5.1f%%                %5.1f%%          %5.1f' % (old[0] * 100, old[1] * 100, old[2] * 100))
    say('  new finder              %5.1f%%                %5.1f%%          %5.1f' % (new[0] * 100, new[1] * 100, new[2] * 100))
    with open(os.path.join(DIRS['models'], 'trained_latest.json'), 'w') as f:
        json.dump({'tag': tag, 'file': out, 'old': old, 'new': new, 'frames': len(gold), 'train': counts['train'], 'auto': counts['pseudo'],
                   'test': counts['val'], 'rounds': rounds['n'], 'when': time.strftime('%b %d, %H:%M'), 'published': False}, f)
    say('\nTRAINING FINISHED after %d rounds: learned from %d frames you reviewed and %d the finder was already sure of;'
        ' tested on %d it never saw.' % (rounds['n'], counts['train'], counts['pseudo'], counts['val']))
    if new[2] > old[2]:
        say('The new finder is better on frames it has never seen.')
    else:
        say('\nThe new finder is NOT better than the current one, so it is not published. Review more frames (especially\n'
            'ones where the green boxes were wrong) and train again.')
    return {'tag': tag, 'file': out, 'old': old, 'new': new, 'frames': len(gold)}


def do_publish(cfg):
    site = Site(cfg)
    if not need_key(cfg, site):
        return
    info_path = os.path.join(DIRS['models'], 'trained_latest.json')
    if not os.path.exists(info_path):
        say('\nNo trained finder yet. Choose Train first.')
        return
    with open(info_path) as f:
        info = json.load(f)
    old, new = info['old'], info['new']
    say('\nNewest trained finder: %s — overall %.1f against the current %.1f, from %d reviewed frames.' % (info['tag'], new[2] * 100, old[2] * 100, info['frames']))
    say('  1  Publish it: the website and this app use it from now on\n  2  Take my finder off the website (back to the built-in one)\n  Enter  do nothing')
    pick = input('> ').strip()
    if pick == '2':
        r = site.post({'model': {'clear': True}})
        if r and r.get('ok'):
            try:
                os.remove(os.path.join(DIRS['models'], 'trained_current.onnx'))
            except OSError:
                pass
            say('Removed. The website is back on its built-in finder.')
        else:
            say('The website did not accept that:', (r or {}).get('error'))
        return
    if pick != '1':
        return
    if new[2] <= old[2]:
        if input('It measured no better than the current finder. Type YES to publish it anyway: ').strip() != 'YES':
            return
    send_finder(cfg, site, info)


def send_finder(cfg, site, info):
    """Put a trained finder on the website, in parts. → True when it is in use."""
    old, new = info['old'], info['new']
    with open(info['file'], 'rb') as f:
        data = f.read()
    part = 640 * 1024
    n = math.ceil(len(data) / part)
    note = 'overall %.1f vs %.1f, %d frames' % (new[2] * 100, old[2] * 100, info['frames'])
    for i in range(n):
        r = site.post({'model': {'tag': info['tag'], 'i': i, 'n': n, 'note': note, 'b64': base64.b64encode(data[i * part:(i + 1) * part]).decode('ascii')}})
        if not (r and r.get('ok')):
            say('Stopped at part %d of %d: %s. Nothing changed on the website.' % (i + 1, n, (r or {}).get('error')))
            return False
        say('  sent part %d of %d' % (i + 1, n))
        progress('Publishing the finder', i + 1, n)
    shutil.copyfile(info['file'], os.path.join(DIRS['models'], 'trained_current.onnx'))
    say('Published. The website\'s tracker fetches it the next time it starts and uses it from the start after that;\n'
        'its status line then says "your trained finder".')
    return True

def unpublish(cfg):
    site = Site(cfg)
    if not need_key(cfg, site):
        return
    r = site.post({'model': {'clear': True}})
    if r and r.get('ok'):
        try:
            os.remove(os.path.join(DIRS['models'], 'trained_current.onnx'))
        except OSError:
            pass
        say('Removed. The website and this app are back on the built-in finder.')
    else:
        say('The website did not accept that:', (r or {}).get('error'))


# ── review anywhere ─────────────────────────────────────────────────────────
# The frames worth a person's look are sent to the website, shrunk, so they
# can be corrected on a phone. The corrections come back here before training.
UPLOADED = os.path.join(HERE, 'data', 'uploaded.json')

def push_review(cfg, limit=120):
    """Send the hardest unreviewed frames to the website. → how many went."""
    import cv2
    site = Site(cfg)
    if not cfg.get('key'):
        return 0
    try:
        with open(UPLOADED) as f:
            sent = set(json.load(f))
    except Exception:
        sent = set()
    waiting = set(site.get('?frames=1').get('ids') or [])
    queue, _ = review_queue()
    room = max(0, limit - len(waiting))
    n = 0
    for name in queue:
        if n >= room:
            break
        if name in sent or name in waiting:
            continue
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        try:
            with open(os.path.join(PROPS, name + '.json')) as f:
                p = json.load(f)
        except Exception:
            continue
        h, w = frame.shape[:2]
        k = min(1.0, 960 / w)
        small = cv2.resize(frame, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA) if k < 1 else frame
        ok, buf = cv2.imencode('.jpg', small, [cv2.IMWRITE_JPEG_QUALITY, 72])
        if not ok:
            continue
        r = site.post({'frame': {'id': name, 'w': int(p['w']), 'h': int(p['h']), 'boxes': [[float(v) for v in b[:5]] for b in p['boxes'][:60]],
                                 'b64': base64.b64encode(buf.tobytes()).decode('ascii')}}, tries=1)
        if r and r.get('ok'):
            sent.add(name)
            n += 1
        elif (r or {}).get('error') == 'full' or (r or {}).get('status') == 403:
            break
    os.makedirs(os.path.dirname(UPLOADED), exist_ok=True)
    with open(UPLOADED, 'w') as f:
        json.dump(sorted(sent)[-5000:], f)
    return n

def pull_labels(cfg):
    """Bring back what was corrected on the website. → how many came."""
    site = Site(cfg)
    if not cfg.get('key'):
        return 0
    labels = site.get('?labels=1').get('labels') or {}
    got = []
    os.makedirs(LABELS, exist_ok=True)
    for name, lab in labels.items():
        if not re.fullmatch(r'[A-Za-z0-9_-]{4,60}', str(name)) or not isinstance(lab, dict):
            continue
        got.append(name)
        if not os.path.exists(os.path.join(PROPS, name + '.json')):
            continue                                  # a frame this computer does not have
        boxes = [[float(v) for v in b[:4]] for b in (lab.get('boxes') or []) if isinstance(b, list) and len(b) >= 4][:60]
        with open(os.path.join(LABELS, name + '.json'), 'w') as f:
            json.dump({'skip': bool(lab.get('skip')), 'boxes': boxes}, f)
    for i in range(0, len(got), 300):
        site.post({'labelsdone': got[i:i + 300]}, tries=1)
    return len(got)

def sync_review(cfg, quiet=False):
    try:
        came = pull_labels(cfg)
        went = push_review(cfg)
        if (came or went) and not quiet:
            say('Review: %d corrected frames came back from the website, %d new frames sent there for review.' % (came, went))
    except Exception as e:
        if not quiet:
            say('Could not sync the review frames with the website (%s).' % str(e)[:120])


# ── what the window's buttons run ───────────────────────────────────────────
# Each is one whole job with nothing to answer along the way.
def track_all(cfg, loop=True):
    """Everything the website asked for; then keep an eye out for more."""
    quiet = False
    while True:
        try:
            site = Site(cfg)
            events = site.get('?jobs=1').get('events') or []
            if events:
                quiet = False
                n = do_jobs(cfg)
                sync_review(cfg)
                if not n:
                    events = []                       # nothing could be done with what is there: wait, do not spin
            if not events and not quiet:
                say('\nNothing to track right now. To give it work, on the website: Jumper, open an event,\n'
                    'Robot tracker box, "Send this event to the app".')
                if loop:
                    say('Waiting for the website to send work. It starts by itself.')
                quiet = True
        except Exception as e:
            say('Could not reach the website (%s). Trying again in a minute.' % str(e)[:120])
        if not loop:
            return
        progress('Waiting for the website to send work', wait=60)
        time.sleep(60)

def add_source(cfg, src):
    """A file, a link to a recording, or a link to a stream that is live now: learn from it."""
    src = str(src or '').strip().strip('"')
    if not src:
        say('Paste a link or a file path first.')
        return
    ensure_models(Site(cfg))
    if os.path.exists(src):
        return harvest_video(src, 'file' + hashlib.md5(src.encode()).hexdigest()[:6])
    if '://' not in src and not video_id(src):
        say('That is neither a file on this computer nor a link.')
        return
    ensure_downloader()
    try:
        import yt_dlp
    except ImportError:
        say('The downloader is not installed. Close this and run VEX_Trainer.bat again.')
        return
    url = src if '://' in src else 'https://www.youtube.com/watch?v=' + src
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'format': 'b[height<=720]/b'}) as y:
            info = y.extract_info(url, download=False)
    except Exception as e:
        say('Could not open that link:', str(e)[:300])
        return
    vid = video_id(src) or str(info.get('id') or 'link')[:20]
    if info.get('is_live'):
        say('That stream is live. Watching it as it plays; press Stop when you have had enough.')
        stream = info.get('url') or (info.get('formats') or [{}])[-1].get('url')
        if not stream:
            say('Could not find a playable address for that stream.')
            return
        return harvest_video(stream, re.sub(r'[^A-Za-z0-9_-]', '', vid) or 'live', live=True, every_sec=3.0, limit=100000)
    path = find_video(cfg, vid)
    if not path:
        say('Downloading it…')
        path = download(url, os.path.join(DIRS['videos'], re.sub(r'[^A-Za-z0-9_-]', '', vid) or 'video'))
    if path:
        harvest_video(path, re.sub(r'[^A-Za-z0-9_-]', '', vid) or 'video')
        if not cfg.get('keep_videos') and path.startswith(DIRS['videos']):
            try:
                os.remove(path)
            except OSError:
                pass

def train_auto(cfg):
    """Train, measure, and publish only if the new finder is better."""
    sync_review(cfg)                                  # corrections made on a phone count too
    info = do_train(cfg)
    if not info:
        return
    if info['new'][2] <= info['old'][2]:
        return
    site = Site(cfg)
    if not need_key(cfg, site):
        say('It is better, but without the admin key it cannot be published.')
        return
    say('\nPublishing it to the website…')
    if send_finder(cfg, site, info):
        try:
            path = os.path.join(DIRS['models'], 'trained_latest.json')
            with open(path) as f:
                saved = json.load(f)
            saved['published'] = True
            with open(path, 'w') as f:
                json.dump(saved, f)
        except Exception:
            pass
        say('ALL DONE. The website now uses the finder you trained.')


# ── menu ────────────────────────────────────────────────────────────────────
def do_settings(cfg):
    say('\nWebsite: %s\nAdmin key: %s\nMatches watched at once: %d\nKeep downloaded videos: %s' % (cfg['site'], 'saved' if cfg.get('key') else 'not set', cfg.get('workers', 4), 'yes' if cfg.get('keep_videos') else 'no'))
    say('  1  Change the admin key\n  2  Change how many matches are watched at once\n  3  Keep / delete downloaded videos after tracking\n  Enter  back')
    pick = input('> ').strip()
    if pick == '1':
        cfg['key'] = ''
        need_key(cfg, Site(cfg))
    elif pick == '2':
        try:
            cfg['workers'] = max(1, min(16, int(input('How many (1-16; 4 to 8 suits an 8-core processor): '))))
            cfg['workers_chosen'] = True
            save_config(cfg)
        except ValueError:
            pass
    elif pick == '3':
        cfg['keep_videos'] = not cfg.get('keep_videos')
        save_config(cfg)
        say('Downloaded videos will be', 'kept.' if cfg['keep_videos'] else 'deleted after tracking.')

# ── the window ──────────────────────────────────────────────────────────────
# One page, served to this computer only, opened as its own window. Three
# buttons — Track, Review, Train — and a box to paste a link or a file into.
# Each button starts this same program again with a flag, as a separate
# process: a job can then be stopped cleanly, and a crash in one cannot take
# the window down with it. What the job prints is what the window shows.
UI_HTML = r"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VEX Trainer</title>
<style>
 :root{--bg:#101318;--card:#181c24;--line:#272d3a;--text:#e9ecf1;--dim:#98a2b3;--blue:#3b82f6;--green:#22c55e;--amber:#f5b83d;--red:#ef4444}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
 header{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line)}
 header h1{font-size:19px;margin:0;font-weight:650;letter-spacing:.2px} header .site{color:var(--dim);font-size:13px}
 header .sp{flex:1} .pill{font-size:13px;padding:4px 10px;border-radius:99px;background:#1f2633;color:var(--dim)} .pill.ok{color:var(--green)} .pill.bad{color:var(--amber)}
 button{font:inherit;color:#fff;background:var(--blue);border:0;border-radius:9px;padding:10px 18px;cursor:pointer;font-weight:600}
 button:disabled{opacity:.45;cursor:default} button.ghost{background:#252b38;font-weight:500} button.stop{background:var(--red)} button.link{background:none;color:var(--dim);padding:4px 6px;font-weight:400;text-decoration:underline}
 main{max-width:1080px;margin:0 auto;padding:22px}
 .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px} @media(max-width:820px){.cards{grid-template-columns:1fr}}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px}
 .card h2{margin:0;font-size:17px} .card p{margin:0;color:var(--dim);font-size:14px;flex:1} .card .n{font-size:13px;color:var(--text);line-height:1.5} .card .n b{color:var(--green)}
 .card button{width:100%;padding:13px;font-size:16px}
 .add{display:flex;gap:10px;margin-top:16px} .add input{flex:1}
 select{font:inherit;background:#0c0f14;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px 12px}
 input{font:inherit;background:#0c0f14;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px 12px;min-width:0}
 .panel{margin-top:16px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
 .now{display:flex;gap:12px;align-items:center} .now b{flex:1;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .bar{height:6px;background:#0c0f14;border-radius:9px;margin:12px 0 10px;overflow:hidden} .bar i{display:block;height:100%;width:0;background:var(--blue);transition:width .4s} .bar.idle{display:none} .bar.busy i{width:30%!important;animation:slide 1.4s ease-in-out infinite;transition:none} @keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}} @media (prefers-reduced-motion:reduce){.bar.busy i{animation:none;margin-left:35%}} #eta{display:flex;justify-content:space-between;color:var(--dim,#9aa4b2);font-size:13px;margin:-4px 0 8px;font-variant-numeric:tabular-nums} #eta:empty{display:none}
 pre{margin:0;max-height:270px;overflow:auto;font:12.5px/1.55 ui-monospace,Consolas,monospace;color:#b7c0cf;white-space:pre-wrap;word-break:break-word}
 .hint{color:var(--dim);font-size:13px;margin-top:10px}
 details.more{margin-top:14px} details.more>summary{cursor:pointer;color:var(--dim);font-size:13px} details.more .add{margin-top:10px} .panel details.more{margin-top:4px}
 #key{display:none;margin-bottom:16px;border-color:#4a3d1a;background:#1d1a12} #key .row{display:flex;gap:10px;margin-top:10px} #key input{flex:1}
 #rev{display:none} #rev .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px} #rev .top .sp{flex:1}
 #rev canvas{max-width:100%;max-height:calc(100vh - 210px);background:#000;border-radius:10px;cursor:crosshair;display:block;margin:0 auto}
 kbd{background:#252b38;border-radius:5px;padding:1px 7px;font:12.5px ui-monospace,Consolas,monospace;margin-right:3px}
 .keys{color:var(--dim);font-size:13px}
 dialog{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:20px;min-width:340px} dialog::backdrop{background:#000a}
 dialog label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px} dialog .row{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
</style>
<header><h1>VEX Trainer</h1><span class="site" id="site"></span><span class="sp"></span>
 <span class="pill" id="keyPill">…</span><button class="ghost" onclick="openSettings()">Settings</button></header>
<main id="home">
 <div class="panel" id="key"><b>Enter the admin key once</b><div class="hint" style="margin-top:4px">The same key that is saved in the website's Settings. It is kept on this computer and sent only to your website.</div>
  <div class="row"><input id="keyIn" type="password" placeholder="Admin key" autocomplete="off" onkeydown="if(event.key==='Enter')saveKey()"><button id="bKey" onclick="saveKey()">Save</button></div><div class="hint" id="keyMsg"></div></div>
 <div class="cards">
  <div class="card"><h2>1 · Track</h2><p>Watches the matches the website sent. Starts by itself.</p>
   <div class="n" id="trackN">&nbsp;</div><button id="bTrack" onclick="start('track')">Start tracking</button></div>
  <div class="card"><h2>2 · Review</h2><p>Fix the boxes on 150 frames, the hardest first. You never need to do them all.</p>
   <div class="n" id="revN">&nbsp;</div><button id="bRev" onclick="openReview()">Review frames</button></div>
  <div class="card"><h2>3 · Train</h2><p>Makes a better robot finder and publishes it only if it wins.</p>
   <div class="n" id="trainN">&nbsp;</div><button id="bTrain" onclick="start('train')">Train</button></div>
 </div>
 <details class="more"><summary>More: learn from another video</summary><div class="add"><input id="src" placeholder="Optional: paste a stream link (recorded or live) or a video file's path to learn from it" autocomplete="off" onkeydown="if(event.key==='Enter'&&!$('bAdd').disabled)start('add')"><button class="ghost" id="bAdd" onclick="start('add')">Learn from this</button></div></details>
 <div class="panel"><div class="now"><b id="now">Ready.</b><button class="stop" id="bStop" style="display:none" onclick="stopJob()">Stop</button></div>
  <div class="bar idle" id="barBox"><i id="bar"></i></div><div id="eta"></div><details class="more"><summary>Details</summary><pre id="log"></pre></details></div>
 <div class="hint">To give it work: on the website, Jumper → open an event → <b>Send this event to the app</b>.</div>
</main>
<main id="rev">
 <div class="top"><button class="ghost" onclick="closeReview()">← Back</button><b id="revLeft"></b><span class="sp"></span>
  <span class="keys"><kbd>click a box</kbd>remove <kbd>drag</kbd>add a robot <kbd>Enter</kbd>save, next <kbd>S</kbd>not a field view <kbd>Z</kbd>undo <kbd>B</kbd>back one</span>
  <button class="ghost" onclick="saveFrame(true)">Skip</button><button onclick="saveFrame(false)">Save, next</button></div>
 <canvas id="c"></canvas><div class="hint" id="revMsg">Green boxes are what the finder thinks are robots. Box every robot you can see, even partly hidden ones, and nothing else. <b>Two robots touching get one box each:</b> if one green box covers both, click it away and draw two, split at the gap between their drivebases.</div>
</main>
<dialog id="dlg"><b>Settings</b>
 <label>Matches watched at once (4 to 8 suits an 8-core processor)</label><input id="sWorkers" type="number" min="1" max="16" style="width:100%">
 <label>Download speed</label><select id="sSpeed" style="width:100%"><option value="0">Full speed (uses the whole connection)</option><option value="40">Fast, leaves some room (40 MB/s)</option><option value="15">Gentle, fine for gaming (15 MB/s)</option><option value="5">Very gentle (5 MB/s)</option></select>
 <label><input id="sKeep" type="checkbox" style="width:auto"> Keep downloaded videos after tracking</label>
 <label>Admin key</label><button class="ghost" onclick="forgetKey()">Change the admin key</button>
 <label>Trained finder</label><button class="ghost" onclick="dlg.close();start('unpublish')">Take my finder off the website</button>
 <div class="row"><button class="ghost" onclick="dlg.close()">Cancel</button><button onclick="saveSettings()">Save</button></div></dialog>
<script>
const T=new URLSearchParams(location.search).get('t')||'',$=id=>document.getElementById(id),dlg=$('dlg');
const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'X-Token':T,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()};
let st=null,inReview=false;
async function poll(){try{st=await api('/api/state');paint()}catch(e){$('now').textContent='The program behind this window has stopped. Close this and run VEX_Trainer.bat again.'}}
function paint(){
 $('site').textContent=st.site.replace(/^https?:\/\//,'');
 $('keyPill').textContent=st.key?'Admin key saved':'No admin key';$('keyPill').className='pill '+(st.key?'ok':'bad');
 $('key').style.display=st.key?'none':'block';
 const goal=st.gold<150?150:st.gold<300?300:Math.ceil((st.gold+1)/150)*150;
 $('revN').textContent=st.gold+' of '+goal+' done'+(st.gold<150?' · '+(150-st.gold)+' more and it can train':st.gold<300?' · it can train now; 300 is better':' · plenty; more still helps');
 $('bRev').disabled=!st.waiting;
 $('trackN').textContent=st.task==='track'?'Running':' ';
 const need=Math.max(0,150-st.gold);
 const L=st.last,since=L?Math.max(0,st.gold-L.frames):0;
 $('trainN').innerHTML=st.task==='train'?'Training now. The bar below shows how far along.':need?('Review '+need+' more frames first'):!L?(st.gold+' reviewed frames ready'):
  ('<b>'+(L.published?'Finished and published':'Finished, not published (it was no better)')+'</b>'+(L.when?' · '+L.when:'')+'<br>Trained on '+L.frames+' frames you reviewed'+(L.auto?' + '+L.auto+' it was sure of':'')+(L.rounds?', '+L.rounds+' rounds':'')+
   '<br>Score: new '+L.new+' vs old '+L.old+(since?'<br>'+since+' more reviewed since then':''));
 for(const b of ['bTrack','bTrain','bAdd'])$(b).disabled=st.busy||(b==='bTrain'&&need>0)||(b==='bTrack'&&!st.key);
 $('bStop').style.display=st.busy?'':'none';
 const names={track:'Tracking',train:'Training',add:'Learning from a video',unpublish:'Removing the finder'};
 const last=(st.log.filter(l=>l.trim()).pop()||'').trim();
 const P=st.busy?st.progress:null,box=$('barBox'),eta=$('eta');
 // A real bar: how much is done, and how long is left at the pace so far.
 // Nothing to measure yet → a moving stripe; waiting for work → no bar at all.
 if(P&&P.total){const pct=Math.min(100,100*P.done/P.total),mb=/Downloading/.test(P.stage);
  box.className='bar';$('bar').style.width=pct+'%';
  $('now').textContent=P.stage;
  eta.innerHTML='<span>'+(mb?Math.round(P.done/1e6)+' of '+Math.round(P.total/1e6)+' MB':Math.round(P.done)+' of '+Math.round(P.total))+' · '+Math.floor(pct)+'%</span><span>'+left(P.left)+'</span>';}
 else if(P&&P.stage){box.className='bar idle';$('now').textContent=P.stage;eta.innerHTML='<span>Nothing to do right now</span><span>checks again in '+P.wait+' s</span>';}
 else{box.className=st.busy?'bar busy':'bar idle';$('bar').style.width='0';eta.innerHTML='';
  $('now').textContent=st.busy?(names[st.task]||'Working')+' · '+last:(last||'Ready.');}
 const log=$('log'),atEnd=log.scrollTop+log.clientHeight>=log.scrollHeight-30;log.textContent=st.log.join('\n');if(atEnd)log.scrollTop=log.scrollHeight;
}
function left(s){if(s===null||s===undefined)return 'working out the time left…';if(s<=0)return 'finishing';if(s<60)return 'under a minute left';const m=Math.round(s/60);return 'about '+(m<90?m+' min':Math.floor(m/60)+' h '+(m%60)+' min')+' left'}
async function start(task){const r=await api('/api/start',{task,src:$('src').value});if(r.error)alert(r.error);if(task==='add'&&!r.error)$('src').value='';poll()}
async function stopJob(){await api('/api/stop',{});poll()}
async function saveKey(){const v=$('keyIn').value.trim();if(!v){$('keyMsg').textContent='Type the admin key first.';return}
 $('keyMsg').textContent='Checking with the website…';$('bKey').disabled=true;
 try{const r=await api('/api/key',{key:v});$('keyMsg').textContent=r.ok?'Saved.':(r.error||'Not accepted.')}
 catch(e){$('keyMsg').textContent='The program behind this window did not answer. Close it and run VEX_Trainer.bat again.'}
 $('bKey').disabled=false;poll()}
async function forgetKey(){await api('/api/key',{key:''});dlg.close();poll()}
function openSettings(){$('sWorkers').value=st.workers;$('sKeep').checked=st.keep;$('sSpeed').value=String(st.speed||0);dlg.showModal()}
async function saveSettings(){await api('/api/settings',{workers:+$('sWorkers').value,keep:$('sKeep').checked,speed:+$('sSpeed').value});dlg.close();poll()}
// review
const c=$('c'),x=c.getContext('2d');let cur=null,img=new Image(),boxes=[],hist=[],drag=null,back=[];
function openReview(){inReview=true;$('home').style.display='none';$('rev').style.display='block';nextFrame()}
function closeReview(){inReview=false;$('rev').style.display='none';$('home').style.display='block';poll()}
async function nextFrame(id){cur=await api('/api/next'+(id?'?id='+id:''));if(!cur.id){closeReview();return}
 const g=cur.gold||0,goal=g<150?150:g<300?300:Math.ceil((g+1)/150)*150;$('revLeft').textContent=g+' of '+goal+' done'+(g<150?' · '+(150-g)+' to go until it can train':' · enough to train; stop whenever you like');boxes=cur.boxes.map(b=>b.slice(0,4));hist=[];
 img=new Image();img.onload=()=>{c.width=cur.w;c.height=cur.h;draw()};img.src='/img/'+cur.id+'.jpg?t='+T}
function draw(){x.drawImage(img,0,0);x.lineWidth=Math.max(2,c.width/450);for(const b of boxes){x.strokeStyle='#39ff88';x.strokeRect(b[0],b[1],b[2],b[3])}
 if(drag&&drag.w){x.strokeStyle='#ffd23f';x.strokeRect(drag.x,drag.y,drag.w,drag.h)}}
function pos(e){const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]}
c.onmousedown=e=>{const[px,py]=pos(e);drag={x0:px,y0:py,x:px,y:py,w:0,h:0}};
c.onmousemove=e=>{if(!drag)return;const[px,py]=pos(e);drag.x=Math.min(px,drag.x0);drag.y=Math.min(py,drag.y0);drag.w=Math.abs(px-drag.x0);drag.h=Math.abs(py-drag.y0);draw()};
window.onmouseup=()=>{if(!drag)return;const d=drag;drag=null;hist.push(boxes.map(b=>b.slice()));
 if(d.w>8&&d.h>8)boxes.push([d.x,d.y,d.w,d.h]);
 else{let k=-1,a=1e12;boxes.forEach((b,i)=>{if(d.x0>=b[0]&&d.x0<=b[0]+b[2]&&d.y0>=b[1]&&d.y0<=b[1]+b[3]&&b[2]*b[3]<a){a=b[2]*b[3];k=i}});if(k>=0)boxes.splice(k,1);else hist.pop()}draw()};
async function saveFrame(skip){if(!cur||!cur.id)return;back.push(cur.id);await api('/api/save',{id:cur.id,skip,boxes});nextFrame()}
window.onkeydown=e=>{if(!inReview||dlg.open)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();saveFrame(false)}else if(/^s$/i.test(e.key))saveFrame(true);
 else if(/^z$/i.test(e.key)){if(hist.length){boxes=hist.pop();draw()}}else if(/^b$/i.test(e.key)){if(back.length)nextFrame(back.pop())}else if(e.key==='Escape')closeReview()};
poll();setInterval(()=>{if(!inReview)poll()},1000);
</script></html>"""


class Job:
    """The one thing running now, as a separate process, and what it has printed."""
    def __init__(self):
        self.proc, self.task, self.log, self.lock = None, '', [], threading.Lock()
        self.tail, self.prog, self.seen = '', None, {}

    def busy(self):
        return self.proc is not None and self.proc.poll() is None

    def add(self, text):
        with self.lock:
            text = self.tail + text.replace('\r\n', '\n')
            cut = text.rfind('\n') + 1                  # half a progress line waits for its other half
            self.tail = text[cut:] if text[cut:].startswith('@') else ''
            if self.tail:
                text = text[:cut]
            for line in text.split('\n'):
                if line.startswith('@@P '):
                    self.note(line[4:])
                    continue
                if '\r' in line:                         # a progress bar redrawing itself: keep its last state
                    line = [p for p in line.split('\r') if p.strip()][-1:] or ['']
                    line = line[0]
                    if self.log and self.log[-1].startswith('\x00'):
                        self.log[-1] = '\x00' + line
                        continue
                    self.log.append('\x00' + line)
                    continue
                self.log.append(line)
            del self.log[:-400]

    def note(self, body):
        """One progress line. The time left comes from how fast this stage has
        gone since it was first heard of, waits between videos included."""
        try:
            d = json.loads(body)
            stage, done, total, wait = str(d.get('s') or ''), float(d.get('d') or 0), float(d.get('t') or 0), float(d.get('w') or 0)
        except Exception:
            return
        now = time.time()
        if wait or total <= 0:
            self.prog = {'s': stage, 'wait_until': now + wait} if stage else None
            return
        first = self.seen.setdefault((stage, total), (now, done))
        left = None
        if done >= total:
            left = 0
        elif done > first[1] and now - first[0] >= 2:
            left = (total - done) * (now - first[0]) / (done - first[1])
        self.prog = {'s': stage, 'd': done, 't': total, 'ends': None if left is None else now + left}

    def progress(self):
        """→ what the window shows: stage, share done, seconds left (None while it cannot say yet)."""
        p = self.prog if self.busy() else None
        if not p:
            return None
        now = time.time()
        if 'wait_until' in p:
            return {'stage': p['s'], 'wait': max(0, int(round(p['wait_until'] - now)))}
        return {'stage': p['s'], 'done': p['d'], 'total': p['t'], 'left': None if p['ends'] is None else max(0, int(round(p['ends'] - now)))}

    def lines(self):
        with self.lock:
            return [l.lstrip('\x00') for l in self.log[-200:]]

    def start(self, task, args):
        if self.busy():
            return False
        env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8', VEX_UI='1')
        self.prog, self.seen, self.tail = None, {}, ''
        flags = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
        self.task = task
        self.add('\n── %s ──' % time.strftime('%H:%M'))
        self.proc = subprocess.Popen([sys.executable, os.path.abspath(__file__)] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, cwd=HERE, env=env, creationflags=flags)
        def pump(proc):
            while True:
                chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096)
                if not chunk:
                    break
                self.add(chunk.decode('utf-8', 'replace'))
            proc.wait()
            if proc.returncode not in (0, None) and self.proc is proc and not getattr(proc, 'stopped', False):
                self.add('It stopped unexpectedly. The lines above say why.')
        threading.Thread(target=pump, args=(self.proc,), daemon=True).start()
        return True

    def stop(self):
        proc = self.proc
        if not proc or proc.poll() is not None:
            return
        proc.stopped = True
        try:
            if os.name == 'nt':                          # and the processes it started
                subprocess.call(['taskkill', '/PID', str(proc.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                proc.kill()
        except Exception:
            pass
        self.add('Stopped. Everything already saved is kept.')


def serve_ui(cfg, port=8765, open_window=True):
    import secrets
    token = secrets.token_urlsafe(18)
    job = Job()
    queue_cache = {'at': 0, 'queue': [], 'done': 0, 'gold': 0}

    def counts(force=False):
        if force or time.time() - queue_cache['at'] > 60:     # ordering a thousand frames takes a moment; not every poll
            q, done = review_queue()
            queue_cache.update(at=time.time(), queue=q, done=done, gold=len(reviewed()) if done else 0)
        return queue_cache

    def last_train():
        try:
            with open(os.path.join(DIRS['models'], 'trained_latest.json')) as f:
                i = json.load(f)
            return {'new': '%.1f' % (i['new'][2] * 100), 'old': '%.1f' % (i['old'][2] * 100), 'better': i['new'][2] > i['old'][2],
                    'frames': i.get('frames', 0), 'auto': i.get('auto', 0), 'test': i.get('test', 0), 'rounds': i.get('rounds', 0),
                    'when': i.get('when', ''), 'published': bool(i.get('published', i['new'][2] > i['old'][2]))}
        except Exception:
            return None

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass
        def _send(self, code, body, ctype='application/json'):
            body = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)
        def _allowed(self, u):
            # Only this window: the address must be this computer's, and every
            # request must carry the token the window was opened with. Another
            # website open in a browser can reach neither.
            host = (self.headers.get('Host') or '').split(':')[0]
            if host not in ('127.0.0.1', 'localhost'):
                return False
            given = self.headers.get('X-Token') or urllib.parse.parse_qs(u.query).get('t', [''])[0]
            return secrets.compare_digest(given, token)
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if not self._allowed(u):
                return self._send(403, {'error': 'not allowed'})
            if u.path == '/':
                return self._send(200, UI_HTML, 'text/html; charset=utf-8')
            if u.path.startswith('/img/'):
                name = os.path.basename(u.path)
                if not re.fullmatch(r'[A-Za-z0-9_-]+\.jpg', name):
                    return self._send(404, {})
                try:
                    with open(os.path.join(FRAMES, name), 'rb') as f:
                        return self._send(200, f.read(), 'image/jpeg')
                except OSError:
                    return self._send(404, {})
            if u.path == '/api/state':
                c = counts()
                return self._send(200, {'version': VERSION, 'site': cfg['site'], 'key': bool(cfg.get('key')), 'busy': job.busy(), 'task': job.task if job.busy() else '',
                                        'log': job.lines(), 'progress': job.progress(), 'waiting': len(c['queue']), 'done': c['done'], 'gold': c['gold'], 'workers': cfg.get('workers', 4),
                                        'keep': bool(cfg.get('keep_videos')), 'speed': cfg.get('max_mbps', 0), 'last': last_train()})
            if u.path == '/api/next':
                c = counts()
                want = urllib.parse.parse_qs(u.query).get('id', [None])[0]
                if want and re.fullmatch(r'[A-Za-z0-9_-]+', want) and os.path.exists(os.path.join(PROPS, want + '.json')):
                    name = want
                else:
                    name = c['queue'][0] if c['queue'] else None
                if not name:
                    return self._send(200, {'id': None, 'done': c['done']})
                with open(os.path.join(PROPS, name + '.json')) as f:
                    p = json.load(f)
                boxes = [b for b in p['boxes'] if b[4] >= 0.35]
                lab = os.path.join(LABELS, name + '.json')
                if os.path.exists(lab):                  # going back: show what was saved
                    with open(lab) as f:
                        boxes = json.load(f).get('boxes', boxes)
                return self._send(200, {'id': name, 'w': p['w'], 'h': p['h'], 'boxes': boxes, 'left': len(c['queue']), 'done': c['done'], 'gold': c['gold']})
            self._send(404, {})
        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
            if not self._allowed(u):
                return self._send(403, {'error': 'not allowed'})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf-8') or '{}')
            except Exception:
                return self._send(400, {'error': 'bad request'})
            if u.path == '/api/save':
                name = str(body.get('id', ''))
                if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
                    return self._send(400, {'error': 'bad id'})
                boxes = [[float(v) for v in b[:4]] for b in body.get('boxes', []) if len(b) >= 4][:60]
                os.makedirs(LABELS, exist_ok=True)
                with open(os.path.join(LABELS, name + '.json'), 'w') as f:
                    json.dump({'skip': bool(body.get('skip')), 'boxes': boxes}, f)
                c = counts()
                if name in c['queue']:
                    c['queue'].remove(name)
                    c['done'] += 1
                    c['gold'] += 0 if body.get('skip') else 1
                return self._send(200, {'ok': True})
            if u.path == '/api/key':
                key = str(body.get('key', '')).strip()
                if not key:
                    cfg['key'] = ''
                    save_config(cfg)
                    return self._send(200, {'ok': True})
                site = Site(cfg)
                site.key = key
                r = site.post({'check': True}, tries=1)
                if not (r and r.get('ok')):
                    return self._send(200, {'ok': False, 'error': key_problem(r, cfg)})
                cfg['key'] = key
                save_config(cfg)
                if not job.busy():                       # the key was the only thing missing: start
                    job.start('track', ['--track'])
                return self._send(200, {'ok': True})
            if u.path == '/api/settings':
                try:
                    w = max(1, min(16, int(body.get('workers', cfg.get('workers', 4)))))
                    if w != cfg.get('workers'):
                        cfg['workers'], cfg['workers_chosen'] = w, True
                except (TypeError, ValueError):
                    pass
                cfg['keep_videos'] = bool(body.get('keep'))
                if body.get('speed') in (0, 5, 15, 40):
                    cfg['max_mbps'] = body['speed']
                save_config(cfg)
                return self._send(200, {'ok': True})
            if u.path == '/api/stop':
                job.stop()
                return self._send(200, {'ok': True})
            if u.path == '/api/start':
                task = body.get('task')
                if job.busy():
                    return self._send(200, {'error': 'Something is already running. Press Stop first.'})
                if task == 'track':
                    args = ['--track']
                elif task == 'train':
                    args = ['--train']
                elif task == 'unpublish':
                    args = ['--unpublish']
                elif task == 'add':
                    src = str(body.get('src', '')).strip()
                    if not src:
                        return self._send(200, {'error': 'Paste a link or a file path into the box first.'})
                    args = ['--add', src]
                else:
                    return self._send(400, {'error': 'unknown task'})
                job.start(task, args)
                return self._send(200, {'ok': True})
            self._send(404, {})

    srv = None
    for p in range(port, port + 10):
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', p), H)
            break
        except OSError:
            continue
    if not srv:
        say('Could not open the window: ports %d-%d on this computer are all in use.' % (port, port + 9))
        return None
    url = 'http://127.0.0.1:%d/?t=%s' % (srv.server_address[1], token)
    srv.url, srv.job, srv.token = url, job, token
    if not open_window:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv
    # Nothing to press: with the key saved, tracking starts with the window.
    if cfg.get('key'):
        threading.Thread(target=lambda: (sync_review(cfg, quiet=True), counts(True)), daemon=True).start()
        job.start('track', ['--track'])
    say('The window is opening. Leave THIS black window open too: closing it stops the program.')
    opened = False
    if os.name == 'nt':                                  # its own window, without tabs or an address bar
        try:
            subprocess.Popen('start "" msedge --app="%s" --window-size=1180,860' % url, shell=True)
            opened = True
        except Exception:
            pass
    if not opened:
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass
    say('If no window appeared, open this address in your browser:\n  ' + url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        job.stop()
    return None


def menu():
    cfg = load_config()
    say('VEX Trainer %s — works with %s' % (VERSION, cfg['site']))
    for d in DIRS.values():
        os.makedirs(d, exist_ok=True)
    try:
        ensure_models(Site(cfg))
    except Exception as e:
        say('Could not get the models from the website:', e)
        return
    actions = {'1': do_jobs, '2': do_add_video, '3': do_live, '4': do_map_file, '5': do_review, '6': do_train, '7': do_publish, '8': do_settings}
    while True:
        queue, done = review_queue()
        say('\n────────────────────────────────────────────────────────')
        say('  1  Track what the website asked for')
        say('  2  Add a video for training (a link or a file)')
        say('  3  Watch a live stream for training')
        say('  4  Use a video file I already have for a stream')
        say('  5  Review frames            (%d waiting, %d done)' % (len(queue), done))
        say('  6  Train the robot finder')
        say('  7  Publish the trained finder to the website')
        say('  8  Settings')
        say('  Enter  quit')
        pick = input('> ').strip()
        if not pick:
            return
        fn = actions.get(pick)
        if not fn:
            continue
        try:
            fn(cfg)
        except KeyboardInterrupt:
            say('\nStopped.')
        except Exception as e:
            say('\nThat went wrong:', e)
            import traceback
            traceback.print_exc()


def main():
    """No flags: the window. A flag: one job, the way the window's buttons run it."""
    global INTERACTIVE
    args = sys.argv[1:]
    if args and args[0] == '--menu':
        return menu()
    cfg = load_config()
    for d in DIRS.values():
        os.makedirs(d, exist_ok=True)
    if not args:
        say('VEX Trainer %s — works with %s' % (VERSION, cfg['site']))
        try:
            ensure_models(Site(cfg))
        except Exception as e:
            say('Could not get the models from the website:', e)
            return
        return serve_ui(cfg)
    INTERACTIVE = False
    try:
        ensure_models(Site(cfg))
        if args[0] == '--track':
            track_all(cfg, loop='--once' not in args)
        elif args[0] == '--add' and len(args) > 1:
            add_source(cfg, args[1])
        elif args[0] == '--train':
            train_auto(cfg)
        elif args[0] == '--unpublish':
            unpublish(cfg)
        else:
            say('Unknown option:', args[0])
    except KeyboardInterrupt:
        pass
    except Exception as e:
        say('That went wrong:', e)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
