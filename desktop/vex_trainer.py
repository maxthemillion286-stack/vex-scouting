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

VERSION = '2.52'
INTERACTIVE = True                # False when a button started this, not a person at the console
HERE = os.path.dirname(os.path.abspath(__file__))
DIRS = {k: os.path.join(HERE, k) for k in ('models', 'videos', 'data', 'build')}
FRAMES, PROPS, LABELS = (os.path.join(HERE, 'data', k) for k in ('frames', 'prop', 'labels'))
CONFIG = os.path.join(HERE, 'config.json')
DEFAULT_SITE = 'https://vex-scouting-by-max.vercel.app'

SIZE = 640
CONF, IOU = 0.45, 0.5            # the website's VT_CONF, VT_IOU
PROPOSE = 0.25                   # boxes this sure are kept as suggestions for review
LOOKS_PER_SEC = 6                # looks per second of VIDEO (the website manages about 3); never fewer
BURST_PER_SEC, BURST_HOLD = 12, 1.5   # at a goal or robots touching: twice as often, for 1.5 s after
LEAD, WINDOW, WINDOW_WIDE = 3, 150, 330
GIVE_UP_SEC, MIN_FRAMES = 25, 30
LOOKALIKE = ['0ODQ', '1IL', '8B', '5S', '2Z', '6G']


# ── small things ────────────────────────────────────────────────────────────
def say(*a):
    print(*a, flush=True)

_PROG = {'hold': False, 'all': None}
_SHARE = None                     # in a tracking worker: how far each match is (v2.34)
def progress(stage='', done=0, total=0, wait=0, minor=False, sub=''):
    """How far along, for the window's bar and its countdown. A line only the
    window reads (it is started with VEX_UI set); the console never sees it.
    `minor` is something going on behind the main work (the next video coming
    down while this one is tracked) and must not take the bar over."""
    if not os.environ.get('VEX_UI') or (minor and _PROG['hold'] and not _PROG['all']):
        return
    # v2.34: while a whole job is running (tracking every match), the bar is
    # the job's, and a step inside it (a video coming down) is only named
    # under it. Reported: "the progress bar isnt total progress but progress
    # of the task it has on hand".
    if minor and _PROG['all'] and total:
        _PROG['dl'] = '%s · %d%%' % (stage, 100 * done / total) if done < total else ''
        if _PROG['hold']:
            return                                      # shown by the job's own next update
        a = _PROG['all']
        stage, done, total, sub = a[0], a[1], a[2], _PROG['dl']
    try:
        print('@@P ' + json.dumps({'s': stage, 'd': done, 't': total, 'w': wait, 'u': sub}), flush=True)
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
        json.dump({k: v for k, v in cfg.items() if not k.startswith('_')}, f, indent=1)

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
    mx, mn = np.maximum(np.maximum(b, g), r), np.minimum(np.minimum(b, g), r)   # the same numbers as a max along the colours, 20× sooner
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

# ── the camera's lens (v2.43) ─────────────────────────────────────────────
# A wide lens bends straight lines, most near the picture's edges, so a field
# mapped from its four corners alone drifts there. One number per stream, k,
# undoes it (r² radial: a picture point moves out from the middle by 1 + k·r²,
# r measured in half-widths, `ka` = height / width). It is carried on the field
# mark as q[8], q[9]; every mapping of the mark goes through it.
def lens_undo(x, y, k, ka):
    nx, ny = (x - 0.5) * 2, (y - 0.5) * 2 * ka
    s = 1 + k * (nx * nx + ny * ny)
    return 0.5 + nx * s / 2, 0.5 + ny * s / (2 * ka)

def lens_do(x, y, k, ka):
    """The inverse of lens_undo: where an undistorted point shows in the picture."""
    xd, yd = x, y
    for _ in range(12):
        nx, ny = (xd - 0.5) * 2, (yd - 0.5) * 2 * ka
        s = 1 + k * (nx * nx + ny * ny)
        xd, yd = 0.5 + (x - 0.5) / s, 0.5 + (y - 0.5) / s
    return xd, yd

def lens_of(q):
    """(k, ka) carried on a field mark, or None."""
    if isinstance(q, (list, tuple)) and len(q) >= 10 and q[8] and q[9]:
        return float(q[8]), float(q[9])
    return None

def straight_q(q):
    """The four corners with the lens undone (the first eight numbers)."""
    L = lens_of(q)
    if not L:
        return list(q[:8])
    out = []
    for i in range(0, 8, 2):
        out += list(lens_undo(q[i], q[i + 1], *L))
    return out

def estimate_lens(frame, q, strict=True):
    """k for this stream's camera, from one picture and its four corners: the
    floor's edge is found along each side, and k is what makes those edges
    straight. → (k, how much straighter: 0..1), (0, 0) if it cannot tell or the
    lens bends nothing worth undoing."""
    import cv2, numpy as np
    H, W = frame.shape[:2]
    ka = H / W
    g = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0).astype(np.float32)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    cx, cy = (q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4
    c = sorted(((q[i], q[i + 1]) for i in range(0, 8, 2)), key=lambda t: math.atan2(t[1] - cy, t[0] - cx))
    S = int(0.035 * W)
    edges = []
    rng = np.random.default_rng(7)
    for i in range(4):
        (x0, y0), (x1, y1) = c[i], c[(i + 1) % 4]
        dx, dy = (x1 - x0) * W, (y1 - y0) * H
        ln = math.hypot(dx, dy)
        if ln < 40:
            return 0.0, 0.0
        nx, ny = -dy / ln, dx / ln
        ts = np.linspace(0.08, 0.92, 41)
        profs = []
        for t in ts:
            px, py = (x0 + t * (x1 - x0)) * W, (y0 + t * (y1 - y0)) * H
            sh = np.arange(-S, S + 1)
            X, Y = np.round(px + nx * sh).astype(int), np.round(py + ny * sh).astype(int)
            inside = (X >= 0) & (X < W) & (Y >= 0) & (Y < H)
            pr = np.zeros(len(sh), np.float32)
            pr[inside] = np.abs(gx[Y[inside], X[inside]] * nx + gy[Y[inside], X[inside]] * ny)
            profs.append(pr)
        top = max(float(pr.max()) for pr in profs)
        if top < 20:
            return 0.0, 0.0
        # Every strong edge across the side at each place along it...
        cand = []
        for t, pr in zip(ts, profs):
            for k_ in range(1, len(pr) - 1):
                if pr[k_] >= 0.3 * top and pr[k_] >= pr[k_ - 1] and pr[k_] >= pr[k_ + 1]:
                    cand.append((t, float(k_ - S), float(pr[k_])))
        if len(cand) < 10:
            continue                                    # a side it cannot see (an overlay, robots): the others will do
        cand = np.array(cand)
        # ...and the smooth curve (offset = a + b·t + c·t²) through the most of
        # them: the wall's foot runs the whole side; a pin or a robot does not.
        best, best_n = None, 0
        for _ in range(400):
            pick = cand[rng.choice(len(cand), 3, replace=False)]
            if len(set(pick[:, 0])) < 3:
                continue
            try:
                coef = np.polyfit(pick[:, 0], pick[:, 1], 2)
            except Exception:
                continue
            inl = np.abs(np.polyval(coef, cand[:, 0]) - cand[:, 1]) < 2.0
            n_in = len(set(cand[inl, 0]))
            if n_in > best_n:
                best, best_n = coef, n_in
        if best is None or best_n < 20:
            continue
        inl = np.abs(np.polyval(best, cand[:, 0]) - cand[:, 1]) < 2.0
        coef = np.polyfit(cand[inl, 0], cand[inl, 1], 2)
        pts = [(((x0 + t * (x1 - x0)) * W + nx * np.polyval(coef, t)) / W, ((y0 + t * (y1 - y0)) * H + ny * np.polyval(coef, t)) / H) for t in ts]
        edges.append((c[i], c[(i + 1) % 4], pts))
    if len(edges) < 2:
        return 0.0, 0.0
    def cost(k):
        # How far each edge's points, unbent by k, are from the straight line
        # that fits them best (the corners only said where to look: a corner
        # clicked a few pixels off must not look like a bend).
        res = []
        for a, b, pts in edges:
            P = np.array([lens_undo(x, y, k, ka) for x, y in pts]) * [1, ka]
            P -= P.mean(axis=0)
            _, _, vt = np.linalg.svd(P, full_matrices=False)
            res += list(np.abs(P @ vt[1]))
        return float(np.median(res))
    ks = [round(v, 3) for v in np.arange(-0.4, 0.401, 0.005)]
    costs = [cost(k) for k in ks]
    j = int(np.argmin(costs))
    c0 = cost(0.0)
    gain = 1 - costs[j] / c0 if c0 > 0 else 0
    if strict and (c0 < 0.0008 or gain < 0.35 or abs(ks[j]) < 0.01):
        return 0.0, round(gain, 2)
    return ks[j], round(gain, 2)

def with_lens(q, k, ka):
    """A field mark carrying its lens (or not, for k = 0)."""
    return list(q[:8]) + ([round(float(k), 4), round(float(ka), 4)] if k else [])

def quad_fwd(q):
    """Unit square → picture, for four corners in any order (the website's vtHomographyFwd);
    through the camera's lens when the mark carries one (v2.43)."""
    L = lens_of(q)
    if L:
        inner = quad_fwd(straight_q(q))
        if not inner:
            return None
        return lambda u, v: lens_do(*inner(u, v), *L)
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
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
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

_TILT_COS = _TILT_SIN = None
def plate_tilts(img, col):
    """Plates that are not level. A camera above a corner of the field sees
    most plates at a slant, and the reader only reads level writing (the
    first real frame the owner sent: four robots, no plate read; straightened,
    one read). Each solid patch of the plate's colour, with the way it lies:
    → up to two of [cx, cy, angle, length, height], biggest first."""
    import numpy as np, cv2
    global _TILT_COS, _TILT_SIN
    if _TILT_COS is None:
        _TILT_COS = np.array([math.cos(k * math.pi / 60) for k in range(60)])[:, None]
        _TILT_SIN = np.array([math.sin(k * math.pi / 60) for k in range(60)])[:, None]
    px = img.astype(np.float64)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    strong = (mx >= 90) & ((mx - mn) >= 0.45 * mx)
    hit = strong & ((r == mx) & (g < 0.55 * r) & (b < 0.6 * r) if col == 1 else (b == mx) & (r < 0.55 * b))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(hit.astype(np.uint8), connectivity=8)
    out = []
    for k in range(1, n):
        x0, y0, bw, bh, cnt = (int(v) for v in stats[k])
        if cnt < 120:
            continue
        ys, xs = np.nonzero(lab[y0:y0 + bh, x0:x0 + bw] == k)
        xs, ys = xs + x0, ys + y0
        ax, ay = float(xs.mean()), float(ys.mean())
        # The way it lies: the turn at which a box round it is smallest. (Seen
        # from the side a plate is a slanted parallelogram; its long edges, and
        # the writing, run along that box.) Every 3 degrees. The box round a
        # patch is the box round its outline, so only the outline's corners
        # are turned: the same box, from a few dozen points instead of thousands.
        hull = cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32)).reshape(-1, 2)
        dx, dy = (hull[:, 0] - ax)[None, :], (hull[:, 1] - ay)[None, :]
        u, v = dx * _TILT_COS + dy * _TILT_SIN, dy * _TILT_COS - dx * _TILT_SIN
        U0, U1, V0, V1 = u.min(1), u.max(1), v.min(1), v.max(1)
        best = None
        for step in range(60):
            u0, u1, v0, v1 = float(U0[step]), float(U1[step]), float(V0[step]), float(V1[step])
            area = (u1 - u0 + 1) * (v1 - v0 + 1)
            if best is None or area < best[0] - 1e-9:
                best = (area, step * math.pi / 60, u0, u1, v0, v1)
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

def score_text(text):
    """A score as a stream writes it: one to three digits, nothing else."""
    m = re.match(r'^\s*(\d{1,3})\s*$', str(text or ''))
    return int(m.group(1)) if m else None

