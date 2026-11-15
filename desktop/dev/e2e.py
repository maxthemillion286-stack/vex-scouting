import sys, os, json, threading, time, math, urllib.request
import numpy as np, cv2
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import vex_trainer as T
ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1; print('  ok  ', name)
    else: fail += 1; print('  FAIL', name, detail)

# plate alphabet as the app would fetch it
import re
m = re.search(r'const PLATE_CHARS = (\{.*?\});', open('/home/claude/vex-scouting/vendor/vt-worker.js').read(), re.S)
open('run/models/plate_chars.json', 'w').write(m.group(1))

# a mock website
posts = []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        posts.append(body); out = json.dumps({'ok': True}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)
srv = ThreadingHTTPServer(('127.0.0.1', 8799), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
cfg = {'site': 'http://127.0.0.1:8799', 'key': 'correct-horse', 'workers': 2, 'keep_videos': True, 'files': {}}

# a video: 30 fps, 1280x720, 200 s. An overlay with the match name and a clock;
# four "robots" that move. Match 5 starts at 20 s (auto 15 s, driver from 35 s).
W, H_, FPS = 1280, 720, 30
path = 'run/test.mp4'
vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H_))
def robots(t):
    out = []
    for r in range(4):
        x = 200 + r * 240 + 80 * math.sin(t * 0.6 + r); y = 300 + 90 * math.cos(t * 0.4 + r)
        out.append((x, y, 1 if r < 2 else 2))
    return out
