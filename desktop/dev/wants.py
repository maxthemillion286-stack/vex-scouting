"""v2.50 checks: matches watched in the website's Jumper are tracked too.

Run from desktop/:  python3 dev/wants.py
"""
import io, os, sys, tempfile, contextlib, time
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
J = lambda i, vid: {'id': str(i), 'vid': vid, 'off': 100 * i, 'name': 'Q%d' % i, 'red': ['1A', '2B'], 'blue': ['3C', '4D']}
state = {'wants': [{'ev': '77', 'job': J(1, 'vidWWWWWWW1')}, {'ev': '77', 'job': J(2, 'vidWWWWWWW1')}, {'ev': '78', 'job': J(3, 'vidWWWWWWW2')}], 'have': {'78': ['3']}}
class FakeSite:
    def __init__(self, cfg): pass
    def get(self, q):
        if q == '?jobs=1': return {'events': []}
        if q == '?wants=1': return {'wants': state['wants']}
        if q.startswith('?event='): return {'ids': state['have'].get(q.split('=')[1], [])}
        return {}
T.Site = FakeSite
T.need_key = lambda cfg, site: True
T.ensure_think = lambda cfg: False
T.load_config = lambda: {}
T.quad_for = lambda vid, site=None: None
def fake_find(cfg, vid, windows=None):
    path = os.path.join(tmp, vid + '.mp4'); open(path, 'w').write('x'); return path
T.find_video = fake_find
ran = []
def fake_chunk(args):
    cfg, ev, path, jobs_, sp = args[:5]
    T._SHARE = args[5]
    out = []
    for j in jobs_:
        ran.append((ev, j['id']))
        T.share_set(j['id'], 1.0)
        out.append({'id': j['id'], 'name': j['name'], 'ok': True, 'why': 'ok', 'sec': 1, 'hw': False, 'looks': 1, 'plates': 0, 'pins': 0, 'clock': 0, 'think': 0, 'cam': None, 'spent': {}, 'det': 'CPU'})
    return out
T.work_chunk = fake_chunk
check('watched matches are work even with nothing sent', len(T.wants_open(FakeSite({}))) == 3)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    T.do_jobs({'workers': 2, 'keep_videos': True})
done = sorted(l.split()[1] for l in buf.getvalue().splitlines() if '/2  Q' in l)
check('the watched matches not yet tracked are tracked', done == ['Q1', 'Q2'], buf.getvalue()[-600:])
check('it says so', 'watched on the website' in buf.getvalue())
tried = T.wants_tried()
check('each is counted as tried; one tracked already is not tried again', tried.get('77:1') == 1 and tried.get('78:3') == T.WANTS_TRIES, str(tried))
tried['77:1'] = 2; T.wants_tried(tried)
check('after two tries it is left alone', [w['job']['id'] for w in T.wants_open(FakeSite({}))] == ['2'])
check('app 2.50 or later', T.VERSION >= '2.50')
print('wants checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
