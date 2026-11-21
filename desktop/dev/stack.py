"""v2.49 checks: counting pins exactly, in the app.

Run from desktop/:  python3 dev/stack.py path/to/a_wide_stream_frame.jpg [--train]
  · a goal a robot stands in front of is not counted that look;
  · sharper downloads when asked for;
  · the stack reader: goals read bottom to top, practice stacks made from the
    marks, looks laid over each other. Frames are made from the real one with
    stacks of coloured halves drawn on its goals (the real game's pieces are
    not here); with --train it is really trained on them (CPU) and has to
    count most goals it never saw exactly right.
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
T.say = lambda *a, **k: print(' ', *a) if '--train' in sys.argv else None
T.progress = lambda *a, **k: None
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]

# ── blocked goals
check('a goal mostly behind a robot is blocked', T.blocked([100, 100, 140, 200], [[90, 120, 80, 100, 0.9]]))
check('one a robot only touches is not', not T.blocked([100, 100, 140, 200], [[135, 120, 80, 100, 0.9]]))
src = open(T.__file__).read()
check('blocked spots are written as not seen (-1s)', "if sb and blocked(sb, boxes):\n                            cnt[k] = [-1, -1, -1, -1]" in src)
check('sharper downloads: 1080p when asked', "hp = 1080 if load_config().get('sharp') else 720" in src and 'sSharp' in T.UI_HTML)

# ── frames with stacks drawn on the goals
COL = {0: (40, 40, 220), 1: (220, 90, 30), 2: (30, 220, 240)}
rng = np.random.default_rng(3)
def make(name):
    T._QUADS['streamSSSSS'] = {'q': Q, 'g': None, 'l': None, 'at': 9e12}
    pic = img.copy()
    spots = T.spot_boxes(1280, 720, Q)
    pieces = []
    for k, sb in enumerate(spots[:9]):
        if not sb: continue
        x0, y0, x1, y1 = sb
        w, h = (x1 - x0) * 0.45, (y1 - y0) * 0.08
        y = y1 - (y1 - y0) * 0.06
        for _ in range(int(rng.integers(0, 5))):
            c = int(rng.integers(0, 3))
            bx, by = (x0 + x1) / 2 - w / 2, y - h
            cv2.rectangle(pic, (int(bx), int(by)), (int(bx + w), int(by + h) - 1), COL[c], -1)
            cv2.line(pic, (int(bx), int(by + h) - 1), (int(bx + w), int(by + h) - 1), (20, 20, 20), 1)
            pieces.append([round(bx, 1), round(by, 1), round(w, 1), round(h, 1), c])
            y -= h
    cv2.imwrite(os.path.join(T.FRAMES, name + '.jpg'), pic, [cv2.IMWRITE_JPEG_QUALITY, 80])
    json.dump({'w': 1280, 'h': 720, 'boxes': []}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
    T.lab_write(name, skip=False, boxes=[], pieces=pieces, pskip=False)
for i in range(60):
    make('streamSSSSS_%d' % i)
marked = T.pieces_marked()
check('the marked frames are found', len(marked) == 60, str(len(marked)))
ex = T.stack_examples(marked)
check('every goal and loader of them is an example, read bottom to top', len(ex) >= 60 * 9 and all(c.shape == (T.STACK_H, T.STACK_W, 3) for c, s, n in ex))
name0 = marked[0][0]
seq0 = [s for c, s, n in ex if n == name0]
want0 = T.spot_counts_of(marked[0][4], marked[0][5])
check('the sequences hold what was marked', [T.stack_counts_of([v - 1 for v in s]) for s in seq0][:9] == [w for w, sb in zip(want0, marked[0][5]) if sb][:9], str(seq0[:3]))
fake = T.stack_practice(marked, 200)
check('practice stacks are made from the marks', len(fake) == 200 and any(len(s) >= 3 for c, s in fake), str([len(s) for c, s in fake[:10]]))
check('CTC reading: repeats need a gap, nothing is skipped', T.stack_decode(np.array([[0, 5, 0, 0, 0], [0, 5, 0, 0, 0], [9, 0, 0, 0, 0], [0, 5, 0, 0, 0], [0, 0, 0, 7, 0]], float)) == [0, 0, 2])
check('the window and the trainer know it', 'do_stack_reader(cfg)' in src and "'--stack-reader'" in src)

if '--train' in sys.argv:
    info = T.do_stack_reader({'stack_rounds': int(os.environ.get('ROUNDS', '25')), 'stack_synth': 1500})
    check('it is trained, tested and written down', info and os.path.exists(T.stack_file()), str(info))
    if info:
        check('it counts most goals it never saw exactly right (%d%%; colours %d%%)' % (100 * info['exact'], 100 * info['colour']), info['exact'] >= 0.7, str(info))
        rd = T.StackReader(prov=['CPUExecutionProvider'])
        fr = cv2.imread(os.path.join(T.FRAMES, name0 + '.jpg'))
        mem = {}
        a = rd.counts(fr, marked[0][5], mem); b = rd.counts(fr, marked[0][5], mem)
        check('looks laid over each other read the same as one', a == b and len(mem) >= 9)
        # In tracking: the robot finder stood in for (four robots on the field), the reader real.
        foot = T.quad_fwd(Q)
        class FakeVideo:
            fps, length, hw, out, spans = 30, 2000, False, False, None
            def __init__(self): self.pos = 0
            def seek(self, s_): self.pos = s_
            def read_at_step(self, step): self.pos += step / self.fps; return self.pos, fr
            def frame_at(self, s_): return fr
        class FakeEyes:
            backend, pieces = 'CPU', None
            stack = rd
            def detect(self, frame, thr):
                out = []
                for (u, v, c) in [(0.3, 0.4, 1), (0.35, 0.7, 1), (0.65, 0.4, 2), (0.7, 0.7, 2)]:
                    X, Y = foot(u, v); out.append([X * 1280 - 30, Y * 720 - 50, 60, 50, 0.9, c, None, 0])
                return out
            def plate(self, *a): return 0
            def scan(self, *a): return []
            def clock_at(self, *a): return None
        T.WINDOW = 15
        rec, why, _ = T.track_match(FakeVideo(), FakeEyes(), {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'streamSSSSS', 'off': 100, 'id': '1'}, 0, 300, False, {}, Q, 0, None)
        gs = (rec or {}).get('gs') or []
        step = 1 + 4 * len(T.SPOTS)
        check('tracking writes its counts every second', len(gs) >= 3 * step and len(gs) % step == 0, '%s %d' % (why, len(gs)))
        if gs:
            first = [gs[1 + 4 * k:5 + 4 * k] for k in range(9)]
            check('and they are the stacks drawn (%s)' % first, sum(list(f) == list(w) for f, w in zip(first, want0[:9])) >= 7, str(want0[:9]))
check('app 2.49 or later', T.VERSION >= '2.49')
print('stack checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
