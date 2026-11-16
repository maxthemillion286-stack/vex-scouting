import sys, os, json, threading, numpy as np, cv2
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import vex_trainer as T
if __name__ == '__main__':
    for name in ('a', 'b', 'c'):
        vw = cv2.VideoWriter('run/vid_%s.mp4' % name, cv2.VideoWriter_fourcc(*'mp4v'), 30, (640, 360))
        for i in range(30 * 45): vw.write(np.full((360, 640, 3), 70, np.uint8))
        vw.release()
    job = lambda i, vid: {'id': str(i), 'name': 'Qualification %d' % i, 'round': 2, 'num': i, 'vid': vid, 'off': 5, 'red': ['66449A', '1A'], 'blue': ['2B', '3C']}
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _j(self, o):
            b = json.dumps(o).encode(); self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_GET(self):
            if 'jobs=1' in self.path: return self._j({'events': ['900']})
            if 'jobs=900' in self.path: return self._j({'list': [job(1, 'aaaaaaaaaaa'), job(2, 'aaaaaaaaaaa'), job(3, 'bbbbbbbbbbb'), job(4, 'ccccccccccc')]})
            self._j({'ids': []})
        def do_POST(self): self.rfile.read(int(self.headers['Content-Length'])); self._j({'ok': True})
    srv = ThreadingHTTPServer(('127.0.0.1', 8796), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    here = os.path.abspath('run')
    cfg = {'site': 'http://127.0.0.1:8796', 'key': 'correct-horse', 'workers': 2, 'keep_videos': True, 'hw_decode': False,
           'files': {'aaaaaaaaaaa': here + '/vid_a.mp4', 'bbbbbbbbbbb': here + '/vid_b.mp4', 'ccccccccccc': here + '/missing.mp4'}}
    fake_dl = []
    T.download = lambda vid, stem, windows=None: fake_dl.append(vid) or None       # the third has no file: "download" fails
    n = T.do_jobs(cfg)
    print('saved', n, '| asked to download:', fake_dl)
    assert fake_dl == ['ccccccccccc'], fake_dl
