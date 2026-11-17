"""Pins & cups marking, finder and training plumbing (no real training here: no GPU, no ultralytics)."""
import sys, os, json, shutil, tempfile, numpy as np, cv2
sys.path.insert(0, 'run')
import vex_trainer as T
import onnx
from onnx import helper, TensorProto, numpy_helper
ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)
tmp = tempfile.mkdtemp()
models = os.path.join(tmp, 'models'); os.makedirs(models)
for n in os.listdir('run/models'):
    if not n.startswith('pieces') and not n.startswith('trained'): os.symlink(os.path.abspath(os.path.join('run/models', n)), os.path.join(models, n))
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
T.FRAMES, T.PROPS, T.LABELS = (os.path.join(tmp, 'data', k) for k in ('frames', 'prop', 'labels'))
img = cv2.imread(sys.argv[1]); img = cv2.resize(img, (1920, 1080), interpolation=cv2.INTER_AREA)
robots = [[x * 0.75, y * 0.75, w * 0.75, h * 0.75] for x, y, w, h in [[923, 551, 268, 331], [527, 277, 252, 250], [341, 463, 301, 316], [1943, 450, 286, 301]]]
for tag, fr in (('vidA', img), ('vidA', img[:, ::-1].copy()), ('vidB', img[::-1].copy())):
    T.keep_frame(fr, [r + [0.9] for r in robots], tag, 1)
names = sorted(n[:-4] for n in os.listdir(T.FRAMES))
img0 = {n: cv2.imread(os.path.join(T.FRAMES, n + '.jpg')) for n in names}
check('three frames kept', len(names) == 3)
check('nothing to mark before robots are reviewed', T.pieces_queue() == [])
for n in names: T.lab_write(n, skip=False, boxes=robots)
q = T.pieces_queue()
check('reviewed frames wait for pins', len(q) == 3 and q[0].split('_')[0] != q[1].split('_')[0], str(q))
prop = T.pieces_from_colour(img0[names[0]], robots)
check('the colour finder proposes pin halves in the frame\'s pixels, none on robots', len(prop) > 5 and all(0 <= b[4] <= 2 for b in prop) and not any(T.on_robot(b, robots) for b in prop), str(prop[:3]))
# marking keeps robots, saving robots keeps marks
T.lab_write(names[0], pieces=T.clean_pieces(prop + [[100, 100, 40, 50, 3], [1, 1, 1, 1, 2], [5, 5, 20, 20, 9]]))
lab = T.lab_read(names[0])
check('marks are cleaned: tiny boxes and unknown classes dropped', len(lab['pieces']) == len(prop) + 1 and lab['pieces'][-1][4] == 3)
T.lab_write(names[0], skip=False, boxes=robots[:3])
check('saving robots again keeps the pin marks', len(T.lab_read(names[0])['pieces']) == len(prop) + 1 and len(T.lab_read(names[0])['boxes']) == 3)
T.lab_write(names[0], boxes=robots)
check('a marked frame leaves the queue', names[0] not in T.pieces_queue() and len(T.pieces_marked()) == 1)
T.lab_write(names[1], pskip=True)
check('a skipped one too, and it is not training material', names[1] not in T.pieces_queue() and len(T.pieces_marked()) == 1)
# scoring: the colour finder against its own guesses is perfect; against nothing, all wrong
m = T.pieces_marked()
sc = T.score_pieces(lambda fr, rb: T.pieces_from_colour(fr, rb), [(n, w, h, rb, [p for p in pcs if p[4] < 3]) for n, w, h, rb, pcs in m])
check('scoring: the same boxes score 100', abs(sc['halves'][2] - 1) < 1e-9, str(sc))
sc2 = T.score_pieces(lambda fr, rb: [], m)
check('scoring: finding nothing scores 0, cups missed', sc2['halves'][2] == 0 and sc2['cups'][1] == 0)
shifted = T.score_pieces(lambda fr, rb: [[b[0] + b[2] * 0.15, b[1], b[2], b[3], b[4]] for b in T.pieces_from_colour(fr, rb)], m)
check('scoring: a box a little off still counts', shifted['halves'][2] > 0.9, str(shifted['halves']))
wrong = T.score_pieces(lambda fr, rb: [[*b[:4], (b[4] + 1) % 3] for b in T.pieces_from_colour(fr, rb)], m)
check('scoring: the wrong colour does not count', wrong['halves'][0] == 0)
# dataset
root, counts = T.build_pieces_dataset(m)
lbl = open(os.path.join(root, 'labels', 'val' if T.is_val(m[0][0]) else 'train', m[0][0] + '.txt')).read().split('\n')
check('dataset: one line a box, classes 0-3, centres within the picture', len([l for l in lbl if l]) == len(prop) + 1 and all(0 <= float(v) <= 1 for l in lbl if l for v in l.split()[1:]) and lbl[-2].startswith('3 '))
check('dataset names its four classes', 'yellow half' in open(os.path.join(root, 'data.yaml')).read() and '3: cup' in open(os.path.join(root, 'data.yaml')).read())
# a stand-in trained finder: always says the same boxes (in the 1280 square)
lb = T.piece_letterbox(1920, 1080)
want = [(300, 400, 30, 40, 2), (302, 402, 30, 40, 2), (800, 900, 60, 70, 3), (1000, 600, 20, 30, 0), (480, 640, 40, 40, 1)]   # frame boxes
N = 16; out = np.zeros((1, 8, N), np.float32)
for i, (x, y, w, h, c) in enumerate(want):
    out[0, 0, i] = (x + w / 2) * lb['s'] + lb['px']; out[0, 1, i] = (y + h / 2) * lb['s'] + lb['py']; out[0, 2, i] = w * lb['s']; out[0, 3, i] = h * lb['s']; out[0, 4 + c, i] = 0.9
