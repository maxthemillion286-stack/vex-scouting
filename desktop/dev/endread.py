"""Dev check (app 2.59): the end-of-match read.
Run: python3 desktop/dev/endread.py FRAME.jpg"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2
import vex_trainer as T
ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)
tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
T.FRAMES, T.PROPS, T.LABELS = (os.path.join(tmp, 'data', k) for k in ('frames', 'prop', 'labels'))
for d in (T.FRAMES, T.PROPS, T.LABELS): os.makedirs(d, exist_ok=True)
T._QUADS.clear(); T._QUADS_LOADED.append(1)
T.say = lambda *a, **k: None
T.progress = lambda *a, **k: None
fr = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]
check('the middle of three or more clear looks; fewer is unknown',
      T.end_read_pack(125.3, [[[2, 0, 4, 1], [-1] * 4], [[2, 0, 6, 1], [1] * 4], [[4, 0, 6, 1], [-1] * 4], [[2, 0, 6, 0], [1] * 4]], 2) == [1253, 2, 0, 6, 1, -1, -1, -1, -1])
foot = T.quad_fwd(Q)
looks = []
class FakeVideo:
    fps, length, hw, out, spans = 30, 4000, False, False, None
    def __init__(self): self.pos = 0
    def seek(self, s_): self.pos = s_
    def read_at_step(self, step): self.pos += step / self.fps; return self.pos, fr
    def frame_at(self, s_): return fr
class Pieces:
    def spot_counts(self, frame, spots, memory=None):
        looks.append(1)
        return [[k % 3, 1, 2, 0] for k in range(len(spots))]
class FakeEyes:
    backend, pieces, stack = 'CPU', Pieces(), None
    def detect(self, frame, thr):
        out = []
        for (u, v, c) in [(0.3, 0.4, 1), (0.35, 0.7, 1), (0.65, 0.4, 2), (0.7, 0.7, 2)]:
            X, Y = foot(u, v); out.append([X * 1280 - 30, Y * 720 - 50, 60, 50, 0.9, c, None, 0])
        return out
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
rec, why, _ = T.track_match(FakeVideo(), FakeEyes(), {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'streamEEEEE', 'off': 100, 'id': '1'}, 0, 300, False, {}, Q, 0, None)
ge = (rec or {}).get('ge')
check('a match without a clock: the end read comes about when a match ends', ge is not None and len(ge) == 1 + 4 * len(T.SPOTS), '%s %s' % (why, ge and len(ge)))
if ge:
    check('at about 127 s', 1265 <= ge[0] <= 1285, str(ge[0]))
    check('with each spot\'s counts', [ge[1 + 4 * k:5 + 4 * k] for k in range(3)] == [[0, 1, 2, 0], [1, 1, 2, 0], [2, 1, 2, 0]] or any(v == -1 for v in ge[1:13]), str(ge[1:13]))
check('and the colours\' looks of those seconds', len((rec or {}).get('pe') or []) >= 2 * 10, str(len((rec or {}).get('pe') or [])))
print('end-read checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
