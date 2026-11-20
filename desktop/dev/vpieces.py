"""v2.48 checks: the vision model marks pins & cups first.

Run from desktop/:  python3 dev/vpieces.py path/to/a_wide_stream_frame.jpg
Asked: "why cant the vision model also … let the vision model review first
too for cups and pins". Against a stand-in for Ollama (the real model's
counts are NOT tested here, only that they are asked for and used right).
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

asked, answer = [], {'mode': 'agree'}
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
        n = body['format']['properties']['spots']['maxItems']
        # Goal 1 (picture 1) has two yellow halves and a cup; the rest nothing.
        rows = [{'n': i + 1, 'red': 0, 'blue': 0, 'yellow': 2 if i == 0 else 0, 'cups': 1 if i == 0 else 0} for i in range(n)]
        if answer['mode'] == 'differ':
            rows[0]['yellow'] = 4
        self._send({'message': {'role': 'assistant', 'content': json.dumps({'spots': rows})}, 'done': True})
srv = ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
T.OLLAMA = 'http://127.0.0.1:%d' % srv.server_address[1]
T.say = lambda *a, **k: None
T.progress = lambda *a, **k: None

tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
T.FRAMES, T.PROPS, T.LABELS = (os.path.join(tmp, 'data', k) for k in ('frames', 'prop', 'labels'))
for d in (T.FRAMES, T.PROPS, T.LABELS): os.makedirs(d, exist_ok=True)
T._QUADS.clear(); T._QUADS_LOADED.append(1)
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
Q = [0.066, 0.80, 0.86, 0.78, 0.81, 0.21, 0.21, 0.21]
T._QUADS['streamPPPPP'] = {'q': Q, 'g': None, 'l': None, 'at': 9e12}
for i in range(4):
    name = 'streamPPPPP_%d' % i
    cv2.imwrite(os.path.join(T.FRAMES, name + '.jpg'), img)
    json.dump({'w': 1280, 'h': 720, 'boxes': []}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
    T.lab_write(name, skip=False, boxes=[[10, 10, 50, 50]])
spots = T.frame_spots('streamPPPPP_0')
sb = spots[0]
cx, cy = (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2
GUESS = [[cx - 5, cy - 20, 10, 10, 2], [cx - 5, cy - 8, 10, 10, 2], [cx - 8, cy + 5, 16, 10, 3]]
T.piece_guesses = lambda name, frame, robots, spots_: [list(b) for b in GUESS]
cfg = {'think': True}

check('each goal and loader is counted by kind', T.spot_counts_of(GUESS, spots)[0] == [0, 0, 2, 1] and sum(map(sum, T.spot_counts_of(GUESS, spots)[1:])) == 0)
answer['mode'] = 'differ'
got = T.vlm_pieces_frame(cfg, 'streamPPPPP_3')
check('the model is shown each goal and loader and asked for counts', asked and asked[-1]['messages'][0]['images'] and 'red halves, blue halves, yellow halves and cups' in asked[-1]['messages'][0]['content'])
check('a different count: not agreed', got and not got['agree'] and got['model'][0] == [0, 0, 4, 1], str(got and got['model'][:2]))
check('and said plainly', T.pvlm_text(got) == 'The vision model counts goal 1: 4 yellow halves, 1 cup.', T.pvlm_text(got))
answer['mode'] = 'agree'
T.do_vpieces(cfg)
labs = {n: T.lab_read(n) for n in ('streamPPPPP_0', 'streamPPPPP_1', 'streamPPPPP_2', 'streamPPPPP_3')}
check('frames where it agrees with the guesses on every spot are marked for you', all(labs['streamPPPPP_%d' % i].get('pby') == 'vlm' and len(labs['streamPPPPP_%d' % i]['pieces']) == 3 for i in range(3)), str(labs))
check('the frame it disagreed on is not asked again and stays for you', 'pieces' not in labs['streamPPPPP_3'] and T.pieces_queue() == ['streamPPPPP_3'])
check('its marks are trained on, never used to grade', not T.pieces_by_person('streamPPPPP_0') and T.pieces_by_person('streamPPPPP_3'))
T.lab_write('streamPPPPP_0', pieces=GUESS, pskip=False, pby=None)
check('marked again by you: yours, and it grades', T.pieces_by_person('streamPPPPP_0'))
ui, src = T.UI_HTML, open(T.__file__).read()
check('the window has the button', "start('vpieces')" in ui and 'Let the vision model mark pins &amp; cups first' in ui)
check('the frames it disagreed on come first, with its counts', "if pv_ and not pv_.get('agree'):" in src and "'vlm': pvlm_text(p.get('pvlm'))" in src and "else if(cur.vlm)" in ui)
check('a frame you mark yourself is yours', "pskip=False, pby=None)" in src)
check('app 2.48 or later', T.VERSION >= '2.48')
print('vision pins checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
