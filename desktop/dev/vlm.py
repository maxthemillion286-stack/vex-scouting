"""v2.40 checks: the vision model as a reviewer and a field finder, and boxes
standing off the field left out — against a stand-in for Ollama (no model can
be downloaded where this was written; the real model's answers are NOT
tested here, only that its answers are asked for and used correctly).

Run from desktop/:  python3 dev/vlm.py path/to/a_wide_stream_frame.jpg
"""
import json, os, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2, numpy as np
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]
TRUE_SPOTS = [[p[0] + 0.01, p[1] - 0.01] for p in T.first_spots(Q)]
asked = []
mode = {'review': 'mixed'}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == '/api/version': return self._send({'version': 'standin'})
        if self.path == '/api/tags': return self._send({'models': [{'name': 'qwen3-vl:8b'}]})
        self._send({})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        asked.append(body)
        props = body['format']['properties']
        if 'outlined' in props:
            n = props['outlined']['maxItems']
            if mode['review'] == 'agree':
                ans = {'outlined': [{'n': k + 1, 'what': 'robot'} for k in range(n)], 'missed': []}
            else:
                ans = {'outlined': [{'n': k + 1, 'what': 'person' if k == 1 else 'robot'} for k in range(n)],
                       'missed': [[700, 300, 760, 360]]}
        elif 'corners' in props:
            ans = {'corners': [[Q[i] * 1000, Q[i + 1] * 1000] for i in range(0, 8, 2)],
                   'goals': [[p[0] * 1000, p[1] * 1000] for p in TRUE_SPOTS[:9]][::-1],
                   'loaders': [[p[0] * 1000, p[1] * 1000] for p in TRUE_SPOTS[9:]]}
        else:
            ans = {}
        self._send({'message': {'role': 'assistant', 'content': json.dumps(ans)}, 'done': True})
srv = ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
T.OLLAMA = 'http://127.0.0.1:%d' % srv.server_address[1]
T.say = lambda *a, **k: None
T.progress = lambda *a, **k: None

tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
T.FRAMES, T.PROPS, T.LABELS = (os.path.join(tmp, 'data', k) for k in ('frames', 'prop', 'labels'))
for d in (T.FRAMES, T.PROPS, T.LABELS): os.makedirs(d, exist_ok=True)
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
cfg = {'think': True}

