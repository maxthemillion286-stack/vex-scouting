"""v2.42 checks: the marking helper and the most useful frames first.

Run from desktop/:  python3 dev/helper.py path/to/a_wide_stream_frame.jpg [--train]
With --train it really trains the helper (2 rounds, on the CPU; slow but real).
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
T.progress = lambda *a, **k: None
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]

# Two streams; A already has marks, B none. Frames differ in how many pieces stand on goals.
def frame(name, extra=0):
    pic = img.copy()
    cv2.imwrite(os.path.join(T.FRAMES, name + '.jpg'), pic)
    json.dump({'w': 1280, 'h': 720, 'boxes': []}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
    T.lab_write(name, skip=False, boxes=[[10, 10, 50, 50]])
for v in ('streamAAAAA', 'streamBBBBB'):
    T._QUADS[v] = {'q': Q, 'g': None, 'l': None, 'at': 9e12}
    for i in range(6):
        frame('%s_%d' % (v, i))
for i in range(3):
    T.lab_write('streamAAAAA_%d' % i, pieces=[[100, 100, 10, 10, 2]])

check('the helper is due after 20 marked frames', not T.helper_due(19) and T.helper_due(20))
json.dump({'marks': 20}, open(os.path.join(T.DIRS['models'], 'pieces_helper.json'), 'w'))
check('and again after 20 more', not T.helper_due(39) and T.helper_due(40))
check('no helper, no trained finder: colours draw the guesses', T.guess_source()[0] == 'colour')
open(T.helper_file(), 'wb').write(b'x')
check('with a helper: it draws them', T.guess_source() == ('helper', T.helper_file()))
os.remove(T.helper_file())

q = T.pieces_queue()
ranked = T.rank_pieces(q)
check('the stream marked least comes first', ranked and ranked[0].startswith('streamBBBBB'), str(ranked[:3]))
check('and they still take turns', ranked and [n[:11] for n in ranked[:4]] == ['streamBBBBB', 'streamAAAAA', 'streamBBBBB', 'streamAAAAA'], str(ranked[:4]))

# With a finder: the frames it is unsure about first.
class Stub:
    def __init__(self, *a, **k): pass
    def find_spots(self, frame, spots):
        name = Stub.now
        k = int(name.rsplit('_', 1)[1])
        return [[100, 100, 10, 10, 0.4 if j < k else 0.9, 2, 0] for j in range(6)]
real_pf, real_fi = T.PieceFinder, T.frame_interest
T.PieceFinder = Stub
def fi(name, finder, robots):
    Stub.now = name
    return real_fi(name, finder, robots)
T.frame_interest = fi
open(T.helper_file(), 'wb').write(b'x')
ranked = T.rank_pieces(q)
b_order = [n for n in ranked if n.startswith('streamBBBBB')]
check('within a stream, the frames the finder doubts most come first', b_order[:3] == ['streamBBBBB_5', 'streamBBBBB_4', 'streamBBBBB_3'], str(b_order))
p5 = json.load(open(os.path.join(T.PROPS, 'streamBBBBB_5.json')))
check('worked out once and kept', isinstance(p5.get('pint'), list) and p5['pint'][0].startswith('helper:'))
T.PieceFinder, T.frame_interest = real_pf, real_fi
os.remove(T.helper_file())

ui = T.UI_HTML
check('the window says what draws the guesses and that the useful frames come first', 'Guesses drawn by: ' in ui and 'most useful frames first' in ui)
check('and when a helper starts training', 'A helper is training on your marks' in ui)

if '--train' in sys.argv:
    # Really train it (on the CPU here, 2 rounds) on 20 marked frames, from colour guesses on the real picture.
    T.HELPER_ROUNDS = 2
    for i in range(20):
        name = 'streamCCCCC_%d' % i
        T._QUADS['streamCCCCC'] = {'q': Q, 'g': None, 'l': None, 'at': 9e12}
        frame(name)
        sp = T.frame_spots(name)
        T.lab_write(name, pieces=[b[:5] for b in T.pieces_from_colour(img, [], sp)][:30] or [[100, 100, 10, 10, 2]])
    T.do_quick_pieces({'helper_cpu': True})
    check('the helper trains and is saved', os.path.exists(T.helper_file()) and T.helper_info().get('marks', 0) >= 20, str(T.helper_info()))
    if os.path.exists(T.helper_file()):
        f = T.PieceFinder(T.helper_file(), prov=['CPUExecutionProvider'])
        check('and it can draw guesses', isinstance(f.find_spots(img, T.frame_spots('streamCCCCC_0')), list))
        check('it now draws them', T.guess_source()[0] == 'helper')

check('app 2.42 or later', T.VERSION >= '2.42')
print('helper checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