def score_spots(seen, rs, bs, end):
    """Where the stream writes each alliance's score, worked out from the
    official final score (v2.31): of every number seen in the same place over
    the match, the place that showed red's final in the last 40 s is red's,
    and blue's likewise. → {'r': box, 'b': box} or None (no live score shown,
    a wrong one, or a tie that cannot tell them apart)."""
    if rs is None or bs is None or rs == bs:
        return None
    def best(want):
        got = [(len(v), k) for k, v in seen.items() if any(n == want and t >= end - 40 for t, n, _ in v)]
        return max(got)[1] if got else None
    kr, kb = best(rs), best(bs)
    if kr is None or kb is None or kr == kb:
        return None
    med = lambda k: [sorted(b[i] for _, _, b in seen[k])[len(seen[k]) // 2] for i in range(4)]
    return {'r': med(kr), 'b': med(kb), 'kr': kr, 'kb': kb}

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
        self.pieces = None
        if pieces_ready():
            try:
                self.pieces = PieceFinder(pieces_file(), so, prov)
            except Exception:
                self.pieces = None
        self.stack = None
        if stack_ready():
            try:
                self.stack = StackReader(prov=prov)
            except Exception:
                self.stack = None
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
        return self._spell(self.reader.run(None, {self.reader.get_inputs()[0].name: f})[0][0])

    def read_many(self, strips, width=160):
        """Several strips, each (strip, used), read in ONE call: on a graphics
        card most of a read is the trip there and back, so four at once cost
        little more than one. → [(text, how sure)] in the same order."""
        np = self.np
        if len(strips) == 1:
            return [self.read(*strips[0])]
        f = np.zeros((len(strips), 3, 48, width), np.float32)
        for k, (strip, used) in enumerate(strips):
            f[k, :, :, :used] = ((strip[:, :used].astype(np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)
        return [self._spell(o) for o in self.reader.run(None, {self.reader.get_inputs()[0].name: f})[0]]

    def _spell(self, out):
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
                ways = [(flip, pad) for flip in (0, 1) for pad in PLATE_PADS]
                if self.backend != 'CPU':
                    # On a graphics card: all four ways of looking at it in one call.
                    got = self.read_many([plate_strip(crop, tilt, flip, pad) for flip, pad in ways])
                else:
                    # On the processor a call costs what it costs: stop at the first that reads.
                    got = (self.read(*plate_strip(crop, tilt, flip, pad)) for flip, pad in ways)
                for text, conf in got:
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
        lines = []
        for b in found[:14]:
            bx, by, bw, bh = b[0] / k, b[1] / k, b[2] / k, b[3] / k
            if bh < 6:
                continue
            strip = self._strip(frame, bx, by, bw, bh)
            if strip:
                lines.append(([bx / w, by / h, bw / w, bh / h], strip))
        # On a graphics card every line in one call; on the processor one by one (no gain there).
        if self.backend != 'CPU' and len(lines) > 1:
            got = self.read_many([l[1] for l in lines], 320)
        else:
            got = [self.read(*l[1]) for l in lines]
        return [{'text': g[0], 'conf': g[1], 'box': l[0]} for l, g in zip(lines, got) if g[1] >= 0.5 and g[0]]

    def _line(self, frame, bx, by, bw, bh):
        strip = self._strip(frame, bx, by, bw, bh)
        return self.read(*strip) if strip else None

    def _strip(self, frame, bx, by, bw, bh):
        import cv2
        np = self.np
        h, w = frame.shape[:2]
        x0, y0, x1, y1 = max(0, int(bx)), max(0, int(by)), min(w, int(math.ceil(bx + bw))), min(h, int(math.ceil(by + bh)))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        used = min(320, max(8, jround(bw * 48 / bh)))
        strip = np.zeros((48, 320, 3), np.uint8)
        strip[:, :used] = cv2.resize(frame[y0:y1, x0:x1], (used, 48), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]
        return strip, used

    def clock_at(self, frame, box):
        h, w = frame.shape[:2]
        got = self._line(frame, box[0] * w, box[1] * h, box[2] * w, box[3] * h)
        return timer_text(got[0]) if got and got[1] >= 0.5 else None

    def number_at(self, frame, box):
        """The number written at a known place (a score), or None."""
        h, w = frame.shape[:2]
        got = self._line(frame, box[0] * w, box[1] * h, box[2] * w, box[3] * h)
        return score_text(got[0]) if got and got[1] >= 0.5 else None


class CamFollow:
    """Follows the camera, so a pan or zoom does not move the field (v2.28).

    The field is marked once per stream, on one picture of it. Every second
    the tracker finds that picture's fixed features again (the field's walls,
    goals and posts, ORB corners with RANSAC, robots moving across them
    ignored) and works out how the camera has moved since. Every box and pin
    it records is then put back into the marked picture, so the website's one
    field mark fits the whole match, and the goals and toggles are looked for
    where they now are. When the picture is not the field at all (a close-up,
    a replay, a crowd shot) for three seconds running, robots are not
    recorded until it is back: a close-up's robots are not on the field mark.

    Asked for: "what are they doing that we aren't" — the best tracker finds
    the field every frame, "even when the camera pans".
    """
    WIDTH, NEED, MOVE = 640, 30, 0.004

    def __init__(self, quad):
        import cv2
        self.cv2, self.quad = cv2, quad
        self.orb = cv2.ORB_create(2500, fastThreshold=10)
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING)
        self.ref, self.kp, self.des = None, None, None

    def _gray(self, frame):
        h, w = frame.shape[:2]
        g = self.cv2.cvtColor(self.cv2.resize(frame, (self.WIDTH, max(2, round(h * self.WIDTH / w))), interpolation=self.cv2.INTER_AREA), self.cv2.COLOR_BGR2GRAY)
        return g

    def set_ref(self, frame):
        """The picture the field was marked on. → True when it has enough to follow."""
        import numpy as np
        g = self._gray(frame)
        h, w = g.shape
        # Only the field and what stands on it: its corners, and the same again
        # a quarter of the field's height higher (goals and posts stand up);
        # never the stream's own overlays, which stay still while the field moves.
        q = np.array(self.quad[:8], dtype=np.float32).reshape(4, 2) * [w, h]
        tall = (q[:, 1].max() - q[:, 1].min()) * 0.25
        mask = np.zeros((h, w), np.uint8)
        hull = self.cv2.convexHull(np.vstack([q, q - [0, tall]]).astype(np.int32))
        self.cv2.fillConvexPoly(mask, hull, 255)
        kp, des = self.orb.detectAndCompute(g, mask)
        if des is None or len(kp) < 80:
            return False
        self.ref, self.kp, self.des, self.size = g, kp, des, (w, h)
        return True

    def look(self, frame):
        """How the camera has moved since the marked picture: a 3×3 matrix
        from marked-picture fractions to this picture's, or None when this is
        not that view."""
        import numpy as np
        if self.des is None:
            return None
        g = self._gray(frame)
        h, w = g.shape
        kp, des = self.orb.detectAndCompute(g, None)
        if des is None or len(kp) < self.NEED:
            return None
        good = []
        for m in self.bf.knnMatch(self.des, des, k=2):
            if len(m) == 2 and m[0].distance < 0.75 * m[1].distance:
                good.append(m[0])
        if len(good) < self.NEED:
            return None
        a = np.float32([self.kp[m.queryIdx].pt for m in good]) / [self.size[0], self.size[1]]
        b = np.float32([kp[m.trainIdx].pt for m in good]) / [w, h]
        H, inl = self.cv2.findHomography(a, b, self.cv2.RANSAC, 3.0 / self.WIDTH)
        if H is None or inl is None:
            return None
        n = int(inl.sum())
        if n < self.NEED or n < 0.3 * len(good):
            return None
        # A real camera move keeps the field about the same size and the right way round.
        q0 = np.float32(self.quad[:8]).reshape(4, 2)
        q1 = self.cv2.perspectiveTransform(q0.reshape(1, 4, 2), H).reshape(4, 2)
        area = lambda q: abs(self.cv2.contourArea(q.astype(np.float32)))
        if not (0.4 < area(q1) / max(1e-6, area(q0)) < 2.5) or not self.cv2.isContourConvex(self.cv2.convexHull(q1).astype(np.float32)):
            return None
        return H

    def quad_now(self, H):
        import numpy as np
        return [round(float(v), 4) for v in self.cv2.perspectiveTransform(np.float32(self.quad[:8]).reshape(1, 4, 2), H).reshape(-1)] + list(self.quad[8:10])

    def placed_now(self, placed, H):
        """The dragged goals and loaders, where they are in this picture."""
        import numpy as np
        if not placed:
            return None
        out = dict(placed)
        for k in ('g', 'l'):
            if isinstance(placed.get(k), list) and placed[k]:
                out[k] = [round(float(v), 4) for v in self.cv2.perspectiveTransform(np.float32(placed[k]).reshape(1, -1, 2), H).reshape(-1)]
        return out


def back_to_marked(Hinv, W, H, x, y):
    """A point of this W×H picture, in the marked picture's pixels (same size),
    and how much bigger things are there (the zoom at that point)."""
    def go(px, py):
        u, v = px / W, py / H
        d = Hinv[2][0] * u + Hinv[2][1] * v + Hinv[2][2]
        return (Hinv[0][0] * u + Hinv[0][1] * v + Hinv[0][2]) / d * W, (Hinv[1][0] * u + Hinv[1][1] * v + Hinv[1][2]) / d * H
    X, Y = go(x, y)
    X1, Y1 = go(x + 10, y)
    X2, Y2 = go(x, y + 10)
    return X, Y, max(0.2, min(5.0, math.sqrt(abs((X1 - X) * (Y2 - Y) - (X2 - X) * (Y1 - Y))) / 10))

def boxes_to_marked(boxes, Hinv, W, H):
    """Robot boxes [x, y, w, h, …] moved into the marked picture, by where they stand (bottom middle)."""
    out = []
    for b in boxes:
        X, Y, z = back_to_marked(Hinv, W, H, b[0] + b[2] / 2, b[1] + b[3])
        nb = list(b)
        nb[2], nb[3] = b[2] * z, b[3] * z
        nb[0], nb[1] = X - nb[2] / 2, Y - nb[3]
        out.append(nb)
    return out

def blobs_to_marked(blobs, Hinv, W, H):
    """Pin patches [x, bottom y, w, h, area, colour] moved into the marked picture."""
    out = []
    for x, y, w, h, area, c in blobs:
        X, Y, z = back_to_marked(Hinv, W, H, x, y)
        out.append([jround(X), jround(Y), max(1, jround(w * z)), max(1, jround(h * z)), max(1, jround(area * z * z)), c])
    return out


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
def looks_broken(frame):
    """A picture the video decoder garbled (v2.33): rows smeared straight down
    from the one above, so long runs of rows are the same as the row before
    while not being one flat colour (a black bar is flat, a smear has
    streaks). Reported with a screenshot: a review frame of yellow streaks."""
    import numpy as np
    if frame is None or frame.size == 0:
        return True
    g = frame[::2, ::4].mean(axis=2) if frame.ndim == 3 else frame[::2, ::4].astype(np.float32)
    same = np.abs(np.diff(g, axis=0)).mean(axis=1) < 1.0
    busy = g[1:].std(axis=1) > 8
    return bool((same & busy).mean() > 0.25)

def keep_frame(frame, boxes, tag, hard, steady=None, auto=False, at=None):
    """Save a picture with the finder's suggestions, for review later.
    `steady`: the four robots in it were where the look before put them (v2.32);
    `auto`: kept only to train on, never asked about in review."""
    import cv2
    if looks_broken(frame):
        return
    for d in (FRAMES, PROPS, LABELS):
        os.makedirs(d, exist_ok=True)
    name = tag + '_' + hashlib.md5(frame[::16, ::16].tobytes()).hexdigest()[:10]
    path = os.path.join(FRAMES, name + '.jpg')
    if os.path.exists(path):
        return
    cv2.imwrite(path, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    h, w = frame.shape[:2]
    with open(os.path.join(PROPS, name + '.json'), 'w') as f:
        p = {'w': w, 'h': h, 'hard': hard, 'boxes': [[round(b[0], 1), round(b[1], 1), round(b[2], 1), round(b[3], 1), round(b[4], 3)] for b in boxes]}
        if steady is not None:
            p['steady'] = 1 if steady else 0
        if auto:
            p['auto'] = 1
        if at is not None:
            p['t'] = round(float(at), 1)            # seconds into the stream (v2.36): marking the field on it then lets the camera be followed
        json.dump(p, f)

AUTO_PER_MATCH, AUTO_GAP, AUTO_MAX = 6, 15, 1500

def steady_four(boxes, before, unsure, w):
    """A look the tracker is certain of (v2.32): exactly four sure robots, two
    of each colour, nothing unsure about, and each robot within 3% of the
    picture's width of where it was a look ago, much the same size."""
    if len(boxes) != 4 or unsure or sorted(b[5] for b in boxes) != [1, 1, 2, 2] or len(before) != 4:
        return False
    for b in boxes:
        cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        if not any(abs(cx - (a[0] + a[2] / 2)) < 0.03 * w and abs(cy - (a[1] + a[3] / 2)) < 0.03 * w and 0.75 < b[2] / max(1, a[2]) < 1.33 for a in before):
            return False
    return True

# ── self-teaching (v2.52) ─────────────────────────────────────────────────
# Asked for the robot finder to teach itself. Frames it was sure of while
# tracking (four sure robots, two of each colour, where the look before had
# them) are already trained on. Before each training they are now looked at
# again by the newest finder, as the teacher: once as they are and once
# mirrored. A frame is kept only where both looks find the same four robots;
# its boxes become the teacher's. So as the finder gets better, so do the
# frames it learns from, and a frame it was wrongly sure of drops out.
TEACH_MAX = 1500

def _iou(a, b):
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    u = a[2] * a[3] + b[2] * b[3] - ix * iy
    return ix * iy / u if u > 0 else 0.0

def teacher_look(eyes, frame):
    """The finder's four robots on a frame if it finds the same four mirrored, else None."""
    w = frame.shape[1]
    a = [b for b in eyes.detect(frame) if b[4] >= CONF]
    if len(a) != 4 or sorted(b[5] for b in a) != [1, 1, 2, 2] or any(b[4] < 0.6 for b in a):
        return None
    m = [b for b in eyes.detect(frame[:, ::-1].copy()) if b[4] >= CONF]
    if len(m) != 4:
        return None
    back = [[w - b[0] - b[2], b[1], b[2], b[3], b[4], b[5]] for b in m]
    out = []
    for b in a:
        best = max(back, key=lambda o: _iou(b, o))
        if _iou(b, best) < 0.6 or best[5] != b[5]:
            return None
        out.append([round((b[0] + best[0]) / 2, 1), round((b[1] + best[1]) / 2, 1), round((b[2] + best[2]) / 2, 1), round((b[3] + best[3]) / 2, 1), round(min(b[4], best[4]), 3), int(b[5])])
    return out

def teach_again(eyes=None, limit=TEACH_MAX):
    """The newest finder looks again at the frames it was sure of. → (kept, dropped)."""
    import cv2
    try:
        tag = str(int(os.path.getmtime(detector_path())))
    except Exception:
        tag = '0'
    todo = []
    for n in os.listdir(PROPS):
        name = n[:-5]
        if os.path.exists(os.path.join(LABELS, n)) or not os.path.exists(os.path.join(FRAMES, name + '.jpg')):
            continue
        try:
            with open(os.path.join(PROPS, n)) as f:
                p = json.load(f)
        except Exception:
            continue
        if len(p.get('boxes') or []) == 4 and p.get('steady', 1) and p.get('teach') != tag:
            todo.append((name, p))
    if not todo:
        return 0, 0
    if eyes is None:
        eyes = Eyes(quiet=True)
    kept = dropped = 0
    for i, (name, p) in enumerate(todo[:limit]):
        if i % 25 == 0:
            progress('The finder is checking the frames it was sure of', i, min(limit, len(todo)))
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        got = teacher_look(eyes, frame) if frame is not None else None
        if got:
            p['boxes'] = [b[:5] for b in got]
            p['steady'] = 1
            kept += 1
        else:
            p['steady'] = 0                   # not sure of it any more: not trained on
            dropped += 1
        p['teach'] = tag
        with open(os.path.join(PROPS, name + '.json'), 'w') as f:
            json.dump(p, f)
    return kept, dropped

def auto_count():
    try:
        return sum(1 for n in os.listdir(PROPS) if n.endswith('.json') and '"auto": 1' in open(os.path.join(PROPS, n)).read(200))
    except Exception:
        return 0

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


# Where a match's time goes (v2.46), so a slow run can say why: reading the
# video, finding robots, reading plates, following the camera; the rest is
# everything else in the loop. Asked: "any way to make the tracking process
# faster … it takes hours upon hours just to get a few streams done".
_TIME = {}
_LAST_SPENT = {}
def _tick(k, t0):
    _TIME[k] = _TIME.get(k, 0.0) + time.perf_counter() - t0

def blocked(sb, boxes, most=0.35):
    """Is a spot box [x0, y0, x1, y1] more than `most` covered by a robot box [x, y, w, h, …]?"""
    area = max(1.0, (sb[2] - sb[0]) * (sb[3] - sb[1]))
    for b in boxes:
        ix = max(0.0, min(sb[2], b[0] + b[2]) - max(sb[0], b[0]))
        iy = max(0.0, min(sb[3], b[1] + b[3]) - max(sb[1], b[1]))
        if ix * iy / area > most:
            return True
    return False

def track_match(video, eyes, job, shift=0, spacing=300, harvest=True, learn=None, quad=None, think=None, follow=None):
    """Watch one match. → (recording or None, why, shift found)

    `follow`: a CamFollow for this video (v2.28), or None to take the field
    mark as it is for the whole match."""
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
                'model': 'det1', 'at': int(time.time() * 1000), 'f': [], 'tm': [], 'pn': [], 'tg': [], 'gs': [], 'sc': [], 'em': []}

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
        before, auto_kept, next_auto, share_at, emb_at = [], 0, start + LEAD + 5, -1e9, -1e9
        auto_room = [AUTO_MAX - auto_count()] if harvest else [0]
        spot_at, spots, stack_mem = -1e9, None, {}
        # The stream's own score (v2.31), a check and never the truth: live
        # scorers make mistakes and some events show none. Read every second
        # once its place is known; until then, every number on screen every
        # three seconds, to find the place from the official final.
        score_at, seen_nums, rs_, bs_ = -1e9, {}, job.get('rs'), job.get('bs')
        # Frames for the vision model: spread through driver control, each with two or more robots of known colour.
        shots, think_gap = [], ((WINDOW_WIDE - 30) if wide else 100) / max(1, think or 1)
        think_at = start + (10 if wide else LEAD + 20)
        cuts = CutWatch()
        redo = None
        # Following the camera: Hcur says how it has moved since the marked
        # picture (None: not yet known); `view` is False while the picture is
        # not the field. Until it has been found once in this match, nothing
        # is dropped (the marked picture may simply not be found).
        cam = {'H': None, 'Hinv': None, 'at': -1e9, 'fails': 0, 'view': None, 'checks': 0, 'found': 0, 'moves': 0, 'away': 0.0}
        cur_quad, cur_placed, was_cut, last_n = quad, placed_for(job['vid']), False, 0
        field_inv = [None, None]
        # v2.30: looks never come less often than LOOKS_PER_SEC; at the moments
        # that decide things (a robot at a goal, two robots touching) they
        # come twice as often, BURST_PER_SEC, for BURST_HOLD seconds after.
        # The extra looks are the first to go if a match is over the
        # website's ceiling.
        burst_step = max(1, int(math.ceil(video.fps / BURST_PER_SEC - 1e-9)))
        burst_until, next_base, extra, goal_boxes = -1e9, None, set(), None
        now_step = step
        while True:
            _t0 = time.perf_counter()
            t, frame = video.read_at_step(now_step)
            _tick('video', _t0)
            if frame is None or t >= end:
                break
            h, w = frame.shape[:2]
            if cuts.changing(frame, t):                 # mid-cut or mid-fade: not a picture of anything
                was_cut = True
                continue
            if looks_broken(frame):                     # garbled by the decoder: not a picture of anything
                continue
            if follow is not None and quad and (t >= cam['at'] + 1 or was_cut):
                by_cut = was_cut
                cam['at'], was_cut = t, False
                if follow.des is None and t >= start + 3 and last_n >= 3:
                    follow.set_ref(frame)                # no marked picture to go by: the first wide look (3+ robots) stands in for it
                _t0 = time.perf_counter()
                Hn = follow.look(frame)
                _tick('camera', _t0)
                cam['checks'] += 1
                if Hn is not None:
                    cam['found'] += 1
                    cam['fails'] = 0
                    nq = follow.quad_now(Hn)
                    if cam['H'] is None or cam['view'] is False or max(abs(a - b) for a, b in zip(nq, cur_quad)) > CamFollow.MOVE:
                        if cam['H'] is not None and cam['view'] is not False:
                            cam['moves'] += 1
                        import numpy as np
                        cam['H'], cam['Hinv'] = Hn, np.linalg.inv(Hn).tolist()
                        cur_quad, cur_placed, spots, goal_boxes = nq, follow.placed_now(placed_for(job['vid']), Hn), None, None
                    cam['view'] = True
                else:
                    cam['fails'] += 1
                    # Straight after a cut one look says it (the stream went to
                    # another picture); otherwise three in a row, as a robot
                    # driving across the camera can hide the field for a moment.
                    if cam['view'] and (cam['fails'] >= 3 or by_cut):
                        cam['view'] = False
            away = cam['view'] is False
            if away:
                cam['away'] += step / video.fps
            if t >= share_at + 2:
                share_at = t
                share_set(job.get('id'), min(0.98, (t - start) / max(1.0, end - start)))
            _t0 = time.perf_counter()
            every = eyes.detect(frame, PROPOSE)
            _tick('robots', _t0)
            cut = learn.get('conf', CONF)
            boxes = [b for b in every if b[4] >= cut and robot_like(b)]
            if cur_quad and not away:                   # standing off the field: a person, not a robot (v2.40)
                if field_inv[0] is not cur_quad:
                    field_inv[:] = [cur_quad, field_inverse(cur_quad)]
                boxes = [b for b in boxes if on_field(b, field_inv[1], w, h)]
            last_n = len(boxes)
            # v2.29: up to three boxes the finder was less sure of, not on top
            # of a sure one, kept marked as unsure (below `cf`). The website
            # uses them only to carry on a robot that just went missing, right
            # where it should be: half hidden behind a goal, a real robot is
            # often only found faintly.
            cf = max(2, jround(cut * 100))
            unsure = sorted((b for b in every if PROPOSE <= b[4] < cut and robot_like(b) and all(iou(b, k) < 0.3 for k in boxes)), key=lambda b: -b[4])[:3]
            unsure = [b[:4] + [min(b[4], (cf - 1) / 100)] + b[5:] for b in unsure]
            if cur_quad and not away and field_inv[1] is not None:
                unsure = [b for b in unsure if on_field(b, field_inv[1], w, h)]
            rec['cf'] = cf
            rec['h'] = jround(h * SIZE / w)
            for b, tr in attend(att, boxes, t, w, reads):
                tr['tries'] += 1
                tr['read'] = t
                _t0 = time.perf_counter()
                who = eyes.plate(frame, b, four)
                _tick('plates', _t0)
                if who:
                    b[7] = who
                    b[5] = 1 if who <= 2 else 2
                    tr['hits'] += 1
            # Recorded where they stand in the marked picture; nothing while
            # the picture is not the field.
            put = [] if away else (boxes_to_marked(boxes + unsure, cam['Hinv'], w, h) if cam['Hinv'] else boxes + unsure)
            if next_base is None or t >= next_base - 0.5 / video.fps:
                next_base = (next_base if next_base is not None and t - next_base < 1 else t) + 1 / LOOKS_PER_SEC
            else:
                extra.add(len(rec['f']))                 # a look only a key moment asked for
            rec['f'].append(pack_frame(t - rec['off'], put, w))
            # A fingerprint of each robot every EMBED_EVERY s (v2.44), keyed like
            # the vision model's notes: by the look's time and the box's corner.
            if getattr(eyes, 'embed', None) is not None and not away and boxes and t >= emb_at + EMBED_EVERY and len(rec['em']) < 27 * 400:
                emb_at = t
                try:
                    fr_ = rec['f'][-1]
                    _t0 = time.perf_counter()
                    _em = eyes.embed(frame, boxes[:6])
                    _tick('fingerprints', _t0)
                    for i, e_ in enumerate(_em):
                        rec['em'] += [fr_[0], fr_[2 + 10 * i], fr_[3 + 10 * i]] + e_
                except Exception:
                    pass
            if goal_boxes is None:
                goal_boxes = (spot_boxes(w, h, cur_quad, cur_placed) or [])[:9] if cur_quad else []
            if not away and key_moment(boxes, goal_boxes):
                burst_until = t + BURST_HOLD
            now_step = burst_step if t < burst_until else step
            if think and not away and t >= think_at and len(shots) < think and 2 <= len(boxes) <= 6 and sum(1 for b in boxes if b[5]) >= 2:
                jpeg, n = think_picture(frame, boxes)
                if jpeg:
                    shots.append((rec['f'][-1], jpeg, n))
                    think_at = t + think_gap
            if any(b[5] for b in boxes):
                robot_looks += 1
            # The pins, every two seconds: by colour and size, off the robots.
            if t >= pin_at + 2 and len(rec['pn']) < PIN_MAX_INTS:
                pin_at = t
                _t0 = time.perf_counter()
                pw, ph_, blobs = pin_blobs(frame, boxes)
                _tick('pins', _t0)
                rec['pw'], rec['ph'] = pw, ph_
                if away:
                    blobs = []
                elif cam['Hinv']:
                    blobs = blobs_to_marked(blobs, cam['Hinv'], pw, ph_)
                rec['pn'] += [jround((t - rec['off']) * 10), len(blobs)] + [v for bl in blobs for v in bl]
                if quad and not away and len(rec['tg']) < 1800:      # the toggles, where the field's corners now put them
                    tg = toggle_look(frame, cur_quad)
                    if tg:
                        rec['tg'] += [jround((t - rec['off']) * 10)] + tg
            # Pins and cups on each goal and in each loader, every second, once
            # the trained finder is in use and the field is marked.
            if (eyes.pieces is not None or getattr(eyes, 'stack', None) is not None) and quad and not away and t >= spot_at + 1 and len(rec['gs']) < 24000:
                spot_at = t
                if spots is None:
                    spots = spot_boxes(frame.shape[1], frame.shape[0], cur_quad, cur_placed) or []
                    stack_mem.clear()                   # the camera moved: earlier looks no longer line up
                if spots:
                    _t0 = time.perf_counter()
                    # The stack reader where it won its test (v2.49), from the last looks laid over each other; else the pin finder.
                    if getattr(eyes, 'stack', None) is not None:
                        unblocked = [None if (sb and blocked(sb, boxes)) else sb for sb in spots]
                        cnt = eyes.stack.counts(frame, unblocked, stack_mem)
                    else:
                        cnt = eyes.pieces.spot_counts(frame, spots)
                    # v2.49: a goal or loader a robot stands in front of is not
                    # counted this look (-1s): the website keeps its last clear
                    # count instead of a half-hidden stack read short.
                    for k, sb in enumerate(spots):
                        if sb and blocked(sb, boxes):
                            cnt[k] = [-1, -1, -1, -1]
                    rec['gs'] += [jround((t - rec['off']) * 10)] + [v for c in cnt for v in c]
                    _tick('pins', _t0)
            if (learn.get('score') or (rs_ is not None and bs_ is not None)) and not away and t >= score_at + (1 if learn.get('score') else 3) and len(rec['sc']) < 1200:
                score_at = t
                if learn.get('score'):
                    r_, b_ = eyes.number_at(frame, learn['score']['r']), eyes.number_at(frame, learn['score']['b'])
                    rec['sc'] += [jround((t - rec['off']) * 10), -1 if r_ is None else r_, -1 if b_ is None else b_]
                else:
                    for x in eyes.scan(frame):
                        n_ = score_text(x['text'])
                        if n_ is not None:
                            seen_nums.setdefault((round(x['box'][0] * 40), round(x['box'][1] * 40)), []).append((t, n_, x['box']))
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
            steady = steady_four(boxes, before, unsure, w)
            before = boxes
            if harvest and kept < 10 and t >= next_keep and every:
                hard = hardness(every)
                if hard or kept < 4:
                    keep_frame(frame, every, job['vid'], hard, steady, at=t)
                    kept += 1
                    next_keep = t + (6 if hard else 14)
            # Frames to train on that nobody has to look at (v2.32): only looks
            # the tracker is certain of, spread through the match.
            if harvest and steady and not away and auto_kept < AUTO_PER_MATCH and t >= next_auto and auto_room[0] > 0:
                keep_frame(frame, boxes, job['vid'], 0, True, auto=True, at=t)
                auto_kept += 1
                auto_room[0] -= 1
                next_auto = t + AUTO_GAP
        if redo is not None:
            tried_find = True
            found = find_match(video, eyes, job, spacing, redo)
            if found is None:
                return None, 'no robots there, and the match name could not be found on the stream', 0
            off, wide = found, True
            continue
        break
    sure = lambda fr, i: fr[2 + 10 * i + 4] >= rec.get('cf', 0)
    with_robot = sum(1 for fr in rec['f'] if any(fr[2 + 10 * i + 5] and sure(fr, i) for i in range(fr[1])))
    red = sum(1 for fr in rec['f'] if any(fr[2 + 10 * i + 5] == 1 and sure(fr, i) for i in range(fr[1])))
    blue = sum(1 for fr in rec['f'] if any(fr[2 + 10 * i + 5] == 2 and sure(fr, i) for i in range(fr[1])))
    if with_robot < MIN_FRAMES or red < 10 or blue < 10:
        return None, 'robots of both alliances were not seen (a break, a slate, or the wrong place)', 0
    if len(rec['f']) > 2000 and extra:               # the website's ceiling: extra looks go first, evenly
        over = min(len(extra), len(rec['f']) - 2000)
        ex = sorted(extra)
        drop = set(ex[int(i * len(ex) / over)] for i in range(over)) if over else set()
        rec['f'] = [fr for k, fr in enumerate(rec['f']) if k not in drop]
    if len(rec['f']) > 2000:                         # still over: evenly
        keep = len(rec['f']) / 2000
        rec['f'] = [rec['f'][int(i * keep)] for i in range(2000)]
    # The score: its place found from this match's numbers, or, with a place
    # already known, checked against the official final; a place that no
    # longer shows the finals is forgotten and found again next match.
    if not learn.get('score'):
        sp = score_spots(seen_nums, rs_, bs_, max((x[0] for v in seen_nums.values() for x in v), default=0))
        if sp:
            learn['score'] = {'r': sp['r'], 'b': sp['b']}
            at = sorted(set(x[0] for k in (sp['kr'], sp['kb']) for x in seen_nums[k]))
            val = lambda k, tt: next((n for t2, n, _ in seen_nums[k] if t2 == tt), -1)
            rec['sc'] = [v for tt in at for v in (jround((tt - rec['off']) * 10), val(sp['kr'], tt), val(sp['kb'], tt))]
    elif rec['sc']:
        tail = [(rec['sc'][i + 1], rec['sc'][i + 2]) for i in range(0, len(rec['sc']), 3)][-40:]
        if rs_ is not None and bs_ is not None and (rs_, bs_) not in tail:
            learn['score'] = None
    if not rec['sc']:
        del rec['sc']
    if not rec.get('em'):
        rec.pop('em', None)
    rec['_shots'] = shots if think else []
    rec['_cam'] = {k: cam[k] for k in ('checks', 'found', 'moves')}
    rec['_cam']['away'] = round(cam['away'])
    return rec, 'ok', (rec['off'] - off0) if wide else shift


# ── a second pair of eyes: a vision model on this computer ────────────────
# Asked for: "the tracker needs to track as well as a human … i can actively
# think about what a team is doing, so should the tracker", then "work on
# building for the open vision model that's free with no fees".
#
# The finder says WHERE robots are. A vision-language model can also say what
# a robot is doing and read a plate the small reader cannot. It runs here, on
# the graphics card, through Ollama (free, open source; nothing is sent
# anywhere and nothing is paid for). A few frames a match, each with the
# robots outlined and numbered; the model answers from fixed lists, never in
# free writing, so it cannot ramble: which of the four teams' numbers it can
# READ on each robot (or "unreadable"), and what each robot is doing.
#
# NOT TESTED WITH A REAL MODEL when written (the build machine cannot download
# one); the plumbing is tested against a stand-in server. Off until the owner
# turns it on.
OLLAMA = 'http://127.0.0.1:11434'
THINK_MODEL = 'qwen3-vl:8b'       # about 6 GB; the best small model at reading small text
THINK_LOOKS = 6
THINK_DOING = ['cannot tell', 'stacking pins on a goal', 'picking up pins or cups', 'carrying pins', 'at a toggle',
               'pushing or blocking another robot', 'driving', 'not moving', 'tipped over or stuck']

def ollama_call(path, body=None, timeout=120):
    req = urllib.request.Request(OLLAMA + path, data=None if body is None else json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))

def ollama_up():
    try:
        return bool(ollama_call('/api/version', timeout=3).get('version'))
    except Exception:
        return False

def ollama_exe():
    found = shutil.which('ollama')
    if found:
        return found
    for base in (os.environ.get('LOCALAPPDATA', ''), os.environ.get('ProgramFiles', '')):
        for sub in ('Programs\\Ollama\\ollama.exe', 'Ollama\\ollama.exe'):
            cand = os.path.join(base, sub) if base else ''
            if cand and os.path.exists(cand):
                return cand
    return None

def ollama_start():
    """Running already, or started now. → True when it answers."""
    if ollama_up():
        return True
    exe = ollama_exe()
    if not exe:
        return False
    try:
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0)
        subprocess.Popen([exe, 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, creationflags=flags)
    except Exception:
        return False
    for _ in range(40):
        if ollama_up():
            return True
        time.sleep(0.5)
    return False

def ensure_ollama():
    """Ollama on this computer and answering. Installs it (Windows) when it is
    not there: the owner asked for this by turning the vision model on."""
    if ollama_start():
        return True
    if os.name != 'nt':
        say('Ollama is not installed. Get it from https://ollama.com/download and start again.')
        return False
    say('Installing Ollama (free; it runs the vision model on this computer)…')
    done = False
    if shutil.which('winget'):
        try:
            r = subprocess.run(['winget', 'install', '-e', '--id', 'Ollama.Ollama', '--accept-source-agreements', '--accept-package-agreements', '--silent'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
            done = r.returncode == 0
        except Exception:
            done = False
    if not done and not ollama_exe():
        try:
            setup = os.path.join(DIRS['build'], 'OllamaSetup.exe')
            say('  downloading its installer…')
            urllib.request.urlretrieve('https://ollama.com/download/OllamaSetup.exe', setup)
            subprocess.run([setup, '/VERYSILENT', '/NORESTART'], timeout=1800)
        except Exception as e:
            say('  could not install it:', e)
    if ollama_start():
        return True
    say('Ollama did not start. Install it from https://ollama.com/download , open it once, then press Track again.')
    return False

def think_model(cfg):
    return str(cfg.get('think_model') or THINK_MODEL)

def have_think_model(cfg):
    want = think_model(cfg)
    try:
        names = [m.get('name', '') for m in ollama_call('/api/tags', timeout=10).get('models', [])]
    except Exception:
        return False
    return any(n == want or n == want + ':latest' or n.split(':')[0] == want for n in names)

def ensure_think(cfg):
    """Everything the vision model needs, fetched once. → True when it can be asked."""
    if not ensure_ollama():
        return False
    if have_think_model(cfg):
        return True
    want = think_model(cfg)
    say('Downloading the vision model %s (about 6 GB, once)…' % want)
    try:
        req = urllib.request.Request(OLLAMA + '/api/pull', data=json.dumps({'model': want, 'stream': True}).encode('utf-8'), headers={'Content-Type': 'application/json'})
        last = 0
        with urllib.request.urlopen(req, timeout=3600) as r:
            for line in r:
                try:
                    d = json.loads(line.decode('utf-8'))
                except Exception:
                    continue
                if d.get('error'):
                    say('  the download failed:', d['error'])
                    return False
                if d.get('total') and time.time() - last > 1:
                    last = time.time()
                    progress('Downloading the vision model', d.get('completed', 0), d['total'])
    except Exception as e:
        say('  the download failed:', e)
        return False
    progress()
    ok = have_think_model(cfg)
    say('  the vision model is ready.' if ok else '  the vision model did not arrive.')
    return ok

def think_picture(frame, boxes):
    """What the model is shown, as one JPEG: the whole frame with each robot
    outlined and numbered, and under it each robot again, enlarged from the
    full-size frame, because in the wide view a plate is a few dozen pixels.
    → (bytes, how many)"""
    import cv2, numpy as np
    h, w = frame.shape[:2]
    W = 1280
    k = W / w
    img = cv2.resize(frame, (W, int(round(h * k))), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)
    def tag(pic, n, x, y):
        cv2.rectangle(pic, (x, y), (x + 30, y + 30), (0, 0, 0), -1)
        cv2.putText(pic, str(n), (x + 6, y + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
    row = np.zeros((320, W, 3), np.uint8)
    cell = W // max(4, len(boxes))
    for n, b in enumerate(boxes, 1):
        x, y, bw, bh = [int(round(v)) for v in b[:4]]
        px, py = int(bw * 0.08), int(bh * 0.08)
        crop = frame[max(0, y - py):min(h, y + bh + py), max(0, x - px):min(w, x + bw + px)]
        if crop.size:
            z = min((cell - 8) / crop.shape[1], 320 / crop.shape[0])
            crop = cv2.resize(crop, (max(1, int(crop.shape[1] * z)), max(1, int(crop.shape[0] * z))), interpolation=cv2.INTER_CUBIC)
            x0 = (n - 1) * cell + 4
            row[:crop.shape[0], x0:x0 + crop.shape[1]] = crop
            tag(row, n, x0, 0)
        X, Y = int(round(x * k)), int(round(y * k))
        cv2.rectangle(img, (X, Y), (X + int(round(bw * k)), Y + int(round(bh * k))), (255, 255, 255), 2)
        tag(img, n, X, max(0, Y - 30))
    ok, buf = cv2.imencode('.jpg', np.vstack([img, row]), [cv2.IMWRITE_JPEG_QUALITY, 90])
    return (buf.tobytes() if ok else None), len(boxes)

def think_prompt(four, n):
    red = ', '.join(t for t in four[:2] if t) or 'unknown'
    blue = ', '.join(t for t in four[2:] if t) or 'unknown'
    return ('One frame of a VEX V5 Robotics Competition match (the game is called Override), from a camera above the field. '
            '%d robot%s outlined in white and numbered in the corner of each outline. Under the frame each robot is shown again, enlarged, with the same number.\n'
            'Every robot carries licence plates in its alliance colour, red or blue, with its team number in white. '
            'Red alliance: %s. Blue alliance: %s.\n'
            'On the field: pins (small red, blue or yellow pieces shaped like two cones), clear cups, goals (cone-shaped stands that pins are stacked on) '
            'and toggles (a bar at the middle of each wall).\n'
            'For each numbered robot give:\n'
            '- plate: the team number, ONLY if you can actually read it on that robot\'s plate; otherwise "unreadable". Never guess from colour alone.\n'
            '- doing: what that robot is doing in this frame, from the list. If it is not clear, "cannot tell".'
            % (n, ' is' if n == 1 else 's are', red, blue))

def think_schema(four, n):
    teams = [t for t in four if t]
    return {'type': 'object', 'required': ['robots'], 'properties': {'robots': {'type': 'array', 'minItems': n, 'maxItems': n, 'items': {
        'type': 'object', 'required': ['n', 'plate', 'doing'], 'properties': {
            'n': {'type': 'integer', 'minimum': 1, 'maximum': n}, 'plate': {'type': 'string', 'enum': teams + ['unreadable']},
            'doing': {'type': 'string', 'enum': THINK_DOING}}}}}}

_THINK = {'plain': False, 'failed': 0}
def think_ask(cfg, jpeg, four, n):
    """One frame to the model. → [{'n', 'plate', 'doing'}] or None."""
    body = {'model': think_model(cfg), 'stream': False, 'keep_alive': '10m', 'format': think_schema(four, n),
            'options': {'temperature': 0, 'num_predict': 60 + 40 * n},
            'messages': [{'role': 'user', 'content': think_prompt(four, n), 'images': [base64.b64encode(jpeg).decode('ascii')]}]}
    if not _THINK['plain']:
        body['think'] = False                     # models that reason first: skip it, the answer is a short form
    try:
        try:
            r = ollama_call('/api/chat', body, timeout=180)
        except urllib.error.HTTPError as e:
            if e.code == 400 and 'think' in body:    # a model with no such switch
                _THINK['plain'] = True
                del body['think']
                r = ollama_call('/api/chat', body, timeout=180)
            else:
                raise
        got = json.loads((r.get('message') or {}).get('content') or '{}').get('robots')
        return got if isinstance(got, list) else None
    except Exception:
        _THINK['failed'] += 1
        return None

def trim_shots(rec, shots):
    """The vision model is the slowest thing in a match (seconds a picture,
    and one model for every worker). Where the plates already say who each of
    the four robots is (two reads or more each), it is asked about two
    pictures, for what the robots are doing; otherwise about all of them, as
    its reading of numbers is what tells the robots apart (v2.46)."""
    if len(shots) <= 2:
        return shots
    reads = [0, 0, 0, 0, 0]
    for fr in rec.get('f', []):
        for i in range(fr[1]):
            who = fr[2 + 10 * i + 9] if len(fr) > 2 + 10 * i + 9 else 0
            if who and 1 <= who <= 4:
                reads[who] += 1
    if min(reads[1:]) >= 2:
        return [shots[0], shots[len(shots) // 2]]
    return shots

def think_match(rec, shots, job, cfg):
    """What the vision model saw in this match's kept frames, written into the
    recording: `vo`, five whole numbers a robot a look [tenths, box x, box y,
    what it is doing, plate read (1-4 as in a box, 0 none)]. The website joins
    each to the robot the tracker had at that spot. → how many it answered."""
    four = [(job['red'] + ['', ''])[0], (job['red'] + ['', ''])[1], (job['blue'] + ['', ''])[0], (job['blue'] + ['', ''])[1]]
    alive = set(id(fr) for fr in rec['f'])
    vo, asked = [], 0
    for fr, jpeg, n in shots:
        if id(fr) not in alive or _THINK['failed'] >= 3:   # dropped when the recording was thinned; or the model is not answering
            continue
        got = think_ask(cfg, jpeg, four, n)
        if not got:
            continue
        asked += 1
        said = {}
        for g in got:
            try:
                k = int(g.get('n', 0))
            except (TypeError, ValueError):
                continue
            if 1 <= k <= n and k not in said:
                said[k] = g
        # Two robots given the same number: at least one is a guess. Neither counts.
        plates = [g.get('plate') for g in said.values() if g.get('plate') in four and g.get('plate')]
        twice = set(p for p in plates if plates.count(p) > 1)
        for k, g in said.items():
            o = 2 + 10 * (k - 1)
            who = four.index(g['plate']) + 1 if g.get('plate') in four and g.get('plate') and g['plate'] not in twice else 0
            col = fr[o + 5]
            if who and col and (1 if who <= 2 else 2) != col:      # a red team's number on a robot seen as blue: not believed
                who = 0
            act = THINK_DOING.index(g['doing']) if g.get('doing') in THINK_DOING else 0
            if act or who:
                vo += [fr[0], fr[o], fr[o + 1], act, who]
    if vo:
        rec['vo'] = vo[:600]
    return asked


def spacing_of(jobs):
    """Seconds between one qualification match and the next, from the schedule."""
    q = sorted((j for j in jobs if j.get('round') == 2 and j.get('num') is not None), key=lambda j: j['num'])
    gaps = [(b['off'] - a['off']) / (b['num'] - a['num']) for a, b in zip(q, q[1:]) if b['num'] > a['num'] and 60 < (b['off'] - a['off']) / (b['num'] - a['num']) < 1500]
    gaps.sort()
    return gaps[len(gaps) // 2] if gaps else 300


_EYES = None
def cam_note(cam):
    """For the log: how following the camera went in one match."""
    if not cam or not cam.get('checks'):
        return ''
    if not cam.get('found'):
        return ' · camera: the marked picture was not found (mark the field again on a clear wide shot)'
    bits = ['followed %d%% of the time' % round(100 * cam['found'] / cam['checks'])]
    if cam.get('moves'):
        bits.append('%d camera moves' % cam['moves'])
    if cam.get('away'):
        bits.append('%d s off the field left out' % cam['away'])
    return ' · camera: ' + ', '.join(bits)

def field_inverse(q):
    """Picture fractions → field units (0..1 inside), for four corners in any
    order (the same order as quad_fwd). → a function, or None."""
    import cv2, numpy as np
    L = lens_of(q)
    q0 = q
    q = straight_q(q)
    cx, cy = (q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4
    pts = sorted(((q[i], q[i + 1]) for i in range(0, 8, 2)), key=lambda t: math.atan2(t[1] - cy, t[0] - cx))
    try:
        M = cv2.getPerspectiveTransform(np.float32(pts), np.float32([[0, 0], [1, 0], [1, 1], [0, 1]]))
    except Exception:
        return None
    if L:
        def inv_lens(x, y):
            x, y = lens_undo(x, y, *L)
            d = M[2][0] * x + M[2][1] * y + M[2][2]
            return (M[0][0] * x + M[0][1] * y + M[0][2]) / d, (M[1][0] * x + M[1][1] * y + M[1][2]) / d
        return inv_lens
    def inv(x, y):
        d = M[2][0] * x + M[2][1] * y + M[2][2]
        return (M[0][0] * x + M[0][1] * y + M[0][2]) / d, (M[1][0] * x + M[1][1] * y + M[1][2]) / d
    return inv

FIELD_MARGIN = 0.06       # how far outside the field's edge a robot's wheels can be seen to stand (8-9 in)

def on_field(b, inv, W, H):
    """Does box b stand on the field? Its bottom middle, mapped through the
    field mark, must be inside the field (with a little margin). People, refs
    and signs stand around it, never on it (v2.40; reported: "its selecting
    like people sometimes still")."""
    if inv is None:
        return True
    u, v = inv((b[0] + b[2] / 2) / W, (b[1] + b[3]) / H)
    return -FIELD_MARGIN <= u <= 1 + FIELD_MARGIN and -FIELD_MARGIN <= v <= 1 + FIELD_MARGIN

def key_moment(boxes, goals):
    """A moment worth looking at more often: a robot standing at a goal (its
    foot within a goal's own size of it), or two robots touching (closer than
    a quarter of the smaller's width)."""
    for b in boxes:
        fx, fy = b[0] + b[2] / 2, b[1] + b[3]
        for g in goals:
            if g and g[0] - (g[2] - g[0]) <= fx <= g[2] + (g[2] - g[0]) and g[1] - (g[3] - g[1]) <= fy <= g[3] + (g[3] - g[1]):
                return True
    for i in range(len(boxes)):
        a = boxes[i]
        for b in boxes[i + 1:]:
            gx = max(0, max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2]))
            gy = max(0, max(a[1], b[1]) - min(a[1] + a[3], b[1] + b[3]))
            if max(gx, gy) < 0.25 * min(a[2], b[2]):
                return True
    return False

def share_set(key, frac):
    """How far through one match this worker is, for the job's bar."""
    if _SHARE is None or key is None:
        return
    try:
        _SHARE[str(key)] = float(frac)
    except Exception:
        pass

# ── the vision model as a reviewer and a field finder (v2.40) ─────────────
# Asked: "build as much and utilize as much as you can with it as long as its
# reasonable". It is far too slow to look at every box of every look (a
# second or more a question), so it is used where a person's time goes: it
# reviews saved frames (is each box a robot? any robot without a box?), and
# finds the field's corners, goals and loaders on a picture for the person to
# check. Coordinates from Qwen3-VL come as 0-1000 of the picture (pixels of
# the picture sent are taken too, if a model gives those).
VLM_WHAT = ['robot', 'person', 'referee or staff', 'field element or game piece', 'sign or screen', 'other']

# ── Ask: questions about the scouting data, answered on this computer (v2.52) ──
# Asked: "ask it anything … would this be like basically a chatbot?" The
# website's Ask box sends the question with the event's numbers as a table
# (what the website already shows); the vision model here answers from that
# table only, and says when the table does not have the answer. Only the
# website (and this computer) may ask, it only gets text back, and one
# question is answered at a time. Nothing leaves this computer.
ASK_ORIGINS = ('https://vex-scouting-by-max.vercel.app', 'http://localhost:3000', 'http://127.0.0.1:3000')
ASK_MAX_BYTES = 400000
_ASK_LOCK = threading.Lock()

def ask_answer(cfg, q):
    question = str(q.get('question') or '').strip()[:600]
    table = str(q.get('table') or '')[:300000]
    where = str(q.get('where') or '').strip()[:200]
    history = [h for h in (q.get('history') or [])[-6:] if isinstance(h, dict)]
    if not question:
        return {'error': 'no question'}
    if not cfg.get('think'):
        return {'error': 'Turn on the vision model in the app\'s Settings: it is what answers.'}
    if not ensure_think(cfg):
        return {'error': 'The vision model is not ready on this computer yet.'}
    system = ('You are a scouting assistant for a VEX V5 Robotics Competition team (game: Override). Answer the question using ONLY the data below%s. '
              'Quote the numbers you use, name teams by their number, and keep it short: a few sentences or a short list. '
              'If the data does not answer it, say so plainly and say what would. Do not invent numbers. '
              'Column meanings are given in the first lines of the data.\n\nDATA:\n%s') % ((' about ' + where) if where else '', table)
    msgs = [{'role': 'system', 'content': system}]
    for h in history:
        if h.get('role') in ('user', 'assistant') and isinstance(h.get('content'), str):
            msgs.append({'role': h['role'], 'content': h['content'][:2000]})
    msgs.append({'role': 'user', 'content': question})
    body = {'model': think_model(cfg), 'stream': False, 'keep_alive': '10m', 'options': {'temperature': 0.2, 'num_predict': 700, 'num_ctx': 32768}, 'messages': msgs}
    if not _THINK['plain']:
        body['think'] = False
    if not _ASK_LOCK.acquire(timeout=120):
        return {'error': 'Busy with another question; try again in a moment.'}
    try:
        try:
            r = ollama_call('/api/chat', body, timeout=300)
        except urllib.error.HTTPError as e:
            if e.code == 400 and 'think' in body:
                _THINK['plain'] = True
                del body['think']
                r = ollama_call('/api/chat', body, timeout=300)
            else:
                raise
        text = ((r.get('message') or {}).get('content') or '').strip()
        return {'answer': text or 'No answer came back.'}
    except Exception as e:
        return {'error': 'The vision model could not answer (%s).' % str(e)[:120]}
    finally:
        _ASK_LOCK.release()

def vlm_ask(cfg, prompt, schema, jpeg, tokens=400):
    """One question with one picture, answered as JSON to the schema. → dict or None."""
    body = {'model': think_model(cfg), 'stream': False, 'keep_alive': '10m', 'format': schema,
            'options': {'temperature': 0, 'num_predict': tokens},
            'messages': [{'role': 'user', 'content': prompt, 'images': [base64.b64encode(jpeg).decode('ascii')]}]}
    if not _THINK['plain']:
        body['think'] = False
    try:
        try:
            r = ollama_call('/api/chat', body, timeout=240)
        except urllib.error.HTTPError as e:
            if e.code == 400 and 'think' in body:
                _THINK['plain'] = True
                del body['think']
                r = ollama_call('/api/chat', body, timeout=240)
            else:
                raise
        got = json.loads((r.get('message') or {}).get('content') or '{}')
        return got if isinstance(got, dict) else None
    except Exception:
        return None

def vlm_point(v, W, H):
    """A model's [x, y] (0-1000, or pixels of the W×H picture sent) → fractions."""
    try:
        x, y = float(v[0]), float(v[1])
    except (TypeError, ValueError, IndexError):
        return None
    if x > 1000 or y > 1000:
        return [x / W, y / H]
    return [x / 1000, y / 1000]

def vlm_review_frame(cfg, name):
    """The model's look at one saved frame: what each of the finder's boxes is,
    and robots on the field without a box. Kept in the frame's notes (`vlm`).
    → the notes, or None."""
    import cv2
    frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
    try:
        with open(os.path.join(PROPS, name + '.json')) as f:
            p = json.load(f)
    except Exception:
        return None
    if frame is None:
        return None
    boxes = [b for b in p.get('boxes', []) if b[4] >= 0.35][:8]
    jpeg, n = think_picture(frame, [list(b[:4]) + [b[4], 0, None, 0] for b in boxes]) if boxes else (None, 0)
    if not boxes:
        ok_, buf = cv2.imencode('.jpg', cv2.resize(frame, (1280, int(round(frame.shape[0] * 1280 / frame.shape[1])))), [cv2.IMWRITE_JPEG_QUALITY, 90])
        jpeg = buf.tobytes() if ok_ else None
    if not jpeg:
        return None
    prompt = ('One frame of a VEX V5 Robotics Competition match, seen from the side of the field. '
              + ('%d things are outlined in white and numbered; under the frame each is shown again, enlarged. ' % n if n else 'Nothing is outlined. ')
              + 'A robot is a machine of metal, wheels and motors, about the size of a small suitcase, ON the grey field floor inside the walls, '
              'with red or blue licence plates. People, referees, drivers holding controllers, signs, screens, the walls, goals and game pieces are not robots.\n'
              + ('For each numbered outline say what it is, from the list. ' if n else '')
              + 'Then give "missed": a box [x0, y0, x1, y1] (x and y from 0 to 1000 across and down the whole picture) for every robot ON the field, in the top part, that has NO outline. '
              'An empty list if there is none. Never put a person in "missed".')
    schema = {'type': 'object', 'required': ['outlined', 'missed'], 'properties': {
        'outlined': {'type': 'array', 'minItems': n, 'maxItems': n, 'items': {'type': 'object', 'required': ['n', 'what'], 'properties': {
            'n': {'type': 'integer', 'minimum': 1, 'maximum': max(1, n)}, 'what': {'type': 'string', 'enum': VLM_WHAT}}}},
        'missed': {'type': 'array', 'maxItems': 6, 'items': {'type': 'array', 'minItems': 4, 'maxItems': 4, 'items': {'type': 'number'}}}}}
    got = vlm_ask(cfg, prompt, schema, jpeg, 120 + 30 * n)
    if not got:
        return None
    H, W = frame.shape[:2]
    pic_h = int(round(H * 1280 / W))                   # the frame's part of the picture sent (the enlargements are under it)
    sent_h = pic_h + (320 if n else 0)
    what = ['?'] * n
    for o in got.get('outlined') or []:
        try:
            k = int(o.get('n')) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= k < n and o.get('what') in VLM_WHAT:
            what[k] = o['what']
    missed = []
    for m in (got.get('missed') or [])[:6]:
        a, b = vlm_point(m[:2], 1280, sent_h), vlm_point(m[2:4], 1280, sent_h)
        if not a or not b:
            continue
        a, b = [a[0], a[1] * sent_h / pic_h], [b[0], b[1] * sent_h / pic_h]     # down the frame, not the whole picture
        if min(a[1], b[1]) >= 1:
            continue
        x0, y0, x1, y1 = min(a[0], b[0]) * W, min(a[1], b[1]) * H, max(a[0], b[0]) * W, max(a[1], b[1]) * H
        if 8 < x1 - x0 < W * 0.5 and 8 < y1 - y0 < H * 0.6 and all(iou([x0, y0, x1 - x0, y1 - y0], bb) < 0.3 for bb in boxes):
            missed.append([round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)])
    notes = {'boxes': [[round(v, 1) for v in b[:4]] for b in boxes], 'what': what, 'missed': missed, 'at': int(time.time())}
    p['vlm'] = notes
    with open(os.path.join(PROPS, name + '.json'), 'w') as f:
        json.dump(p, f)
    return notes

def vlm_verdict(notes):
    """From the model's notes: the robots it would keep, and whether it agrees
    with the finder outright (every box a robot, none missed, 1 to 6 robots)."""
    keep = [b for b, w in zip(notes.get('boxes', []), notes.get('what', [])) if w == 'robot'] + notes.get('missed', [])
    agree = bool(notes.get('boxes')) and all(w == 'robot' for w in notes.get('what', [])) and not notes.get('missed') and 1 <= len(keep) <= 6
    return keep, agree

def do_vreview(cfg, limit=400):
    """The vision model goes through the frames waiting for review. Where it
    and the finder agree outright, the frame is labelled (trained on, never
    graded on, like the tracker's own certain frames); where they do not, its
    view is waiting in review: boxes it says are not robots taken away, robots
    it says were missed added, and those frames come first."""
    if not ensure_think(cfg):
        say('The vision model is not ready, so it cannot review.')
        return
    q, _ = review_queue()
    todo = [n for n in q if 'vlm' not in (json.load(open(os.path.join(PROPS, n + '.json'))) if os.path.exists(os.path.join(PROPS, n + '.json')) else {})][:limit]
    say('\nThe vision model is reviewing %d frames (about %d minutes).' % (len(todo), max(1, round(len(todo) * 4 / 60))))
    agreed = changed = failed = 0
    for i, name in enumerate(todo):
        progress('The vision model is reviewing frames', i, len(todo))
        notes = vlm_review_frame(cfg, name)
        if not notes:
            failed += 1
            if failed >= 5 and failed > i // 2:
                say('  the vision model is not answering; stopped.')
                break
            continue
        keep, agree = vlm_verdict(notes)
        if agree:
            lab_write(name, skip=False, boxes=keep, by='vlm')
            agreed += 1
        else:
            changed += 1
        if (i + 1) % 25 == 0:
            say('  %d looked at: %d agreed with the finder and were labelled, %d left for you with its changes.' % (i + 1, agreed, changed))
    progress('The vision model is reviewing frames', len(todo), len(todo))
    say('Done: %d frames labelled where the model and the finder agreed; %d left for you, with what the model thinks already applied.' % (agreed, changed))

# ── the vision model marks pins & cups first (v2.48) ──────────────────────
# Asked: "why cant the vision model also do the thing for cups that marks the
# confident ones aka let the vision model review first too for cups and
# pins". As for robots: the model is shown each goal and loader of a frame,
# cut out and enlarged, and counts the pin halves of each colour and the cups
# on it. Where its counts and the guesses' (the marking helper's, the trained
# finder's, or the colours') agree on every goal and loader, the guesses are
# saved as that frame's marks; they are trained on, never used to grade a
# finder (`pby` 'vlm'). Where they disagree the frame stays for you, with the
# model's counts shown, and those frames come first.
def piece_guesses(name, frame, robots, spots):
    """The boxes drawn on a frame before anyone marks it: the marking
    helper's, else the trained finder's, else the colours'. [[x, y, w, h, c]]"""
    src = guess_source()
    try:
        if src[1]:
            f = PieceFinder(src[1], prov=['CPUExecutionProvider'])
            return [list(b[:4]) + [int(b[5])] for b in f.find_spots(frame, spots)]
    except Exception:
        pass
    return [list(b[:5]) for b in pieces_from_colour(frame, robots, spots)]

def spot_counts_of(pieces, spots):
    """Pieces on each spot, by kind: [[red halves, blue halves, yellow halves, cups]] a spot."""
    out = [[0, 0, 0, 0] for _ in spots]
    for b in pieces:
        k = in_spots(b, spots)
        if k >= 0 and 0 <= int(b[4]) < 4:
            out[k][int(b[4])] += 1
    return out

def spots_picture(frame, spots):
    """Each goal and loader of a frame cut out, enlarged and numbered, in one
    JPEG. → (bytes, [the spot index each number is])"""
    import cv2, numpy as np
    H, W = frame.shape[:2]
    cells, which = [], []
    for k, sb in enumerate(spots):
        if not sb:
            continue
        x0, y0, x1, y1 = (int(round(v)) for v in sb)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        crop = frame[y0:y1, x0:x1]
        ch = 300
        cw = max(60, min(260, int(round((x1 - x0) * ch / (y1 - y0)))))
        cells.append(cv2.resize(crop, (cw, ch), interpolation=cv2.INTER_CUBIC))
        which.append(k)
    if not cells:
        return None, []
    cols = 5
    rows = (len(cells) + cols - 1) // cols
    cw = max(c.shape[1] for c in cells)
    pic = np.full((rows * 340, cols * (cw + 10), 3), 30, np.uint8)
    for i, c in enumerate(cells):
        r_, c_ = divmod(i, cols)
        x, y = c_ * (cw + 10), r_ * 340 + 40
        pic[y:y + c.shape[0], x:x + c.shape[1]] = c
        cv2.rectangle(pic, (x, y - 38), (x + 46, y - 4), (0, 0, 0), -1)
        cv2.putText(pic, str(i + 1), (x + 6, y - 11), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
    ok_, buf = cv2.imencode('.jpg', pic, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return (buf.tobytes() if ok_ else None), which

def vlm_pieces_frame(cfg, name):
    """The model's count of pins and cups on each goal and loader of one
    saved frame, and the guesses'. → {'model', 'guess', 'pieces', 'agree'} or None."""
    import cv2
    frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
    if frame is None:
        return None
    spots = frame_spots(name, frame)
    if not spots:
        return None
    robots = lab_read(name).get('boxes', [])
    guesses = piece_guesses(name, frame, robots, spots)
    jpeg, which = spots_picture(frame, spots)
    if not jpeg:
        return None
    n = len(which)
    prompt = ('Each numbered picture is one goal or one match loader, cut from a frame of a VEX V5 Robotics Competition match (the game Override) and enlarged. '
              'Pins stack on goals and sit in loaders. A pin is two halves, each red, blue or yellow (one pin can be two colours). Cups are the cup-shaped pieces. '
              'For each picture, count the red halves, blue halves, yellow halves and cups that are ON that goal or IN that loader, including half-hidden ones. '
              'Do not count pieces lying loose on the floor, pieces on a robot, or pieces on another goal behind it.')
    cnt = {'type': 'integer', 'minimum': 0, 'maximum': 30}
    schema = {'type': 'object', 'required': ['spots'], 'properties': {'spots': {'type': 'array', 'minItems': n, 'maxItems': n, 'items': {
        'type': 'object', 'required': ['n', 'red', 'blue', 'yellow', 'cups'],
        'properties': {'n': {'type': 'integer', 'minimum': 1, 'maximum': n}, 'red': cnt, 'blue': cnt, 'yellow': cnt, 'cups': cnt}}}}}
    got = vlm_ask(cfg, prompt, schema, jpeg, 60 + 40 * n)
    if not got:
        return None
    model = [None] * len(spots)
    for s_ in got.get('spots') or []:
        try:
            i = int(s_.get('n')) - 1
            row = [int(s_.get(k, 0)) for k in ('red', 'blue', 'yellow', 'cups')]
        except (TypeError, ValueError):
            continue
        if 0 <= i < n:
            model[which[i]] = row
    guess = spot_counts_of(guesses, spots)
    agree = all(m is not None for k, m in enumerate(model) if spots[k]) and all(model[k] == guess[k] for k in range(len(spots)) if spots[k])
    notes = {'model': model, 'guess': guess, 'agree': agree, 'at': int(time.time())}
    try:
        with open(os.path.join(PROPS, name + '.json')) as f:
            p = json.load(f)
        p['pvlm'] = notes
        with open(os.path.join(PROPS, name + '.json'), 'w') as f:
            json.dump(p, f)
    except Exception:
        pass
    return dict(notes, pieces=guesses)

def pvlm_text(notes):
    """The model's counts where they differ from the boxes drawn, said plainly."""
    if not notes or notes.get('agree'):
        return ''
    kinds = ('red', 'blue', 'yellow', 'cups')
    out = []
    for k, (m, g) in enumerate(zip(notes.get('model') or [], notes.get('guess') or [])):
        if m is None or m == g:
            continue
        what = 'goal %d' % (k + 1) if k < N_GOALS else 'loader %d' % (k - N_GOALS + 1)
        out.append('%s: %s' % (what, ', '.join('%d %s' % (v, ('cup' if v == 1 else 'cups') if i == 3 else kinds[i] + (' half' if v == 1 else ' halves')) for i, v in enumerate(m) if v) or 'nothing'))
    return ('The vision model counts ' + '; '.join(out[:5]) + '.') if out else ''

def do_vpieces(cfg, limit=300):
    """The vision model goes through the frames waiting for pins & cups."""
    if not ensure_think(cfg):
        say('The vision model is not ready, so it cannot mark.')
        return
    todo = []
    for name in pieces_queue():
        try:
            with open(os.path.join(PROPS, name + '.json')) as f:
                if 'pvlm' in json.load(f):
                    continue
        except Exception:
            continue
        todo.append(name)
        if len(todo) >= limit:
            break
    say('\nThe vision model is counting pins & cups on %d frames (about %d minutes).' % (len(todo), max(1, round(len(todo) * 8 / 60))))
    agreed = changed = failed = 0
    for i, name in enumerate(todo):
        progress('The vision model is counting pins & cups', i, len(todo))
        got = vlm_pieces_frame(cfg, name)
        if not got:
            failed += 1
            if failed >= 5 and failed > i // 2:
                say('  the vision model is not answering; stopped.')
                break
            continue
        if got['agree']:
            lab_write(name, pieces=clean_pieces(got['pieces']), pskip=False, pby='vlm')
            agreed += 1
        else:
            changed += 1
        if (i + 1) % 25 == 0:
            say('  %d looked at: %d marked where it agreed with the guesses, %d left for you.' % (i + 1, agreed, changed))
    progress('The vision model is counting pins & cups', len(todo), len(todo))
    say('Done: %d frames marked where the vision model and the guesses agreed on every goal and loader; %d left for you, with its counts shown.' % (agreed, changed))

def pieces_by_person(name):
    """Marked by a person (not the vision model): only these grade a finder."""
    return lab_read(name).get('pby') != 'vlm'

# ── the field finder: trained on your own field marks (v2.47) ─────────────
# Reported: "finding the field for me feature doesnt actually find the field
# for me or mark goals automatically", then "fix the automatically finding
# field and goal locations itll make my life very easier". The vision model
# places points roughly at best, and a finder built by hand from colours and
# edges was tried and was not good enough: the side walls' grey insides look
# like floor, and dark goal bases are lost among wheels and shadows. So the
# field is learned the way robots are: a small keypoint model (YOLO11 pose),
# trained on the saved frames of every stream whose field is marked. Each
# frame's answer is the stream's mark, moved with the camera (the following
# tracking uses), so one marked stream gives dozens of examples. It answers
# with the field's four corners and every goal and loader, and gets better
# with every stream marked.
FIELD_KP = 4 + 13                         # corners, nine goals, four loaders
FIELD_SIZE = 640
FIELD_START, FIELD_EVERY = 3, 2           # trained once 3 streams are marked, again after every 2 more
FIELD_PER_STREAM = 60
FIELD_ROUNDS = 80

def field_file():
    return os.path.join(DIRS['models'], 'field_finder.onnx')

def field_info():
    try:
        with open(os.path.join(DIRS['models'], 'field_finder.json')) as f:
            return json.load(f)
    except Exception:
        return {}

def field_points(q, placed=None):
    """The 17 points of a field mark, as picture fractions: corners (0,0),
    (1,0), (1,1), (0,1) of the field square, then the goals' and loaders' feet
    (dragged into place where they were, else where the corners put them)."""
    fwd = quad_fwd(q)
    if not fwd:
        return None
    pts = [list(fwd(u, v)) for u, v in ((0, 0), (1, 0), (1, 1), (0, 1))]
    feet = [list(p) for p in (first_spots(q) or [])]
    if len(feet) != len(SPOTS):
        return None
    if placed and isinstance(placed.get('g'), list) and len(placed['g']) == 18:
        for k in range(9):
            feet[k] = placed['g'][2 * k:2 * k + 2]
    if placed and isinstance(placed.get('l'), list) and len(placed['l']) == 8:
        for k in range(4):
            feet[9 + k] = placed['l'][2 * k:2 * k + 2]
    return [[float(a), float(b)] for a, b in pts + feet]

def field_streams():
    """Streams with a field mark and saved frames here: {vid: [frame names]}."""
    out = {}
    try:
        names = sorted(n[:-4] for n in os.listdir(FRAMES) if n.endswith('.jpg'))
    except Exception:
        names = []
    for n in names:
        vid = n.rsplit('_', 1)[0]
        if vid not in out:
            out[vid] = [] if quad_for(vid) else None
        if out[vid] is not None:
            out[vid].append(n)
    return {v: ns for v, ns in out.items() if ns}

def field_examples(per=FIELD_PER_STREAM):
    """Frames with the field's 17 points: [(name, points)]. Where the field
    was marked on a frame here, every frame follows the camera from it (and
    frames it cannot match are left out); where it was marked on the website,
    frames are kept only while the picture is the same view as the stream's
    first saved frame (a fixed camera), as the mark holds there."""
    import cv2
    out = []
    for vid, names in field_streams().items():
        step = max(1, len(names) // per)
        pick = names[::step][:per]
        q, placed = quad_for(vid), placed_for(vid)
        if field_ref(vid):
            for n in pick:
                geo = frame_geom(n)
                if geo:
                    pts = field_points(geo[0], geo[1])
                    if pts:
                        out.append((n, pts))
            continue
        pts0 = field_points(q, placed)
        if not pts0:
            continue
        cf = CamFollow(q)
        first = cv2.imread(os.path.join(FRAMES, pick[0] + '.jpg'))
        if first is None or not cf.set_ref(first):
            continue
        for n in pick:
            if n != pick[0]:
                fr = cv2.imread(os.path.join(FRAMES, n + '.jpg'))
                Hm = cf.look(fr) if fr is not None else None
                if Hm is None:
                    continue
                nq = cf.quad_now(Hm)
                if max(abs(a - b) for a, b in zip(nq, q[:8])) > 0.015:
                    continue
            out.append((n, pts0))
    return out

def build_field_dataset(examples):
    """A keypoint dataset: one box (the field) with its 17 points a picture.
    Whole streams are held back for testing, so the test is a stream it never saw."""
    root = os.path.join(DIRS['build'], 'field_dataset')
    shutil.rmtree(root, ignore_errors=True)
    for part in ('train', 'val'):
        os.makedirs(os.path.join(root, 'images', part))
        os.makedirs(os.path.join(root, 'labels', part))
    vids = sorted(set(n.rsplit('_', 1)[0] for n, _ in examples))
    held = set(v for v in vids if is_val(v)) if len(vids) >= 4 else set()
    if len(vids) >= 4 and not held:
        held = {vids[-1]}
    if held and len(held) >= len(vids):
        held = {vids[-1]}
    counts = {'train': 0, 'val': 0}
    for n, pts in examples:
        vid = n.rsplit('_', 1)[0]
        part = 'val' if (vid in held or (not held and is_val(n))) else 'train'
        src = os.path.join(FRAMES, n + '.jpg')
        if not os.path.exists(src):
            continue
        cs = pts[:4]
        x0 = min(max(0.0, min(p[0] for p in cs)), 1.0); x1 = max(min(1.0, max(p[0] for p in cs)), 0.0)
        y0 = min(max(0.0, min(p[1] for p in cs)), 1.0); y1 = max(min(1.0, max(p[1] for p in cs)), 0.0)
        if x1 - x0 < 0.05 or y1 - y0 < 0.05:
            continue
        shutil.copyfile(src, os.path.join(root, 'images', part, n + '.jpg'))
        kp = []
        for x, y in pts:
            kp += ['%.6f' % x, '%.6f' % y, '2'] if (0 <= x <= 1 and 0 <= y <= 1) else ['0', '0', '0']
        with open(os.path.join(root, 'labels', part, n + '.txt'), 'w') as f:
            f.write('0 %.6f %.6f %.6f %.6f %s\n' % ((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, ' '.join(kp)))
        counts[part] += 1
    with open(os.path.join(root, 'data.yaml'), 'w') as f:
        f.write('path: %s\ntrain: images/train\nval: images/%s\nkpt_shape: [%d, 3]\nnames:\n  0: field\n' % (root.replace('\\', '/'), 'val' if counts['val'] else 'train', FIELD_KP))
    return root, counts, sorted(held)

_FSTAT = {'at': 0, 'v': None}
def field_status():
    """For the window: streams marked, and the finder's state. Counted at most every 30 s."""
    if _FSTAT['v'] is None or time.time() - _FSTAT['at'] > 30:
        info = field_info()
        _FSTAT['v'] = {'streams': len(field_streams()), 'need': FIELD_START, 'ready': os.path.exists(field_file()),
                       'on': info.get('streams', 0), 'when': info.get('when', ''), 'corners': info.get('corners'), 'goals': info.get('goals')}
        _FSTAT['at'] = time.time()
    return _FSTAT['v']

def field_due():
    """Is it time to train the field finder (again)?"""
    n = len(field_streams())
    info = field_info()
    return n >= FIELD_START and (not info or n - int(info.get('streams', 0)) >= FIELD_EVERY)

class FieldFinder:
    """The trained field finder. find(frame) → (17 points as fractions, each
    point's confidence, the field's confidence) or None."""
    def __init__(self, path=None, prov=None):
        import onnxruntime as ort, numpy as np
        self.np = np
        have = ort.get_available_providers()
        prov = prov or [p for p in ('DmlExecutionProvider', 'CUDAExecutionProvider') if p in have] + ['CPUExecutionProvider']
        self.s = ort.InferenceSession(path or field_file(), providers=prov)
        self.inp = self.s.get_inputs()[0].name

    def find(self, frame):
        import cv2
        np = self.np
        H, W = frame.shape[:2]
        r = FIELD_SIZE / max(W, H)
        nw, nh = int(round(W * r)), int(round(H * r))
        px, py = (FIELD_SIZE - nw) // 2, (FIELD_SIZE - nh) // 2
        sq = np.full((FIELD_SIZE, FIELD_SIZE, 3), 114, np.uint8)
        sq[py:py + nh, px:px + nw] = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
        x = np.ascontiguousarray(sq[:, :, ::-1].transpose(2, 0, 1)[None]).astype(np.float32) / 255.0
        out = self.s.run(None, {self.inp: x})[0][0]           # (5 + 17*3, anchors)
        if out.shape[0] != 5 + 3 * FIELD_KP:
            return None
        j = int(np.argmax(out[4]))
        conf = float(out[4, j])
        k = out[5:, j].reshape(FIELD_KP, 3)
        pts = [[float((k[i, 0] - px) / r / W), float((k[i, 1] - py) / r / H)] for i in range(FIELD_KP)]
        return pts, [float(v) for v in k[:, 2]], conf

def do_field_finder(cfg, auto=False):
    """Train the field finder on every marked stream's saved frames.
    `auto`: started by itself after a field was saved; only with a graphics card."""
    streams = field_streams()
    if len(streams) < FIELD_START:
        say('The field finder is trained once the field is marked on %d streams with saved frames (%d so far).' % (FIELD_START, len(streams)))
        return
    if not ensure_training_tools():
        return
    import torch
    from ultralytics import YOLO
    gpu = torch.cuda.is_available()
    if auto and not gpu:
        say('The field finder is not trained by itself without a graphics card (it would take hours on the processor). Use "Train the field finder" when the computer is free.')
        return
    say('\nThe field finder: gathering frames of the %d marked streams…' % len(streams))
    ex = field_examples()
    root, counts, held = build_field_dataset(ex)
    if counts['train'] < 20:
        say('Only %d frames could be used (the camera could not be matched on the rest); mark the field on more streams.' % counts['train'])
        return
    say('  %d frames to learn from; %d held back to test it%s.' % (counts['train'], counts['val'], (' (from %d stream%s it never sees)' % (len(held), '' if len(held) == 1 else 's')) if held else ''))
    tag = 'f' + time.strftime('%y%m%d%H%M')
    runs = os.path.join(DIRS['build'], 'runs')
    rounds = int(cfg.get('field_rounds') or (FIELD_ROUNDS if gpu else 25))
    def each_round(trainer):
        progress('Training the field finder', int(getattr(trainer, 'epoch', 0)) + 1, rounds)
    model = newest_yolo(YOLO, 'yolo11n-pose.pt')
    try:
        model.add_callback('on_fit_epoch_end', each_round)
    except Exception:
        pass
    if not gpu:
        say('  No graphics card for training: a shorter run on the processor (slow; better with a card).')
    # No left-right flips: the corners are named by where they lie in the picture.
    model.train(data=os.path.join(root, 'data.yaml'), epochs=rounds, imgsz=FIELD_SIZE, batch=16 if gpu else 8, device=0 if gpu else 'cpu',
                workers=2, patience=20, project=runs, name=tag, exist_ok=True, verbose=False, plots=False,
                fliplr=0.0, mosaic=0.0, degrees=3, translate=0.15, scale=0.35, hsv_h=0.02, hsv_s=0.5, hsv_v=0.4)
    onnx_path = YOLO(os.path.join(runs, tag, 'weights', 'best.pt')).export(format='onnx', imgsz=FIELD_SIZE, opset=12, simplify=True, dynamic=False)
    import onnxruntime as ort
    shape = list(ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider']).get_outputs()[0].shape)
    if shape[:2] != [1, 5 + 3 * FIELD_KP]:
        say('The field finder came out in an unexpected shape (%s); not used.' % shape)
        return
    # How far off it is on the test frames, in % of the picture's width.
    err = field_error(onnx_path, [e for e in ex if os.path.exists(os.path.join(root, 'images', 'val', e[0] + '.jpg'))])
    tmp = field_file() + '.tmp'
    shutil.copyfile(onnx_path, tmp)
    os.replace(tmp, field_file())
    info = {'streams': len(streams), 'frames': counts['train'], 'test': counts['val'], 'held': held, 'when': time.strftime('%b %d, %H:%M'), 'tag': tag}
    if err:
        info.update(err)
    with open(os.path.join(DIRS['models'], 'field_finder.json'), 'w') as f:
        json.dump(info, f)
    say('The field finder is ready (trained on %d streams).%s Use "Find it for me" when marking a field.' % (
        len(streams), (' On frames it never trained on, its corners are off by %.1f%% of the picture\'s width and its goals by %.1f%%, on average.' % (err['corners'], err['goals'])) if err else ''))

def field_error(path, examples):
    """Average distance of its corners and goals from the marks, % of width."""
    import cv2
    if not examples:
        return None
    ff = FieldFinder(path, prov=['CPUExecutionProvider'])
    c, g = [], []
    for n, pts in examples[:200]:
        fr = cv2.imread(os.path.join(FRAMES, n + '.jpg'))
        got = ff.find(fr) if fr is not None else None
        if not got:
            continue
        H, W = fr.shape[:2]
        d = [math.hypot(a[0] - b[0], (a[1] - b[1]) * H / W) for a, b in zip(got[0], pts)]
        c += [v for v, p in zip(d[:4], pts[:4]) if 0 <= p[0] <= 1 and 0 <= p[1] <= 1]
        g += [v for v, p in zip(d[4:4 + N_GOALS], pts[4:4 + N_GOALS]) if 0 <= p[0] <= 1 and 0 <= p[1] <= 1]
    if not c:
        return None
    return {'corners': round(100 * sum(c) / len(c), 1), 'goals': round(100 * sum(g) / max(1, len(g)), 1)}

def trained_find_field(frame):
    """The field from the trained finder → {'q', 'spots', 'conf'} or None."""
    if not os.path.exists(field_file()):
        return None
    try:
        got = FieldFinder().find(frame)
    except Exception:
        return None
    if not got or got[2] < 0.3:
        return None
    pts, kc, conf = got
    q = [v for p in pts[:4] for v in p]
    first = first_spots(q)
    if not first:
        return None
    spots = [list(p) for p in first]
    for k in range(len(SPOTS)):
        x, y = pts[4 + k]
        if kc[4 + k] >= 0.5 and 0 <= x <= 1 and 0 <= y <= 1:
            spots[k] = [round(x, 4), round(y, 4)]
    return {'q': [round(v, 4) for v in q], 'spots': spots, 'conf': conf}

def find_field(cfg, name):
    """'Find it for me': the trained field finder first; the vision model if
    there is none yet (or it could not see the field). → {'pts', 'spots', 'how'} or {'error'}."""
    import cv2
    frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
    if frame is None:
        return {'error': 'no picture'}
    H, W = frame.shape[:2]
    t = trained_find_field(frame)
    if t:
        q = t['q']
        return {'pts': [[q[i] * W, q[i + 1] * H] for i in range(0, 8, 2)], 'spots': t['spots'], 'how': 'field finder'}
    n = len(field_streams())
    have = os.path.exists(field_file())
    if cfg.get('think'):
        v = vlm_find_field(cfg, name)
        if v.get('pts'):
            v['how'] = 'vision model'
            return v
        if not have:
            v['error'] = (v.get('error') or '') + (' The field finder learns from your marks: it is trained once %d streams are marked (%d so far).' % (FIELD_START, n))
        return v
    if have:
        return {'error': 'The field finder could not see the field in this picture. Try a frame showing the whole field, or click the corners yourself.'}
    return {'error': 'The field finder learns from your marks: it is trained once the field is marked on %d streams (%d so far). Until then, click the four corners.' % (FIELD_START, n)}

def vlm_find_field(cfg, name):
    """The field's corners, goals and loaders on one saved frame, as the
    model sees them, for the person to check. → {'pts': 4 × [x, y] pixels,
    'spots': 13 × [x, y] fractions} or {'error'}."""
    import cv2
    if not ensure_think(cfg):
        return {'error': 'Turn on the vision model in Settings first (it is fetched once).'}
    frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
    if frame is None:
        return {'error': 'no picture'}
    H, W = frame.shape[:2]
    ph = int(round(H * 1280 / W))
    ok_, buf = cv2.imencode('.jpg', cv2.resize(frame, (1280, ph)), [cv2.IMWRITE_JPEG_QUALITY, 92])
    prompt = ('One frame of a VEX V5 Robotics Competition match (the game Override): a square field of grey foam tiles inside low white walls. '
              'Give, as [x, y] points with x and y from 0 to 1000 across and down the whole picture:\n'
              '- corners: the four corners of the field floor, where the walls meet the floor (all four, even if one must be estimated);\n'
              '- goals: the bottom centre of each goal standing on the floor (cone-shaped stands that pins are stacked on; there are nine);\n'
              '- loaders: the bottom of each match loader (holders at the corners by the walls; there are four).\n'
              'Leave out what you cannot see. Never give a robot or a person.')
    pt = {'type': 'array', 'minItems': 2, 'maxItems': 2, 'items': {'type': 'number'}}
    schema = {'type': 'object', 'required': ['corners', 'goals', 'loaders'], 'properties': {
        'corners': {'type': 'array', 'minItems': 4, 'maxItems': 4, 'items': pt},
        'goals': {'type': 'array', 'maxItems': 9, 'items': pt}, 'loaders': {'type': 'array', 'maxItems': 4, 'items': pt}}}
    got = vlm_ask(cfg, prompt, schema, buf.tobytes(), 500)
    if not got:
        return {'error': 'The vision model did not answer. Is Ollama running?'}
    corners = [vlm_point(c, 1280, ph) for c in got.get('corners') or []]
    corners = [c for c in corners if c]
    if len(corners) != 4:
        return {'error': 'It could not find the four corners. Click them yourself.'}
    q = [v for c in corners for v in c]
    first = first_spots(q)
    if not first:
        return {'error': 'Its corners do not make a field. Click them yourself.'}
    spots = [list(p) for p in first]
    # Each slot takes the nearest point the model gave, nearest pairs first.
    for lo, hi, key in ((0, N_GOALS, 'goals'), (N_GOALS, len(SPOTS), 'loaders')):
        found = [p for p in (vlm_point(g, 1280, ph) for g in got.get(key) or []) if p]
        pairs = sorted((math.hypot(f[0] - spots[k][0], f[1] - spots[k][1]), k, j) for k in range(lo, hi) for j, f in enumerate(found))
        used_k, used_j = set(), set()
        for d, k, j in pairs:
            if k in used_k or j in used_j or d > 0.15:
                continue
            used_k.add(k); used_j.add(j)
            spots[k] = [round(found[j][0], 4), round(found[j][1], 4)]
    return {'pts': [[c[0] * W, c[1] * H] for c in corners], 'spots': spots}

# ── a robot's look, learned from plate reads (v2.44) ──────────────────────
# A pretrained image model (YOLO11's classifier, trained on millions of
# photos) turns a robot's picture into an appearance fingerprint; the website
# learns each team's fingerprint, at each event, from the matches where its
# plate was read, and uses it to tell robots apart where no plate was. Plates
# still settle a match; a fingerprint that looks like the crowd names nobody.
# EMBED_DIMS numbers a robot a look (a fixed random projection of the
# model's 1280, kept as whole numbers −100..100).
EMBED_DIMS, EMBED_EVERY = 24, 2.0

def embed_file():
    return os.path.join(DIRS['models'], 'embed.onnx')

def ensure_embedder():
    """Make the fingerprint model once (needs the training tools: PyTorch).
    → True if it is there."""
    if os.path.exists(embed_file()):
        return True
    try:
        import torch
        from ultralytics import YOLO
    except Exception:
        return False
    try:
        cls = YOLO('yolo11n-cls.pt').model.eval()
        layers = list(cls.model)
        head = layers[-1]
        class Body(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.body = torch.nn.Sequential(*layers[:-1])
                self.conv, self.pool = head.conv, head.pool
            def forward(self, x):
                return torch.flatten(self.pool(self.conv(self.body(x))), 1)
        net = Body().eval()
        tmp = embed_file() + '.tmp'
        args = dict(input_names=['x'], output_names=['f'], opset_version=12, dynamic_axes={'x': {0: 'n'}, 'f': {0: 'n'}})
        try:
            torch.onnx.export(net, torch.zeros(1, 3, 224, 224), tmp, dynamo=False, **args)   # the plain exporter: needs nothing more
        except TypeError:
            torch.onnx.export(net, torch.zeros(1, 3, 224, 224), tmp, **args)                # an older PyTorch: it is the only one
        os.replace(tmp, embed_file())
        return True
    except Exception as e:
        say('  the fingerprint model could not be made (%s); robots are told apart by colour alone.' % str(e)[:100])
        return False

class Embedder:
    """A robot's picture → EMBED_DIMS whole numbers (its fingerprint)."""
    def __init__(self, path=None):
        import onnxruntime as ort, numpy as np
        self.np = np
        self.sess = ort.InferenceSession(path or embed_file(), providers=[p for p in ('CUDAExecutionProvider', 'DmlExecutionProvider', 'CPUExecutionProvider') if p in ort.get_available_providers()])
        self.inp = self.sess.get_inputs()[0].name
        dims = self.sess.get_outputs()[0].shape[-1]
        self.proj = np.random.default_rng(1234).normal(size=(int(dims) if isinstance(dims, int) else 1280, EMBED_DIMS)).astype(np.float32)

    def __call__(self, frame, boxes):
        import cv2
        np = self.np
        H, W = frame.shape[:2]
        crops = []
        for b in boxes:
            x, y, w, h = b[:4]
            x0, y0, x1, y1 = int(max(0, x - 0.08 * w)), int(max(0, y - 0.08 * h)), int(min(W, x + 1.08 * w)), int(min(H, y + 1.08 * h))
            c = frame[y0:y1, x0:x1]
            if c.size == 0:
                c = np.zeros((8, 8, 3), np.uint8)
            crops.append(cv2.resize(cv2.cvtColor(c, cv2.COLOR_BGR2RGB), (224, 224), interpolation=cv2.INTER_AREA))
        if not crops:
            return []
        x = np.stack(crops).astype(np.float32).transpose(0, 3, 1, 2) / 255.0
        f = self.sess.run(None, {self.inp: x})[0].reshape(len(crops), -1)
        f /= np.linalg.norm(f, axis=1, keepdims=True) + 1e-9
        e = f @ self.proj
        e /= np.linalg.norm(e, axis=1, keepdims=True) + 1e-9
        return [[int(round(v * 100)) for v in row] for row in e]

def make_follow(video, quad, t):
    """A CamFollow for one video: from the picture the field was marked on
    (`t`, seconds into the stream, saved by the website from v149), or, for a
    mark saved before then, from the first clear look of the first match."""
    try:
        f = CamFollow(quad)
    except Exception:
        return None
    if isinstance(t, (int, float)) and t >= 0:
        try:
            fr = video.frame_at(float(t))
            if fr is not None:
                f.set_ref(fr)
        except Exception:
            pass
    return f

def work_chunk(args):
    """One worker: a run of consecutive matches from one video."""
    global _EYES, _SHARE
    cfg, ev, path, jobs, spacing = args[:5]
    _SHARE = args[5] if len(args) > 5 else None
    site = Site(cfg)
    if _EYES is None:
        _EYES = Eyes(quiet=True, threads=max(1, (os.cpu_count() or 8) // max(1, int(cfg.get('workers', 4)))))
        _EYES.embed = None
        if cfg.get('fingerprints', True) and os.path.exists(embed_file()):
            try:
                _EYES.embed = Embedder()
            except Exception:
                _EYES.embed = None
    video = Video(path, hw=bool(cfg.get('hw_decode', True)))
    out, shift, learn = [], 0, {}
    quads = {}                                        # the field's corners for each video, as marked on the website
    follows = {}                                      # and the camera, followed from the picture they were marked on
    from concurrent.futures import ThreadPoolExecutor
    behind, pending = ThreadPoolExecutor(max_workers=1), []

    def finish(job, rec, why, sec, hw, spent=None):
        spent = dict(spent or {})
        try:
            saved = None
            if rec is not None:
                shots = trim_shots(rec, rec.pop('_shots', []))
                cam = rec.pop('_cam', None)
                if shots:
                    t0 = time.perf_counter()
                    try:
                        think_match(rec, shots, job, cfg)
                    except Exception:
                        pass
                    spent['vision model'] = time.perf_counter() - t0
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
            return {'id': job['id'], 'name': job.get('name'), 'ok': bool(saved), 'why': why, 'sec': sec, 'hw': hw, 'spent': spent, 'det': getattr(_EYES, 'backend', ''),
                    'looks': len(rec['f']) if rec else 0, 'plates': plates, 'pins': pins, 'clock': len(rec['tm']) // 2 if rec else 0, 'think': len(rec.get('vo', [])) // 5 if rec else 0, 'cam': cam if rec else None}
        except Exception as e:
            return {'id': job['id'], 'name': job.get('name'), 'ok': False, 'why': 'error: ' + str(e), 'sec': sec, 'hw': hw, 'spent': spent, 'looks': 0, 'plates': 0, 'pins': 0, 'clock': 0, 'think': 0}

    try:
        for job in jobs:
            t0 = time.time()
            try:
                if job['vid'] not in quads:
                    fld = (site.get('?field=' + job['vid']) or {}).get('field') or {}
                    q = fld.get('q')
                    quads[job['vid']] = q if isinstance(q, list) and len(q) == 8 else None
                    if quads[job['vid']] and isinstance(fld.get('k'), (int, float)) and isinstance(fld.get('ka'), (int, float)):
                        quads[job['vid']] = with_lens(quads[job['vid']], fld['k'], fld['ka'])
                    _QUADS[job['vid']] = {'q': quads[job['vid']], 'g': fld.get('g'), 'l': fld.get('l'), 't': fld.get('t'), 'at': time.time()}
                    follows[job['vid']] = make_follow(video, quads[job['vid']], fld.get('t')) if quads[job['vid']] and cfg.get('follow', True) else None
                    # The lens, once a stream, from the picture the field was marked on (v2.43).
                    if quads[job['vid']] and not lens_of(quads[job['vid']]) and isinstance(fld.get('t'), (int, float)) and cfg.get('lens', True):
                        try:
                            pic = video.frame_at(float(fld['t']))
                            k, gain = estimate_lens(pic, quads[job['vid']]) if pic is not None else (0.0, 0.0)
                            if k:
                                quads[job['vid']] = with_lens(quads[job['vid']], k, pic.shape[0] / pic.shape[1])
                                if follows.get(job['vid']):
                                    follows[job['vid']].quad = quads[job['vid']]
                                lens_save(cfg, job['vid'], fld, k, pic.shape[0] / pic.shape[1])
                                say('  the camera lens on this stream bends the field; straightened (k %.3f, edges %d%% straighter).' % (k, round(100 * gain)))
                        except Exception as e:
                            say('  could not work out the lens (%s)' % e)
                looks = int(cfg.get('think_looks') or THINK_LOOKS) if cfg.get('think') and cfg.get('_think_ok') else 0
                _TIME.clear()
                rec, why, shift = track_match(video, _EYES, job, shift, spacing, True, learn, quads[job['vid']], looks, follows.get(job['vid']))
            except Exception as e:
                rec, why = None, 'error: ' + str(e)
            share_set(job.get('id'), 1.0)
            # Asking the vision model and sending the recording do not need the
            # video or the finder, so they go on behind while the next match is
            # tracked: the model's twenty seconds a match cost no time at all.
            spent = dict(_TIME)
            spent['other'] = max(0.0, (time.time() - t0) - sum(spent.values()))
            pending.append(behind.submit(finish, job, rec, why, time.time() - t0, video.hw, spent))
        out = [p.result() for p in pending]
    finally:
        video.close()
        behind.shutdown(wait=True)
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
    # v2.49: "Sharper pin counting" downloads 1080p where there is one. Far
    # pins are a few pixels tall at 720p; robots are found as well either way
    # (every picture is shrunk for that), so it only costs download size and
    # a little decoding.
    hp = 1080 if load_config().get('sharp') else 720
    opts = {'format': 'bv*[height<=%d][fps<=30][vcodec^=avc1]/bv*[height<=%d][fps<=30]/bv*[height<=%d]/b[height<=%d]/b' % (hp, hp, hp, hp),
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
    totals = {'ok': 0, 'no': 0, 'plates': 0, 'clock': 0, 'looks': 0, 'think': 0}
    # The vision model, when it is switched on: got ready once, here, so each match can ask it.
    fresh = load_config()                             # the switch may have been turned since this started
    for k in ('think', 'think_model', 'think_looks'):
        cfg[k] = fresh.get(k)
    cfg['_think_ok'] = bool(cfg.get('think')) and ensure_think(cfg)
    if cfg.get('think') and not cfg['_think_ok']:
        say('Tracking without the vision model this time.')
    t_all = time.time()
    # The next video is fetched while this one is being tracked: downloading
    # uses the network and tracking the processor and graphics card, so neither
    # waits for the other.
    order = sorted(todo.items(), key=lambda kv: -len(kv[1]))
    fetched = {}
    def windows_of(vid):
        # Each match with room either side: the Jumper's place for it can be a minute or two out.
        ws = sorted((max(0, j['off'] - 120), j['off'] + WINDOW_WIDE + 120) for _, j in todo[vid])
        # And the few seconds the field was marked on, to follow the camera from.
        try:
            quad_for(vid, site)
            mt = (_QUADS.get(vid) or {}).get('t') if isinstance(_QUADS.get(vid), dict) else None
            if isinstance(mt, (int, float)) and mt >= 0:
                ws = sorted(ws + [(max(0, mt - 3), mt + 3)])
        except Exception:
            pass
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
    # One bar for the whole job (v2.34): matches, counted in fractions as each
    # worker gets through each one; a video coming down is named under it.
    import multiprocessing
    mgr = multiprocessing.Manager()
    share = mgr.dict()
    _PROG['all'] = ('Tracking matches', 0, left)
    def job_bar(sub=''):
        _PROG['all'] = ('Tracking matches', done_all, left)
        dl = _PROG.get('dl') or ''
        progress('Tracking matches', done_all, left, sub=' · '.join(x for x in (sub, ('next video: ' + dl) if dl and _PROG['hold'] else dl) if x))
    job_bar('Getting the first video')
    # v2.46: one pool of workers for the whole job. Each video's matches used
    # to be shared out and the next video waited until the slowest worker
    # finished, so at the end of every video most workers sat idle; and a
    # video with few matches kept only one or two of them busy. Now the next
    # video's matches are handed out as soon as workers are about to run out
    # of work, so they never wait for each other.
    spent_all = {}
    from concurrent.futures import wait as fwait, FIRST_COMPLETED
    pool = ProcessPoolExecutor(max_workers=workers)
    inflight, vids, done, cur_sub = {}, {}, 0, ['']
    def collect(timeout):
        nonlocal done_all, done
        if not inflight:
            return
        ready, _ = fwait(set(inflight), timeout=timeout, return_when=FIRST_COMPLETED)
        try:
            part = sum(share.values())
        except Exception:
            part = 0
        done_all = max(done_all, min(left - 0.01, part))
        job_bar(cur_sub[0] + (' (and %d before it)' % (len(set(inflight.values())) - 1) if len(set(inflight.values())) > 1 else ''))
        for fut in ready:
            vid = inflight.pop(fut)
            V = vids[vid]
            V['chunks'] -= 1
            try:
                results = fut.result()
            except Exception as e:
                say('  a worker stopped:', str(e)[:200])
                results = []
            for res in results:
                done += 1
                totals['ok' if res['ok'] else 'no'] += 1
                totals['plates'] += res['plates']
                totals['clock'] += res['clock']
                totals['looks'] += res['looks']
                totals['think'] += res.get('think', 0)
                totals['hw'] = totals.get('hw') or res.get('hw')
                totals['gpu'] = totals.get('gpu') or res.get('det') not in (None, '', 'CPU')
                for k, v in (res.get('spent') or {}).items():
                    spent_all[k] = spent_all.get(k, 0.0) + v
                say('  %3d/%d  %-22s %s' % (done, left, str(res['name'])[:22],
                    ('saved · %d looks · %d plates · %d pin sightings · clock %d%s · %.0fs' % (res['looks'], res['plates'], res.get('pins', 0), res['clock'], (' · vision model: %d robot looks' % res['think']) if cfg.get('_think_ok') else '', res['sec']) + cam_note(res.get('cam'))) if res['ok'] else 'not saved: ' + res['why']))
            if V['chunks'] == 0:
                say('  video %s finished.' % vid)
                path = V['path']
                if not cfg.get('keep_videos') and path.startswith(DIRS['videos']):
                    for junk in (path, path + '.have.json'):
                        try:
                            os.remove(junk)
                        except OSError:
                            pass
    try:
        for n, (vid, pairs) in enumerate(order, 1):
            # Enough work queued for every worker: let some finish first.
            while len(inflight) >= workers * 2:
                collect(1.5)
            _PROG['hold'] = bool(inflight)
            say('\nVideo %d of %d (%s): %d matches' % (n, len(order), vid, len(pairs)))
            if ahead and ahead[0] == vid:
                while ahead[1].is_alive():
                    ahead[1].join(1.5)
                    collect(0)
            else:
                say('  getting the video…')
                th = threading.Thread(target=fetch, args=(vid,), daemon=True)
                th.start()
                while th.is_alive():
                    th.join(1.5)
                    collect(0)
            path = fetched.get(vid)
            ahead = None
            if n < len(order):
                nxt = order[n][0]
                ahead = (nxt, threading.Thread(target=fetch, args=(nxt,), daemon=True))
                ahead[1].start()
            if not path or not os.path.exists(path):
                say('  no video, skipped. If you have the file, choose "Use a video file I already have" and point it at this stream.')
                totals['no'] += len(pairs)
                for _, j in pairs:
                    share[str(j['id'])] = 1.0
                continue
            by_ev = {}
            for ev, j in pairs:
                by_ev.setdefault(ev, []).append(j)
            chunks = []
            for ev, jobs in by_ev.items():
                jobs.sort(key=lambda j: j['off'])
                sp = spacing_of(jobs)
                # Runs of two or more (a run finds each next match from the
                # last), small enough that every worker gets some.
                size = max(2, math.ceil(len(jobs) / workers))
                for i in range(0, len(jobs), size):
                    chunks.append((cfg, ev, path, jobs[i:i + size], sp, share))
            vids[vid] = {'chunks': len(chunks), 'path': path}
            cur_sub[0] = 'Video %d of %d' % (n, len(order))
            job_bar(cur_sub[0])
            for c in chunks:
                inflight[pool.submit(work_chunk, c)] = vid
            _PROG['hold'] = True
        while inflight:
            collect(1.5)
    finally:
        pool.shutdown(wait=True)
        _PROG['hold'] = False
    done_all = left
    job_bar('')
    if spent_all:
        tot = sum(spent_all.values()) or 1
        say('\nWhere the time went (all workers together): ' + ', '.join('%s %d%%' % (k, round(100 * v / tot)) for k, v in sorted(spent_all.items(), key=lambda kv: -kv[1]) if v / tot >= 0.02) + '.')
        _LAST_SPENT.clear(); _LAST_SPENT.update({k: round(v / tot, 3) for k, v in spent_all.items()})
        if spent_all.get('vision model', 0) / tot > 0.3:
            say('The vision model took the most time. It is only asked about every picture where plates did not settle who is who; to go faster still, turn it off in Settings.')
        elif spent_all.get('robots', 0) / tot > 0.4 and not totals.get('gpu'):
            say('Finding robots took the most time, and it ran on the processor. On a graphics card it is several times faster: check that the graphics card driver is up to date, then start the app again.')
    mins = (time.time() - t_all) / 60
    _PROG['all'], _PROG['dl'] = None, ''
    try:
        mgr.shutdown()
    except Exception:
        pass
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
 boxes=cur.boxes.map(b=>b.slice(0,4));hist=[];img=new Image();img.onload=()=>{c.width=img.naturalWidth||cur.w;c.height=img.naturalHeight||cur.h;draw()};img.src='/img/'+cur.id+'.jpg';}
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

_SURE = [0]           # frames the last count left out because the finder was plainly sure of them
# Frames a person must review before the robot finder trains (v2.45: 100, was
# 150, now that frames the finder was sure of are no longer asked about; they
# and the vision model's labels train it too, and grading stays on these).
TRAIN_MIN = 100

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
    _SURE[0] = 0
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
        if p.get('auto'):                             # kept only to train on: nothing to ask
            continue
        # v2.45: a frame the finder was plainly sure of is not asked about
        # (reported: "why does it have me review so many frames still?"):
        # nothing it doubted, every box confident, one to six robots, the
        # tracker not unsure of it, the vision model not against it. Training
        # already uses such frames by themselves.
        sure_boxes = [b for b in p.get('boxes', []) if b[4] >= 0.35]
        if (not p.get('hard', 0) and p.get('steady', 1) != 0 and 1 <= len(sure_boxes) <= 6 and all(b[4] >= 0.6 for b in sure_boxes)
                and not (p.get('vlm') and not vlm_verdict(p['vlm'])[1])):
            _SURE[0] += 1
            continue
        # The vision model disagreed with the finder here: the most to teach, first.
        todo.append((-p.get('hard', 0) - (100 if p.get('vlm') and not vlm_verdict(p['vlm'])[1] else 0), hashlib.md5(name.encode()).hexdigest(), name, vid, layout_of(p)))
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
def reviewed(vlm=False):
    """Frames a person reviewed (or, with vlm=True, the ones the vision model
    labelled where it and the finder agreed: trained on, never graded on)."""
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
        if lab.get('skip') or not os.path.exists(os.path.join(FRAMES, name + '.jpg')) or (lab.get('by') == 'vlm') != vlm:
            continue
        out.append((name, p['w'], p['h'], lab.get('boxes', [])))
    return out

# ── pins and cups ─────────────────────────────────────────────────────────
# Asked: "how can i make it recognize pin and cups?", then "build it". Pins
# were found by colour alone (patches of red, blue or yellow), which cannot
# tell two touching pins apart, misses a pin in shadow and cannot see a cup at
# all (clear and black). So the owner marks them, like the robots: the review
# screen has a second job, "Pins & cups", where the colour finder's guesses
# are drawn already and he fixes them. From 60 marked frames a second finder
# is trained (one half of a pin is one box, coloured red, blue or yellow; a
# cup is one box). It replaces the colour finder only when it beats it on
# marked frames neither trained on. Its boxes go into the recording in the
# same shape the colour finder's did, so the website counts pins as before;
# cups are recorded as well (`cu`).
PIECE_NAMES = ('red half', 'blue half', 'yellow half', 'cup')
PIECE_SIZE, PIECE_NEED, PIECE_CONF = 320, 60, 0.35

# v2.22. The owner: "it doesnt need to track stuff on the field only in the
# goals for pin and cups. maybe matchloader too to count matchload speeds."
# So pins and cups are looked for only in a few fixed SPOTS: a column standing
# on each of the nine goals and one over each corner's loader. Each spot is
# cut out of the frame and enlarged, so a pin a few pixels wide in the wide
# shot fills a good part of the picture the finder sees. The spots are where
# the field mark puts them, in the marked square (u, v from 0 to 1). The goal
# layout looks the same turned a quarter, so which goal is red's is left to
# the website, which knows which way round the field is.
SPOTS = [  # u, v, half-width, height above, depth below (field widths)
    # Where the manual's drawing puts them. On a real stream the corners put
    # them near, not on, the goals; the website asks for each to be dragged
    # onto its goal (v141), and then the dragged foot is used (`placed`).
    # Tall enough for a full stack seen from the far end (owner's Excalibur frame).
    # v2.39: wide enough for a stack that leans (the camera tilts tall things,
    # robots push them); what counts is decided by `stacked`, not the box.
    (0.17, 0.66, 0.11, 0.30, 0.03), (0.34, 0.82, 0.11, 0.30, 0.03), (0.66, 0.18, 0.11, 0.30, 0.03), (0.82, 0.34, 0.11, 0.30, 0.03),
    (0.34, 0.18, 0.11, 0.30, 0.03), (0.18, 0.34, 0.11, 0.30, 0.03), (0.66, 0.82, 0.11, 0.30, 0.03), (0.82, 0.66, 0.11, 0.30, 0.03),
    (0.5, 0.5, 0.12, 0.38, 0.03),
    # The loaders: placed by hand; until then, the corners. A loader is small:
    # about 10 in wide and 21 in tall around where it stands (v2.39; they were
    # 2.4 ft by 4 ft, reported: "why are matchload boxes so ridiculously huge").
    (0.02, 0.02, 0.035, 0.12, 0.025), (0.98, 0.02, 0.035, 0.12, 0.025), (0.98, 0.98, 0.035, 0.12, 0.025), (0.02, 0.98, 0.035, 0.12, 0.025)]
N_GOALS = 9

def spot_boxes(W, H, q, placed=None):
    """Each spot's box in a W×H picture: [x0, y0, x1, y1] in pixels, or None
    when it falls off the picture. `placed`: where the goals (g) and loaders
    (l) really are, dragged into place on the website (v141); the corners
    alone put them near, not on, the real ones."""
    fwd = quad_fwd(q) if q else None
    if not fwd:
        return None
    aspect = W / H
    out = []
    pts = None
    if placed and isinstance(placed.get('g'), list) and len(placed['g']) == 18:
        pts = [placed['g'][i:i + 2] for i in range(0, 18, 2)]
        pts += [placed['l'][i:i + 2] for i in range(0, 8, 2)] if isinstance(placed.get('l'), list) and len(placed['l']) == 8 else [None] * 4
    for k, (u, v, hw, up, down) in enumerate(SPOTS):
        M, A, B = fwd(u, v), fwd(u + 0.02, v), fwd(u, v + 0.02)
        scale = max(math.hypot(A[0] - M[0], (A[1] - M[1]) / aspect), math.hypot(B[0] - M[0], (B[1] - M[1]) / aspect)) / 0.02
        if pts and pts[k]:
            M = pts[k]
        x0, x1 = (M[0] - hw * scale) * W, (M[0] + hw * scale) * W
        y0, y1 = (M[1] - up * scale * aspect) * H, (M[1] + down * scale * aspect) * H
        x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(W, int(math.ceil(x1))), min(H, int(math.ceil(y1)))
        out.append([x0, y0, x1, y1] if x1 - x0 >= 6 and y1 - y0 >= 6 else None)
    return out

def spot_units(W, H, q):
    """Pixels per field width at each spot's foot: how big a pin or cup there looks."""
    fwd = quad_fwd(q) if q else None
    if not fwd:
        return None
    aspect = W / H
    out = []
    for u, v, *_ in SPOTS:
        M, A, B = fwd(u, v), fwd(u + 0.02, v), fwd(u, v + 0.02)
        out.append(round(max(math.hypot(A[0] - M[0], (A[1] - M[1]) / aspect), math.hypot(B[0] - M[0], (B[1] - M[1]) / aspect)) / 0.02 * W, 1))
    return out

COLUMN = 0.44          # a goal's column: this share of its spot's width, centred on the goal (v2.37)

def spot_column(k, sb):
    """Where a piece must be to be ON goal k (v2.37): in the goal's own column
    (centred on its foot, a little wider than a pin) and standing on or above
    its base, not lying on the floor beside or in front of it. Reported:
    "its automatically marking ones on the loose field though, make it so i
    only have to mark towers and loaders". → (x0, x1, base y) or None for a
    loader (a loader is its whole box)."""
    if k >= N_GOALS or not sb:
        return None
    x0, y0, x1, y1 = sb
    mid, half = (x0 + x1) / 2, COLUMN * (x1 - x0) / 2
    up, down = SPOTS[k][3], SPOTS[k][4]
    base = y1 - down / (up + down) * (y1 - y0)
    return (mid - half, mid + half, base + 0.04 * (y1 - y0))

def spot_foot_px(k, sb):
    """Where spot k's goal or loader stands, in pixels, and pixels per field
    width there (from the box, which is centred on the foot)."""
    hw, up, down = SPOTS[k][2], SPOTS[k][3], SPOTS[k][4]
    x0, y0, x1, y1 = sb
    return (x0 + x1) / 2, y1 - down / (up + down) * (y1 - y0), (x1 - x0) / (2 * hw)

def stacked(pieces, k, sb):
    """Of the pieces in spot k, the ones on its goal (v2.39): the ones touching
    the goal's base, and then any touching one already counted, so a stack is
    followed however it leans. Loose pieces lie apart and are left out. A
    loader keeps everything in its box. Reported, with a picture of a leaning
    stack outside its column: "not gonna work"."""
    inside = [b for b in pieces if sb and sb[0] <= b[0] + b[2] / 2 <= sb[2] and sb[1] <= b[1] + b[3] / 2 <= sb[3]]
    if k >= N_GOALS:
        return inside
    fx, fy, u = spot_foot_px(k, sb)
    gap = 0.025 * u                                     # about 3.5 in: touching, give or take the box
    near = lambda a, b: a[0] - gap <= b[0] + b[2] and b[0] - gap <= a[0] + a[2] and a[1] - gap <= b[1] + b[3] and b[1] - gap <= a[1] + a[3]
    base = [fx - 0.045 * u, fy - 0.06 * u, 0.09 * u, 0.09 * u]
    got, todo = [], list(inside)
    grew = True
    while grew:
        grew = False
        for b in list(todo):
            if near(b, base) or any(near(b, g) for g in got):
                got.append(b); todo.remove(b); grew = True
    return got

def keep_stacked(pieces, spots):
    """All the pieces on goals or in loaders, from boxes anywhere in the picture."""
    out, seen = [], set()
    for k, sb in enumerate(spots or []):
        if not sb:
            continue
        for b in stacked(pieces, k, sb):
            if id(b) not in seen:
                seen.add(id(b)); out.append(b)
    return out

def on_spot(b, k, sb):
    """Is box b ([x, y, w, h, …]) a piece on spot k: on the goal (its column,
    not below its base), or anywhere over the loader?"""
    if not sb:
        return False
    cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
    if not (sb[0] <= cx <= sb[2] and sb[1] <= cy <= sb[3]):
        return False
    col = spot_column(k, sb)
    return col is None or (col[0] <= cx <= col[1] and b[1] + b[3] <= col[2])

_FOLLOW = {}
def refs_file():
    return os.path.join(DIRS['data'], 'fieldrefs.json')

def field_ref(vid):
    """The saved frame a stream's field was marked on in the app, while that
    mark is still the stream's mark: {'id', 'q'} or None."""
    try:
        with open(refs_file()) as f:
            r = json.load(f).get(vid)
    except Exception:
        return None
    q = quad_for(vid)
    if not r or not q or [round(v, 3) for v in r.get('q', [])] != [round(v, 3) for v in q[:8]]:
        return None
    return r if os.path.exists(os.path.join(FRAMES, r['id'] + '.jpg')) else None

def frame_geom(name, frame=None):
    """The field mark as it sits in one saved frame: (q, placed, W, H), the
    camera followed from the picture the field was marked on in the app; or
    None (no mark, no picture, or not that view)."""
    import cv2
    vid = name.rsplit('_', 1)[0]
    q = quad_for(vid)
    if q is None:
        return None
    placed = placed_for(vid)
    if frame is None:
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
    if frame is None:
        return None
    H, W = frame.shape[:2]
    ref = field_ref(vid)
    if ref and ref['id'] != name:
        f = _FOLLOW.get(vid)
        if not f or f[0] != ref['id']:
            cf = CamFollow(q)
            pic = cv2.imread(os.path.join(FRAMES, ref['id'] + '.jpg'))
            ok_ = pic is not None and cf.set_ref(pic)
            f = _FOLLOW[vid] = (ref['id'], cf if ok_ else None)
        if f[1] is not None:
            Hm = f[1].look(frame)
            if Hm is None:
                return None
            q, placed = f[1].quad_now(Hm), f[1].placed_now(placed, Hm)
    return q, placed, W, H

def spot_foot(k, sb, W, H):
    """Where a spot box stands (its goal's or loader's foot), as picture fractions."""
    up, down = SPOTS[k][3], SPOTS[k][4]
    return [round(((sb[0] + sb[2]) / 2) / W, 4), round((sb[3] - down / (up + down) * (sb[3] - sb[1])) / H, 4)]

def move_spots(cfg, body):
    """Goals and loaders dragged into place on one frame (v2.38). Asked: "make
    it so box sizes are set and i can drag the box over where it should be".
    Saved as the stream's field mark, on this picture, so every other frame
    follows the camera from it. → (ok, why not)."""
    name = str(body.get('id', ''))
    if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
        return False, 'bad frame'
    geo = frame_geom(name)
    if not geo:
        return False, 'the field is not marked for this stream yet'
    q, placed, W, H = geo
    feet = [list(p) for p in (first_spots(q) or [])]
    if placed and isinstance(placed.get('g'), list) and len(placed['g']) == 18:
        for k in range(9):
            feet[k] = placed['g'][2 * k:2 * k + 2]
    if placed and isinstance(placed.get('l'), list) and len(placed['l']) == 8:
        for k in range(4):
            feet[9 + k] = placed['l'][2 * k:2 * k + 2]
    for row in body.get('spots') or []:
        try:
            k, x0, y0, x1, y1 = int(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4])
        except (TypeError, ValueError, IndexError):
            continue
        if 0 <= k < len(SPOTS) and x1 > x0 and y1 > y0:
            feet[k] = spot_foot(k, [x0, y0, x1, y1], W, H)
    if len(feet) != len(SPOTS):
        return False, 'the field mark is not usable'
    return save_field(cfg, {'vid': name.rsplit('_', 1)[0], 'id': name, 'q': q, 'g': [v for p in feet[:9] for v in p], 'l': [v for p in feet[9:] for v in p],
                            't': (json.load(open(os.path.join(PROPS, name + '.json'))) if os.path.exists(os.path.join(PROPS, name + '.json')) else {}).get('t')})

def frame_spots(name, frame=None, W=None, H=None):
    """The goals and loaders in one saved frame (v2.37). The field is marked
    on one picture; the camera of a stream pans and zooms, and boxes drawn
    from the mark alone land off the goals on frames from other moments
    (reported, with a picture: "yellow boxes also arent correct"). When the
    field was marked on a saved frame here, every other frame of the stream
    is matched to that picture (as tracking follows the camera) and the mark
    moved with it. → spot boxes, or [] (no mark, or not this view)."""
    geo = frame_geom(name, frame)
    if not geo:
        return []                                       # no mark, or not the view the field was marked on
    q, placed, W, H = geo
    return spot_boxes(W, H, q, placed) or []

def on_spots(b, boxes):
    """→ the spot box b is a piece on, or -1."""
    for k, sb in enumerate(boxes or []):
        if on_spot(b, k, sb):
            return k
    return -1

def in_spots(b, boxes):
    """Is a box's middle inside one of the spots? → that spot's index, or -1."""
    cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
    for k, s in enumerate(boxes or []):
        if s and s[0] <= cx <= s[2] and s[1] <= cy <= s[3]:
            return k
    return -1

_QUADS, _QUADS_LOADED = {}, []
def placed_for(vid):
    """The goals and loaders as dragged into place on the website, or None."""
    f = _QUADS.get(vid)
    return f if isinstance(f, dict) and f.get('g') else None

def quad_for(vid, site=None):
    """The field mark of a video, as the website has it (kept on disk once fetched).

    v2.27: a video with no mark is remembered as having none, for ten minutes,
    like one with a mark. It used to be asked about again every time, once for
    each saved frame of it, and the window's status check did that every
    second, so the checks piled up and the window stopped answering clicks
    (reported: "the app is kind of frozen i cant really click into settings")."""
    path = os.path.join(DIRS['data'], 'quads.json')
    if not _QUADS_LOADED:
        _QUADS_LOADED.append(1)
        try:
            with open(path) as f:
                _QUADS.update(json.load(f))
        except Exception:
            pass
    f = _QUADS.get(vid, 0)
    have = f.get('q') if isinstance(f, dict) else (f if isinstance(f, list) else None)
    fresh = isinstance(f, dict) and time.time() - f.get('at', 0) < 600
    if site is None or fresh:
        return have
    try:
        r = site.get('?field=' + vid) or {}
    except Exception:
        r = {'error': 'unreachable'}
    if r.get('error'):                                # the website did not answer: keep what we had, ask again later
        _QUADS[vid] = dict(f if isinstance(f, dict) else {'q': have}, at=time.time())
        return have
    fld = r.get('field') or {}
    q = fld.get('q')
    q = q if isinstance(q, list) and len(q) == 8 else None
    if q and isinstance(fld.get('k'), (int, float)) and isinstance(fld.get('ka'), (int, float)):
        q = with_lens(q, fld['k'], fld['ka'])
    _QUADS[vid] = {'q': q, 'g': fld.get('g') if q else None, 'l': fld.get('l') if q else None, 't': fld.get('t') if q else None, 'at': time.time()}
    try:
        os.makedirs(DIRS['data'], exist_ok=True)
        with open(path, 'w') as f:
            json.dump(_QUADS, f)
    except Exception:
        pass
    return q

def pieces_file():
    return os.path.join(DIRS['models'], 'pieces.onnx')

def pieces_info_file():
    return os.path.join(DIRS['models'], 'pieces_latest.json')

def lab_read(name):
    try:
        with open(os.path.join(LABELS, name + '.json')) as f:
            return json.load(f)
    except Exception:
        return {}

def lab_write(name, **changes):
    """Change one frame's saved marks, keeping the rest (robot boxes and
    pin/cup boxes are saved by different screens)."""
    os.makedirs(LABELS, exist_ok=True)
    lab = lab_read(name)
    lab.update(changes)
    tmp = os.path.join(LABELS, name + '.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(lab, f)
    os.replace(tmp, os.path.join(LABELS, name + '.json'))

def clean_pieces(raw):
    out = []
    for b in raw or []:
        try:
            x, y, w, h, c = float(b[0]), float(b[1]), float(b[2]), float(b[3]), int(b[4])
        except (TypeError, ValueError, IndexError):
            continue
        if w >= 2 and h >= 2 and 0 <= c < len(PIECE_NAMES):
            out.append([round(x, 1), round(y, 1), round(w, 1), round(h, 1), c])
    return out[:300]

def pieces_marked():
    """Frames whose pins and cups have been marked: (name, w, h, robots, pieces)."""
    out = []
    if not os.path.isdir(LABELS):
        return out
    for n in sorted(os.listdir(LABELS)):
        if not n.endswith('.json'):
            continue
        name = n[:-5]
        lab = lab_read(name)
        if 'pieces' not in lab or lab.get('pskip') or not os.path.exists(os.path.join(FRAMES, name + '.jpg')):
            continue
        try:
            with open(os.path.join(PROPS, name + '.json')) as f:
                p = json.load(f)
        except Exception:
            continue
        q = quad_for(name.rsplit('_', 1)[0])
        if q is None:
            continue
        sb = frame_spots(name)
        if not sb:
            continue
        out.append((name, p['w'], p['h'], lab.get('boxes', []), [b for b in clean_pieces(lab['pieces']) if in_spots(b, sb) >= 0], sb))
    return out

def pieces_queue(site=None):
    """Frames with their robots done (not skipped) and pins not yet marked,
    taking turns between videos so it is not the same scene twice in a row.
    Only frames whose video has its field marked: the spots come from that."""
    if not os.path.isdir(LABELS):
        return []
    by, marked = {}, {}
    for n in sorted(os.listdir(LABELS), key=lambda n: hashlib.md5(n.encode()).hexdigest()):
        if not n.endswith('.json'):
            continue
        name = n[:-5]
        lab = lab_read(name)
        if lab.get('skip') or 'pieces' in lab or lab.get('pskip') or not os.path.exists(os.path.join(FRAMES, name + '.jpg')):
            continue
        vid = name.rsplit('_', 1)[0]
        if vid not in marked:
            marked[vid] = quad_for(vid, site) is not None
        if not marked[vid]:
            continue
        by.setdefault(vid, []).append(name)
    out, lists = [], list(by.values())
    while any(lists):
        for l in lists:
            if l:
                out.append(l.pop(0))
    return out

# ── helping the marking (v2.42) ──────────────────────────────────────────
# Asked for: pre-filled marks from a quickly trained finder, and the most
# useful frames first. After the first HELPER_START frames (and every
# HELPER_EVERY after), a small finder is trained on them in a few minutes,
# only to draw the guesses for the frames still to mark: checking a good
# guess is quicker than marking from nothing. It never counts pins in
# tracking (the finder made by Train, which must win a test, does that).
HELPER_START, HELPER_EVERY, HELPER_ROUNDS = 20, 20, 30

def helper_file():
    return os.path.join(DIRS['models'], 'pieces_helper.onnx')

def helper_info():
    try:
        with open(os.path.join(DIRS['models'], 'pieces_helper.json')) as f:
            return json.load(f)
    except Exception:
        return {}

def helper_due(marked):
    """Is it time to train the marking helper again?"""
    return marked >= HELPER_START and marked - int(helper_info().get('marks', 0)) >= HELPER_EVERY

def do_quick_pieces(cfg):
    """Train the marking helper (a small finder, a few minutes on a graphics
    card) on every frame marked so far."""
    marked = pieces_marked()
    if len(marked) < HELPER_START:
        say('The marking helper is trained after %d marked frames (%d so far).' % (HELPER_START, len(marked)))
        return
    if not ensure_training_tools():
        return
    import torch
    from ultralytics import YOLO
    if not torch.cuda.is_available() and not cfg.get('helper_cpu'):
        say('No graphics card for training, so no marking helper: the colour guesses stay. (It would take too long without one.)')
        return
    root, counts = build_pieces_dataset(marked)
    tag = 'h' + time.strftime('%y%m%d%H%M')
    runs = os.path.join(DIRS['build'], 'runs')
    def each_round(trainer):
        progress('Training the marking helper', int(getattr(trainer, 'epoch', 0)) + 1, HELPER_ROUNDS)
    model = newest_yolo(YOLO, 'yolo11n.pt')
    try:
        model.add_callback('on_fit_epoch_end', each_round)
    except Exception:
        pass
    say('Training the marking helper on %d marked frames…' % len(marked))
    model.train(data=os.path.join(root, 'data.yaml'), epochs=HELPER_ROUNDS, imgsz=PIECE_SIZE, batch=16, device=0 if torch.cuda.is_available() else 'cpu',
                workers=2, patience=10, project=runs, name=tag, exist_ok=True, verbose=False, plots=False, fliplr=0.5, mosaic=1.0)
    onnx_path = YOLO(os.path.join(runs, tag, 'weights', 'best.pt')).export(format='onnx', imgsz=PIECE_SIZE, opset=12, simplify=True, dynamic=False)
    import onnxruntime as ort
    if list(ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider']).get_outputs()[0].shape)[:2] != [1, 4 + len(PIECE_NAMES)]:
        say('The marking helper came out in an unexpected shape; the colour guesses stay.')
        return
    tmp = helper_file() + '.tmp'
    shutil.copyfile(onnx_path, tmp)
    os.replace(tmp, helper_file())
    with open(os.path.join(DIRS['models'], 'pieces_helper.json'), 'w') as f:
        json.dump({'marks': len(marked), 'when': time.strftime('%b %d, %H:%M'), 'tag': tag}, f)
    say('The marking helper is ready: the next frames come with its guesses (trained on %d marked frames).' % len(marked))

def guess_source():
    """Which finder draws the guesses: the marking helper when it has seen
    more marked frames than the finder in use, else the finder in use, else
    the colours. → ('helper' | 'trained' | 'colour', file or None)"""
    h, info = helper_file(), helper_info()
    trained_frames = 0
    try:
        with open(pieces_info_file()) as f:
            trained_frames = int(json.load(f).get('frames', 0)) if pieces_ready() else 0
    except Exception:
        pass
    if os.path.exists(h) and int(info.get('marks', 0)) > trained_frames:
        return 'helper', h
    if pieces_ready():
        return 'trained', pieces_file()
    return 'colour', None

def frame_interest(name, finder, robots):
    """How much marking this frame would teach (v2.42): the guesses' doubts
    (pieces found only half sure) and how far the finder and the colours
    disagree on how many there are; without a finder, how many pieces stand
    on goals there. Kept in the frame's notes with what worked it out."""
    import cv2
    try:
        with open(os.path.join(PROPS, name + '.json')) as f:
            p = json.load(f)
    except Exception:
        return 0.0
    tag = finder[0] if finder else 'colour'
    if isinstance(p.get('pint'), list) and p['pint'][0] == tag:
        return p['pint'][1]
    frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
    spots = frame_spots(name, frame) if frame is not None else []
    if frame is None or not spots:
        return 0.0
    colour = pieces_from_colour(frame, robots, spots)
    if finder:
        found = finder[1].find_spots(frame, spots)
        unsure = sum(1 for b in found if b[4] < 0.6)
        sure = sum(1 for b in found if b[4] >= 0.6)
        v = 2.0 * unsure + abs(sure - len(colour)) + 0.1 * len(found)
    else:
        v = float(len(colour))
    p['pint'] = [tag, round(v, 2)]
    with open(os.path.join(PROPS, name + '.json'), 'w') as f:
        json.dump(p, f)
    return v

def rank_pieces(queue, budget=120):
    """The pins & cups queue, most useful first (v2.42): streams marked least
    come first in turn; within a stream, the frames that would teach most
    (`frame_interest`, for the first `budget` frames; worked out once each).
    Taking turns between streams stays, so it is never the same scene twice."""
    src = guess_source()
    finder = None
    if src[1]:
        try:
            finder = (src[0] + ':' + str(int(os.path.getmtime(src[1]))), PieceFinder(src[1], prov=['CPUExecutionProvider']))
        except Exception:
            finder = None
    done_by = {}
    for n in os.listdir(LABELS) if os.path.isdir(LABELS) else []:
        if n.endswith('.json') and 'pieces' in lab_read(n[:-5]):
            v = n[:-5].rsplit('_', 1)[0]
            done_by[v] = done_by.get(v, 0) + 1
    score = {}
    for name in queue[:budget]:
        try:
            score[name] = frame_interest(name, finder, lab_read(name).get('boxes', []))
        except Exception:
            score[name] = 0.0
    by = {}
    for name in queue:
        by.setdefault(name.rsplit('_', 1)[0], []).append(name)
    lists = [sorted(l, key=lambda n: -score.get(n, -1)) for v, l in sorted(by.items(), key=lambda kv: done_by.get(kv[0], 0))]
    out = []
    while any(lists):
        for l in lists:
            if l:
                out.append(l.pop(0))
    return out

def pieces_from_colour(frame, robots, spots=None):
    """The colour finder's pins as boxes in the frame: [x, y, w, h, class];
    with `spots`, only those inside one."""
    W, H, blobs = pin_blobs(frame, robots)
    k = W / frame.shape[1]
    out = [[round((b[0] - b[2] / 2) / k, 1), round((b[1] - b[3]) / k, 1), round(b[2] / k, 1), round(b[3] / k, 1), b[5] - 1] for b in blobs]
    return keep_stacked(out, spots) if spots is not None else out

def pieces_why(site=None):
    """Why there may be nothing to mark pins and cups on (v2.35): frames are
    marked only once their robots are reviewed, and only from streams whose
    field is marked on the website. → reviewed frames, and the streams that
    have reviewed frames but no field mark, most frames first."""
    reviewed, unmarked = 0, {}
    if not os.path.isdir(LABELS):
        return {'reviewed': 0, 'unmarked': []}
    for n in os.listdir(LABELS):
        if not n.endswith('.json'):
            continue
        lab = lab_read(n[:-5])
        if lab.get('skip') or 'boxes' not in lab:
            continue
        reviewed += 1
        vid = n[:-5].rsplit('_', 1)[0]
        if quad_for(vid, site) is None:
            unmarked[vid] = unmarked.get(vid, 0) + 1
    return {'reviewed': reviewed, 'unmarked': sorted(unmarked.items(), key=lambda kv: -kv[1])[:5]}

def field_frame(vid, want=None):
    """The picture to mark a stream's field on: of this stream's saved
    frames, a reviewed one with the most robots (a wide view), else any."""
    import cv2
    if not os.path.isdir(FRAMES):
        return None
    best = None
    for n in os.listdir(FRAMES):
        if want and n != want + '.jpg':
            continue
        if not (n.startswith(vid + '_') and n.endswith('.jpg')):
            continue
        name = n[:-4]
        lab = lab_read(name)
        try:
            with open(os.path.join(PROPS, name + '.json')) as f:
                p = json.load(f)
        except Exception:
            p = {}
        score = (0 if lab.get('skip') else 1, len(lab.get('boxes') or p.get('boxes') or []))
        if best is None or score > best[0]:
            best = (score, name, p)
    if not best:
        return None
    pic = cv2.imread(os.path.join(FRAMES, best[1] + '.jpg'))
    if pic is None:
        return None
    out = {'id': best[1], 'w': pic.shape[1], 'h': pic.shape[0]}
    if isinstance(best[2].get('t'), (int, float)):
        out['t'] = best[2]['t']
    return out

def first_spots(q):
    """Where the goals and loaders start, from the four corners (the
    manual's drawing): picture fractions, to be dragged onto the real ones."""
    fwd = quad_fwd(q)
    if not fwd:
        return None
    return [[round(min(0.99, max(0.01, v)), 4) for v in fwd(u, v_)] for u, v_, *_ in SPOTS]

def lens_save(cfg, vid, fld, k, ka):
    """Keep a stream's lens with its field mark, here and on the website."""
    e = _QUADS.get(vid) if isinstance(_QUADS.get(vid), dict) else None
    if e and e.get('q'):
        e['q'] = with_lens(e['q'], k, ka)
    try:
        with open(os.path.join(DIRS['data'], 'quads.json'), 'w') as f:
            json.dump(_QUADS, f)
    except Exception:
        pass
    if cfg.get('key') and fld.get('q') and fld.get('g') and fld.get('l'):
        field = {'vid': vid, 'q': fld['q'][:8], 'g': fld['g'], 'l': fld['l'], 'k': round(float(k), 4), 'ka': round(float(ka), 4)}
        if isinstance(fld.get('t'), (int, float)):
            field['t'] = fld['t']
        try:
            Site(cfg).post({'field': field})
        except Exception:
            pass

def save_field(cfg, body):
    """A field marked in the app, saved to the website like one marked
    there. → (ok, why not)."""
    vid = str(body.get('vid', ''))
    if not re.fullmatch(r'[A-Za-z0-9_-]{6,20}', vid):
        return False, 'bad stream'
    num = lambda a, n: isinstance(a, list) and len(a) == n and all(isinstance(v, (int, float)) and -0.5 <= v <= 1.5 for v in a)
    q, g, l = body.get('q'), body.get('g'), body.get('l')
    if isinstance(q, list) and len(q) >= 8:
        q = q[:8]                                       # a lens carried on it is worked out again
    if not (num(q, 8) and num(g, 18) and num(l, 8)):
        return False, 'the corners, goals and loaders were not all there'
    if not cfg.get('key'):
        return False, 'save the admin key in Settings first'
    field = {'vid': vid, 'q': [round(v, 4) for v in q[:8]], 'g': [round(v, 4) for v in g], 'l': [round(v, 4) for v in l]}
    # The lens, from the picture it was marked on (v2.43).
    fid = str(body.get('id', ''))
    if cfg.get('lens', True) and re.fullmatch(r'[A-Za-z0-9_-]+', fid) and os.path.exists(os.path.join(FRAMES, fid + '.jpg')):
        try:
            import cv2
            pic = cv2.imread(os.path.join(FRAMES, fid + '.jpg'))
            k, _ = estimate_lens(pic, field['q'])
            if k:
                field['k'], field['ka'] = round(k, 4), round(pic.shape[0] / pic.shape[1], 4)
        except Exception:
            pass
    t = body.get('t')
    if isinstance(t, (int, float)) and 0 <= t <= 200000:
        field['t'] = round(float(t), 1)
    r = Site(cfg).post({'field': field})
    if not (r and r.get('ok')):
        return False, 'the website said: ' + str((r or {}).get('error') or 'no answer')
    _QUADS[vid] = {'q': with_lens(field['q'], field.get('k', 0), field.get('ka', 0)), 'g': field['g'], 'l': field['l'], 't': field.get('t'), 'at': time.time()}
    fid = str(body.get('id', ''))
    if re.fullmatch(r'[A-Za-z0-9_-]+', fid) and os.path.exists(os.path.join(FRAMES, fid + '.jpg')):
        try:
            with open(refs_file()) as f:
                refs = json.load(f)
        except Exception:
            refs = {}
        refs[vid] = {'id': fid, 'q': field['q'][:8]}
        with open(refs_file(), 'w') as f:
            json.dump(refs, f)
        _FOLLOW.pop(vid, None)
    try:
        with open(os.path.join(DIRS['data'], 'quads.json'), 'w') as f:
            json.dump(_QUADS, f)
    except Exception:
        pass
    return True, ''

def pieces_ready():
    """A trained pin and cup finder that beat the colour finder, on this computer."""
    try:
        with open(pieces_info_file()) as f:
            info = json.load(f)
    except Exception:
        return False
    # A finder trained before 2.22 looked at the whole frame at 1280 and cannot
    # read the goal and loader pictures; it is not used (its marks are kept and
    # train the new one).
    return bool(info.get('use')) and info.get('size') == PIECE_SIZE and os.path.exists(pieces_file())

def piece_letterbox(w, h):
    s = PIECE_SIZE / max(w, h)
    nw, nh = jround(w * s), jround(h * s)
    return {'s': s, 'nw': nw, 'nh': nh, 'px': (PIECE_SIZE - nw) // 2, 'py': (PIECE_SIZE - nh) // 2}

def piece_decode(out, lb, w, h, conf):
    """out: (4 + classes, N) → [x, y, w, h, score, class] in the frame, kept apart by class."""
    import numpy as np
    sc = out[4:]
    cls, best = sc.argmax(0), sc.max(0)
    by = {}
    for i in np.nonzero(best >= conf)[0]:
        bw, bh = out[2, i] / lb['s'], out[3, i] / lb['s']
        x = (out[0, i] - lb['px']) / lb['s'] - bw / 2
        y = (out[1, i] - lb['py']) / lb['s'] - bh / 2
        x0, y0, x1, y1 = max(0, x), max(0, y), min(w, x + bw), min(h, y + bh)
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            by.setdefault(int(cls[i]), []).append([float(x0), float(y0), float(x1 - x0), float(y1 - y0), float(best[i]), int(cls[i])])
    out_ = []
    for c, bs in by.items():
        out_ += nms(bs, 0.5)
    return out_

def on_robot(b, robots):
    cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
    return any(r[0] - r[2] * 0.06 <= cx <= r[0] + r[2] * 1.06 and r[1] - r[3] * 0.06 <= cy <= r[1] + r[3] * 1.06 for r in robots or [])

def score_pieces(find, val):
    """How a pin finder does on marked frames: find(frame, robots) → [[x,y,w,h,class], …].
    Halves count right when the class matches and they overlap (IoU 0.3: they
    are small, and a few pixels move it a lot). → {'halves': (p, r, f1), 'cups': (p, r, f1)}"""
    import cv2
    tally = {'halves': [0, 0, 0], 'cups': [0, 0, 0]}
    for item in val:
        name, w, h, robots, truth = item[:5]
        spots = item[5] if len(item) > 5 else None
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        found = find(frame, robots, spots) if spots is not None else find(frame, robots)
        for part, keep in (('halves', lambda c: c < 3), ('cups', lambda c: c == 3)):
            T = [t for t in truth if keep(t[4])]
            F = [f for f in found if keep(f[4])]
            used = set()
            for f in sorted(F, key=lambda f: -f[2] * f[3]):
                best, bi = 0, -1
                for i, t in enumerate(T):
                    if i in used or t[4] != f[4]:
                        continue
                    v = iou(f, t)
                    if v > best:
                        best, bi = v, i
                if best >= 0.3:
                    used.add(bi)
                    tally[part][0] += 1
                else:
                    tally[part][1] += 1
            tally[part][2] += len(T) - len(used)
    res = {}
    for part, (tp, fp, fn) in tally.items():
        pr = tp / (tp + fp) if tp + fp else 0
        rc = tp / (tp + fn) if tp + fn else 0
        res[part] = (pr, rc, (2 * pr * rc / (pr + rc) if pr + rc else 0))
    return res

def build_pieces_dataset(marked):
    """One picture for each spot of each marked frame: the spot cut out, its
    pins and cups as labels inside it (empty spots teach "nothing here" too)."""
    import cv2
    root = os.path.join(DIRS['build'], 'pieces_dataset')
    shutil.rmtree(root, ignore_errors=True)
    counts = {'train': 0, 'val': 0}
    for part in ('train', 'val'):
        os.makedirs(os.path.join(root, 'images', part))
        os.makedirs(os.path.join(root, 'labels', part))
    for name, w, h, robots, pieces, spots in marked:
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        part = 'val' if is_val(name) and pieces_by_person(name) else 'train'     # the vision model's marks never grade
        for k, sb in enumerate(spots):
            if not sb:
                continue
            x0, y0, x1, y1 = sb
            cw, ch = x1 - x0, y1 - y0
            stem = '%s_s%02d' % (name, k)
            cv2.imwrite(os.path.join(root, 'images', part, stem + '.jpg'), frame[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 95])
            with open(os.path.join(root, 'labels', part, stem + '.txt'), 'w') as f:
                for x, y, bw, bh, c in pieces:
                    if in_spots([x, y, bw, bh], [sb]) < 0:
                        continue
                    ax, ay = max(x0, x), max(y0, y)
                    bx, by = min(x1, x + bw), min(y1, y + bh)
                    if bx - ax > 1 and by - ay > 1:
                        f.write('%d %.6f %.6f %.6f %.6f\n' % (c, ((ax + bx) / 2 - x0) / cw, ((ay + by) / 2 - y0) / ch, (bx - ax) / cw, (by - ay) / ch))
            counts[part] += 1
    with open(os.path.join(root, 'data.yaml'), 'w') as f:
        f.write('path: %s\ntrain: images/train\nval: images/val\nnames:\n' % root.replace('\\', '/') + ''.join('  %d: %s\n' % (i, n) for i, n in enumerate(PIECE_NAMES)))
    return root, counts

def do_train_pieces(cfg):
    """Train the pin and cup finder from the marked frames; use it only if it
    finds pin halves better than what is used now. → info, or None."""
    marked = pieces_marked()
    val = [m for m in marked if is_val(m[0]) and pieces_by_person(m[0])]
    say('\nPins & cups: %d marked frames (%d held back for testing).' % (len(marked), len(val)))
    if len(marked) < PIECE_NEED or len(val) < 6:
        say('Mark pins and cups on at least %d frames to train their finder (%d more).' % (PIECE_NEED, max(0, PIECE_NEED - len(marked), 6 - len(val))))
        return None
    if not ensure_training_tools():
        return None
    import torch
    from ultralytics import YOLO
    root, counts = build_pieces_dataset(marked)
    device = 0 if torch.cuda.is_available() else 'cpu'
    tag = 'p' + time.strftime('%y%m%d%H%M')
    runs = os.path.join(DIRS['build'], 'runs')
    total_rounds = int(cfg.get('piece_epochs', 150))
    rounds = {'n': 0}
    def each_round(trainer):
        rounds['n'] = int(getattr(trainer, 'epoch', rounds['n'])) + 1
        say('  training pins & cups: round %d/%d' % (rounds['n'], total_rounds))
        progress('Training the pin & cup finder', rounds['n'], total_rounds)
    # A bigger model than the robot finder: it looks at the spots cut out and
    # enlarged, where a pin is a good part of the picture.
    model = newest_yolo(YOLO, str(cfg.get('piece_model') or 'yolo11s.pt'))
    try:
        model.add_callback('on_fit_epoch_end', each_round)
    except Exception:
        pass
    say('Training the pin & cup finder on %d goal and loader pictures; testing on %d.' % (counts['train'], counts['val']))
    model.train(data=os.path.join(root, 'data.yaml'), epochs=total_rounds, imgsz=PIECE_SIZE, batch=int(cfg.get('piece_batch', 32)), device=device,
                workers=4, patience=30, project=runs, name=tag, exist_ok=True, verbose=False, plots=False, fliplr=0.5, mosaic=1.0)
    best = os.path.join(runs, tag, 'weights', 'best.pt')
    onnx_path = YOLO(best).export(format='onnx', imgsz=PIECE_SIZE, opset=12, simplify=True, dynamic=False)
    out = os.path.join(DIRS['models'], 'pieces_%s.onnx' % tag)
    shutil.copyfile(onnx_path, out)
    import onnxruntime as ort
    sess = ort.InferenceSession(out, providers=['CPUExecutionProvider'])
    if list(sess.get_outputs()[0].shape)[:2] != [1, 4 + len(PIECE_NAMES)]:
        say('The new pin finder answers in an unexpected shape (%s); not used.' % sess.get_outputs()[0].shape)
        return None
    say('\nMeasuring on the %d test frames…' % len(val))
    colour = score_pieces(lambda fr, rb, sp: pieces_from_colour(fr, rb, sp), val)
    newf = PieceFinder(out)
    new = score_pieces(lambda fr, rb, sp: [b[:4] + [b[5]] for b in newf.find_spots(fr, sp)], val)
    cur = None
    if pieces_ready():
        curf = PieceFinder(pieces_file())
        cur = score_pieces(lambda fr, rb, sp: [b[:4] + [b[5]] for b in curf.find_spots(fr, sp)], val)
    bar = max(colour['halves'][2], cur['halves'][2] if cur else 0)
    use = new['halves'][2] > bar
    say('                     pin halves: right when it says one / found / overall      cups: found / overall')
    say('  colour finder            %5.1f%% / %5.1f%% / %5.1f                        —' % (colour['halves'][0] * 100, colour['halves'][1] * 100, colour['halves'][2] * 100))
    if cur:
        say('  current trained          %5.1f%% / %5.1f%% / %5.1f              %5.1f%% / %5.1f' % (cur['halves'][0] * 100, cur['halves'][1] * 100, cur['halves'][2] * 100, cur['cups'][1] * 100, cur['cups'][2] * 100))
    say('  new                      %5.1f%% / %5.1f%% / %5.1f              %5.1f%% / %5.1f' % (new['halves'][0] * 100, new['halves'][1] * 100, new['halves'][2] * 100, new['cups'][1] * 100, new['cups'][2] * 100))
    info = {'tag': tag, 'file': out, 'colour': colour, 'new': new, 'frames': len(marked), 'train': counts['train'], 'test': counts['val'],
            'rounds': rounds['n'], 'when': time.strftime('%b %d, %H:%M'), 'use': False, 'size': PIECE_SIZE}
    if use:
        tmp = pieces_file() + '.tmp'
        shutil.copyfile(out, tmp)
        os.replace(tmp, pieces_file())
        info['use'] = True
        say('PIN & CUP FINDER IN USE: it beat what was used before on frames it never saw. Matches tracked from now on count pins and cups on every goal and loader with it.')
    else:
        try:
            with open(pieces_info_file()) as f:
                before = json.load(f)                        # the one before stays, if it is the same kind
                info['use'] = bool(before.get('use')) and before.get('size') == PIECE_SIZE and os.path.exists(pieces_file())
        except Exception:
            pass
        info['beat'] = False
        say('The new pin & cup finder is NOT better than what is used now, so it is not used. Mark more frames and train again.')
    with open(pieces_info_file(), 'w') as f:
        json.dump(info, f)
    return info


class PieceFinder:
    """The trained pin and cup finder."""
    def __init__(self, path=None, so=None, prov=None):
        import numpy as np, onnxruntime as ort
        self.np = np
        if prov is None:
            have = ort.get_available_providers()
            prov = [p for p in ('DmlExecutionProvider', 'CUDAExecutionProvider') if p in have] + ['CPUExecutionProvider']
        self.sess = ort.InferenceSession(path or pieces_file(), so, providers=prov) if so else ort.InferenceSession(path or pieces_file(), providers=prov)

    def find(self, frame, robots=None, conf=PIECE_CONF):
        """→ [x, y, w, h, score, class] in the frame's pixels, none on a robot."""
        import cv2
        np = self.np
        h, w = frame.shape[:2]
        lb = piece_letterbox(w, h)
        sq = np.full((PIECE_SIZE, PIECE_SIZE, 3), 114, np.uint8)
        sq[lb['py']:lb['py'] + lb['nh'], lb['px']:lb['px'] + lb['nw']] = cv2.resize(frame, (lb['nw'], lb['nh']), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]
        out = self.sess.run(None, {self.sess.get_inputs()[0].name: (sq.astype(np.float32) / 255).transpose(2, 0, 1)[None]})[0][0]
        return [b for b in piece_decode(out, lb, w, h, conf) if not on_robot(b, robots)]

    def find_spots(self, frame, spots):
        """Pins and cups in each spot, in the frame's pixels: [x, y, w, h, score, class, spot]."""
        out = []
        for k, sb in enumerate(spots or []):
            if not sb:
                continue
            x0, y0, x1, y1 = sb
            found = [[b[0] + x0, b[1] + y0, b[2], b[3], b[4], b[5], k] for b in self.find(frame[y0:y1, x0:x1])]
            out += stacked(found, k, sb)                 # on the goal, not loose beside it (v2.39)
        return out

    def spot_counts(self, frame, spots):
        """→ per spot [red halves, blue halves, yellow halves, cups], -1s where the spot is off the picture."""
        cnt = [[0, 0, 0, 0] if sb else [-1, -1, -1, -1] for sb in (spots or [])]
        for b in self.find_spots(frame, spots):
            cnt[b[6]][b[5]] += 1
        return cnt


# ── the stack reader (v2.49) ──────────────────────────────────────────────
# Asked for pins counted exactly ("build all of it"). Pins have one shape and
# score only on the goals and in the loaders, so each goal is read the way a
# line of text is: one goal's column, cut out, is read bottom to top as a
# sequence ("red, red, yellow, blue, cup") by a small network (a few
# convolutions and a recurrent layer, trained with CTC, as text readers are).
# It learns from:
#   · every goal and loader on the frames marked for pins & cups;
#   · practice stacks made from those marks: each marked half and cup is cut
#     out and stacked again, in new orders and heights, on goals marked
#     empty, so it sees thousands of stacks before it has to read a real one;
# and, while tracking, it reads each goal from the last few looks at it laid
# over each other (the camera is followed, so they line up; pins do not move
# once scored), which takes out a stream's blur and blocky compression.
# It is tested on marked frames it never saw against the pin finder and the
# colours, by how many goals it counts exactly right, and used only if it wins.
STACK_W, STACK_H = 48, 144
STACK_KINDS = 4                        # red half, blue half, yellow half, cup (0 is "nothing" for CTC)
STACK_SYNTH = 3000
STACK_ROUNDS = 30

def stack_file():
    return os.path.join(DIRS['models'], 'stack_reader.onnx')

def stack_info():
    try:
        with open(os.path.join(DIRS['models'], 'stack_reader.json')) as f:
            return json.load(f)
    except Exception:
        return {}

def stack_ready():
    return os.path.exists(stack_file()) and bool(stack_info().get('use'))

def stack_crop(frame, sb):
    """A spot's column as the reader sees it: STACK_H × STACK_W, bottom row first (uint8 HWC)."""
    import cv2
    H, W = frame.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in sb)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    return cv2.resize(frame[y0:y1, x0:x1], (STACK_W, STACK_H), interpolation=cv2.INTER_AREA if (x1 - x0) > STACK_W else cv2.INTER_CUBIC)[::-1]

def stack_label(pieces, k, spots):
    """The marked pieces on spot k, bottom to top: [kind + 1, …]."""
    on = [b for b in pieces if in_spots(b, spots) == k and 0 <= int(b[4]) < STACK_KINDS]
    return [int(b[4]) + 1 for b in sorted(on, key=lambda b: -(b[1] + b[3] / 2))]

def stack_examples(marked):
    """(crop, sequence, frame name) for every spot of every marked frame."""
    import cv2
    out = []
    for item in marked:
        name, w, h, robots, pieces, spots = item[:6]
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        for k, sb in enumerate(spots):
            if not sb:
                continue
            c = stack_crop(frame, sb)
            if c is not None:
                out.append((c, stack_label(pieces, k, spots), name))
    return out

def stack_practice(marked, n, seed=5):
    """Practice stacks: marked halves and cups cut out and stacked again on
    goals marked empty. → [(crop, sequence)]"""
    import cv2, numpy as np
    rng = np.random.default_rng(seed)
    patches = {k: [] for k in range(STACK_KINDS)}
    empties = []
    for item in marked:
        name, w, h, robots, pieces, spots = item[:6]
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        for b in pieces:
            k = in_spots(b, spots)
            if k < 0:
                continue
            sb = spots[k]
            x, y, bw, bh = (int(round(v)) for v in b[:4])
            if bw < 2 or bh < 2:
                continue
            p = frame[max(0, y):y + bh, max(0, x):x + bw]
            if p.size:
                # Kept relative to its goal's column, so it is pasted at the size it really was.
                patches[int(b[4])].append((p.copy(), bw / max(1.0, sb[2] - sb[0]), bh / max(1.0, sb[3] - sb[1])))
        for k, sb in enumerate(spots):
            if sb and not stack_label(pieces, k, spots):
                c = stack_crop(frame, sb)
                if c is not None:
                    empties.append(c[::-1].copy())          # upright again, to paste on
    kinds = [k for k in range(STACK_KINDS) if patches[k]]
    if not kinds or not empties:
        return []
    out = []
    for _ in range(n):
        bg = empties[int(rng.integers(len(empties)))].copy()
        seq, y = [], STACK_H * (0.92 + 0.06 * rng.random())
        for _ in range(int(rng.integers(0, 11))):
            k = kinds[int(rng.integers(len(kinds)))]
            p, fw, fh = patches[k][int(rng.integers(len(patches[k])))]
            pw = max(3, int(round(fw * STACK_W * (0.9 + 0.2 * rng.random()))))
            ph = max(3, int(round(fh * STACK_H * (0.9 + 0.2 * rng.random()))))
            top = int(round(y - ph))
            if top < 2:
                break
            x0 = int(round((STACK_W - pw) / 2 + rng.normal(0, STACK_W * 0.04)))
            x0 = min(max(0, x0), STACK_W - pw)
            bg[top:top + ph, x0:x0 + pw] = cv2.resize(p, (pw, ph), interpolation=cv2.INTER_LINEAR)
            seq.append(k + 1)
            y = top + ph * (0.12 + 0.12 * rng.random())        # stacked pieces overlap a little
        # As a stream shows it: a little blur, noise and brightness.
        if rng.random() < 0.6:
            bg = cv2.GaussianBlur(bg, (3, 3), 0.4 + rng.random())
        bg = np.clip(bg.astype(np.float32) * (0.8 + 0.4 * rng.random()) + rng.normal(0, 4, bg.shape), 0, 255).astype(np.uint8)
        out.append((bg[::-1].copy(), seq))
    return out

def stack_net():
    import torch.nn as nn
    class StackNet(nn.Module):
        def __init__(self):
            super().__init__()
            def blk(i, o, pool):
                return [nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True)] + ([nn.MaxPool2d(pool)] if pool else [])
            self.cnn = nn.Sequential(*blk(3, 32, (2, 2)), *blk(32, 64, (2, 2)), *blk(64, 96, (1, 2)), *blk(96, 128, (1, 2)), *blk(128, 128, None))
            self.rnn = nn.GRU(128, 64, bidirectional=True, batch_first=True)
            self.out = nn.Linear(128, STACK_KINDS + 1)
        def forward(self, x):                       # x: N×3×H×W, bottom row first
            f = self.cnn(x).mean(dim=3)             # N×128×T (T = H/4), from the bottom up
            f, _ = self.rnn(f.permute(0, 2, 1))
            return self.out(f)                      # N×T×(kinds+1)
    return StackNet()

def stack_decode(logits):
    """Greedy CTC: T×(kinds+1) scores → [kind, …] bottom to top (kinds 0..3)."""
    best = logits.argmax(axis=1)
    out, prev = [], 0
    for v in best:
        v = int(v)
        if v and v != prev:
            out.append(v - 1)
        prev = v
    return out

def stack_counts_of(seq):
    c = [0] * STACK_KINDS
    for k in seq:
        c[k] += 1
    return c

class StackReader:
    """The trained reader: counts(frame, spots, memory) → per spot [red, blue,
    yellow halves, cups] (-1s off the picture). `memory` (a dict kept for a
    match) holds the last looks at each spot, laid over each other."""
    def __init__(self, path=None, prov=None):
        import onnxruntime as ort, numpy as np
        self.np = np
        have = ort.get_available_providers()
        prov = prov or [p for p in ('DmlExecutionProvider', 'CUDAExecutionProvider') if p in have] + ['CPUExecutionProvider']
        self.s = ort.InferenceSession(path or stack_file(), providers=prov)
        self.inp = self.s.get_inputs()[0].name

    def read(self, crops):
        np = self.np
        if not crops:
            return []
        x = np.stack([c[:, :, ::-1].transpose(2, 0, 1) for c in crops]).astype(np.float32) / 255.0
        out = self.s.run(None, {self.inp: np.ascontiguousarray(x)})[0]
        return [stack_decode(o) for o in out]

    def counts(self, frame, spots, memory=None):
        np = self.np
        cnt, crops, where = [], [], []
        for k, sb in enumerate(spots or []):
            c = stack_crop(frame, sb) if sb else None
            if c is None:
                cnt.append([-1, -1, -1, -1])
                continue
            if memory is not None:
                last = memory.setdefault(k, [])
                last.append(c)
                del last[:-3]
                if len(last) >= 2:
                    c = np.median(np.stack(last), axis=0).astype(np.uint8)
            cnt.append(None)
            crops.append(c)
            where.append(k)
        for k, seq in zip(where, self.read(crops)):
            cnt[k] = stack_counts_of(seq)
        return cnt

def stack_exact(count_of, val):
    """Share of the spots on marked frames counted exactly right (all four kinds).
    count_of(frame, robots, spots) → per spot counts."""
    import cv2
    right = total = 0
    for item in val:
        name, w, h, robots, pieces, spots = item[:6]
        frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
        if frame is None:
            continue
        got = count_of(frame, robots, spots)
        truth = spot_counts_of(pieces, spots)
        for k, sb in enumerate(spots):
            if not sb:
                continue
            total += 1
            right += int(list(got[k]) == list(truth[k]))
    return right / total if total else 0.0

def do_stack_reader(cfg):
    """Train the stack reader on the pins & cups marks and practice stacks."""
    marked = pieces_marked()
    val = [m for m in marked if is_val(m[0]) and pieces_by_person(m[0])]
    train = [m for m in marked if m not in val]
    if len(train) < 20 or len(val) < 4:
        say('The stack reader learns from pins & cups marks: at least 20 frames to learn from and 4 to test it on (now %d and %d).' % (len(train), len(val)))
        return None
    try:
        import torch
    except Exception:
        if not ensure_training_tools():
            return None
        import torch
    import numpy as np
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    real = [(c, s) for c, s, _ in stack_examples(train)]
    fake = stack_practice(train, int(cfg.get('stack_synth') or STACK_SYNTH))
    data = real * 3 + fake                          # the real ones count more
    say('\nThe stack reader: %d goals and loaders from %d marked frames, and %d practice stacks.' % (len(real), len(train), len(fake)))
    if len(data) < 50:
        say('  Not enough to learn from yet.')
        return None
    net = stack_net().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
    rounds = int(cfg.get('stack_rounds') or STACK_ROUNDS)
    rng = np.random.default_rng(1)
    for ep in range(rounds):
        net.train()
        order = rng.permutation(len(data))
        tot = 0.0
        for i in range(0, len(order), 64):
            batch = [data[j] for j in order[i:i + 64]]
            x = torch.from_numpy(np.stack([c[:, :, ::-1].transpose(2, 0, 1) for c, _ in batch]).astype(np.float32) / 255.0).to(dev)
            tg = torch.tensor([v for _, s in batch for v in s] or [1], dtype=torch.long)
            tl = torch.tensor([len(s) for _, s in batch], dtype=torch.long)
            lp = net(x).log_softmax(2).permute(1, 0, 2)        # T×N×C
            il = torch.full((len(batch),), lp.shape[0], dtype=torch.long)
            loss = ctc(lp.cpu(), tg, il, tl)
            opt.zero_grad(); loss.backward(); opt.step()
            tot += float(loss.detach()) * len(batch)
        progress('Training the stack reader', ep + 1, rounds)
        if (ep + 1) % 10 == 0 or ep == 0:
            say('  round %d/%d: loss %.3f' % (ep + 1, rounds, tot / len(data)))
    net.eval().cpu()
    tmp = os.path.join(DIRS['build'], 'stack_reader.onnx')
    torch.onnx.export(net, torch.zeros(1, 3, STACK_H, STACK_W), tmp, input_names=['x'], output_names=['y'],
                      dynamic_axes={'x': {0: 'n'}, 'y': {0: 'n'}}, opset_version=13, **({'dynamo': False} if 'dynamo' in torch.onnx.export.__code__.co_varnames else {}))
    rd = StackReader(tmp, prov=['CPUExecutionProvider'])
    mine = stack_exact(lambda fr, rb, sp: rd.counts(fr, sp), val)
    colour = stack_exact(lambda fr, rb, sp: spot_counts_of(pieces_from_colour(fr, rb, sp), sp), val)
    finder = None
    if pieces_ready():
        try:
            pf = PieceFinder(pieces_file(), prov=['CPUExecutionProvider'])
            finder = stack_exact(lambda fr, rb, sp: pf.spot_counts(fr, sp), val)
        except Exception:
            finder = None
    best_other = max(colour, finder or 0)
    use = mine > best_other
    shutil.copyfile(tmp, stack_file())
    info = {'use': use, 'exact': round(mine, 3), 'colour': round(colour, 3), 'finder': None if finder is None else round(finder, 3),
            'frames': len(train), 'test': len(val), 'practice': len(fake), 'when': time.strftime('%b %d, %H:%M')}
    with open(os.path.join(DIRS['models'], 'stack_reader.json'), 'w') as f:
        json.dump(info, f)
    say('Goals and loaders counted exactly right, on %d marked frames it never saw:' % len(val))
    say('  stack reader %d%%   ·   pin finder %s   ·   colours %d%%' % (round(100 * mine), ('%d%%' % round(100 * finder)) if finder is not None else '—', round(100 * colour)))
    say('STACK READER IN USE: matches tracked from now on are counted with it.' if use else 'The stack reader is not better yet, so it is not used. It learns again with every pins & cups training.')
    return info

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
    # Labelled by the vision model where it and the finder agreed (v2.40):
    # trained on, up to three times as many as a person reviewed, never graded on.
    for name, w, h, boxes in reviewed(vlm=True)[:3 * max(1, counts['train'])]:
        put(name, w, h, boxes, 'train')
        counts['vlm'] = counts.get('vlm', 0) + 1
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
        # v2.32: a frame the tracker marked as not steady (its robots were not
        # where the look before had them) is not trusted to train on.
        if len(p['boxes']) == 4 and all(b[4] >= 0.6 for b in p['boxes']) and p.get('steady', 1):
            pseudo.append((0 if p.get('steady') else 1, name, p['w'], p['h'], p['boxes']))
    random.Random(7).shuffle(pseudo)
    pseudo = [x[1:] for x in sorted(pseudo, key=lambda x: x[0])]      # steady ones first
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
            # YOLO11 needs ultralytics 8.3 or newer.
            try:
                major, minor = (int(x) for x in ultralytics.__version__.split('.')[:2])
                if (major, minor) < (8, 3):
                    say('Updating the training tools for YOLO11…')
                    pip('ultralytics', '--upgrade')
            except Exception:
                pass
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

def newest_yolo(YOLO, name):
    """The model training starts from. v2.27: YOLO11 (what the best trackers
    we looked at use), a little more accurate than YOLOv8 for the same size
    and speed, and its answers come in the same shape, so the website reads
    it as before. Falls back to YOLOv8 if the installed tools are too old."""
    try:
        return YOLO(name)
    except Exception as e:
        old = name.replace('yolo11', 'yolov8')
        say('  YOLO11 could not be loaded (%s); starting from %s instead.' % (str(e)[:80], old))
        return YOLO(old)

def do_train(cfg):
    gold = reviewed()
    val = [g for g in gold if is_val(g[0])]
    say('\n%d reviewed frames (%d held back for testing).' % (len(gold), len(val)))
    if len(gold) < TRAIN_MIN:
        say('That is too few to train on: review at least %d, and 300 or more to expect a real improvement.' % TRAIN_MIN)
        return
    if len(val) < 20:
        say('Too few test frames yet to measure a new finder fairly; review some more.')
        return
    ensure_models(Site(cfg))
    if not ensure_training_tools():
        return
    import torch
    from ultralytics import YOLO
    try:
        kept, dropped = teach_again()
        if kept or dropped:
            say('The finder looked again at the frames it was sure of: %d confirmed (its newest boxes kept), %d it is no longer sure of (left out).' % (kept, dropped))
    except Exception as e:
        say('  (could not look again at the frames it was sure of: %s)' % str(e)[:100])
    root, counts = build_dataset()
    say('Training on %d reviewed frames and %d the finder was sure of; testing on %d.' % (counts['train'], counts['pseudo'], counts['val']))
    device = 0 if torch.cuda.is_available() else 'cpu'
    if device == 'cpu':
        say('The graphics card is not being used (PyTorch cannot see it), so this will be slow.')
    tag = 'u' + time.strftime('%y%m%d%H%M')
    runs = os.path.join(DIRS['build'], 'runs')
    model = newest_yolo(YOLO, 'yolo11n.pt')           # the same size as the website's finder, so it stays fast in a browser
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
        lab_write(name, skip=bool(lab.get('skip')), boxes=boxes)
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
    if cfg.get('fingerprints', True) and not os.path.exists(embed_file()):
        say('Making the robot fingerprint model (once)…')
        say('  done: robots are also told apart by their look.' if ensure_embedder() else '  not now (needs the training tools); robots are told apart by colour, as before.')
    while True:
        try:
            site = Site(cfg)
            events = site.get('?jobs=1').get('events') or []
            if events:
                quiet = False
                n = do_jobs(cfg)
                sync_review(cfg)
                # The vision model looks at the new frames first, by itself (v2.45).
                if n and cfg.get('think') and cfg.get('vreview_after', True):
                    try:
                        do_vreview(cfg, limit=200)
                    except Exception as e:
                        say('  the vision model could not review (%s)' % str(e)[:100])
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
    robots_ok, pieces_ok = len(reviewed()) >= TRAIN_MIN, len(pieces_marked()) >= PIECE_NEED
    if not robots_ok and not pieces_ok:
        say('Nothing to train yet: review %d frames for robots, or mark pins & cups on %d.' % (TRAIN_MIN, PIECE_NEED))
        return
    if pieces_ok:
        try:
            do_train_pieces(cfg)
        except Exception as e:
            say('Training the pin & cup finder stopped:', e)
        try:
            do_stack_reader(cfg)
        except Exception as e:
            say('Training the stack reader stopped:', e)
    if not robots_ok:
        return
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
 #rev,#fld{display:none} #fld .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px} #fld .top .sp{flex:1}
 #fld canvas{max-width:100%;max-height:calc(100vh - 210px);background:#000;border-radius:10px;cursor:crosshair;display:block;margin:0 auto}
 #rev .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px} #rev .top .sp{flex:1}
 .pc{border:2px solid transparent;border-radius:9px;padding:8px 16px;margin-right:8px;cursor:pointer;font-size:15px;font-weight:600;display:inline-block} .pc.on{border-color:#fff}
 .pbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:-2px 0 12px} .pbar .sp{flex:1} .fixlink{color:#8b93a7;font-size:13px} .phelp{display:inline} .phelp summary{display:inline;cursor:pointer;color:#8b93a7}
 #rev canvas{max-width:100%;max-height:calc(100vh - 210px);background:#000;border-radius:10px;cursor:crosshair;display:block;margin:0 auto}
 kbd{background:#252b38;border-radius:5px;padding:1px 7px;font:12.5px ui-monospace,Consolas,monospace;margin-right:3px}
 .keys{color:var(--dim);font-size:13px}
 dialog{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:20px;min-width:340px} dialog::backdrop{background:#000a}
 dialog label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px} dialog .row{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
.warn{color:#ffb86b}.dim{color:#8b93a7}
</style>
<header><h1>VEX Trainer</h1><span class="site" id="site"></span><span class="sp"></span>
 <span class="pill" id="keyPill">…</span><button class="ghost" onclick="openSettings()">Settings</button></header>
<main id="home">
 <div class="panel" id="key"><b>Enter the admin key once</b><div class="hint" style="margin-top:4px">The same key that is saved in the website's Settings. It is kept on this computer and sent only to your website.</div>
  <div class="row"><input id="keyIn" type="password" placeholder="Admin key" autocomplete="off" onkeydown="if(event.key==='Enter')saveKey()"><button id="bKey" onclick="saveKey()">Save</button></div><div class="hint" id="keyMsg"></div></div>
 <div class="cards">
  <div class="card"><h2>1 · Track</h2><p>Watches the matches the website sent. Starts by itself.</p>
   <div class="n" id="trackN">&nbsp;</div><button id="bTrack" onclick="start('track')">Start tracking</button></div>
  <div class="card"><h2>2 · Review</h2><p>Only frames the finder is unsure about, the hardest first. You never need to do them all.</p>
   <div class="n" id="revN">&nbsp;</div><button id="bRev" onclick="openReview(false)">Review robots</button>
   <button class="ghost" id="bVrev" style="margin-top:6px" onclick="start('vreview')" title="The vision model looks at the waiting frames first: frames where it and the finder agree are done for you, the rest come to you with its changes">Let the vision model review first</button>
   <div class="n" id="pcsN" style="margin-top:10px">&nbsp;</div><button class="ghost" id="bPcs" onclick="openReview(true)">Mark pins &amp; cups</button>
   <button class="ghost" id="bVpcs" style="margin-top:6px" onclick="start('vpieces')" title="The vision model counts the pins and cups on every goal and loader of the waiting frames: frames where its counts and the guesses agree are marked for you, the rest come to you first with its counts">Let the vision model mark pins &amp; cups first</button></div>
  <div class="card"><h2>3 · Train</h2><p>Makes a better robot finder and publishes it only if it wins.</p>
   <div class="n" id="trainN">&nbsp;</div><button id="bTrain" onclick="start('train')">Train</button>
   <div class="n" id="fieldN" style="margin-top:10px">&nbsp;</div><button class="ghost" id="bField" onclick="start('field')">Train the field finder</button></div>
 </div>
 <details class="more"><summary>More: learn from another video</summary><div class="add"><input id="src" placeholder="Optional: paste a stream link (recorded or live) or a video file's path to learn from it" autocomplete="off" onkeydown="if(event.key==='Enter'&&!$('bAdd').disabled)start('add')"><button class="ghost" id="bAdd" onclick="start('add')">Learn from this</button></div></details>
 <div class="panel"><div class="now"><b id="now">Ready.</b><button class="stop" id="bStop" style="display:none" onclick="stopJob()">Stop</button></div>
  <div class="bar idle" id="barBox"><i id="bar"></i></div><div id="eta"></div><details class="more"><summary>Details</summary><pre id="log"></pre></details></div>
 <div class="hint">To give it work: on the website, Jumper → open an event → <b>Send this event to the app</b>.</div>
</main>
<main id="rev">
 <div class="top"><button class="ghost" onclick="closeReview()">← Back</button><b id="revLeft"></b><span class="sp"></span>
  <span class="keys" id="rKeys"><kbd>click a box</kbd>remove <kbd>drag</kbd>add a robot <kbd>Enter</kbd>save, next <kbd>S</kbd>not a field view <kbd>Z</kbd>undo <kbd>B</kbd>back one</span>
  <button class="ghost" onclick="saveFrame(true)">Skip</button><button onclick="saveFrame(false)">Save, next</button></div>
 <div class="pbar" id="pBar" style="display:none"><span id="pCls"></span><span class="sp"></span>
  <a href="#" class="fixlink" onclick="event.preventDefault();$('pFix').style.display=$('pFix').style.display==='none'?'':'none'">Boxes in the wrong place?</a>
  <span id="pFix" style="display:none"><button class="ghost" id="pMove" style="display:none" onclick="moveGoals()">Move the goals</button>
  <button class="ghost" id="pRemark" style="display:none" onclick="if(cur&&cur.id)openField(cur.id.replace(/_[^_]*$/,''),cur.id)">Mark the field on this picture</button></span></div>
 <div id="cw" style="overflow:auto;max-height:calc(100vh - 210px)"><canvas id="c"></canvas></div><div class="hint" id="pMsg" style="display:none">Pick a colour, then <b>click each piece stacked on a goal or sitting in a loader</b>. Click a piece again to remove it. Scroll to zoom. <details class="phelp"><summary>Help</summary>A pin is two halves: a red-and-yellow pin is two clicks, one per colour. Click the middle of each half, and the middle of each cup. Mark every one you can see on a goal (however the stack leans) or in a loader, even half hidden; never loose pieces lying on the floor. Boxes already drawn are guesses: click away wrong ones, drag a box to move it. Keys: <kbd>1</kbd>–<kbd>4</kbd> colour, <kbd>Enter</kbd> save, <kbd>Z</kbd> undo, <kbd>B</kbd> back. If the faint goal boxes are not on the goals, use <b>Boxes in the wrong place?</b>: the other frames of the stream then follow the camera from this one.</details></div><div class="hint" id="revMsg">Green boxes are what the finder thinks are robots. Box every robot you can see, even partly hidden ones, and nothing else. <b>Two robots touching get one box each:</b> if one green box covers both, click it away and draw two, split at the gap between their drivebases.</div>
</main>
<main id="fld">
 <div class="top"><button class="ghost" onclick="closeField()">← Back</button><b id="fSay"></b><span class="sp"></span>
  <button class="ghost" id="fFind" onclick="findField()">Find it for me</button><button class="ghost" onclick="resetField()">Start again</button><button id="fSave" onclick="saveField()" disabled>Save to the website</button></div>
 <canvas id="fc"></canvas>
 <div class="hint">Marked once per stream, on a picture of the whole field. Click the four corners of the field (any order), then drag each circle onto the bottom of its real one: <b style="color:#ffe14a">yellow</b> on the nine goals, <b style="color:#ff6bd6">pink</b> on the four match loaders. It is saved to the website, the same as marking it there.</div>
</main>
<dialog id="dlg"><b>Settings</b>
 <label>Matches watched at once (4 to 8 suits an 8-core processor)</label><input id="sWorkers" type="number" min="1" max="16" style="width:100%">
 <label>Download speed</label><select id="sSpeed" style="width:100%"><option value="0">Full speed (uses the whole connection)</option><option value="40">Fast, leaves some room (40 MB/s)</option><option value="15">Gentle, fine for gaming (15 MB/s)</option><option value="5">Very gentle (5 MB/s)</option></select>
 <label><input id="sKeep" type="checkbox" style="width:auto"> Keep downloaded videos after tracking</label>
 <label title="Downloads 1080p where the stream has it: pins at the far end of the field are a few pixels tall at 720p. Bigger downloads, a little slower."><input id="sSharp" type="checkbox" style="width:auto"> Sharper pin counting (1080p downloads)</label>
 <label><input id="sThink" type="checkbox" style="width:auto"> Vision model: also say what each robot is doing, and read plates the small reader cannot</label>
 <p style="margin:2px 0 10px;font-size:13px;opacity:.75">Free, and it runs on this computer's graphics card: nothing is sent anywhere. Turning it on installs Ollama and downloads a model of about 6 GB, once. Tracking takes roughly 20 seconds longer a match. It is new and can be wrong; the website marks what came from it.</p>
 <label>Admin key</label><button class="ghost" onclick="forgetKey()">Change the admin key</button>
 <label>Trained finder</label><button class="ghost" onclick="dlg.close();start('unpublish')">Take my finder off the website</button>
 <div class="row"><button class="ghost" onclick="dlg.close()">Cancel</button><button onclick="saveSettings()">Save</button></div></dialog>
<script>
const T=new URLSearchParams(location.search).get('t')||'',$=id=>document.getElementById(id),dlg=$('dlg');
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'X-Token':T,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()};
// The review screen never sits as an empty black box: it says what went wrong.
function revTrouble(t){$('revLeft').innerHTML='<span style="color:#ff8a8a">'+t+'</span> <button class="ghost" onclick="nextFrame()">Try again</button>'}
// The picture's own size, not the size saved beside it: a size that was
// missing or wrong left the canvas at the browser's 300×150 and showed only
// the picture's corner (reported, with screenshots, on app 2.32).
function loadFrame(){const want=cur.id;img=new Image();c.style.visibility='hidden';
 img.onload=()=>{if(!cur||cur.id!==want)return;const W=img.naturalWidth||cur.w,H=img.naturalHeight||cur.h;
  if(!(W>16&&H>16)){img.onerror();return}
  if(cur.w&&cur.w!==W){const k=W/cur.w;boxes=boxes.map(b=>b.map((v,i)=>i<4?v*k:v));cur.robots=(cur.robots||[]).map(b=>b.map(v=>v*k));cur.spots=(cur.spots||[]).map(b=>b.map((v,i)=>i<4?v*k:v))}
  c.width=W;c.height=H;c.style.visibility='';draw()};
 img.onerror=()=>{const id=cur.id;revTrouble('The picture for this frame is missing on this computer; it is set aside.');api(pm?'/api/psave':'/api/save',pm?{id,skip:true,pieces:[]}:{id,skip:true,boxes:[]}).then(()=>setTimeout(()=>nextFrame(),1200))};
 img.src='/img/'+cur.id+'.jpg?t='+T}
let st=null,inReview=false;
async function poll(){try{st=await api('/api/state');paint()}catch(e){$('now').textContent='The program behind this window has stopped. Close this and run VEX_Trainer.bat again.'}}
// Redrawn only when it changed: the window repaints every second, and a
// button rebuilt between pressing and letting go loses the click (v2.36).
function setHtml(id,h){const e=$(id);if(e&&e.innerHTML!==h&&e.dataset.h!==h){e.innerHTML=h;e.dataset.h=h}}
function paint(){
 $('site').textContent=st.site.replace(/^https?:\/\//,'');
 $('keyPill').textContent=st.key?'Admin key saved':'No admin key';$('keyPill').className='pill '+(st.key?'ok':'bad');
 $('key').style.display=st.key?'none':'block';
 const goal=st.gold<100?100:st.gold<300?300:Math.ceil((st.gold+1)/150)*150;
 $('revN').textContent=st.gold+' of '+goal+' done'+(st.gold<100?' · '+(100-st.gold)+' more and it can train':st.gold<300?' · it can train now; 300 is better':' · plenty; more still helps')+(st.sure?' · '+st.sure+' it was sure about are not asked':'');
 $('bRev').disabled=!st.waiting;
 const Pc=st.pieces||{marked:0,left:0,need:60},PL=Pc.last;
 setHtml('pcsN','Pins &amp; cups: '+Pc.marked+' of '+(Pc.marked<Pc.need?Pc.need:Math.max(150,Math.ceil((Pc.marked+1)/100)*100))+' marked'+(Pc.marked<Pc.need?' · '+(Pc.need-Pc.marked)+' more and it can train':'')+
  (Pc.guess?'<br><span class="dim">Guesses drawn by: '+(Pc.guess==='helper'?'the marking helper (trained on '+Pc.helper+' frames)':Pc.guess==='trained'?'the trained finder':'colours'+(Pc.marked<20?' (a helper takes over after 20 marked)':''))+' · most useful frames first</span>':'')+
  (PL?'<br>'+(PL.use?'Trained finder in use':'Colour finder in use')+' · pin halves '+(PL.use?PL.new:PL.colour)+(PL.use?' (colours: '+PL.colour+')':'')+' · cups '+PL.cups:'')+
  // v2.35: when there is nothing to mark, say why. Reported: the button greyed out, nothing said.
  (Pc.counted===false?'<br><span class="dim">Counting the frames…</span>':!Pc.left&&Pc.why?'<br><span class="warn">'+(!Pc.why.reviewed?'Nothing to mark yet: pins and cups are marked on frames whose robots you have reviewed. Review some robot frames first.':Pc.why.unmarked&&Pc.why.unmarked.length?'Nothing to mark yet: your reviewed frames come from '+(Pc.why.unmarked.length===1?'a stream':'streams')+' whose field is not marked. Mark it here, once a stream:</span><br>'+Pc.why.unmarked.map(u=>'<button class="ghost" style="margin:4px 6px 0 0" onclick="openField(\''+esc(u[0])+'\')">Mark the field: '+esc(u[0])+' ('+u[1]+' frame'+(u[1]===1?'':'s')+')</button>').join('')+'<span>':'Every reviewed frame from a marked stream is done. Review more robot frames to get more.')+'</span>':''));
 $('bPcs').disabled=Pc.counted!==false&&!Pc.left;
 $('bVpcs').disabled=st.busy||!st.think||!((st.pieces||{}).left);$('bVpcs').title=st.think?'The vision model counts the pins and cups on every goal and loader of the waiting frames: frames where its counts and the guesses agree are marked for you, the rest come to you first with its counts':'Turn on the vision model in Settings first';
 $('bVrev').disabled=st.busy||!st.think;$('bVrev').title=st.think?'The vision model looks at the waiting frames first: frames where it and the finder agree are done for you, the rest come to you with its changes':'Turn on the vision model in Settings first';
 $('trackN').textContent=st.task==='track'?'Running':' ';
 const need=Math.max(0,150-st.gold);
 const L=st.last,since=L?Math.max(0,st.gold-L.frames):0;
 {const Fd=st.field||{};$('fieldN').innerHTML=st.task==='field'?'The field finder is training: the bar below shows how far along.':Fd.ready?('Field finder: trained on '+Fd.on+' streams ('+Fd.when+')'+(Fd.corners!=null?' · off by about '+Fd.corners+'% on streams it never saw':'')+(Fd.streams>Fd.on?' · '+(Fd.streams-Fd.on)+' more marked since':'')):('Field finder: learns from your field marks · '+Fd.streams+' of '+Fd.need+' streams marked');$('bField').disabled=!!st.busy||(Fd.streams||0)<(Fd.need||3)}
 $('trainN').innerHTML=st.task==='train'?'Training now. The bar below shows how far along.':need?(((st.pieces||{}).marked||0)>=((st.pieces||{}).need||60)?'Ready to train the pin &amp; cup finder. Robots: review '+need+' more frames first':'Review '+need+' more frames first'):!L?(st.gold+' reviewed frames ready'):
  ('<b>'+(L.published?'Finished and published':'Finished, not published (it was no better)')+'</b>'+(L.when?' · '+L.when:'')+'<br>Trained on '+L.frames+' frames you reviewed'+(L.auto?' + '+L.auto+' it was sure of':'')+(L.rounds?', '+L.rounds+' rounds':'')+
   '<br>Score: new '+L.new+' vs old '+L.old+(since?'<br>'+since+' more reviewed since then':''));
 const pNeed=Math.max(0,((st.pieces||{}).need||60)-((st.pieces||{}).marked||0));
 for(const b of ['bTrack','bTrain','bAdd'])$(b).disabled=st.busy||(b==='bTrain'&&need>0&&pNeed>0)||(b==='bTrack'&&!st.key);
 $('bStop').style.display=st.busy?'':'none';
 const names={helper:'Training the marking helper',vreview:'The vision model is reviewing',think:'Getting the vision model ready',track:'Tracking',train:'Training',add:'Learning from a video',unpublish:'Removing the finder'};
 const last=(st.log.filter(l=>l.trim()).pop()||'').trim();
 const P=st.busy?st.progress:null,box=$('barBox'),eta=$('eta');
 // A real bar: how much is done, and how long is left at the pace so far.
 // Nothing to measure yet → a moving stripe; waiting for work → no bar at all.
 if(P&&P.total){const pct=Math.min(100,100*P.done/P.total),mb=/Downloading/.test(P.stage);
  box.className='bar';$('bar').style.width=pct+'%';
  $('now').textContent=P.stage+(P.sub?' · '+P.sub:'');
  eta.innerHTML='<span>'+(mb?Math.round(P.done/1e6)+' of '+Math.round(P.total/1e6)+' MB':Math.floor(P.done)+' of '+Math.round(P.total)+(/match/i.test(P.stage)?' matches':''))+' · '+Math.floor(pct)+'%</span><span>'+left(P.left)+'</span>';}
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
function openSettings(){$('sWorkers').value=st.workers;$('sKeep').checked=st.keep;$('sSharp').checked=!!st.sharp;$('sThink').checked=!!st.think;$('sSpeed').value=String(st.speed||0);dlg.showModal()}
async function saveSettings(){await api('/api/settings',{workers:+$('sWorkers').value,keep:$('sKeep').checked,sharp:$('sSharp').checked,think:$('sThink').checked,speed:+$('sSpeed').value});dlg.close();poll()}
// review
const c=$('c'),x=c.getContext('2d');let cur=null,img=new Image(),boxes=[],hist=[],drag=null,back=[],pm=false,pc=2,zoom=1;
// Pins & cups: one class for each half's colour, one for cups.
const PN=['red half','blue half','yellow half','cup'],PCOL=['#ff4d4d','#4da3ff','#ffd23f','#e8e8e8'];
function clsBar(){$('pCls').innerHTML=PN.map((n,i)=>'<span class="pc'+(i===pc?' on':'')+'" style="background:'+PCOL[i]+'33;color:'+PCOL[i]+'" onclick="pc='+i+';clsBar()" title="key '+(i+1)+'">'+n[0].toUpperCase()+n.slice(1)+'</span>').join('')}
function setZoom(z){zoom=Math.max(1,Math.min(6,z));if(zoom===1){c.style.maxWidth='100%';c.style.maxHeight='calc(100vh - 210px)';c.style.width=''}else{c.style.maxWidth='none';c.style.maxHeight='none';c.style.width=($('cw').clientWidth*zoom)+'px'}}
c.addEventListener('wheel',e=>{if(!pm)return;e.preventDefault();const r=c.getBoundingClientRect(),fx=(e.clientX-r.left)/r.width,fy=(e.clientY-r.top)/r.height,w=$('cw');setZoom(zoom*(e.deltaY<0?1.25:0.8));const r2=c.getBoundingClientRect();w.scrollLeft+=r2.width*fx-(e.clientX-r.left)-(r2.left-r.left);w.scrollTop+=r2.height*fy-(e.clientY-r.top)-(r2.top-r.top)},{passive:false});
function openReview(p){pm=!!p;back=[];setZoom(1);inReview=true;$('home').style.display='none';$('rev').style.display='block';
 $('rKeys').style.display=pm?'none':'';$('pBar').style.display=pm?'flex':'none';$('pMsg').style.display=pm?'':'none';$('revMsg').style.display=pm?'none':'';if(pm)clsBar();nextFrame()}
// Marking the field in the app (v2.36). Asked: "can i mark the field in the app??"
let F=null;const fc=$('fc'),fx=fc.getContext('2d');
async function openField(vid,id){let r;try{r=await api('/api/fframe?vid='+encodeURIComponent(vid)+(id?'&id='+encodeURIComponent(id):''))}catch(e){r={error:e.message}}
 F0=$('rev').style.display==='block'?{back:true}:null;
 $('home').style.display='none';$('rev').style.display='none';$('fld').style.display='block';inReview=true;
 if(r.error){$('fSay').textContent=r.error;return}
 F={vid,id:r.id,t:r.t,pts:[],spots:null,drag:-1,img:new Image()};$('fSave').disabled=true;
 F.img.onload=()=>{fc.width=F.img.naturalWidth;fc.height=F.img.naturalHeight;drawField();if(r.auto)findField()};F.img.src='/img/'+r.id+'.jpg?t='+T;fieldSay()}
let F0=null;
function closeField(){F=null;$('fld').style.display='none';if(F0&&F0.back){F0=null;$('rev').style.display='block';inReview=true;nextFrame(cur&&cur.id)}else{inReview=false;$('home').style.display='block';poll()}}
// The field finder trained on your marks (v2.47), else the vision model (v2.40), finds the corners, goals and loaders; the person checks them and drags any that are off.
async function findField(){if(!F)return;$('fFind').disabled=true;$('fSay').textContent='Looking for the field…';
 let r;try{r=await api('/api/ffind',{id:F.id})}catch(e){r={error:e.message}}$('fFind').disabled=false;
 if(!F)return;if(r.error){$('fSay').textContent=r.error;return}
 F.pts=r.pts;F.spots=r.spots;$('fSave').disabled=false;$('fSay').textContent='Found by the '+(r.how||'vision model')+'. Check the outline and every circle: drag any that are off, then Save';drawField()}
function resetField(){if(!F)return;F.pts=[];F.spots=null;$('fSave').disabled=true;fieldSay();drawField()}
function fieldSay(){$('fSay').textContent=!F?'':F.spots?'Drag each circle onto its real goal or loader, then Save':'Click corner '+(F.pts.length+1)+' of 4'}
function fpos(e){const r=fc.getBoundingClientRect();return[(e.clientX-r.left)*fc.width/r.width,(e.clientY-r.top)*fc.height/r.height]}
function drawField(){if(!F||!F.img.complete)return;fx.drawImage(F.img,0,0);const R=Math.max(8,fc.width/90);fx.lineWidth=Math.max(2,fc.width/500);
 if(F.pts.length>=2){fx.strokeStyle='#fff';fx.beginPath();const P=F.spots?orderPts(F.pts):F.pts;P.forEach((p,i)=>i?fx.lineTo(p[0],p[1]):fx.moveTo(p[0],p[1]));if(P.length===4)fx.closePath();fx.stroke()}
 for(const p of F.pts){fx.fillStyle='#fff';fx.beginPath();fx.arc(p[0],p[1],R*0.6,0,7);fx.fill()}
 if(F.spots)F.spots.forEach((p,k)=>{fx.strokeStyle=k<9?'#ffe14a':'#ff6bd6';fx.fillStyle='rgba(0,0,0,.35)';fx.beginPath();fx.arc(p[0]*fc.width,p[1]*fc.height,R,0,7);fx.fill();fx.stroke();
  fx.fillStyle='#fff';fx.font='bold '+Math.round(R*1.1)+'px sans-serif';fx.textAlign='center';fx.textBaseline='middle';fx.fillText(k<9?String(k+1):'L',p[0]*fc.width,p[1]*fc.height)})}
function orderPts(P){const cx=P.reduce((a,p)=>a+p[0],0)/P.length,cy=P.reduce((a,p)=>a+p[1],0)/P.length;return P.slice().sort((a,b)=>Math.atan2(a[1]-cy,a[0]-cx)-Math.atan2(b[1]-cy,b[0]-cx))}
fc.onmousedown=async e=>{if(!F)return;const[px,py]=fpos(e);
 if(!F.spots){if(F.pts.length>=4)return;F.pts.push([px,py]);fieldSay();drawField();
  if(F.pts.length===4){const q=F.pts.flatMap(p=>[p[0]/fc.width,p[1]/fc.height]);const r=await api('/api/fspots',{q});if(r.error){$('fSay').textContent=r.error;F.pts=[];drawField();return}F.spots=r.spots;$('fSave').disabled=false;fieldSay();drawField()}return}
 let best=-1,bd=Math.max(14,fc.width/60);F.spots.forEach((p,k)=>{const d=Math.hypot(p[0]*fc.width-px,p[1]*fc.height-py);if(d<bd){bd=d;best=k}});F.drag=best};
fc.onmousemove=e=>{if(!F||F.drag<0)return;const[px,py]=fpos(e);F.spots[F.drag]=[Math.min(1,Math.max(0,px/fc.width)),Math.min(1,Math.max(0,py/fc.height))];drawField()};
window.addEventListener('mouseup',()=>{if(F)F.drag=-1});
async function saveField(){if(!F||!F.spots)return;$('fSave').disabled=true;$('fSay').textContent='Saving…';
 const q=F.pts.flatMap(p=>[p[0]/fc.width,p[1]/fc.height]),r=await api('/api/fsave',{vid:F.vid,id:F.id,q,g:F.spots.slice(0,9).flat(),l:F.spots.slice(9).flat(),t:F.t});
 if(r.error){$('fSay').textContent='Not saved: '+r.error;$('fSave').disabled=false;return}
 $('fSay').textContent='Saved to the website. Pins and cups can now be marked on this stream\'s frames.'+(r.learning?' The field finder is learning from your marks now.':'');setTimeout(closeField,r.learning?3000:1800)}
function closeReview(){inReview=false;$('rev').style.display='none';$('home').style.display='block';poll()}
async function nextFrame(id){$('pRemark').style.display='none';$('pMove').style.display='none';gm=false;if(pm)return nextPieces(id);$('revLeft').textContent='Loading the next frame…';c.style.visibility='hidden';try{cur=await api('/api/next'+(id?'?id='+id:''))}catch(e){revTrouble('The app did not answer ('+e.message+').');return}
 if(cur.error){revTrouble('Could not load a frame: '+cur.error);return}if(!cur.id){closeReview();return}
 if(cur.vlm)setTimeout(()=>{const v=cur.vlm,bits=[];if(v.removed&&v.removed.length)bits.push('took away '+v.removed.length+' ('+v.removed.join(', ')+')');if(v.added)bits.push('added '+v.added+' it thinks the finder missed');if(bits.length)$('revLeft').textContent+=' · The vision model '+bits.join(' and ')+'. Check them.'},0);
 const g=cur.gold||0,goal=g<150?150:g<300?300:Math.ceil((g+1)/150)*150;$('revLeft').textContent=g+' of '+goal+' done'+(g<150?' · '+(150-g)+' to go until it can train':' · enough to train; stop whenever you like');boxes=(cur.boxes||[]).map(b=>b.slice(0,4));hist=[];loadFrame()}
async function nextPieces(id){$('revLeft').textContent='Loading the next frame…';c.style.visibility='hidden';try{cur=await api('/api/pnext'+(id?'?id='+id:''))}catch(e){revTrouble('The app did not answer ('+e.message+').');return}
 if(cur.error){revTrouble('Could not load a frame: '+cur.error);return}if(!cur.id){closeReview();return}
 const m=cur.marked||0,goal=m<60?60:m<150?150:Math.ceil((m+1)/100)*100;$('revLeft').textContent=m+' of '+goal+' marked'+(m<60?' · '+(60-m)+' to go until it can train':' · enough to train; more makes it better');
 $('pRemark').style.display='';$('pMove').style.display=(cur.spots||[]).length?'':'none';gm=false;$('pMove').textContent='Move the goals';
 $('pFix').style.display=(cur.spots||[]).length?'none':'';
 if(!(cur.spots||[]).length)$('revLeft').textContent='Not the view the field was marked on: Skip it, or mark the field on it.';
 else if(cur.vlm)$('revLeft').textContent+=' · '+cur.vlm;
 boxes=(cur.pieces||[]).map(b=>b.slice(0,5));hist=[];loadFrame()}
function draw(){x.drawImage(img,0,0);
 if(pm){x.lineWidth=Math.max(1,c.width/1400);x.setLineDash([]);
  x.lineWidth=Math.max(1.5,c.width/1100);for(const b of boxes){x.strokeStyle=PCOL[b[4]]||'#fff';x.strokeRect(b[0],b[1],b[2],b[3])}
  x.setLineDash([3,4]);x.lineWidth=Math.max(1.5,c.width/900);x.strokeStyle='#ffd23f';if(gm){x.setLineDash([]);x.lineWidth=Math.max(2,c.width/500)}for(const s of cur.spots||[]){x.globalAlpha=gm?1:0.3;x.strokeRect(s[0],s[1],s[2]-s[0],s[3]-s[1]);x.globalAlpha=1;if(gm&&s.length>7){x.fillStyle='#ffd23f';x.beginPath();x.arc(s[6],s[7],Math.max(3,c.width/(gm?250:400)),0,7);x.fill()}}x.setLineDash([]);
  if(drag&&drag.w){x.strokeStyle=PCOL[pc];x.strokeRect(drag.x,drag.y,drag.w,drag.h)}return}
 x.lineWidth=Math.max(2,c.width/450);for(const b of boxes){x.strokeStyle='#39ff88';x.strokeRect(b[0],b[1],b[2],b[3])}
 if(drag&&drag.w){x.strokeStyle='#ffd23f';x.strokeRect(drag.x,drag.y,drag.w,drag.h)}}
function pos(e){const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]}
// Pins & cups (v2.38): a box is a set size for where it is; press on a box and
// drag to move it, press on a goal or loader to put a new one there and drag
// it into place; a press without moving on a box removes it. "Move the
// goals": drag a goal's or loader's dotted shape (its size stays) onto the
// real one, then Save goals.
let gm=false;
async function moveGoals(){if(!cur)return;if(!gm){gm=true;$('pMove').textContent='Save goals';flash('Drag each dotted shape onto its real goal or loader, then press Save goals.');draw();return}
 const r=await api('/api/fmove',{id:cur.id,spots:(cur.spots||[]).map(s=>[s[5],s[0],s[1],s[2],s[3]])});
 if(r.error){flash('Not saved: '+r.error);return}gm=false;$('pMove').textContent='Move the goals';flash('Saved. The other frames of this stream follow the camera from this one.');nextFrame(cur.id)}
function sizedBox(px,py,s){const u=s[4]/3658,w=(pc===3?95:70)*u,h=(pc===3?165:95)*u;return[px-w/2,py-h/2,w,h,pc]}
function boxAt(px,py){let k=-1,a=1e12;boxes.forEach((b,i)=>{if(px>=b[0]&&px<=b[0]+b[2]&&py>=b[1]&&py<=b[1]+b[3]&&b[2]*b[3]<a){a=b[2]*b[3];k=i}});return k}
function spotIdx(px,py){return (cur.spots||[]).findIndex(s=>px>=s[0]&&px<=s[2]&&py>=s[1]&&py<=s[3])}
c.onmousedown=e=>{const[px,py]=pos(e);
 if(pm&&gm){const k=spotIdx(px,py);if(k>=0)drag={mode:'goal',k,lx:px,ly:py};return}
 if(pm){const k=boxAt(px,py);hist.push(boxes.map(b=>b.slice()));
  if(k>=0){drag={mode:'box',k,lx:px,ly:py,x0:px,y0:py,moved:false};return}
  const s=spotAt(px,py);if(!s){hist.pop();flash('Only on a goal or loader (inside a dotted box). Loose pieces on the floor are not marked.');return}
  boxes.push(sizedBox(px,py,s));drag={mode:'box',k:boxes.length-1,lx:px,ly:py,x0:px,y0:py,moved:true,fresh:true};draw();return}
 drag={x0:px,y0:py,x:px,y:py,w:0,h:0}};
c.onmousemove=e=>{if(!drag)return;const[px,py]=pos(e);
 if(drag.mode==='goal'){const s=cur.spots[drag.k],dx=px-drag.lx,dy=py-drag.ly;for(const i of [0,2,6])if(s[i]!==undefined)s[i]+=dx;for(const i of [1,3,7])if(s[i]!==undefined)s[i]+=dy;drag.lx=px;drag.ly=py;draw();return}
 if(drag.mode==='box'){const b=boxes[drag.k],dx=px-drag.lx,dy=py-drag.ly;b[0]+=dx;b[1]+=dy;drag.lx=px;drag.ly=py;if(Math.hypot(px-drag.x0,py-drag.y0)>3)drag.moved=true;draw();return}drag.x=Math.min(px,drag.x0);drag.y=Math.min(py,drag.y0);drag.w=Math.abs(px-drag.x0);drag.h=Math.abs(py-drag.y0);draw()};
window.onmouseup=()=>{if(!drag)return;const d=drag;drag=null;
 if(d.mode==='goal')return;
 if(d.mode==='box'){const b=boxes[d.k];if(!d.moved){boxes.splice(d.k,1)}else if(b&&!spotAt(b[0]+b[2]/2,b[1]+b[3]/2)){boxes.splice(d.k,1);flash('Only on a goal or loader (inside a dotted box).')}draw();return}
 hist.push(boxes.map(b=>b.slice()));
 if(pm&&d.w>=6&&d.h>=6)boxes.push([d.x,d.y,d.w,d.h,pc]);
 else if(pm&&!onBox(d.x0,d.y0)){const s=spotAt(d.x0,d.y0);if(s){const u=s[4]/3658,w=(pc===3?95:70)*u,h=(pc===3?165:95)*u;boxes.push([d.x0-w/2,d.y0-h/2,w,h,pc])}else{hist.pop();flash('Only on a goal or loader (inside a dotted box). Loose pieces on the floor are not marked.')}}
 else if(!pm&&d.w>8&&d.h>8)boxes.push([d.x,d.y,d.w,d.h]);
 else{let k=-1,a=1e12;boxes.forEach((b,i)=>{if(d.x0>=b[0]&&d.x0<=b[0]+b[2]&&d.y0>=b[1]&&d.y0<=b[1]+b[3]&&b[2]*b[3]<a){a=b[2]*b[3];k=i}});if(k>=0)boxes.splice(k,1);else hist.pop()}draw()};
// Pins & cups: a click places one of the chosen colour, sized for where it is (v2.25).
function onBox(x0,y0){return boxes.some(b=>x0>=b[0]&&x0<=b[0]+b[2]&&y0>=b[1]&&y0<=b[1]+b[3])}
// On a goal only in its column, on or above its base; over a loader anywhere in its box (v2.37).
function spotAt(x0,y0){return (cur.spots||[]).find(s=>x0>=s[0]&&x0<=s[2]&&y0>=s[1]&&y0<=s[3])}
function flash(t){const m=$('pMsg');if(!m)return;if(m.dataset.base===undefined)m.dataset.base=m.innerHTML;m.innerHTML='<b>'+t+'</b>';clearTimeout(flash.t);flash.t=setTimeout(()=>{m.innerHTML=m.dataset.base},2600)}
async function saveFrame(skip){if(!cur||!cur.id)return;back.push(cur.id);if(pm){const r=await api('/api/psave',{id:cur.id,skip,pieces:boxes});if(r&&r.helper)setTimeout(()=>flash('A helper is training on your marks (a few minutes): the guesses get better after it. Keep going.'),300)}else await api('/api/save',{id:cur.id,skip,boxes});nextFrame()}
window.onkeydown=e=>{if(!inReview||dlg.open)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();saveFrame(false)}else if(/^s$/i.test(e.key))saveFrame(true);
 else if(pm&&/^[1-4]$/.test(e.key)){pc=+e.key-1;clsBar()}else if(/^z$/i.test(e.key)){if(hist.length){boxes=hist.pop();draw()}}else if(/^b$/i.test(e.key)){if(back.length)nextFrame(back.pop())}else if(e.key==='Escape')closeReview()};
let polling=0;async function tick(){if(!inReview&&!polling){polling=1;try{await poll()}finally{polling=0}}setTimeout(tick,1000)}tick();
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
            sub = str(d.get('u') or '')[:120]
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
        self.prog = {'s': stage, 'd': done, 't': total, 'u': sub, 'ends': None if left is None else now + left}

    def progress(self):
        """→ what the window shows: stage, share done, seconds left (None while it cannot say yet)."""
        p = self.prog if self.busy() else None
        if not p:
            return None
        now = time.time()
        if 'wait_until' in p:
            return {'stage': p['s'], 'wait': max(0, int(round(p['wait_until'] - now)))}
        return {'stage': p['s'], 'done': p['d'], 'total': p['t'], 'sub': p.get('u', ''), 'left': None if p['ends'] is None else max(0, int(round(p['ends'] - now)))}

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

    # v2.27: worked out off to one side, never while the window waits. The
    # window asks for its status every second; when working these out took
    # longer than that, the asks queued up behind each other and clicks
    # waited behind them (reported: the window "kind of frozen").
    working, work_lock = set(), threading.Lock()
    def later(name, fn):
        with work_lock:
            if name in working:
                return
            working.add(name)
        def run():
            try:
                fn()
            except Exception as e:
                say('  window: could not count the %s frames (%s)' % (name, e))
            finally:
                with work_lock:
                    working.discard(name)
        threading.Thread(target=run, daemon=True).start()

    count_lock = threading.Lock()
    def count_review():
        with count_lock:
            q, done = review_queue()
            queue_cache.update(at=time.time(), queue=q, done=done, gold=len(reviewed()) if done else 0)

    def counts(force=False, wait=False):
        """`wait`: work it out now if it never has been (the review screen needs the list)."""
        if force or (wait and not queue_cache['at']):
            count_review()
        elif time.time() - queue_cache['at'] > 60:     # ordering a thousand frames takes a moment; not every poll
            later('review', count_review)
        return queue_cache

    pcache = {'at': 0, 'queue': [], 'marked': 0, 'why': None}
    plock = threading.Lock()
    def count_pieces():
        with plock:
            q = pieces_queue(qsite())
            try:
                q = rank_pieces(q)                       # most useful first (v2.42)
            except Exception as e:
                say('  could not rank the pin frames (%s)' % e)
            why = pieces_why(qsite()) if not q else {'reviewed': 0, 'unmarked': []}
            pcache.update(at=time.time(), queue=q, marked=len(pieces_marked()), why=why)

    def pcounts(wait=False):
        if wait and not pcache['at']:
            count_pieces()
        elif time.time() - pcache['at'] > 20:
            later('pins', count_pieces)
        return pcache

    pf_holder = {}
    def pfinder(path=None):
        path = path or pieces_file()
        key = (path, os.path.getmtime(path) if os.path.exists(path) else 0)
        if pf_holder.get('fk') != key:                   # a new helper or finder: loaded again
            f = PieceFinder(path, prov=['CPUExecutionProvider'])
            pf_holder['f'], pf_holder['fk'] = (lambda fr, sp: f.find_spots(fr, sp)), key
        return pf_holder['f']

    def qsite():
        if 's' not in pf_holder:
            pf_holder['s'] = Site(cfg)
        return pf_holder['s']

    def last_pieces():
        try:
            with open(pieces_info_file()) as f:
                i = json.load(f)
            return {'when': i.get('when', ''), 'use': bool(i.get('use')), 'beat': i.get('beat', True), 'frames': i.get('frames', 0),
                    'new': '%.1f' % (i['new']['halves'][2] * 100), 'colour': '%.1f' % (i['colour']['halves'][2] * 100), 'cups': '%.1f' % (i['new']['cups'][2] * 100)}
        except Exception:
            return None

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
        def _send(self, code, body, ctype='application/json', cors=None):
            body = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            if cors:
                self.send_header('Access-Control-Allow-Origin', cors)
                self.send_header('Vary', 'Origin')
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
            # Anything that goes wrong comes back to the window as words to
            # show (reported: the review screen stayed an empty black box).
            try:
                return self._get()
            except Exception as e:
                say('  window: %s failed: %s' % (self.path.split('?')[0], e))
                try:
                    return self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
                except Exception:
                    pass

        def _ask_origin(self):
            """The website (or this computer) asking a question: its origin, else None."""
            o = (self.headers.get('Origin') or '').rstrip('/')
            return o if o in ASK_ORIGINS else None
        def do_OPTIONS(self):
            # The website asks first whether it may (a browser's check before
            # a page on the internet talks to this computer): only for /ask.
            o = self._ask_origin()
            if not o or not self.path.startswith('/ask'):
                self.send_response(403); self.end_headers(); return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Vary', 'Origin')
            self.end_headers()
        def _get(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == '/ask/ping':
                o = self._ask_origin()
                if not o:
                    return self._send(403, {'error': 'not allowed'})
                return self._send(200, {'ok': True, 'think': bool(load_config().get('think')), 'app': VERSION}, cors=o)
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
                c, P = counts(), pcounts()
                return self._send(200, {'version': VERSION, 'site': cfg['site'], 'key': bool(cfg.get('key')), 'busy': job.busy(), 'task': job.task if job.busy() else '',
                                        'log': job.lines(), 'progress': job.progress(), 'waiting': len(c['queue']), 'sure': _SURE[0], 'done': c['done'], 'gold': c['gold'], 'workers': cfg.get('workers', 4),
                                        'keep': bool(cfg.get('keep_videos')), 'sharp': bool(cfg.get('sharp')), 'think': bool(cfg.get('think')), 'pieces': {'marked': P['marked'], 'left': len(P['queue']), 'counted': bool(P['at']), 'why': P.get('why'), 'guess': guess_source()[0], 'helper': helper_info().get('marks', 0), 'need': PIECE_NEED, 'last': last_pieces()}, 'speed': cfg.get('max_mbps', 0), 'last': last_train(), 'field': field_status()})
            if u.path == '/api/fframe':
                qs_ = urllib.parse.parse_qs(u.query)
                vid, want = qs_.get('vid', [''])[0], qs_.get('id', [''])[0]
                if not re.fullmatch(r'[A-Za-z0-9_-]{6,20}', vid):
                    return self._send(400, {'error': 'bad stream'})
                pick = field_frame(vid, want if re.fullmatch(r'[A-Za-z0-9_-]+', want or '') else None)
                if not pick:
                    return self._send(200, {'error': 'No saved picture from this stream on this computer. Mark it on the website instead.'})
                # With a field finder (v2.47), a stream not yet marked opens with its answer drawn in.
                pick = dict(pick, auto=os.path.exists(field_file()) and not quad_for(vid))
                return self._send(200, pick)
            if u.path == '/api/pnext':
                P = pcounts(wait=True)
                want = urllib.parse.parse_qs(u.query).get('id', [None])[0]
                if want and re.fullmatch(r'[A-Za-z0-9_-]+', want) and os.path.exists(os.path.join(LABELS, want + '.json')):
                    name = want
                else:
                    name = P['queue'][0] if P['queue'] else None
                    # Frames the vision model counted differently come first (v2.48).
                    for n_ in P['queue'][:200]:
                        try:
                            with open(os.path.join(PROPS, n_ + '.json')) as f_:
                                pv_ = json.load(f_).get('pvlm')
                        except Exception:
                            pv_ = None
                        if pv_ and not pv_.get('agree'):
                            name = n_
                            break
                if not name:
                    return self._send(200, {'id': None, 'marked': P['marked']})
                with open(os.path.join(PROPS, name + '.json')) as f:
                    p = json.load(f)
                lab = lab_read(name)
                robots = lab.get('boxes', [])
                vid = name.rsplit('_', 1)[0]
                q = quad_for(vid, qsite())
                spots = frame_spots(name)
                units = spot_units(p['w'], p['h'], q) or []
                if 'pieces' in lab:                      # going back: what was saved
                    pieces = clean_pieces(lab['pieces'])
                else:
                    import cv2
                    frame = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
                    pieces = []
                    if frame is not None:
                        # The marking helper's guesses, or the trained finder's (cups too), else the colours', in the spots only.
                        try:
                            src = guess_source()
                            pieces = [b[:4] + [b[5]] for b in pfinder(src[1])(frame, spots)] if src[1] else pieces_from_colour(frame, robots, spots)
                        except Exception:
                            pieces = pieces_from_colour(frame, robots, spots)
                return self._send(200, {'id': name, 'w': p['w'], 'h': p['h'], 'pieces': [[round(v, 1) for v in b[:4]] + [int(b[4])] for b in pieces], 'vlm': pvlm_text(p.get('pvlm')),
                                        'robots': robots, 'spots': [s + [units[k], k] + list(spot_foot_px(k, s)[:2]) for k, s in enumerate(spots) if s and k < len(units)], 'left': len(P['queue']), 'marked': P['marked']})
            if u.path == '/api/next':
                c = counts(wait=True)
                want = urllib.parse.parse_qs(u.query).get('id', [None])[0]
                if want and re.fullmatch(r'[A-Za-z0-9_-]+', want) and os.path.exists(os.path.join(PROPS, want + '.json')):
                    name = want
                else:
                    name = c['queue'][0] if c['queue'] else None
                if not name:
                    return self._send(200, {'id': None, 'done': c['done']})
                with open(os.path.join(PROPS, name + '.json')) as f:
                    p = json.load(f)
                import cv2
                pic = cv2.imread(os.path.join(FRAMES, name + '.jpg'))
                if pic is not None and not want and looks_broken(pic) and getattr(self, '_skips', 0) < 40:
                    self._skips = getattr(self, '_skips', 0) + 1
                    lab_write(name, skip=True, boxes=[], broken=True)   # garbled: set aside, the next one comes
                    if name in c['queue']:
                        c['queue'].remove(name)
                    return self._get()
                if pic is not None:
                    p['h'], p['w'] = pic.shape[:2]
                boxes = [b for b in p['boxes'] if b[4] >= 0.35]
                said = None
                if p.get('vlm'):                         # what the vision model thought, already applied (v2.40)
                    keep, _ = vlm_verdict(p['vlm'])
                    gone = [w for w in p['vlm'].get('what', []) if w != 'robot' and w != '?']
                    boxes, said = [b[:4] + [1.0] for b in keep], {'removed': gone, 'added': len(p['vlm'].get('missed', []))}
                lab = os.path.join(LABELS, name + '.json')
                if os.path.exists(lab):                  # going back: show what was saved
                    with open(lab) as f:
                        boxes = json.load(f).get('boxes', boxes)
                return self._send(200, {'id': name, 'w': p['w'], 'h': p['h'], 'boxes': boxes, 'vlm': said, 'left': len(c['queue']), 'done': c['done'], 'gold': c['gold']})
            self._send(404, {})
        def do_POST(self):
            try:
                return self._post()
            except Exception as e:
                say('  window: %s failed: %s' % (self.path.split('?')[0], e))
                try:
                    return self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
                except Exception:
                    pass

        def _post(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == '/ask':
                o = self._ask_origin()
                if not o:
                    return self._send(403, {'error': 'not allowed'})
                try:
                    n = int(self.headers.get('Content-Length', 0))
                    if n > ASK_MAX_BYTES:
                        return self._send(413, {'error': 'too much'}, cors=o)
                    q = json.loads(self.rfile.read(n).decode('utf-8') or '{}')
                except Exception:
                    return self._send(400, {'error': 'bad request'}, cors=o)
                return self._send(200, ask_answer(load_config(), q), cors=o)
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
                lab_write(name, skip=bool(body.get('skip')), boxes=boxes)
                c = counts(wait=True)
                if name in c['queue']:
                    c['queue'].remove(name)
                    c['done'] += 1
                    c['gold'] += 0 if body.get('skip') else 1
                return self._send(200, {'ok': True})
            if u.path == '/api/ffind':
                name = str(body.get('id', ''))
                if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
                    return self._send(400, {'error': 'bad frame'})
                return self._send(200, find_field(cfg, name))
            if u.path == '/api/fspots':
                q = body.get('q')
                if not (isinstance(q, list) and len(q) == 8 and all(isinstance(v, (int, float)) for v in q)):
                    return self._send(400, {'error': 'bad corners'})
                sp = first_spots(q)
                return self._send(200, {'spots': sp} if sp else {'error': 'Those four points do not make a field. Start again.'})
            if u.path == '/api/fmove':
                ok_, why_ = move_spots(cfg, body)
                return self._send(200, {'ok': True} if ok_ else {'error': why_})
            if u.path == '/api/fsave':
                ok_, why_ = save_field(cfg, body)
                learning = False
                if ok_:
                    pcache['at'] = min(pcache['at'], time.time() - 21)      # counted again, off to one side
                    # Every few streams marked, the field finder learns from them again (v2.47).
                    if cfg.get('field_auto', True) and not job.busy() and field_due():
                        job.start('field', ['--field-finder', '--auto'])
                        learning = True
                return self._send(200, {'ok': True, 'learning': learning} if ok_ else {'error': why_})
            if u.path == '/api/psave':
                name = str(body.get('id', ''))
                if not re.fullmatch(r'[A-Za-z0-9_-]+', name) or not os.path.exists(os.path.join(LABELS, name + '.json')):
                    return self._send(400, {'error': 'bad id'})
                if body.get('skip'):
                    lab_write(name, pskip=True)
                else:
                    lab_write(name, pieces=clean_pieces(body.get('pieces')), pskip=False, pby=None)
                if name in pcache['queue']:          # off the list now; counted again properly soon, off to one side
                    pcache['queue'].remove(name)
                    pcache['marked'] += 0 if body.get('skip') else 1
                pcache['at'] = min(pcache['at'], time.time() - 15)
                helping = False
                if not body.get('skip') and cfg.get('helper', True) and not job.busy() and helper_due(pcache['marked']):
                    job.start('helper', ['--quick-pieces'])  # trains while marking goes on
                    helping = True
                return self._send(200, {'ok': True, 'helper': helping})
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
                if 'sharp' in body:
                    cfg['sharp'] = bool(body.get('sharp'))
                turned_on = bool(body.get('think')) and not cfg.get('think')
                cfg['think'] = bool(body.get('think'))
                if body.get('speed') in (0, 5, 15, 40):
                    cfg['max_mbps'] = body['speed']
                save_config(cfg)
                if turned_on and not job.busy():           # fetch what it needs now, where the bar shows it
                    job.start('think', ['--think-setup'])
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
                elif task == 'field':
                    args = ['--field-finder']
                elif task == 'vreview':
                    if not cfg.get('think'):
                        return self._send(200, {'error': 'Turn on the vision model in Settings first.'})
                    args = ['--vreview']
                elif task == 'vpieces':
                    if not cfg.get('think'):
                        return self._send(200, {'error': 'Turn on the vision model in Settings first.'})
                    args = ['--vpieces']
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
        elif args[0] == '--quick-pieces':
            do_quick_pieces(cfg)
        elif args[0] == '--stack-reader':
            do_stack_reader(cfg)
        elif args[0] == '--field-finder':
            do_field_finder(cfg, auto='--auto' in args)
        elif args[0] == '--vreview':
            do_vreview(cfg)
        elif args[0] == '--vpieces':
            do_vpieces(cfg)
        elif args[0] == '--think-setup':
            say('The vision model is ready. It will be used the next time matches are tracked.' if ensure_think(cfg) else 'The vision model is not ready; tracking goes on without it.')
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
