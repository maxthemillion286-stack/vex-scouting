"""v2.22: pins & cups only in goal and loader spots. Stand-in finder (no GPU or ultralytics here)."""
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
T._QUADS.clear()
img = cv2.resize(cv2.imread(sys.argv[1]), (1920, 1080), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]           # the field's corners in that frame, by eye
robots = [[x * 0.75, y * 0.75, w * 0.75, h * 0.75] for x, y, w, h in [[923, 551, 268, 331], [527, 277, 252, 250], [341, 463, 301, 316], [1943, 450, 286, 301]]]
sb = T.spot_boxes(1920, 1080, Q)
check('13 spots, most in the picture', len(sb) == 13 and sum(1 for b in sb if b) >= 12, str(sb))
fwd = T.quad_fwd(Q)
x, y = fwd(0.5, 0.5)
check('the centre goal\'s spot stands on the middle of the field', sb[8][0] < x * 1920 < sb[8][2] and abs(sb[8][3] - y * 1080) < 40)
check('goal spots are taller than wide', all(b[3] - b[1] > b[2] - b[0] for b in sb[:9] if b))
check('none falls outside the picture', all(0 <= b[0] < b[2] <= 1920 and 0 <= b[1] < b[3] <= 1080 for b in sb if b))
check('a box in a spot is found; one outside is not', T.in_spots([sb[8][0] + 5, sb[8][1] + 5, 6, 6], sb) == 8 and T.in_spots([5, 1070, 4, 4], sb[:9]) == -1)
col = T.pieces_from_colour(img, robots, sb)
check('the colour guesses are only inside the spots', len(col) > 0 and all(T.in_spots(b, sb) >= 0 for b in col) and len(col) < len(T.pieces_from_colour(img, robots)), '%d of %d' % (len(col), len(T.pieces_from_colour(img, robots))))
# frames: one with its field marked, one without
T.keep_frame(img, [r + [0.9] for r in robots], 'vidmarkedAA', 1)
T.keep_frame(img[::-1].copy(), [r + [0.9] for r in robots], 'vidnofieldB', 1)
for n in os.listdir(T.PROPS): T.lab_write(n[:-5], skip=False, boxes=robots)
T._QUADS['vidmarkedAA'] = Q; T._QUADS['vidnofieldB'] = None
q = T.pieces_queue()
check('only frames whose field is marked are asked for', len(q) == 1 and q[0].startswith('vidmarkedAA'), str(q))
name = q[0]
T.lab_write(name, pieces=T.clean_pieces(col + [[1800, 20, 30, 30, 2]]))
m = T.pieces_marked()
check('a mark outside every spot is left out of training', len(m) == 1 and len(m[0][4]) == len(col) and len(m[0]) == 6, str(len(m[0][4])))
root, counts = T.build_pieces_dataset(m)
part = 'val' if T.is_val(name) else 'train'
imgs = sorted(os.listdir(os.path.join(root, 'images', part)))
check('one picture for each spot in the frame', counts[part] == sum(1 for b in sb if b) and len(imgs) == counts[part], str(counts))
labs = [open(os.path.join(root, 'labels', part, i[:-4] + '.txt')).read().split('\n') for i in imgs]
nl = sum(1 for L in labs for l in L if l)
check('every mark lands in a spot picture, inside it', nl >= len(col) and all(0 <= float(v) <= 1 for L in labs for l in L if l for v in l.split()[1:]), '%d labels for %d marks' % (nl, len(col)))
k8 = cv2.imread(os.path.join(root, 'images', part, name + '_s08.jpg'))
check('a spot picture is that spot cut out', k8 is not None and k8.shape[:2] == (sb[8][3] - sb[8][1], sb[8][2] - sb[8][0]))
# a stand-in finder for 320×320 spot pictures: two yellow halves and a cup near the middle, always
lb = T.piece_letterbox(320, 320)
out = np.zeros((1, 8, 8), np.float32)
for i, (cx, cy, w, h, c) in enumerate([(160, 100, 30, 40, 2), (160, 160, 30, 40, 2), (160, 230, 50, 50, 3)]):
    out[0, :4, i] = [cx, cy, w, h]; out[0, 4 + c, i] = 0.9
g = helper.make_graph([helper.make_node('Constant', [], ['o'], value=numpy_helper.from_array(out))], 'g',
                      [helper.make_tensor_value_info('images', TensorProto.FLOAT, [1, 3, 320, 320])], [helper.make_tensor_value_info('o', TensorProto.FLOAT, [1, 8, 8])])
mdl = helper.make_model(g, opset_imports=[helper.make_opsetid('', 12)]); mdl.ir_version = 8
onnx.save(mdl, T.pieces_file())
F = T.PieceFinder(T.pieces_file(), prov=['CPUExecutionProvider'])
cnt = F.spot_counts(img, sb)
check('counts for each spot: red, blue, yellow halves, cups', len(cnt) == 13 and all(c == [0, 0, 2, 1] for c, b in zip(cnt, sb) if b), str(cnt[:3]))
off = list(sb); off[12] = None
check('a spot off the picture says so', F.spot_counts(img, off)[12] == [-1, -1, -1, -1])
fs = F.find_spots(img, sb)
check('boxes come back in the frame\'s pixels, inside their spot', all(T.in_spots(b[:4], [sb[b[6]]]) == 0 for b in fs) and len(fs) == 3 * sum(1 for b in sb if b))
check('a look is 1 + 13×4 numbers, as the website reads it', len([0] + [v for c in cnt for v in c]) == 53)
# v2.23: goals dragged into place on the website
g = [0.30, 0.60, 0.4, 0.75, 0.6, 0.3, 0.7, 0.36, 0.4, 0.33, 0.28, 0.41, 0.67, 0.74, 0.79, 0.6, 0.51, 0.49]
a = T.spot_boxes(1920, 1080, Q); b = T.spot_boxes(1920, 1080, Q, {'g': g, 'l': None})
check('a goal dragged into place: its column stands where it was dragged', abs((b[0][0] + b[0][2]) / 2 - 0.30 * 1920) < 2 and b[0][1] < 0.60 * 1080 < b[0][3])
check('same size as before', abs((b[0][2] - b[0][0]) - (a[0][2] - a[0][0])) <= 2)
check('loaders not placed stay where the corners put them', b[9] == a[9])
print('%d passed, %d failed' % (ok, fail)); shutil.rmtree(tmp, ignore_errors=True); sys.exit(1 if fail else 0)
