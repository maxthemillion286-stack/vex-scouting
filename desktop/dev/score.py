"""v2.31 checks: finding and reading the stream's own score.

Run from desktop/:  python3 dev/score.py path/to/a_stream_frame.jpg
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
RB, BB, OTHER = [0.40, 0.90, 0.05, 0.05], [0.55, 0.90, 0.05, 0.05], [0.10, 0.05, 0.04, 0.04]
check('a score is one to three digits', T.score_text('45') == 45 and T.score_text(' 7 ') == 7 and T.score_text('1234') is None and T.score_text('0:45') is None)

class FakeVideo:
    fps, length, hw, out, spans = 30, 4000, False, False, None
    def __init__(self): self.pos = 0
    def seek(self, s): self.pos = s
    def read_at_step(self, step): self.pos += step / self.fps; return self.pos, img
    def frame_at(self, s): return img
class FakeEyes:
    backend, pieces = 'CPU', None
    def __init__(self, v, off, final, live=True): self.v, self.off, self.final, self.live = v, off, final, live
    def score(self):
        m = min(120, max(0, self.v.pos - self.off))
        return [round(self.final[0] * m / 120), round(self.final[1] * m / 120)]
    def detect(self, frame, thr):
        return [[200, 300, 80, 70, 0.9, 1, None, 0], [400, 300, 80, 70, 0.9, 1, None, 0], [900, 300, 80, 70, 0.9, 2, None, 0], [1000, 500, 80, 70, 0.9, 2, None, 0]]
    def plate(self, *a): return 0
    def scan(self, frame):
        r, b = self.score()
        out = [{'text': '12', 'conf': 0.9, 'box': OTHER}]           # a number that is not a score
        if self.live: out += [{'text': str(r), 'conf': 0.9, 'box': RB}, {'text': str(b), 'conf': 0.9, 'box': BB}]
        return out
    def number_at(self, frame, box):
        r, b = self.score()
        if not self.live: return None
        return r if box[0] < 0.5 else b
    def clock_at(self, *a): return None
T.say = lambda *a, **k: None
learn = {}
def run(off, final, live=True, official=None):
    v = FakeVideo()
    job = {'name': 'Q', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidscoreXXX', 'off': off,
           'rs': (official or final)[0], 'bs': (official or final)[1]}
    rec, why, _ = T.track_match(v, FakeEyes(v, off, final, live), job, 0, 300, False, learn, None, 0, None)
    return rec
r1 = run(100, (60, 44))
check('its place is found from the official final', learn.get('score') and abs(learn['score']['r'][0] - 0.40) < 1e-6 and abs(learn['score']['b'][0] - 0.55) < 1e-6, str(learn.get('score')))
check('and the first match keeps what it read', r1 and len(r1.get('sc', [])) >= 60 and r1['sc'][-2:] == [60, 44], str((r1 or {}).get('sc', [])[-6:]))
r2 = run(400, (80, 30))
check('the next match reads it every second', r2 and len(r2['sc']) // 3 >= 120 and r2['sc'][-2:] == [80, 30], str(len((r2 or {}).get('sc', []))))
r3 = run(700, (80, 30), official=(85, 30))
check('a stream score that misses the official final makes the place be found again', learn.get('score') is None)
learn.clear()
r4 = run(1000, (0, 0), live=False, official=(50, 40))
check('no live score shown: nothing recorded, nothing learned', r4 and 'sc' not in r4 and not learn.get('score'))
learn.clear()
r5 = run(1300, (40, 40))
check('a tie cannot tell the two apart: not learned', not learn.get('score') and 'sc' not in r5)
check('app 2.31 or later', T.VERSION >= '2.31')
print('score checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
