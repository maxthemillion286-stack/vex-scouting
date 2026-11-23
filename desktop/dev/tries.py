"""v2.56 checks: a match that cannot be tracked is not tried for ever.

Run from desktop/:  python3 dev/tries.py
"""
import io, os, sys, tempfile, contextlib
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
J = lambda i: {'id': str(i), 'vid': 'vidTRYTRY01', 'off': 100 * i, 'name': 'Q%d' % i, 'red': ['1A', '2B'], 'blue': ['3C', '4D']}
posted = []
HAVE = {'1'}                                                       # Q1 already tracked
class FakeSite:
    def __init__(self, cfg): pass
    def get(self, q):
        if q == '?jobs=1': return {'events': ['77']}
        if q == '?jobs=77': return {'list': [J(1), J(2), J(3)]}
        if q.startswith('?event='): return {'ids': sorted(HAVE)}
        return {}
    def post(self, body, tries=3): posted.append(body); return {'ok': True}
T.Site = FakeSite
T.need_key = lambda cfg, site: True
T.ensure_think = lambda cfg: False
T.load_config = lambda: {}
T.quad_for = lambda vid, site=None: None
T.find_video = lambda cfg, vid, windows=None: (open(os.path.join(tmp, vid + '.mp4'), 'w').write('x') and None) or os.path.join(tmp, vid + '.mp4')
def fake_chunk(args):
    cfg, ev, path, jobs_, sp = args[:5]
    T._SHARE = args[5]
    out = []
    for j in jobs_:
        T.share_set(j['id'], 1.0)
        good = j['id'] == '2'                                          # Q3 can never be tracked
        out.append({'id': j['id'], 'name': j['name'], 'ok': good, 'why': 'ok' if good else 'robots of both alliances were not seen', 'sec': 1, 'hw': False, 'looks': 1, 'plates': 0, 'pins': 0, 'clock': 0, 'think': 0, 'cam': None, 'spent': {}, 'det': 'CPU'})
    return out
T.work_chunk = fake_chunk
def run():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        T.do_jobs({'workers': 2, 'keep_videos': True})
    return buf.getvalue()
log1 = run()
check('the first round tries both matches left', '2 to go' in log1, log1[-400:])
check('a failed one is counted', T.job_tries().get('77:3') == 1, str(T.job_tries()))
HAVE.add('2')                                                      # Q2 was tracked and saved
log2 = run()
check('it is tried a second time', T.job_tries().get('77:3') == 2)
posted.clear()
log3 = run()
check('then left out, and said so', 'could not be tracked after 2 tries' in log3 and 'Q3' in log3 and 'Nothing left' in log3, log3[-500:])
check('and its event is finished on the website (its other matches are tracked)', any((b.get('jobs') or {}).get('done') and b['jobs']['ev'] == '77' for b in posted), str(posted))
check('app 2.56 or later', T.VERSION >= '2.56')
print('tries checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
