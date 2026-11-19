import json, os, sys, tempfile, time, shutil
sys.path.insert(0, '/home/claude/vex-scouting/desktop')
import vex_trainer as T
tmp = tempfile.mkdtemp()
T.DIRS = {k: os.path.join(tmp, k) for k in ('models', 'videos', 'data', 'build')}
for d in T.DIRS.values(): os.makedirs(d, exist_ok=True)
T.FRAMES, T.PROPS, T.LABELS = (os.path.join(tmp, 'data', k) for k in ('frames', 'prop', 'labels'))
for d in (T.FRAMES, T.PROPS, T.LABELS): os.makedirs(d, exist_ok=True)
T.say = lambda *a, **k: None
src = sys.argv[1]
for i in range(3):
    n = 'Ab3dEfGh1Jk_%d' % i
    shutil.copy(src, os.path.join(T.FRAMES, n + '.jpg'))
    json.dump({'w': 1920, 'h': 1080, 'boxes': [[1, 1, 5, 5, 0.9]] * i, 't': 1234.5 + i}, open(os.path.join(T.PROPS, n + '.json'), 'w'))
    T.lab_write(n, skip=False, boxes=[[1, 1, 5, 5]] * (i + 1))
posted = []
class FakeSite:
    def __init__(self, cfg=None): pass
    def get(self, q): return {'db': True, 'field': None} if not posted else {'db': True, 'field': posted[-1]['field']}
    def post(self, body): posted.append(body); return {'ok': True}
T.Site = FakeSite
srv = T.serve_ui({'site': 'https://example.invalid', 'key': 'x', 'workers': 2}, port=18771, open_window=False)
print(srv.url, flush=True)
for _ in range(80):
    time.sleep(0.5)
    if posted:
        time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 3); break
print('POSTED', json.dumps(posted), flush=True)
print('QUAD', json.dumps(T._QUADS.get('Ab3dEfGh1Jk')), flush=True)
srv.shutdown()
