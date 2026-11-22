"""v2.52 checks: Ask, answered on this computer.

Run from desktop/:  python3 dev/ask.py
Against a stand-in for Ollama: only the website may ask, the browser's check
first is answered, and the question goes to the model with the table.
"""
import json, os, sys, tempfile, threading, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

asked = []
class O(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == '/api/version': return self._send({'version': 'standin'})
        if self.path == '/api/tags': return self._send({'models': [{'name': 'qwen3-vl:8b'}]})
        self._send({})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length']))); asked.append(body)
        self._send({'message': {'role': 'assistant', 'content': '66449A: usually 4 pins.'}, 'done': True})
o = ThreadingHTTPServer(('127.0.0.1', 0), O); threading.Thread(target=o.serve_forever, daemon=True).start()
T.OLLAMA = 'http://127.0.0.1:%d' % o.server_address[1]
T.say = lambda *a, **k: None
tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
T.load_config = lambda: {'think': True}
srv = T.serve_ui({'site': 'http://127.0.0.1:1', 'key': '', 'workers': 2, 'think': True}, port=18790, open_window=False)
base = srv.url.split('/?')[0]
SITE = 'https://vex-scouting-by-max.vercel.app'
def req(method, path, origin=None, body=None):
    h = {'Content-Type': 'application/json'}
    if origin: h['Origin'] = origin
    if method == 'OPTIONS': h['Access-Control-Request-Private-Network'] = 'true'
    r = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as x:
            return x.status, dict(x.headers), x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()
c, h, b = req('OPTIONS', '/ask', SITE)
check('the browser\'s check first is answered for the website, private network allowed', c == 204 and h.get('Access-Control-Allow-Private-Network') == 'true' and h.get('Access-Control-Allow-Origin') == SITE, str((c, h)))
c, h, b = req('OPTIONS', '/ask', 'https://evil.example')
check('and refused for any other website', c == 403)
c, h, b = req('GET', '/ask/ping', SITE)
check('the website can find the app', c == 200 and json.loads(b)['ok'] and h.get('Access-Control-Allow-Origin') == SITE)
c, h, b = req('GET', '/ask/ping', 'https://evil.example')
check('another website cannot', c == 403)
c, h, b = req('GET', '/api/state', SITE)
check('nothing else is open to the website', c == 403)
table = 'team | auto pins\n66449A | usually 4 pins'
c, h, b = req('POST', '/ask', SITE, {'question': 'Who has the best auto?', 'table': table, 'where': 'Excalibur', 'history': [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'hello'}]})
check('a question is answered', c == 200 and json.loads(b).get('answer') == '66449A: usually 4 pins.', b)
m = asked[-1]['messages'] if asked else []
check('the model gets the table, the earlier turns and the question', m and table in m[0]['content'] and 'Excalibur' in m[0]['content'] and m[1]['content'] == 'hi' and m[-1]['content'] == 'Who has the best auto?', str(m)[:300])
check('and is told to use only the table', m and 'ONLY the data below' in m[0]['content'])
c, h, b = req('POST', '/ask', 'https://evil.example', {'question': 'x', 'table': ''})
check('another website cannot ask', c == 403)
srv.shutdown()
check('app 2.52 or later', T.VERSION >= '2.52')
print('ask checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
