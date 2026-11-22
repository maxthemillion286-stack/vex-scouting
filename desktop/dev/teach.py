"""v2.52 checks: the robot finder teaching itself.

Run from desktop/:  python3 dev/teach.py
The newest finder looks again at frames it was sure of, as they are and
mirrored; only frames where both looks agree on four robots are kept.
"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
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
T.progress = lambda *a, **k: None
W = 640
FOUR = [[100, 100, 60, 50, 0.9, 1], [300, 120, 60, 50, 0.9, 1], [200, 250, 60, 50, 0.9, 2], [450, 200, 60, 50, 0.9, 2]]
class Teacher:
    """Sees the four robots in 'good' frames, mirrored too; in 'odd' frames, a different thing mirrored."""
    def detect(self, frame, conf=None):
        mirrored = frame[0, 0, 0] == 7
        kind = max(int(frame[0, 1, 0]), int(frame[0, -2, 0]))
        boxes = [list(b) for b in FOUR]
        if mirrored:
            boxes = [[W - b[0] - b[2]] + b[1:] for b in boxes]
            if kind == 2:                                  # an 'odd' frame: mirrored, it sees one robot elsewhere
                boxes[0][0] += 200
        if kind == 3:                                      # a frame where it now finds only three
            boxes = boxes[:3]
        return boxes
def make(name, kind):
    pic = np.zeros((360, W, 3), np.uint8)
    pic[0, 1, 0] = kind
    pic[0, -1, 0] = 7                                      # mirrored, this pixel lands at [0, 0]
    cv2.imwrite(os.path.join(T.FRAMES, name + '.jpg'), pic)
    json.dump({'w': W, 'h': 360, 'auto': 1, 'steady': 1, 'boxes': [b[:5] for b in FOUR]}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
# JPEG would blur the marker pixels; use PNG-backed reads instead.
T_imread = cv2.imread
store = {}
def make_mem(name, kind):
    pic = np.zeros((360, W, 3), np.uint8); pic[0, 1, 0] = kind; pic[0, -1, 0] = 7
    store[name] = pic
    open(os.path.join(T.FRAMES, name + '.jpg'), 'w').write('x')
    json.dump({'w': W, 'h': 360, 'auto': 1, 'steady': 1, 'boxes': [b[:5] for b in FOUR]}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
cv2.imread = lambda p, *a: store.get(os.path.basename(p)[:-4]) if os.path.basename(p)[:-4] in store else T_imread(p, *a)
for i in range(3): make_mem('vidTTTTTTT1_good%d' % i, 1)
make_mem('vidTTTTTTT1_odd', 2)
make_mem('vidTTTTTTT1_three', 3)
open(os.path.join(T.DIRS['models'], 'robot_detector.onnx'), 'w').write('x')
kept, dropped = T.teach_again(Teacher())
props = {n[:-5]: json.load(open(os.path.join(T.PROPS, n))) for n in os.listdir(T.PROPS)}
check('frames both looks agree on are kept', kept == 3 and all(props['vidTTTTTTT1_good%d' % i]['steady'] == 1 for i in range(3)), str((kept, dropped)))
check('a frame the mirrored look disagrees on is left out', props['vidTTTTTTT1_odd']['steady'] == 0)
check('a frame it now finds only three robots in is left out', props['vidTTTTTTT1_three']['steady'] == 0 and dropped == 2)
check('each is looked at once per finder', T.teach_again(Teacher()) == (2, 0) or T.teach_again(Teacher()) == (0, 0))
src = open(T.__file__).read()
check('training looks again first', 'kept, dropped = teach_again()' in src)
check('app 2.52 or later', T.VERSION >= '2.52')
print('teach checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
