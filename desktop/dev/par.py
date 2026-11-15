import sys, os, threading, hashlib, time, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import vex_trainer as T
DATA = os.urandom(37 * 1024 * 1024 + 12345)
mode = {'fail_at': None, 'hits': 0, 'max': 0, 'cur': 0}
lock = threading.Lock()
class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def do_GET(self):
        m = re.match(r'bytes=(\d+)-(\d+)', self.headers.get('Range') or '')
        if not m: self.send_response(400); self.send_header('Content-Length', '0'); self.end_headers(); return
        a, b = int(m.group(1)), int(m.group(2))
        with lock: mode['hits'] += 1; mode['cur'] += 1; mode['max'] = max(mode['max'], mode['cur'])
        try:
            if mode['fail_at'] is not None and a >= mode['fail_at']:
                self.send_response(403); self.send_header('Content-Length', '0'); self.end_headers(); return
            time.sleep(0.05)                                   # a connection is slow; many are not
            body = DATA[a:b + 1]
            self.send_response(206); self.send_header('Content-Range', 'bytes %d-%d/%d' % (a, b, len(DATA))); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        finally:
            with lock: mode['cur'] -= 1
srv = ThreadingHTTPServer(('127.0.0.1', 8797), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
said = []
ok = T.fetch_parallel('http://127.0.0.1:8797/v', 'par.bin', piece=1024 * 1024, conns=24, report=lambda d, t, s: said.append(d))
assert ok and hashlib.sha256(open('par.bin', 'rb').read()).digest() == hashlib.sha256(DATA).digest(), 'file differs'
print('whole file, identical; pieces', mode['hits'] - 1, 'at once up to', mode['max'])
assert mode['max'] >= 12 and not os.path.exists('par.bin.part')
os.remove('par.bin'); mode['fail_at'] = 20 * 1024 * 1024
real_sleep = time.sleep; T.time.sleep = lambda s: real_sleep(0.01)
ok = T.fetch_parallel('http://127.0.0.1:8797/v', 'par.bin', piece=1024 * 1024, conns=8)
assert ok is False and not os.path.exists('par.bin') and not os.path.exists('par.bin.part'), 'a refused piece must leave nothing behind'
print('a refusal part-way leaves nothing behind and reports failure')
assert T.fetch_parallel('http://127.0.0.1:1/none', 'par.bin') is False
print('an unreachable address reports failure')
