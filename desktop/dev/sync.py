import sys, os, json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import vex_trainer as T
frames, labels, posts = {}, {}, []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o, code=200):
        b = json.dumps(o).encode(); self.send_response(code); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if 'frames=1' in self.path: return self._j({'ids': list(frames)})
        if 'labels=1' in self.path: return self._j({'labels': labels})
        self._j({})
    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers['Content-Length']))); posts.append(b)
        if 'frame' in b: frames[b['frame']['id']] = b['frame']
        if 'labelsdone' in b:
            for i in b['labelsdone']: labels.pop(i, None)
        self._j({'ok': True})
srv = ThreadingHTTPServer(('127.0.0.1', 8798), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
cfg = {'site': 'http://127.0.0.1:8798', 'key': 'correct-horse'}
for f in os.listdir(T.LABELS): os.remove(os.path.join(T.LABELS, f))
if os.path.exists(T.UPLOADED): os.remove(T.UPLOADED)
q, _ = T.review_queue()
n = T.push_review(cfg)
print('sent', n, 'of', len(q)); assert n == len(q) and n >= 1
fr = next(iter(frames.values()))
json.dump(fr, open('frame_posted.json', 'w'))
assert fr['b64'].startswith('/9j/') and len(fr['b64']) < 520 * 1024 and fr['w'] == 1280, (fr['w'], len(fr['b64']))
assert T.push_review(cfg) == 0, 'frames are not sent twice'
name = q[0]
labels[name] = {'skip': False, 'boxes': [[1, 2, 30, 40]]}; labels['unknown_frame_1234'] = {'skip': True, 'boxes': []}
came = T.pull_labels(cfg)
lab = json.load(open(os.path.join(T.LABELS, name + '.json')))
assert came == 2 and lab['boxes'] == [[1.0, 2.0, 30.0, 40.0]] and not labels, (came, lab, labels)
assert not os.path.exists(os.path.join(T.LABELS, 'unknown_frame_1234.json'))
q2, done = T.review_queue(); assert name not in q2 and done == 1
print('sync ok; picture', len(fr['b64']) * 3 // 4 // 1024, 'KB')
