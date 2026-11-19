"""v2.30 checks: more looks at key moments, never fewer than usual.

Run from desktop/:  python3 dev/burst.py path/to/a_stream_frame.jpg
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2, numpy as np
import vex_trainer as T

ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)

img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720), interpolation=cv2.INTER_AREA)
B = lambda x, y, w=80, h=70: [x, y, w, h, 0.9, 1, None, 0]
check('two robots touching is a key moment', T.key_moment([B(100, 100), B(185, 100)], []))
check('two robots apart is not', not T.key_moment([B(100, 100), B(400, 100)], []))
check('a robot at a goal is', T.key_moment([B(500, 300)], [[520, 320, 560, 380]]))
check('a robot far from every goal is not', not T.key_moment([B(100, 600)], [[520, 320, 560, 380]]))

class FakeVideo:
    fps, length, hw, out, spans = 30, 2000, False, False, None
    def __init__(self): self.pos, self.n = 0, 0
    def seek(self, s): self.pos = s
    def read_at_step(self, step):
        self.pos += step / self.fps
        return self.pos, img
    def frame_at(self, s): return img
class FakeEyes:
    backend, pieces = 'CPU', None
    def __init__(self, v): self.v = v
    def detect(self, frame, thr):
        m = self.v.pos - 100
        # red's two robots touch from 40 s to 50 s of the match
        gap = 5 if 40 <= m < 50 else 400
        return [B(200, 300), B(280 + gap, 300), [900, 300, 80, 70, 0.9, 2, None, 0], [1000, 500, 80, 70, 0.9, 2, None, 0]]
    def plate(self, *a): return 0
    def scan(self, *a): return []
    def clock_at(self, *a): return None
T.say = lambda *a, **k: None
v = FakeVideo()
job = {'name': 'Q1', 'round': 2, 'num': 1, 'red': ['1A', '2B'], 'blue': ['3C', '4D'], 'vid': 'vidburstXXX', 'off': 100}
rec, why, _ = T.track_match(v, FakeEyes(v), job, 0, 300, False, {}, None, 0, None)
check('tracked', rec is not None, why)
ts = [fr[0] / 10 for fr in rec['f']]
rate = lambda a, b: sum(1 for t in ts if a <= t < b) / (b - a)
check('the usual six looks a second away from key moments', 5.5 <= rate(10, 35) <= 6.5, '%.1f' % rate(10, 35))
check('about twice as many while robots touch', rate(41, 49) >= 9.5, '%.1f' % rate(41, 49))
check('never fewer than usual anywhere', all(rate(a, a + 2) >= 5.5 for a in range(2, 140, 2)), str([round(rate(a, a + 2), 1) for a in range(2, 140, 10)]))
check('back to usual after', 5.5 <= rate(53, 80) <= 6.5, '%.1f' % rate(53, 80))

# Over the website's ceiling: the extra looks go first.
T.WINDOW_SAVE = T.WINDOW
v2 = FakeVideo()
class Busy(FakeEyes):
    def detect(self, frame, thr):
        return [B(200, 300), B(285, 300), [900, 300, 80, 70, 0.9, 2, None, 0], [1000, 500, 80, 70, 0.9, 2, None, 0]]
rec2, why2, _ = T.track_match(v2, Busy(v2), dict(job), 0, 300, False, {}, None, 0, None)
check('a whole match of key moments still fits', rec2 is not None and len(rec2['f']) <= 2000, str(len(rec2['f']) if rec2 else why2))
check('app 2.30 or later', T.VERSION >= '2.30')
print('burst checks: %d ok, %d failing' % (ok, fail))
sys.exit(1 if fail else 0)