out[0, 4, 10] = 0.2                                   # below the bar
g = helper.make_graph([helper.make_node('Constant', [], ['o'], value=numpy_helper.from_array(out))], 'g',
                      [helper.make_tensor_value_info('images', TensorProto.FLOAT, [1, 3, 1280, 1280])], [helper.make_tensor_value_info('o', TensorProto.FLOAT, [1, 8, N])])
mdl = helper.make_model(g, opset_imports=[helper.make_opsetid('', 12)]); mdl.ir_version = 8
onnx.save(mdl, T.pieces_file())
F = T.PieceFinder(T.pieces_file(), prov=['CPUExecutionProvider'])
got = F.find(img, [[460, 620, 80, 80]])
check('the finder\'s boxes come back in frame pixels, by class', any(abs(b[0] - 800) < 1 and abs(b[1] - 900) < 1 and b[5] == 3 for b in got), str(got))
check('overlapping same-class boxes are one; weak ones dropped', sum(1 for b in got if b[5] == 2) == 1 and len(got) == 3, str(got))
check('none on a robot', not any(b[5] == 1 for b in got))
W, H, halves, cups = F.blobs(img, [[460, 620, 80, 80]])
check('in the colour finder\'s shape at 960 wide', W == 960 and H == 540 and len(halves) == 2 and len(cups) == 1 and all(len(h) == 6 and h[5] in (1, 2, 3) for h in halves), str(halves))
check('a cup is x, bottom, w, h', cups[0] == [T.jround(830 / 2), T.jround(970 / 2), 30, 35], str(cups))
check('not used before it has won', not T.pieces_ready())
json.dump({'use': True, 'new': {'halves': [1, 1, 1], 'cups': [1, 1, 1]}, 'colour': {'halves': [0.5, 0.5, 0.5]}}, open(T.pieces_info_file(), 'w'))
check('used once it has', T.pieces_ready())
eyes = T.Eyes(quiet=True)
check('tracking picks it up', eyes.pieces is not None)
os.remove(T.pieces_info_file())
check('and drops it when the record says not to', T.Eyes(quiet=True).pieces is None)
print('%d passed, %d failed' % (ok, fail)); shutil.rmtree(tmp, ignore_errors=True); sys.exit(1 if fail else 0)
