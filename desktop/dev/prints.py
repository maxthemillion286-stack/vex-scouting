"""v2.44 checks: robots' fingerprints, from a pretrained image model.

Run from desktop/:  python3 dev/prints.py path/to/a_wide_stream_frame.jpg
Makes the fingerprint model (downloads YOLO11's classifier once), then tracks
a stand-in match and checks each robot keeps its own fingerprint.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2, numpy as np
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
T.say = lambda *a, **k: None
check('the fingerprint model is made', T.ensure_embedder() and os.path.exists(T.embed_file()))
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
E = T.Embedder()
B = [[270, 380, 150, 130], [440, 380, 150, 140], [800, 350, 165, 165], [720, 210, 130, 130]]
e1 = np.array(E(img, B), float)
shift = np.float32([[1, 0, 6], [0, 1, 4]])
e2 = np.array(E(cv2.warpAffine(img, shift, (1280, 720)), [[b[0] + 6, b[1] + 4, b[2], b[3]] for b in B]), float)
norm = lambda m: m / np.linalg.norm(m, axis=1, keepdims=True)
S = norm(e1) @ norm(e2).T
check('each robot is closest to itself a moment later', all(int(np.argmax(S[i])) == i for i in range(4)), str(np.round(S, 2)))
check('fingerprints are 24 whole numbers', all(len(r) == 24 and all(isinstance(v, int) and -100 <= v <= 100 for v in r) for r in E(img, B)))

class FakeVideo:
    fps, length, hw, out, spans = 30, 2000, False, False, None
    def __init__(self): self.pos = 0
    def seek(self, s): self.pos = s
    def read_at_step(self, step): self.pos += step / self.fps; return self.pos, img
    def frame_at(self, s): return img
class FakeEyes:
    backend, pieces = 'CPU', None
    def __init__(self): self.embed = E
    def detect(self, frame, thr):
        return [b + [0.9, 1 if i < 2 else 2, None, 0] for i, b in enumerate(B)]
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
job = {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidprintsAA', 'off': 100}
rec, why, _ = T.track_match(FakeVideo(), FakeEyes(), job, 0, 300, False, {}, None, 0, None)
em = rec.get('em', []) if rec else []
check('a match carries its robots\' fingerprints', len(em) % 27 == 0 and len(em) // 27 >= 4 * 50, str(len(em)))
keys = set((rec['f'][k][0], rec['f'][k][2 + 10 * i], rec['f'][k][3 + 10 * i]) for k in range(len(rec['f'])) for i in range(rec['f'][k][1])) if rec else set()
check('each is keyed to a box the website will have', all((em[i], em[i + 1], em[i + 2]) in keys for i in range(0, len(em), 27)))
check('every two seconds, not every look', len(em) // 27 < len(rec['f']) * 4 // 6 if rec else False)
check('app 2.44 or later', T.VERSION >= '2.44')
print('fingerprint checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
