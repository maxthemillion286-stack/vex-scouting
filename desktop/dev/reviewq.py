"""v2.45 checks: review asks only about frames that need a person.

Run from desktop/:  python3 dev/queue.py
Reported: "why does it have me review so many frames still?"
"""
import json, os, sys, tempfile
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
def frame(name, p):
    open(os.path.join(T.FRAMES, name + '.jpg'), 'wb').write(b'x')
    json.dump(dict({'w': 1280, 'h': 720}, **p), open(os.path.join(T.PROPS, name + '.json'), 'w'))
sure4 = [[100 + 200 * i, 300, 80, 70, 0.85] for i in range(4)]
frame('vidqueueAAA_sure', {'hard': 0, 'steady': 1, 'boxes': sure4})
frame('vidqueueAAA_old', {'hard': 0, 'boxes': sure4})                                   # from before frames were marked steady
frame('vidqueueBBB_doubt', {'hard': 3, 'boxes': sure4 + [[900, 100, 60, 60, 0.4]]})
frame('vidqueueCCC_shaky', {'hard': 0, 'steady': 0, 'boxes': sure4})
frame('vidqueueDDD_weak', {'hard': 0, 'steady': 1, 'boxes': [[100, 300, 80, 70, 0.5]] + sure4[:3]})
frame('vidqueueEEE_none', {'hard': 0, 'steady': 1, 'boxes': []})
frame('vidqueueFFF_vlm', {'hard': 0, 'steady': 1, 'boxes': sure4, 'vlm': {'boxes': [b[:4] for b in sure4], 'what': ['robot', 'person', 'robot', 'robot'], 'missed': []}})
q, _ = T.review_queue()
check('frames the finder was plainly sure of are not asked about', 'vidqueueAAA_sure' not in q and 'vidqueueAAA_old' not in q and T._SURE[0] == 2, str((q, T._SURE[0])))
check('frames with any doubt still are', all(n in q for n in ('vidqueueBBB_doubt', 'vidqueueCCC_shaky', 'vidqueueDDD_weak', 'vidqueueEEE_none')), str(q))
check('and so are those the vision model disagreed with', 'vidqueueFFF_vlm' in q)
check('the robot finder trains from 100 reviewed frames', T.TRAIN_MIN == 100)
ui = T.UI_HTML
check('the window says how many it did not ask about', "st.sure+' it was sure about are not asked'" in ui and 'Only frames the finder is unsure about' in ui)
src = open(T.__file__).read()
check('after tracking, the vision model reviews new frames by itself (when on)', "do_vreview(cfg, limit=200)" in src and "cfg.get('vreview_after', True)" in src)
check('app 2.45 or later', T.VERSION >= '2.45')
print('queue checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
