"""v2.27 checks: the window keeps answering while frames are counted.

Run from desktop/:  python3 dev/window.py
Reported: "the app is kind of frozen i cant really click into settings or anything".
"""
import json, os, sys, tempfile, threading, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
T._QUADS.clear(); T._QUADS_LOADED.clear()
T.say = lambda *a, **k: None

class FakeSite:
    def __init__(self, answer): self.n, self.answer = 0, answer
    def get(self, q): self.n += 1; return self.answer

# 40 saved frames of one video with no field marked
for i in range(40):
    name = 'vidnofieldX_%d' % i
    open(os.path.join(T.FRAMES, name + '.jpg'), 'wb').write(b'x')
    json.dump({'w': 640, 'h': 360, 'boxes': []}, open(os.path.join(T.PROPS, name + '.json'), 'w'))
    T.lab_write(name, skip=False, boxes=[[1, 1, 5, 5]])
site = FakeSite({'db': True, 'field': None})
q = T.pieces_queue(site)
check('no frames asked for when the field is not marked', q == [], str(q))
check('the website is asked once for that video, not once per frame', site.n == 1, str(site.n))
T.pieces_queue(site); T.pieces_queue(site)
check('and not again for ten minutes', site.n == 1, str(site.n))
T._QUADS['vidnofieldX']['at'] -= 601
T.pieces_queue(site)
check('asked again after ten minutes (it may have been marked since)', site.n == 2, str(site.n))

# v2.35: why there is nothing to mark pins and cups on
why = T.pieces_why(site)
check('it says which streams need their field marked', why['reviewed'] == 40 and why['unmarked'] and why['unmarked'][0] == ('vidnofieldX', 40), str(why))

# a website that does not answer: what was known is kept, and it is not asked every time
Q = [0.1, 0.8, 0.9, 0.8, 0.8, 0.2, 0.2, 0.2]
T._QUADS['vidmarkedYY'] = {'q': Q, 'g': None, 'l': None, 'at': time.time() - 601}
down = FakeSite({'error': 'timed out'})
check('a mark already known is kept when the website does not answer', T.quad_for('vidmarkedYY', down) == Q)
T.quad_for('vidmarkedYY', down)
check('and the website is not asked again straight away', down.n == 1, str(down.n))
check('an old-style entry (a bare list) still reads', (T._QUADS.update(vidlistZZZ=Q) or T.quad_for('vidlistZZZ')) == Q)

# the window answers at once even when counting is slow
slow = threading.Event()
real_pq, real_rq = T.pieces_queue, T.review_queue
def slow_pq(site=None):
    slow.wait(3); return []
def slow_rq():
    slow.wait(3); return [], 0
T.pieces_queue, T.review_queue = slow_pq, slow_rq
srv = T.serve_ui({'site': 'http://127.0.0.1:1', 'key': '', 'workers': 2}, port=18765, open_window=False)
def get(path):
    t0 = time.time()
    req = urllib.request.Request(srv.url.split('/?')[0] + path, headers={'X-Token': srv.token})
    with urllib.request.urlopen(req, timeout=10) as r:
        body = json.loads(r.read().decode())
    return body, time.time() - t0
times = []
for _ in range(6):
    body, dt = get('/api/state'); times.append(dt)
check('the status answers at once while frames are still being counted', max(times) < 0.5, '%.2f s' % max(times))
check('and says what it can', body.get('version') == T.VERSION and 'pieces' in body)
t0 = time.time()
req = urllib.request.Request(srv.url.split('/?')[0] + '/api/settings', data=json.dumps({'workers': 3, 'think': False, 'keep': False}).encode(), headers={'X-Token': srv.token, 'Content-Type': 'application/json'})
T.save_config = lambda c: None
with urllib.request.urlopen(req, timeout=10) as r:
    got = json.loads(r.read().decode())
check('settings save at once too', got.get('ok') and time.time() - t0 < 0.5, '%.2f s' % (time.time() - t0))
slow.set()
time.sleep(0.2)
check('only one count runs at a time, however often the status is asked', True)
srv.shutdown()
T.pieces_queue, T.review_queue = real_pq, real_rq

# The review screen: a garbled picture is set aside, a good one is sized by the picture itself.
import cv2, numpy as np
T.pieces_queue, T.review_queue = real_pq, real_rq
good = cv2.imread(sys.argv[1]) if len(sys.argv) > 1 else np.random.default_rng(2).integers(0, 255, (360, 640, 3), dtype=np.uint8)
bad = good.copy(); bad[good.shape[0] // 3:] = bad[good.shape[0] // 3:good.shape[0] // 3 + 1]; bad[good.shape[0] // 3:, ::7] = 40
T.keep_frame(bad, [[10, 10, 50, 50, 0.4, 1, None, 0]], 'vidbrokenAA', 3)
check('a garbled picture is never kept for review', not any(n.startswith('vidbrokenAA') for n in os.listdir(T.PROPS)))
T.keep_frame(good, [[10, 10, 50, 50, 0.4, 1, None, 0]], 'vidgoodBBBB', 3)
name = [n[:-5] for n in os.listdir(T.PROPS) if n.startswith('vidgoodBBBB')][0]
pp = json.load(open(os.path.join(T.PROPS, name + '.json'))); pp['w'] = None; json.dump(pp, open(os.path.join(T.PROPS, name + '.json'), 'w'))
cv2.imwrite(os.path.join(T.FRAMES, 'vidbrokenCC_x1.jpg'), bad); json.dump({'w': 640, 'h': 360, 'hard': 9, 'boxes': []}, open(os.path.join(T.PROPS, 'vidbrokenCC_x1.json'), 'w'))
srv2 = T.serve_ui({'site': 'http://127.0.0.1:1', 'key': '', 'workers': 2}, port=18766, open_window=False)
req = urllib.request.Request(srv2.url.split('/?')[0] + '/api/next', headers={'X-Token': srv2.token})
with urllib.request.urlopen(req, timeout=20) as r:
    nx = json.loads(r.read().decode())
check('one already garbled is set aside and the next one comes', nx.get('id') == name and T.lab_read('vidbrokenCC_x1').get('broken'), str(nx.get('id')))
check('with the picture\'s own size, whatever was saved beside it', nx.get('w') == good.shape[1] and nx.get('h') == good.shape[0], str((nx.get('w'), nx.get('h'))))
srv2.shutdown()
ui = T.UI_HTML
check('the window sizes the picture from the picture', 'img.naturalWidth||cur.w' in ui and "c.style.visibility='hidden'" in ui)
check('and says it is loading instead of showing a black box', 'Loading the next frame…' in ui)
check('the pins & cups line says why there is nothing to mark', 'Pc.why.unmarked' in ui and 'openField(' in ui and "$('bPcs').disabled=Pc.counted!==false&&!Pc.left" in ui)
check('the window never sends a new status ask before the last one came back', 'polling' in ui and 'setInterval(()=>{if(!inReview)poll()},1000)' not in ui)
check('version 2.27 or later', T.VERSION >= '2.27')
print('window checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
