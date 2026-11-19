"""v2.34 checks: one bar for the whole tracking job.

Run from desktop/:  python3 dev/bar.py
Reported: "the progress bar isnt total progress but progress of the task it has on hand".
Runs the real do_jobs loop with stand-in workers (two videos, eight matches,
a slow download) and records every bar update.
"""
import io, json, os, sys, tempfile, time, contextlib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
os.environ['VEX_UI'] = '1'
jobs = {'ev1': [{'id': str(i), 'vid': 'vidAAAAAAA1' if i < 5 else 'vidBBBBBBB2', 'off': 100 * i, 'name': 'Q%d' % i, 'red': ['1A', '2B'], 'blue': ['3C', '4D']} for i in range(8)]}
class FakeSite:
    def __init__(self, cfg): pass
    def get(self, q):
        if q == '?jobs=1': return {'events': ['ev1']}
        if q.startswith('?jobs='): return {'list': jobs['ev1']}
        if q.startswith('?event='): return {'ids': []}
        return {}
T.Site = FakeSite
T.need_key = lambda cfg, site: True
T.ensure_think = lambda cfg: False
T.load_config = lambda: {}
T.quad_for = lambda vid, site=None: None
def fake_find(cfg, vid, windows=None):
    path = os.path.join(tmp, vid + '.mp4'); open(path, 'w').write('x')
    for k in range(5):                                # a download, reported as it goes
        T.progress('Downloading the video', k * 20e6, 100e6, minor=True); time.sleep(0.05)
    return path
T.find_video = fake_find
def fake_chunk(args):
    cfg, ev, path, jobs_, sp = args[:5]
    T._SHARE = args[5]
    out = []
    for j in jobs_:
        for f in (0.25, 0.5, 0.75):
            T.share_set(j['id'], f); time.sleep(0.6)
        T.share_set(j['id'], 1.0)
        out.append({'id': j['id'], 'name': j['name'], 'ok': True, 'why': 'ok', 'sec': 1, 'hw': False, 'looks': 10, 'plates': 0, 'pins': 0, 'clock': 0, 'think': 0, 'cam': None})
    return out
T.work_chunk = fake_chunk
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    T.do_jobs({'workers': 1, 'keep_videos': True})
bars = [json.loads(l[4:]) for l in buf.getvalue().splitlines() if l.startswith('@@P ')]
main = [b for b in bars if b['t']]
check('every update is the whole job, eight matches', main and all(b['t'] == 8 and b['s'] == 'Tracking matches' for b in main), str(set((b['s'], b['t']) for b in main)))
check('the download is named under the bar, never takes it over', any('Downloading the video' in b.get('u', '') for b in main) and not any(b['s'].startswith('Downloading') for b in bars))
ds = [b['d'] for b in main]
check('it only ever goes forward', all(b >= a - 1e-9 for a, b in zip(ds, ds[1:])), str(ds))
check('it moves inside a batch of matches, not only when the batch is in', len(set(round(d, 2) for d in ds if 0 < d < 5)) >= 4, str(sorted(set(round(d, 2) for d in ds))))
check('it ends on all eight', ds and ds[-1] == 8, str(ds[-3:]))
check('it says which video it is on', any('Video 2 of 2' in b.get('u', '') for b in main))
# The window's side: the step comes through to the screen.
job = T.Job()
job.busy = lambda: True
job.add('@@P ' + json.dumps({'s': 'Tracking matches', 'd': 3.5, 't': 8, 'w': 0, 'u': 'Video 1 of 2 · next video: Downloading the video · 40%'}) + '\n')
P = job.progress()
check('the window gets the whole job and the step', P and P['total'] == 8 and P['done'] == 3.5 and P['sub'].startswith('Video 1 of 2'), str(P))
check('the window shows the step beside the stage', "P.stage+(P.sub?' · '+P.sub:'')" in T.UI_HTML and "'sub': p.get('u', '')" in open(T.__file__).read())
check('app 2.34 or later', T.VERSION >= '2.34')
print('bar checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
