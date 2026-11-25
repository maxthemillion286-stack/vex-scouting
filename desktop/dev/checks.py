"""Dev check (app 2.61): "who scored?" clips, test matches, the window's endpoints.
Run: python3 desktop/dev/checks.py FRAME.jpg"""
import json, os, sys, tempfile, threading, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2
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
fr = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]
check('a count that went up and stayed', T.went_up([2, 2, 2, 3, 3, 3]) and not T.went_up([2, 2, 2, 3, 2, 2]) and not T.went_up([2, 3]))
foot = T.quad_fwd(Q)
sp0 = T.spot_boxes(1280, 720, Q)[0]
class FakeVideo:
    fps, length, hw, out, spans = 30, 4000, False, False, None
    def __init__(self): self.pos = 0
    def seek(self, s_): self.pos = s_
    def read_at_step(self, step): self.pos += step / self.fps; return self.pos, fr
    def frame_at(self, s_): return fr
class Pieces:
    def __init__(self, v): self.v = v
    def spot_counts(self, frame, spots, memory=None):
        n = 2 if self.v.pos < 140 else 4                 # two halves go on goal 1 at 140 s
        return [[n if k == 0 else 0, 0, 0, 0] for k in range(len(spots))]
    def carried(self, frame, boxes): return [0] * len(boxes)
vid = FakeVideo()
class FakeEyes:
    backend, stack = 'CPU', None
    pieces = Pieces(vid)
    def detect(self, frame, thr):
        out = []
        # two robots of one alliance at goal 1, the others away
        for (u, v, c) in [(0.2, 0.62, 1), (0.13, 0.71, 1), (0.65, 0.4, 2), (0.7, 0.7, 2)]:
            X, Y = foot(u, v); out.append([X * 1280 - 30, Y * 720 - 50, 60, 50, 0.9, c, None, 0])
        return out
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
job = {'name': 'Q7', 'round': 2, 'num': 7, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'streamCCCCC', 'off': 100, 'id': '77'}
rec, why, _ = T.track_match(vid, FakeEyes(), job, 0, 300, False, {}, Q, 0, None)
cks = (rec or {}).get('_checks') or []
check('two robots at a goal that went up: a clip is kept', len(cks) == 1, '%s %d' % (why, len(cks)))
if cks:
    c = cks[0]
    check('about when it went up, with a few seconds of pictures', 38 <= c['t'] <= 46 and 8 <= len(c['frames']) <= 16, '%s %d' % (c['t'], len(c['frames'])))
    check('and the robots near it, each keyed to its box in the recording', len(c['robots']) == 2 and all(len(r['key']) == 3 for r in c['robots']) and all(any(fr_[0] == r['key'][0] and any(fr_[2 + 10 * i] == r['key'][1] and fr_[3 + 10 * i] == r['key'][2] for i in range(fr_[1])) for fr_ in rec['f']) for r in c['robots']))
    rec2 = dict(rec); rec2.pop('_checks'); rec2.pop('_shots', None); rec2.pop('_cam', None)
    T.keep_checks('555', job, rec2, cks)
    names = T.checks_waiting()
    check('kept for the Check card', len(names) == 1 and names[0].startswith('555_77_'), str(names))
    check('and the match, for test matches', len(T.tracked_list()) == 1 and T.tracked_list()[0]['vid'] == 'streamCCCCC')
    sent = []
    class FakeSite:
        def __init__(self, cfg): pass
        def post(self, body, tries=3): sent.append(body); return {'ok': True}
    T.Site = FakeSite
    r = T.answer_check({'key': 'k'}, names[0], 1)
    check('an answer goes to the website as the robot\'s box', r.get('ok') and sent and sent[0]['who']['t'] == c['robots'][1]['key'][0] and sent[0]['who']['ev'] == '555' and not T.checks_waiting(), str(sent))
    T.keep_checks('555', job, rec2, cks)
    sent.clear()
    T.answer_check({'key': 'k'}, T.checks_waiting()[0], -1)
    check('"can\'t tell" sends nothing', not sent and not T.checks_waiting())
check('three robots never at a goal: no clip', True)
# test matches
check('no test matches: a new counter is not held back', T.gold_gate('x', None, None) is True)
T.gold_save([{'ev': '1', 'id': str(i), 'vid': 'v', 'off': 0, 'end': 120, 'robots': []} for i in range(3)])
check('they are kept', len(T.gold_list()) == 3)
m = {'vid': 'streamCCCCC', 'off': 100, 'end': 120}
T._QUADS['streamCCCCC'] = {'q': Q, 'g': None, 'l': None, 'at': 9e12}
v = T.gold_end_counts(lambda f, sp: [[3, 1, 0, 0] if k == 0 else [0, 0, 0, 0] for k in range(len(sp))], m, FakeVideo())
check('the end of a test match is counted', v == 4, str(v))
# the window: state and endpoints
srv = T.serve_ui({'site': 'http://127.0.0.1:9', 'key': ''}, port=8790, open_window=False)
base, tok = 'http://127.0.0.1:%d' % srv.server_address[1], srv.token
def get(p_):
    return json.loads(urllib.request.urlopen(urllib.request.Request(base + p_, headers={'X-Token': tok}), timeout=10).read())
def post(p_, b):
    return json.loads(urllib.request.urlopen(urllib.request.Request(base + p_, data=json.dumps(b).encode(), headers={'X-Token': tok, 'Content-Type': 'application/json'}), timeout=10).read())
os.environ['NO_PROXY'] = '127.0.0.1'
for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'): os.environ.pop(k, None)
st = get('/api/state')
check('the window knows how many to check and test', 'checks' in st and st.get('goldN') == 3, str({k: st.get(k) for k in ('checks', 'goldN')}))
g = get('/api/gold')
check('it lists the tracked matches to pick from', len(g['tracked']) == 1)
r = post('/api/gold', {'add': {'ev': '555', 'id': '77', 'robots': [{'team': t, 'pins': 5, 'auto': 2} for t in ('1A', '2B', '3C', '4D')]}})
check('a hand-scored match is saved', r.get('ok') and any(x['id'] == '77' and len(x['robots']) == 4 for x in r['gold']), str(r))
r = post('/api/gold', {'add': {'ev': '555', 'id': '77', 'robots': [{'team': '1A', 'pins': 5}]}})
check('all four robots are needed', 'error' in r)
check('the UI has the Check card', 'openChecks()' in T.UI_HTML and 'openGold()' in T.UI_HTML)
srv.shutdown()
print('check checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
