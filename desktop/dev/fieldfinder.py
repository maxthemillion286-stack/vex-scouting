"""v2.47 checks: the field finder, trained on your own field marks.

Run from desktop/:  python3 dev/fieldfinder.py path/to/a_wide_stream_frame.jpg [--train]
Asked: "fix the automatically finding field and goal locations itll make my
life very easier". Four made-up streams are built from one real frame, each
seen by a differently placed camera, with the field marked on each. Their
frames become a keypoint dataset; with --train a field finder is really
trained (on the CPU here: a few rounds, so it is only checked that what it
says is read correctly, not that it is good).
"""
import json, math, os, sys, tempfile, shutil
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
T.say = lambda *a, **k: print(' ', *a) if '--train' in sys.argv else None
T.progress = lambda *a, **k: None
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]

def cam(k):
    """Stream k's camera: the real picture moved, zoomed and turned a little."""
    rng = np.random.default_rng(k)
    s = 0.85 + 0.25 * rng.random(); a = (rng.random() - 0.5) * 6; tx, ty = (rng.random() - 0.5) * 120, (rng.random() - 0.5) * 60
    return cv2.getRotationMatrix2D((640, 360), a, s) + np.array([[0, 0, tx], [0, 0, ty]])
def move(M, x, y):
    p = M @ np.array([x * 1280, y * 720, 1.0]); return [p[0] / 1280, p[1] / 720]
streams = []
for k in range(5):
    vid = 'stream%05d' % k
    M = cam(k)
    pic = cv2.warpAffine(img, M, (1280, 720), borderMode=cv2.BORDER_REPLICATE)
    q = [v for i in range(0, 8, 2) for v in move(M, Q[i], Q[i + 1])]
    T._QUADS[vid] = {'q': q, 'g': None, 'l': None, 'at': 9e12}
    for i in range(12):
        noisy = np.clip(pic.astype(np.int16) + np.random.default_rng(100 * k + i).integers(-6, 7, pic.shape), 0, 255).astype(np.uint8)
        cv2.imwrite(os.path.join(T.FRAMES, '%s_%d.jpg' % (vid, i)), noisy)
    streams.append((vid, q))

check('17 points: four corners, nine goals, four loaders', len(T.field_points(Q)) == 17)
P = T.field_points(Q)
check('the corners are the mark\'s corners', sorted((round(a, 3), round(b, 3)) for a, b in P[:4]) == sorted((round(Q[i], 3), round(Q[i + 1], 3)) for i in range(0, 8, 2)), str(P[:4]))
check('goals dragged into place are used', T.field_points(Q, {'g': [0.5] * 18, 'l': [0.4] * 8})[4] == [0.5, 0.5])
check('streams with a mark and frames are found', len(T.field_streams()) == 5)
check('it is due once three streams are marked', T.field_due())
ex = T.field_examples()
check('every frame of a fixed camera becomes an example', len(ex) == 60, str(len(ex)))
root, counts, held = T.build_field_dataset(ex)
check('one whole stream is held back to test it', len(held) >= 1 and counts['val'] == 12 * len(held) and counts['train'] == 60 - counts['val'], str((counts, held)))
lab = open(os.path.join(root, 'labels', 'train', os.listdir(os.path.join(root, 'labels', 'train'))[0])).read().split()
check('a label is a field box and 17 points', len(lab) == 5 + 17 * 3 and lab[0] == '0', str(len(lab)))
y = open(os.path.join(root, 'data.yaml')).read()
check('the dataset says it is 17 points', 'kpt_shape: [17, 3]' in y)
ui = T.UI_HTML
check('the window has the button and says what it knows', "start('field')" in ui and 'Field finder: ' in ui)
check('a stream not yet marked opens with the finder\'s answer drawn in', 'if(r.auto)findField()' in ui)
check('without a finder and no vision model, it says how to get one', 'learns from your marks' in T.find_field({}, '%s_0' % streams[0][0]).get('error', ''))

if '--train' in sys.argv:
    T.FIELD_ROUNDS = 3
    T.do_field_finder({'field_rounds': 3})
    check('a field finder is trained and saved', os.path.exists(T.field_file()), str(os.listdir(T.DIRS['models'])))
    info = T.field_info()
    check('its test is written down', 'corners' in info and 'goals' in info, str(info))
    if os.path.exists(T.field_file()):
        # Read correctly: against the training tools' own answer for the same picture.
        from ultralytics import YOLO
        name = '%s_0' % streams[0][0]
        fr = cv2.imread(os.path.join(T.FRAMES, name + '.jpg'))
        r = YOLO(T.field_file(), task='pose').predict(fr, imgsz=640, conf=0.0, verbose=False)[0]
        mine = T.FieldFinder().find(fr)
        if len(r.boxes):
            j = int(r.boxes.conf.argmax())
            theirs = r.keypoints.xyn[j].cpu().numpy()
            d = max(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(mine[0], theirs))
            check('its points are read as the training tools read them (within 1%% of the picture): %.4f' % d, d < 0.01, str(d))
        got = T.find_field({}, name)
        check('"Find it for me" answers with it', got.get('how') == 'field finder' or 'could not see' in got.get('error', ''), str(got)[:200])
check('app 2.47 or later', T.VERSION >= '2.47')
print('field finder checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