for i in range(FPS * 200):
    t = i / FPS
    fr = np.full((H_, W, 3), 70, np.uint8)
    cv2.rectangle(fr, (0, 0), (W, 60), (20, 20, 20), -1)
    cv2.putText(fr, 'Qualification 5', (40, 42), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2, cv2.LINE_AA)
    if 20 <= t < 35: c = 15 - (t - 20)
    elif 35 <= t < 140: c = 105 - (t - 35)
    else: c = 0
    cv2.putText(fr, '%d:%02d' % (int(c) // 60, int(c) % 60), (600, 42), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2, cv2.LINE_AA)
    for x, y, col in robots(t):
        cv2.rectangle(fr, (int(x), int(y)), (int(x) + 90, int(y) + 90), (90, 90, 90), -1)
        cv2.rectangle(fr, (int(x) + 5, int(y) + 60), (int(x) + 85, int(y) + 82), (30, 30, 220) if col == 1 else (220, 40, 30), -1)
    vw.write(fr)
vw.release()

eyes = T.Eyes()
check('the three models load and the finder runs', eyes.backend in ('CPU', 'Dml', 'CUDA'))
fr = T.Video(path).frame_at(60)
texts = eyes.scan(fr)
print('   read:', [(t['text'], round(t['conf'], 2)) for t in texts])
check('the match name is read off the picture', (T.label_of(texts) or {}).get('num') == 5)
clock = next((T.timer_text(t['text']) for t in texts if T.timer_text(t['text']) is not None), None)
check('the clock is read off the picture', clock is not None and abs(clock - 80) <= 1, str(clock))
real = eyes.detect(fr, 0.25)
check('the real finder answers (it need not see drawn squares as robots)', isinstance(real, list))

# The drawn squares are not robots to the real finder, so for the rest it is
# told where they are; everything after detection is the real code.
video = T.Video(path)
orig = eyes.detect
def fake(frame, conf=T.CONF):
    # find the plates by colour to get the robots back
    out = []
    hsv = frame
    for col, lo, hi in ((1, (0, 0, 180), (80, 80, 255)), (2, (180, 0, 0), (255, 90, 90))):
        mask = cv2.inRange(frame, np.array(lo, np.uint8), np.array(hi, np.uint8))
        n, _, st, _ = cv2.connectedComponentsWithStats(mask)
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if a < 600: continue
            b = [float(x - 5), float(y - 60), 90.0, 90.0, 0.9, 0, None, 0]
            lb = T.letterbox(frame.shape[1], frame.shape[0])
            out.append(b)
    # colour and look exactly as the real detect does
    lb = T.letterbox(frame.shape[1], frame.shape[0])
    sq = np.full((640, 640, 3), 114, np.uint8)
    sq[lb['py']:lb['py'] + lb['nh'], lb['px']:lb['px'] + lb['nw']] = cv2.resize(frame, (lb['nw'], lb['nh']))[:, :, ::-1]
    for b in out:
        s = [b[0] * lb['s'] + lb['px'], b[1] * lb['s'] + lb['py'], b[2] * lb['s'], b[3] * lb['s']]
        b[5] = T.color_of(sq, s); b[6] = T.sig_of(sq, s, b[5]) if b[5] else None
    return out
eyes.detect = fake
job = {'id': '77', 'name': 'Qualification 5', 'round': 2, 'num': 5, 'vid': 'abcdefghijk', 'off': 20, 'red': ['66449A', '1A'], 'blue': ['2B', '3C'], 'rs': 30, 'bs': 12}
learn = {}
t0 = time.time()
rec, why, shift = T.track_match(video, eyes, job, 0, 300, True, learn)
dt = time.time() - t0
check('a match is tracked', rec is not None, why)
if rec:
    print('   %d looks in %.1fs (%.0fx real time), clock read %d times, learn=%s' % (len(rec['f']), dt, 150 / dt, len(rec['tm']) // 2, learn))
    check('about six looks a second of video', 700 <= len(rec['f']) <= 1000, str(len(rec['f'])))
    check('four robots in a typical look, two of each colour', rec['f'][300][1] == 4 and sorted(rec['f'][300][2 + 10 * i + 5] for i in range(4)) == [1, 1, 2, 2], str(rec['f'][300][:12]))
    check('the clock was found, then read from its place', learn.get('clock') and len(rec['tm']) // 2 >= 80, str(len(rec['tm']) // 2))
    drv = sorted(rec['tm'][k] / 10 - (105 - rec['tm'][k + 1]) for k in range(0, len(rec['tm']), 2) if 15 < rec['tm'][k + 1] < 105)
    check('the clock puts driver control 15 s after the match position', drv and abs(drv[len(drv) // 2] - 15) <= 1.5, str(drv[len(drv) // 2] if drv else None))
    check('times are from the match position', -40 <= rec['f'][0][0] <= 0 and rec['f'][-1][0] > 1400)
    json.dump(rec, open('rec.json', 'w'))
kept = os.listdir(T.FRAMES) if os.path.isdir(T.FRAMES) else []
check('frames were kept for review with the finder\'s suggestions', 1 <= len(kept) <= 10 and len(os.listdir(T.PROPS)) == len(kept), str(len(kept)))

# the wrong place: the Jumper says 150 s into a second video where match 5 is at 20 s
job2 = dict(job, off=20); 
# make "another match" video cheaply: reuse, but ask for match 6 where 5 is showing
job6 = dict(job, id='78', num=6, name='Qualification 6', off=20)
rec6, why6, _ = T.track_match(video, eyes, job6, 0, 300, False, {})
check('a match whose name never appears is not saved as another one', rec6 is None, why6)
print('   why:', why6)

# the worker: tracks and posts
T._EYES = eyes
res = T.work_chunk((cfg, '900', path, [job], 300))
check('the worker saves the recording to the website', res[0]['ok'] and posts and posts[-1]['ev'] == '900' and posts[-1]['id'] == '77' and posts[-1]['passcode'] == 'correct-horse', str(res))
json.dump(posts[-1]['rec'], open('rec_posted.json', 'w'))

# review server
srvr = T.do_review(cfg, port=8766, open_browser=False)
nxt = json.load(urllib.request.urlopen('http://127.0.0.1:8766/api/next'))
check('the review page offers a frame', nxt['id'] and nxt['w'] == 1280 and isinstance(nxt['boxes'], list))
html = urllib.request.urlopen('http://127.0.0.1:8766/').read().decode()
check('the review page is served', 'Review frames' in html)
img = urllib.request.urlopen('http://127.0.0.1:8766/img/%s.jpg' % nxt['id']).read()
check('with its picture', img[:2] == b'\xff\xd8')
left0 = nxt['left']
for _ in range(left0):
    n = json.load(urllib.request.urlopen('http://127.0.0.1:8766/api/next'))
    req = urllib.request.Request('http://127.0.0.1:8766/api/save', data=json.dumps({'id': n['id'], 'skip': False, 'boxes': [b[:4] for b in n['boxes']]}).encode(), method='POST')
    urllib.request.urlopen(req).read()
end = json.load(urllib.request.urlopen('http://127.0.0.1:8766/api/next'))
check('saving works through the queue to the end', end['id'] is None and len(os.listdir(T.LABELS)) == left0)
try:
    urllib.request.urlopen('http://127.0.0.1:8766/img/..%2Fconfig.json'); bad = False
except Exception: bad = True
check('the review server serves pictures only', bad)
srvr.shutdown()

# dataset + scoring
root, counts = T.build_dataset()
check('a training set is built from the reviewed frames', counts['train'] + counts['val'] == left0 and os.path.exists(os.path.join(root, 'data.yaml')), str(counts))
lab = [f for f in os.listdir(os.path.join(root, 'labels', 'train'))]
line = open(os.path.join(root, 'labels', 'train', lab[0])).read().split('\n')[0].split() if lab else []
check('labels are in the trainer\'s format', len(line) == 5 and line[0] == '0' and all(0 <= float(v) <= 1 for v in line[1:]), str(line))
eyes.detect = orig
p, r, f1 = T.score_finder(os.path.join(T.DIRS['models'], 'robot_detector.onnx'), T.reviewed())
check('a finder can be scored against reviewed frames', 0 <= f1 <= 1)
check('spacing comes from the schedule', T.spacing_of([{'round': 2, 'num': 1, 'off': 100}, {'round': 2, 'num': 2, 'off': 420}, {'round': 2, 'num': 4, 'off': 1040}]) in (310, 320))
check('links become video ids', T.video_id('https://www.youtube.com/watch?v=abcdefghijk&t=3') == 'abcdefghijk' and T.video_id('https://youtu.be/abcdefghijk') == 'abcdefghijk' and T.video_id('https://www.youtube.com/live/abcdefghijk?si=x') == 'abcdefghijk' and T.video_id('nonsense') is None)

# publishing: parts go up in order with the key
posts.clear()
open(os.path.join(T.DIRS['models'], 'trained_utest.onnx'), 'wb').write(os.urandom(1500000))
json.dump({'tag': 'utest', 'file': os.path.join(T.DIRS['models'], 'trained_utest.onnx'), 'old': [0.8, 0.8, 0.8], 'new': [0.9, 0.9, 0.9], 'frames': 300}, open(os.path.join(T.DIRS['models'], 'trained_latest.json'), 'w'))
import builtins
builtins.input = lambda *a: '1'
T.do_publish(cfg)
check('a finder is published in parts', [p['model']['i'] for p in posts] == [0, 1, 2] and all(p['model']['n'] == 3 and len(p['model']['b64']) < 900 * 1024 for p in posts))
json.dump([p['model'] for p in posts], open('model_posts.json', 'w'))
os.remove(os.path.join(T.DIRS['models'], 'trained_current.onnx'))
print('\n%d passed, %d failed' % (ok, fail))