# ── the reviewer
def save(name, boxes):
    cv2.imwrite(os.path.join(T.FRAMES, name + '.jpg'), img)
    json.dump({'w': 1280, 'h': 720, 'hard': 2, 'boxes': boxes}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
robots = [[300, 300, 90, 80, 0.8], [100, 200, 60, 140, 0.6], [900, 400, 90, 80, 0.7]]
for i in range(4):
    save('vidvlmAAAAA_%d' % i, [list(b) for b in robots])
mode['review'] = 'mixed'
notes = T.vlm_review_frame(cfg, 'vidvlmAAAAA_0')
check('the model is asked what each box is and what was missed', notes and notes['what'] == ['robot', 'person', 'robot'], str(notes))
check('a robot it says was missed comes back as a box in the frame', notes and len(notes['missed']) == 1 and 800 < notes['missed'][0][0] + notes['missed'][0][2] / 2 * 2 < 1100, str(notes and notes['missed']))
keep, agree = T.vlm_verdict(notes)
check('it keeps the robots, drops the person, adds the missed one', len(keep) == 3 and not agree)
check('the picture it saw had the boxes numbered', 'outlined' in asked[-1]['format']['properties'] and asked[-1]['messages'][0]['images'])
mode['review'] = 'agree'
T.do_vreview(cfg)
labs = {n[:-5]: T.lab_read(n[:-5]) for n in os.listdir(T.LABELS)}
check('frames where it and the finder agree are labelled for you', sum(1 for l in labs.values() if l.get('by') == 'vlm') == 3, str(labs))
check('a frame where it disagreed stays for you', 'vidvlmAAAAA_0' not in labs)
q, _ = T.review_queue()
check('and comes first in review', q and q[0] == 'vidvlmAAAAA_0', str(q))
check('its labels are never graded on (not "reviewed by a person")', T.reviewed() == [] and len(T.reviewed(vlm=True)) == 3)
T.lab_write('vidvlmAAAAA_0', skip=False, boxes=[b[:4] for b in robots])
root, counts = T.build_dataset()
val = os.listdir(os.path.join(root, 'images', 'val')); train = os.listdir(os.path.join(root, 'images', 'train'))
check('its labels are trained on', counts.get('vlm', 0) >= 1 and any(n.startswith('vidvlmAAAAA_') and n != 'vidvlmAAAAA_0.jpg' for n in train), str(counts))
check('but never in the frames that grade the finder', not any(T.lab_read(n[:-4]).get('by') == 'vlm' for n in val))

# The review screen shows its changes.
os.remove(os.path.join(T.LABELS, 'vidvlmAAAAA_0.json'))
srv2 = T.serve_ui({'site': 'http://127.0.0.1:1', 'key': '', 'workers': 2, 'think': True}, port=18780, open_window=False)
import urllib.request
def api(path, body=None):
    req = urllib.request.Request(srv2.url.split('/?')[0] + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'X-Token': srv2.token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())
nx = api('/api/next')
check('review opens with its changes applied and says so', nx.get('id') == 'vidvlmAAAAA_0' and len(nx['boxes']) == 3 and nx.get('vlm') == {'removed': ['person'], 'added': 1}, str(nx))
ui = T.UI_HTML
check('the window offers it, and says what it changed on a frame', "start('vreview')" in ui and 'The vision model' in ui and 'it thinks the finder missed' in ui)

# ── the field finder
got = T.vlm_find_field(cfg, 'vidvlmAAAAA_1')
check('it finds the four corners', 'pts' in got and len(got['pts']) == 4, str(got))
if 'spots' in got:
    err = max(abs(a - b) for s, t in zip(got['spots'], TRUE_SPOTS) for a, b in zip(s, t))
    check('each goal and loader goes to its own slot, wherever the model listed it', err < 1e-3, 'off by %.4f' % err)
nx2 = api('/api/ffind', {'id': 'vidvlmAAAAA_1'})
check('the field screen can ask for it', 'spots' in nx2 and len(nx2['spots']) == 13)
check('the field screen has the button', 'findField()' in ui and 'Find it for me' in ui)
srv2.shutdown()

# ── boxes off the field
inv = T.field_inverse(Q)
foot = lambda u, v: T.quad_fwd(Q)(u, v)
x, y = foot(0.5, 0.5)
check('a robot on the field is kept', T.on_field([x * 1280 - 40, y * 720 - 60, 80, 60], inv, 1280, 720))
x, y = foot(0.5, -0.2)
check('someone standing beyond the far wall is not', not T.on_field([x * 1280 - 20, y * 720 - 120, 40, 120], inv, 1280, 720))
x, y = foot(-0.25, 0.5)
check('nor someone beside the field', not T.on_field([x * 1280 - 20, y * 720 - 120, 40, 120], inv, 1280, 720))
x, y = foot(1.03, 0.5)
check('a robot right at the wall is kept', T.on_field([x * 1280 - 40, y * 720 - 60, 80, 60], inv, 1280, 720))
check('no field mark: nothing is dropped', T.on_field([0, 0, 10, 10], None, 1280, 720))

class FakeVideo:
    fps, length, hw, out, spans = 30, 2000, False, False, None
    def __init__(self): self.pos = 0
    def seek(self, s): self.pos = s
    def read_at_step(self, step): self.pos += step / self.fps; return self.pos, img
    def frame_at(self, s): return img
class FakeEyes:
    backend, pieces = 'CPU', None
    def detect(self, frame, thr):
        out = []
        for (u, v, c) in [(0.3, 0.4, 1), (0.35, 0.7, 1), (0.65, 0.4, 2), (0.7, 0.7, 2)]:
            X, Y = foot(u, v); out.append([X * 1280 - 40, Y * 720 - 70, 80, 70, 0.9, c, None, 0])
        X, Y = foot(-0.3, 0.5); out.append([X * 1280 - 20, Y * 720 - 140, 40, 140, 0.9, 1, None, 0])    # a person by the field, boxed red
        return out
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
v = FakeVideo()
job = {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidfieldXXX', 'off': 100}
rec, why, _ = T.track_match(v, FakeEyes(), job, 0, 300, False, {}, Q, 0, None)
check('in tracking, the person beside the field is not recorded', rec and max(fr[1] for fr in rec['f']) == 4, why if not rec else str(max(fr[1] for fr in rec['f'])))
check('app 2.40 or later', T.VERSION >= '2.40')
print('vision model checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
