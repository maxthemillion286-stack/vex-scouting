"""v2.32 checks: frames the tracker labels itself.

Run from desktop/:  python3 dev/selflabel.py path/to/a_stream_frame.jpg
"""
import json, os, sys, tempfile
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
T.FRAMES, T.PROPS, T.LABELS = (os.path.join(tmp, 'data', k) for k in ('frames', 'prop', 'labels'))
T.say = lambda *a, **k: None
base = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)

B = lambda x, y, c, k=0.9: [x, y, 80, 70, k, c, None, 0]
four = [B(200, 300, 1), B(400, 300, 1), B(900, 300, 2), B(1000, 500, 2)]
check('four sure robots, two a side, where they were: certain', T.steady_four(four, [B(205, 302, 1), B(398, 300, 1), B(903, 300, 2), B(1000, 497, 2)], [], 1280))
check('not if one jumped', not T.steady_four(four, [B(300, 302, 1), B(398, 300, 1), B(903, 300, 2), B(1000, 497, 2)], [], 1280))
check('not with three of one colour', not T.steady_four([B(200, 300, 1), B(400, 300, 1), B(900, 300, 1), B(1000, 500, 2)], four, [], 1280))
check('not with something unsure about', not T.steady_four(four, four, [B(600, 100, 1, 0.3)], 1280))
check('not with five', not T.steady_four(four + [B(600, 100, 1)], four, [], 1280))

class FakeVideo:
    fps, length, hw, out, spans = 30, 4000, False, False, None
    def __init__(self): self.pos = 0
    def seek(self, s): self.pos = s
    def read_at_step(self, step):
        self.pos += step / self.fps
        f = base.copy()
        cv2.putText(f, '%.2f' % self.pos, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)   # each picture its own
        return self.pos, f
    def frame_at(self, s): return base
class FakeEyes:
    backend, pieces = 'CPU', None
    def __init__(self, v): self.v = v
    def detect(self, frame, thr):
        m = self.v.pos - 100
        d = 3 * np.sin(m)
        out = [B(200 + d, 300, 1), B(400, 300 + d, 1), B(900 - d, 300, 2), B(1000, 500, 2)]
        if 60 <= m < 80: out.append(B(600, 100, 1, 0.3))       # unsure for a while
        return out
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
v = FakeVideo()
job = {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidselfXXXX', 'off': 100}
rec, why, _ = T.track_match(v, FakeEyes(v), job, 0, 300, True, {}, None, 0, None)
props = {n[:-5]: json.load(open(os.path.join(T.PROPS, n))) for n in os.listdir(T.PROPS)}
auto = [n for n, p in props.items() if p.get('auto')]
check('certain frames are kept to train on, a few a match', 3 <= len(auto) <= T.AUTO_PER_MATCH, str(len(auto)))
check('every one of them certain', all(p.get('steady') == 1 and len(p['boxes']) == 4 for n, p in props.items() if p.get('auto')))
q, _ = T.review_queue()
check('none of them is asked about in review', not any(n in auto for n in q), str([n for n in q if n in auto]))
# A person reviews one other frame; the dataset then trains on the certain ones, never grades on them.
other = [n for n in props if n not in auto]
for n in other: T.lab_write(n, skip=False, boxes=[b[:4] for b in props[n]['boxes'][:4]])
root, counts = T.build_dataset()
val = set(f[:-4] for f in os.listdir(os.path.join(root, 'images', 'val')))
train = set(f[:-4] for f in os.listdir(os.path.join(root, 'images', 'train')))
check('they are trained on', any(n in train for n in auto) and counts['pseudo'] >= 1, str(counts))
check('never graded on: grading is reviewed frames only', not any(n in val for n in auto))
check('at most twice as many as reviewed frames', counts['pseudo'] <= 2 * max(1, counts['train']))
# Not steady: not trusted.
bad = props[auto[0]].copy(); bad['steady'] = 0; bad.pop('auto')
json.dump(bad, open(os.path.join(T.PROPS, auto[0] + '.json'), 'w'))
root, counts2 = T.build_dataset()
check('a frame marked not steady is not trained on', auto[0] not in set(f[:-4] for f in os.listdir(os.path.join(root, 'images', 'train'))))
check('app 2.32 or later', T.VERSION >= '2.32')
print('self-label checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
