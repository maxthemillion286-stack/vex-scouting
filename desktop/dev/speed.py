"""v2.46 checks: tracking faster.

Run from desktop/:  python3 dev/speed.py [path/to/a_wide_stream_frame.jpg]
Asked: "any way to make the tracking process faster … it takes hours upon
hours just to get a few streams done".
  · one pool of workers for the whole job: the next video's matches start
    while the last one's slowest worker is still going;
  · the vision model asked about two pictures, not six, where the plates
    already say who is who;
  · where the time went, per match and for the job.
"""
import io, json, os, sys, tempfile, time, contextlib, threading
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

# ── the vision model only where it is needed
fr = lambda who: [10, 4] + sum(([0] * 9 + [w] for w in who), [])
shots = [(i, b'x', 3) for i in range(6)]
check('plates read for all four: two pictures', len(T.trim_shots({'f': [fr([1, 2, 3, 4])] * 2}, shots)) == 2)
check('a robot not read twice: all six', len(T.trim_shots({'f': [fr([1, 2, 3, 0])] * 2}, shots)) == 6)
check('no plates: all six', len(T.trim_shots({'f': [fr([0, 0, 0, 0])]}, shots)) == 6)

# ── one pool for the whole job
tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
os.environ['VEX_UI'] = '1'
# Video A: one long match and one short; video B: two short. With two workers,
# B's matches should start while A's long one is still going.
jobs = [{'id': '1', 'vid': 'vidAAAAAAA1', 'off': 100, 'name': 'Q1', 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'slow': 3.0},
        {'id': '2', 'vid': 'vidAAAAAAA1', 'off': 400, 'name': 'Q2', 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'slow': 0.3},
        {'id': '3', 'vid': 'vidBBBBBBB2', 'off': 100, 'name': 'Q3', 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'slow': 0.3},
        {'id': '4', 'vid': 'vidBBBBBBB2', 'off': 400, 'name': 'Q4', 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'slow': 0.3}]
class FakeSite:
    def __init__(self, cfg): pass
    def get(self, q):
        if q == '?jobs=1': return {'events': ['ev1']}
        if q.startswith('?jobs='): return {'list': jobs}
        if q.startswith('?event='): return {'ids': []}
        return {}
T.Site = FakeSite
T.need_key = lambda cfg, site: True
T.ensure_think = lambda cfg: False
T.load_config = lambda: {}
T.quad_for = lambda vid, site=None: None
def fake_find(cfg, vid, windows=None):
    path = os.path.join(tmp, vid + '.mp4'); open(path, 'w').write('x'); return path
T.find_video = fake_find
def fake_chunk(args):
    cfg, ev, path, jobs_, sp = args[:5]
    T._SHARE = args[5]
    out = []
    for j in jobs_:
        t0 = time.time()
        time.sleep(j['slow'])
        T.share_set(j['id'], 1.0)
        out.append({'id': j['id'], 'name': j['name'], 'ok': True, 'why': 'ok', 'sec': 1, 'hw': False, 'looks': 10, 'plates': 0, 'pins': 0, 'clock': 0, 'think': 0, 'cam': None,
                    'start': t0, 'end': time.time(), 'spent': {'robots': 2.0, 'video': 1.0, 'vision model': 0.5}, 'det': 'DML'})
    return out
T.work_chunk = fake_chunk
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    T.do_jobs({'workers': 2, 'keep_videos': True})
log = buf.getvalue()
lines = [l for l in log.splitlines() if not l.startswith('@@')]
order = [l.split()[1] for l in lines if '/4  Q' in l]
check('all four matches done', len(order) == 4, str(order))
check('the second video\'s matches finished before the first video\'s slow one: no worker waited for it', order[:2] == ['Q3', 'Q4'], str(order))
check('where the time went is said', any(l.startswith('Where the time went') and 'robots 57%' in l and 'video 29%' in l for l in lines), '\n'.join(lines[-6:]))
check('and kept', abs(T._LAST_SPENT.get('robots', 0) - 0.571) < 0.01, str(T._LAST_SPENT))
src = open(T.__file__).read()
check('the time is measured where it goes', all("_tick('%s'" % k in src for k in ('video', 'robots', 'plates', 'camera', 'pins', 'fingerprints')))
check('runs of two matches at least, not four', 'size = max(2, math.ceil(len(jobs) / workers))' in src)

if len(sys.argv) > 1:
    # A real match's breakdown, on this computer.
    import cv2, numpy as np, shutil
    img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720))
    vp = os.path.join(tmp, 'm.mp4')
    vw = cv2.VideoWriter(vp, cv2.VideoWriter_fourcc(*'mp4v'), 30, (1280, 720))
    for i in range(30 * 20): vw.write(img)
    vw.release()
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for n in ('robot_detector.onnx', 'plate_reader.onnx', 'text_finder.onnx'):
        if os.path.exists(os.path.join(root, 'models', n)):
            shutil.copy(os.path.join(root, 'models', n), T.DIRS['models'])
    try:
        import re
        m = re.search(r'const PLATE_CHARS = (\{.*?\});', open(os.path.join(root, 'vendor', 'vt-worker.js'), encoding='utf-8').read(), re.S)
        open(os.path.join(T.DIRS['models'], 'plate_chars.json'), 'w').write(m.group(1))
    except Exception:
        pass
    T._TIME.clear()
    v = T.Video(vp, hw=False)
    try:
        eyes = T.Eyes(quiet=True, threads=2)
        T.WINDOW = 15
        T.track_match(v, eyes, {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidXXXXXXXX', 'off': 2, 'id': '1'}, 0, 300, False, {}, None, 0, None)
        check('a real match records its time', T._TIME.get('robots', 0) > 0 and T._TIME.get('video', 0) > 0, str(T._TIME))
        print('  this computer:', {k: round(v_, 1) for k, v_ in T._TIME.items()})
    except Exception as e:
        print('  (no models here for a real match: %s)' % e)
check('app 2.46 or later', T.VERSION >= '2.46')
print('speed checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
