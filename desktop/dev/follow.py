"""v2.28 checks: following the camera (CamFollow), on a real stream frame.

Run from desktop/:  python3 dev/follow.py path/to/a_wide_stream_frame.jpg
The frame is warped by known pans and zooms; the camera move found must match,
and boxes recorded after a pan must land back where they stand on the marked
picture. Then a whole stand-in match is tracked through track_match with a pan
and a close-up partway through.
"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2, numpy as np
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
H0, W0 = img.shape[:2]
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]          # the field's corners in that frame, by eye
# The stream's own overlay: a score bar that stays put while the camera moves.
def overlay(im):
    im = im.copy()
    cv2.rectangle(im, (0, H0 - 70), (W0, H0), (30, 30, 30), -1)
    for k, txt in enumerate(['QUALIFICATION 12', '00:47', 'RED 18', 'BLUE 22']):
        cv2.putText(im, txt, (40 + 320 * k, H0 - 25), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2)
    return im

def camera(tx, ty, zoom):
    """A camera move as a homography on picture fractions: zoom about the middle, then shift."""
    S = np.array([[zoom, 0, 0.5 - 0.5 * zoom + tx], [0, zoom, 0.5 - 0.5 * zoom + ty], [0, 0, 1]], dtype=np.float64)
    return S

def shot(Hf):
    P = np.diag([W0, H0, 1.0]) @ Hf @ np.diag([1 / W0, 1 / H0, 1.0])
    return overlay(cv2.warpPerspective(img, P, (W0, H0), borderMode=cv2.BORDER_REPLICATE))

ref = overlay(img)
f = T.CamFollow(Q)
check('the marked picture has enough to follow', f.set_ref(ref))
Hs = f.look(ref)
check('the same picture: no move', Hs is not None and max(abs(a - b) for a, b in zip(f.quad_now(Hs), Q)) < 0.003, str(Hs))

for name, (tx, ty, z) in {'a pan right': (0.06, 0.0, 1.0), 'a pan and tilt': (-0.05, 0.03, 1.0), 'a zoom in': (0.0, 0.0, 1.15), 'a zoom out and pan': (0.04, -0.02, 0.9)}.items():
    Ht = camera(tx, ty, z)
    t0 = time.time()
    Hf = f.look(shot(Ht))
    dt = time.time() - t0
    want = cv2.perspectiveTransform(np.float32(Q).reshape(1, 4, 2), Ht).reshape(-1)
    got = f.quad_now(Hf) if Hf is not None else None
    err = max(abs(a - b) for a, b in zip(got, want)) if got else 9
    check(name + ': the field is found where it moved to', err < 0.006, 'off by %.4f' % err)
    check(name + ': quick enough to do every second', dt < 0.15, '%.0f ms' % (dt * 1000))
    if Hf is not None:
        # A robot standing at the field's middle in the marked picture, seen after the move.
        mid = np.float32([[[0.47, 0.5]]])
        seen = cv2.perspectiveTransform(mid, Ht)[0, 0]
        bw, bh = 90 * z, 80 * z
        box = [seen[0] * W0 - bw / 2, seen[1] * H0 - bh, bw, bh, 0.9, 1, None, 0]
        back = T.boxes_to_marked([box], np.linalg.inv(Hf).tolist(), W0, H0)[0]
        foot = ((back[0] + back[2] / 2) / W0, (back[1] + back[3]) / H0)
        check(name + ': a robot seen after it is recorded where it stands on the marked picture', math.hypot(foot[0] - 0.47, (foot[1] - 0.5)) < 0.006, str(foot))
        check(name + ': and its size undoes the zoom', abs(back[2] - 90) < 6, '%.1f' % back[2])

# Not the field: a close-up of the crowd corner, and a different picture altogether.
close = cv2.resize(img[0:int(H0 * 0.3), 0:int(W0 * 0.3)], (W0, H0))
check('a close-up is not taken for the field', f.look(overlay(close)) is None)
noise = overlay(cv2.GaussianBlur(np.random.default_rng(1).integers(0, 255, (H0, W0, 3), dtype=np.uint8), (5, 5), 0))
check('nor is something else entirely', f.look(noise) is None)
check('the overlay alone does not anchor the camera', f.look(overlay(np.full_like(img, 90))) is None)

# The goals and loaders dragged into place move with the camera.
placed = {'g': [0.2, 0.6] * 9, 'l': [0.1, 0.8] * 4}
Ht = camera(0.06, 0.0, 1.0)
Hf = f.look(shot(Ht))
moved = f.placed_now(placed, Hf)
check('dragged goals move with the camera', abs(moved['g'][0] - 0.26) < 0.006 and abs(moved['l'][1] - 0.8) < 0.006, str(moved['g'][:2]))

# A whole stand-in match: wide view, a pan at 40 s, a close-up from 80 to 90 s.
class FakeVideo:
    fps, length, hw, out = 30, 2000, False, False
    def __init__(self): self.pos = 0
    def seek(self, s): self.pos = s
    def view(self, t):
        if 80 <= t - 100 < 90: return 'close'
        return 'pan' if t - 100 >= 40 else 'wide'
    def picture(self, t):
        v = self.view(t)
        return overlay(close) if v == 'close' else (shot(camera(0.05, 0.02, 1.0)) if v == 'pan' else ref)
    def read_at_step(self, step):
        self.pos += step / self.fps
        return self.pos, self.picture(self.pos)
    def frame_at(self, s): return self.picture(s)
class FakeEyes:
    backend, pieces = 'CPU', None
    def __init__(self, v): self.v = v
    def detect(self, frame, thr):
        t = self.v.pos
        Ht = camera(0.05, 0.02, 1.0) if self.v.view(t) == 'pan' else np.eye(3)
        out = []
        for k, (u, v) in enumerate([(0.3, 0.45), (0.35, 0.65), (0.62, 0.45), (0.66, 0.65)]):
            p = cv2.perspectiveTransform(np.float32([[[u, v]]]), Ht)[0, 0]
            out.append([p[0] * W0 - 40, p[1] * H0 - 70, 80, 70, 0.9, 1 if k < 2 else 2, None, 0])
        out.append([600, 200, 80, 70, 0.33, 1, None, 0])      # one the finder is unsure of
        out.append([out[0][0] + 5, out[0][1] + 5, 80, 70, 0.3, 1, None, 0])   # and a faint copy of a sure one
        return out
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
T.say = lambda *a, **k: None
T._QUADS.clear()
v = FakeVideo()
job = {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidfollowXX', 'off': 100}
rec, why, _ = T.track_match(v, FakeEyes(v), job, 0, 300, False, {}, Q, 0, T.make_follow(v, Q, 50.0))
# and a mark saved before v149 (no moment): the first wide look of the match stands in
v2 = FakeVideo()
rec2, why2, _ = T.track_match(v2, FakeEyes(v2), dict(job), 0, 300, False, {}, Q, 0, T.make_follow(v2, Q, None))
cam2 = rec2.pop("_cam") if rec2 else {}
check("an older mark: followed from the first wide look", rec2 is not None and cam2.get("found", 0) / max(1, cam2.get("checks", 1)) > 0.8 and 6 <= cam2.get("away", 0) <= 11, str(cam2))
check('a match with a pan and a close-up is tracked', rec is not None, why)
if rec:
    cam = rec.pop('_cam')
    check('the camera was followed most of the match', cam['found'] / cam['checks'] > 0.8, str(cam))
    check('the pan was seen as one camera move (and back after the close-up)', 1 <= cam['moves'] <= 3, str(cam))
    check('the close-up was left out', 6 <= cam['away'] <= 11, str(cam))
    def feet(lo, hi):
        pts = []
        for fr in rec['f']:
            if lo <= fr[0] / 10 < hi:
                for i in range(fr[1]):
                    o = 2 + 10 * i
                    pts.append(((fr[o] + fr[o + 2] / 2) / T.SIZE, (fr[o + 1] + fr[o + 3]) / rec['h']))
        return pts
    before, after = feet(10, 35), feet(45, 75)
    first = lambda pts: sorted(pts)[0] if pts else None
    check('robots that did not move are recorded in the same place before and after the pan',
          before and after and math.hypot(first(before)[0] - first(after)[0], first(before)[1] - first(after)[1]) < 0.01, '%s %s' % (first(before), first(after)))
    check('no robots are recorded during the close-up', not feet(81.5, 89))
    weak = [fr[2 + 10 * i + 4] for fr in rec['f'] for i in range(fr[1]) if fr[2 + 10 * i + 4] < rec.get('cf', 0)]
    check('unsure boxes are kept, marked below the threshold', rec.get('cf') == 45 and weak and all(c <= 44 for c in weak), str(rec.get('cf')))
    check('but not one lying on top of a sure box', max(fr[1] for fr in rec['f']) == 5, str(max(fr[1] for fr in rec['f'])))
    check('nothing the website does not know is sent', not any(k.startswith('_') for k in rec if k != '_shots'))

check('version 2.28 or later', T.VERSION >= '2.28')
print('follow checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
