"""v2.37 checks: goals and loaders that follow the camera, and only pieces on them.

Run from desktop/:  python3 dev/spots.py path/to/a_wide_stream_frame.jpg
Reported: "its automatically marking ones on the loose field though, make it
so i only have to mark towers and loaders", then "yellow boxes also arent correct".
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
for d in (T.FRAMES, T.PROPS, T.LABELS): os.makedirs(d, exist_ok=True)
T._QUADS.clear(); T._QUADS_LOADED.append(1)
T.say = lambda *a, **k: None
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
H0, W0 = img.shape[:2]
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]
vid = 'vidspotsAAA'
def camera(tx, ty, z):
    return np.array([[z, 0, 0.5 - 0.5 * z + tx], [0, z, 0.5 - 0.5 * z + ty], [0, 0, 1]], dtype=np.float64)
def shot(Hf):
    P = np.diag([W0, H0, 1.0]) @ Hf @ np.diag([1 / W0, 1 / H0, 1.0])
    return cv2.warpPerspective(img, P, (W0, H0), borderMode=cv2.BORDER_REPLICATE)
def save(name, pic):
    cv2.imwrite(os.path.join(T.FRAMES, name + '.jpg'), pic, [cv2.IMWRITE_JPEG_QUALITY, 95])
    json.dump({'w': W0, 'h': H0, 'boxes': []}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
save(vid + '_ref', img)
moved = camera(0.06, 0.02, 1.1)
save(vid + '_pan', shot(moved))
save(vid + '_close', cv2.resize(img[0:int(H0 * 0.3), 0:int(W0 * 0.3)], (W0, H0)))
g = [round(v, 4) for p in T.first_spots(Q)[:9] for v in p]
l = [round(v, 4) for p in T.first_spots(Q)[9:] for v in p]
class FakeSite:
    def __init__(self, cfg=None): pass
    def post(self, body): return {'ok': True}
T.Site = FakeSite
ok_, why = T.save_field({'key': 'x'}, {'vid': vid, 'id': vid + '_ref', 'q': Q, 'g': g, 'l': l})
check('a field marked in the app is saved with the picture it was marked on', ok_ and T.field_ref(vid) and T.field_ref(vid)['id'] == vid + '_ref', why)
ref_spots = T.frame_spots(vid + '_ref')
pan_spots = T.frame_spots(vid + '_pan')
def mid(sb): return ((sb[0] + sb[2]) / 2, sb[3])
want = [cv2.perspectiveTransform(np.float32([[[mid(sb)[0] / W0, mid(sb)[1] / H0]]]), moved)[0, 0] for sb in ref_spots[:9]]
err = max(abs(mid(p)[0] / W0 - w[0]) for p, w in zip(pan_spots[:9], want)) if pan_spots else 9
check('on a frame after the camera moved, the goals move with it', pan_spots and err < 0.01, 'off by %.3f of the width' % err)
check('without following they would have been off', max(abs(mid(a)[0] - mid(b)[0]) / W0 for a, b in zip(ref_spots[:9], ref_spots[:9])) == 0 and max(abs(mid(p)[0] / W0 - mid(r)[0] / W0) for p, r in zip(pan_spots[:9], ref_spots[:9])) > 0.03)
check('a close-up is not the field: no goals drawn on it', T.frame_spots(vid + '_close') == [])
# On a goal: its column, on or above its base. Not loose beside or in front of it.
sb = ref_spots[8]
x0, x1, base = T.spot_column(8, sb)
cx, w_ = (x0 + x1) / 2, 14
check('a pin stacked on the goal counts', T.on_spot([cx - w_ / 2, base - 60, w_, 20], 8, sb))
check('a loose pin beside the goal does not', not T.on_spot([sb[0] + 1, base - 20, w_, 18], 8, sb))
check('nor one lying in front of it', not T.on_spot([cx - w_ / 2, base + 2, w_, 12], 8, sb))
lb = ref_spots[9]
check('anything over a loader counts', lb is None or T.on_spot([(lb[0] + lb[2]) / 2 - 5, (lb[1] + lb[3]) / 2 - 5, 10, 10], 9, lb))
# The colour finder's guesses: only on goals and loaders.
guesses = T.pieces_from_colour(img, [], ref_spots)
check('the colour guesses are only pieces on goals or loaders', all(T.on_spots(b, ref_spots) >= 0 for b in guesses))
check('fewer than everything coloured inside the old wide boxes', len(guesses) <= len([b for b in T.pieces_from_colour(img, []) if T.in_spots(b, ref_spots) >= 0]))
# v2.38: a goal dragged on a frame, its size kept, saved for the stream.
pan = T.frame_spots(vid + '_pan')
moved_box = [8] + [pan[8][0] + 40, pan[8][1], pan[8][2] + 40, pan[8][3]]
ok2, why2 = T.move_spots({'key': 'x'}, {'id': vid + '_pan', 'spots': [moved_box]})
check('dragging a goal on a frame saves it for the stream', ok2, why2)
check('with that frame as the picture the others follow', T.field_ref(vid) and T.field_ref(vid)['id'] == vid + '_pan')
after = T.frame_spots(vid + '_pan')
check('the goal is now where it was dragged, the same size', abs(((after[8][0] + after[8][2]) / 2) - ((moved_box[1] + moved_box[3]) / 2)) < 2 and abs((after[8][2] - after[8][0]) - (pan[8][2] - pan[8][0])) < 3, str((after[8], moved_box)))
check('the goals not dragged stay where they were', all(abs(a[0] - b[0]) < 3 for a, b in zip(after[:8], pan[:8])))
check('app 2.38 or later', T.VERSION >= '2.38')
print('spot checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
