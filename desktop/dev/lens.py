"""v2.43 checks: straightening the camera's lens.

Run from desktop/:  python3 dev/lens.py path/to/a_wide_stream_frame.jpg
The real frame is bent by a known lens; the bend found must match, and the
field mapped through it must land on the bent picture's corners and edges.
"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2, numpy as np
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
H, W = img.shape[:2]
ka = H / W
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]

x, y = T.lens_do(*T.lens_undo(0.9, 0.2, 0.15, ka), 0.15, ka)
check('bending and unbending are each other\'s inverse', abs(x - 0.9) < 1e-6 and abs(y - 0.2) < 1e-6, str((x, y)))

def bend(pic, k):
    """The picture as a lens with this k would show it."""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    fx, fy = xs / W, ys / H
    nx, ny = (fx - 0.5) * 2, (fy - 0.5) * 2 * ka
    s = 1 + k * (nx * nx + ny * ny)
    sx, sy = (0.5 + nx * s / 2) * W, (0.5 + ny * s / (2 * ka)) * H
    return cv2.remap(pic, sx, sy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
k0, g0 = T.estimate_lens(img, Q, strict=False)     # its own small bend, counted or not
print('  the frame as it is: k %.3f (edges %d%% straighter)' % (k0, round(100 * g0)))
for kt in (0.12, -0.10):
    bent = bend(img, kt)
    Qb = []
    for i in range(0, 8, 2):
        Qb += list(T.lens_do(Q[i], Q[i + 1], kt, ka))
    kb, gb = T.estimate_lens(bent, Qb)
    check('a lens bending by %.2f is found (k %.3f; the frame itself %.3f)' % (kt, kb, k0), abs(kb - (kt + k0)) < 0.04, 'found %.3f' % kb)
    q = T.with_lens(Qb, kb, ka)
    fwd, inv = T.quad_fwd(q), T.field_inverse(q)
    corners = sorted((round(a, 3), round(b, 3)) for a, b in (fwd(u, v) for u, v in ((0, 0), (1, 0), (1, 1), (0, 1))))
    want = sorted((round(Qb[i], 3), round(Qb[i + 1], 3)) for i in range(0, 8, 2))
    check('the field\'s corners land on the bent picture\'s corners', max(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in zip(corners, want)) < 0.004, str((corners, want)))
    u, v = inv(*fwd(0.3, 0.7))
    check('picture to field and back', abs(u - 0.3) < 1e-3 and abs(v - 0.7) < 1e-3, str((u, v)))
    # The far edge's middle: on the bent picture's curved edge, not the straight chord.
    mids = [fwd(0.5, 0), fwd(1, 0.5), fwd(0.5, 1), fwd(0, 0.5)]
    chord = T.quad_fwd(Qb[:8])
    straight = [chord(0.5, 0), chord(1, 0.5), chord(0.5, 1), chord(0, 0.5)]
    real = [T.lens_do(*p, kt, ka) for p in [T.quad_fwd([c for i in range(0, 8, 2) for c in T.lens_undo(Qb[i], Qb[i + 1], kt, ka)])(*uv) for uv in ((0.5, 0), (1, 0.5), (0.5, 1), (0, 0.5))]]
    e_lens = max(math.hypot((a[0] - b[0]) * W, (a[1] - b[1]) * H) for a, b in zip(mids, real))
    e_flat = max(math.hypot((a[0] - b[0]) * W, (a[1] - b[1]) * H) for a, b in zip(straight, real))
    check('the middles of the field\'s edges land where the lens puts them (%.1f px off, against %.1f px without it)' % (e_lens, e_flat), e_lens < e_flat / 2 or e_flat < 2, '%.1f vs %.1f' % (e_lens, e_flat))
check('a mark with no lens maps as before', T.quad_fwd(Q)(0.25, 0.5) == T.quad_fwd(T.with_lens(Q, 0, ka))(0.25, 0.5))
check('the spots follow the lens', T.spot_boxes(1280, 720, T.with_lens(Q, 0.12, ka)) != T.spot_boxes(1280, 720, Q))
check('app 2.43 or later', T.VERSION >= '2.43')
print('lens checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
