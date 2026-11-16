import sys, os, threading, re, time, cv2, numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import vex_trainer as T
DATA = open('dash.mp4', 'rb').read(); asked = []
class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def do_GET(self):
        m = re.match(r'bytes=(\d+)-(\d+)', self.headers.get('Range') or ''); a, b = int(m.group(1)), min(int(m.group(2)), len(DATA) - 1)
        asked.append((a, b)); body = DATA[a:b + 1]
        self.send_response(206); self.send_header('Content-Range', 'bytes %d-%d/%d' % (a, b, len(DATA))); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
srv = ThreadingHTTPServer(('127.0.0.1', 8795), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
idx = T.parse_index(DATA[:200000])
anchor, segs = idx
print('index: first segment at byte %d, %d segments, %.1f s each, covering %.0f s' % (anchor, len(segs), segs[0][1], segs[-1][0] + segs[-1][1]))
assert anchor == 1871 and abs(segs[-1][0] + segs[-1][1] - 175) < 3 and len(DATA) - (segs[-1][2] + segs[-1][3]) < 4096
windows = [(20, 40), (100, 130)]
rs, spans = T.needed_ranges(idx, windows, len(DATA))
need = sum(b - a + 1 for a, b in rs)
print('needed: %d ranges, %.0f%% of the file; holds' % (len(rs), 100 * (need + anchor) / len(DATA)), spans)
assert len(rs) == 2 and (need + anchor) < 0.45 * len(DATA) and spans == [[20.0, 40.0], [100.0, 130.0]]
head = T.strip_index(DATA[:anchor], anchor)
assert b'sidx' not in head and head.startswith(DATA[:32]) and b'moov' in head
ok = T.fetch_parallel('http://127.0.0.1:8795/v', 'sparse.mp4', total=len(DATA), piece=200000, conns=8, ranges=rs, head=head)
got = open('sparse.mp4', 'rb').read()
assert ok and len(got) == len(head) + need, 'the file is only as long as what was fetched'
assert got == head + b''.join(DATA[a:b + 1] for a, b in rs), 'each piece is where it belongs'
assert sum(b - a + 1 for a, b in asked) < 0.5 * len(DATA), 'the rest was never asked for'
import json
json.dump({'windows': windows, 'spans': spans}, open('sparse.mp4.have.json', 'w'))
full, part = T.Video('dash.mp4', hw=False), T.Video('sparse.mp4', hw=False)
print('length: full %.0f s, partial says %.0f s (the stream\'s, not the file\'s)' % (full.length, part.length))
for t in (20.5, 22, 30, 39, 100.5, 102, 115, 129):
    a, b = full.frame_at(t), part.frame_at(t)
    d = None if a is None or b is None else float(np.abs(a.astype(int) - b.astype(int)).mean())
    assert d is not None and d < 3.0, 'frame at %s s differs: %s' % (t, d)
print('a frame asked for by its place in the stream is the same frame as in the whole file')
part.seek(102); n = 0; first = last = None
while True:
    t, fr = part.read_at_step(5)
    if fr is None or t > 128: break
    n += 1; first = first if first is not None else t; last = t
print('read %d looks straight through a stretch, stream time %.1f to %.1f' % (n, first, last)); assert n >= 120 and 101.9 < first < 102.5 and 127 < last <= 128
assert part.frame_at(70) is None and part.read_at_step(5) == (None, None), 'a place it does not hold gives nothing, not a wrong picture'
print('a place between stretches gives nothing')
part.seek(25); t, fr = part.read_at_step(1); assert fr is not None and 24.9 < t < 25.2; print('and it can go back to an earlier stretch')
# a whole job on the partial file
job = {'id': '1', 'name': 'Qualification 5', 'round': 2, 'num': 5, 'vid': 'abcdefghijk', 'off': 100, 'red': ['66449A', '1A'], 'blue': ['2B', '3C']}
os.remove('sparse.mp4.have.json')
os.remove('sparse.mp4')
