import sys, os, json, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import vex_trainer as T
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if 'jobs=1' in self.path: return self._j({'events': []})
        self._j({})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if body.get('passcode') != 'correct-horse':
            b = b'{"error":"wrong passcode"}'; self.send_response(403); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        self._j({'ok': True})
site = ThreadingHTTPServer(('127.0.0.1', 8799), H); threading.Thread(target=site.serve_forever, daemon=True).start()
cfg = {'site': 'http://127.0.0.1:8799', 'key': '', 'workers': 4, 'keep_videos': False, 'files': {}}
T.save_config(cfg)
srv = T.serve_ui(cfg, port=8770, open_window=False)
open('ui.url', 'w').write(srv.url)
print(srv.url, flush=True)
time.sleep(600)
