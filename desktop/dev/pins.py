import sys, json, math, time, numpy as np, cv2
sys.path.insert(0, 'run')
import vex_trainer as T
W, H, FPS = 1280, 720, 30
FX0, FX1, FY0, FY1 = 290, 990, 80, 640            # the field in the picture (seen square-on, for the test)
def img(u, v): return FX0 + u * (FX1 - FX0), FY0 + v * (FY1 - FY0)
PW, PH = 5.8, 28.0                                 # one pin (two halves) at this scale, see the test's notes
def pin(fr, u, v, top, bottom):
    x, y = img(u, v)
    col = {'y': (40, 205, 235), 'r': (35, 35, 225), 'b': (225, 60, 35)}
    cv2.rectangle(fr, (int(round(x - PW / 2)), int(round(y - PH))), (int(round(x + PW / 2)), int(round(y - PH / 2)) - 1), col[top], -1)
    cv2.rectangle(fr, (int(round(x - PW / 2)), int(round(y - PH / 2))), (int(round(x + PW / 2)), int(round(y))), col[bottom], -1)
def robot(fr, u, v, c):
    x, y = img(u, v); x0, y0 = int(x - 45), int(y - 90)
    cv2.rectangle(fr, (x0, y0), (x0 + 90, y0 + 90), (95, 95, 95), -1)
    cv2.rectangle(fr, (x0 + 5, y0 + 60), (x0 + 85, y0 + 82), (30, 30, 220) if c == 1 else (220, 40, 30), -1)
START, DRV = 20, 35                                # match position 20 s; driver 15 s later
def scene(t):
    m = t - START
    fr = np.full((H, W, 3), 60, np.uint8)
    cv2.rectangle(fr, (FX0, FY0), (FX1, FY1), (120, 120, 120), -1)
    # the toggles: a bar on top of the middle of each wall. Left (red's wall) and top show red, right and bottom blue.
    for (x0, y0, x1, y1), col in (((284, 250, 296, 388), (35, 35, 225)), ((984, 250, 996, 388), (225, 60, 35)), ((577, 18, 703, 58), (35, 35, 225)), ((577, 578, 703, 618), (225, 60, 35))):
        cv2.rectangle(fr, (x0, y0), (x1, y1), col, -1)
    for u, v in ((0.45, 0.45), (0.55, 0.45), (0.45, 0.55), (0.55, 0.55)): pin(fr, u, v, 'y', 'y')     # never touched
    # red 0 works the left quadrant: a yellow pin set down every 12 s of driver control (6 pins)
    k = int(max(0, min(6, (m - 15 - 6) // 12 + 1))) if m >= 21 else 0
    for i in range(k): pin(fr, 0.26 + 0.035 * (i % 3), 0.62 + 0.07 * (i // 3), 'y', 'y')
    # red 1 works the top quadrant: two red-over-yellow pins
    k2 = 0 if m < 40 else 1 if m < 70 else 2
    for i in range(k2): pin(fr, 0.46 + 0.06 * i, 0.26, 'r', 'y')
    d = max(0, min(1, m / 6)) if m > 0 else 0
    r0 = (0.08 + (0.20 - 0.08) * d + 0.02 * math.sin(t), 0.40 + 0.04 * math.cos(t * 0.7))
    r1 = (0.08 + (0.50 - 0.08) * d + 0.03 * math.sin(t * 0.8), 0.70 + (0.15 - 0.70) * d + 0.02 * math.cos(t))
    b0 = (0.92 - 0.10 * d + 0.03 * math.sin(t * 0.9), 0.35 + 0.05 * math.cos(t * 0.6))
    b1 = (0.92 - 0.14 * d + 0.03 * math.cos(t * 0.7), 0.68 + 0.05 * math.sin(t * 0.5))
    # red 0 carries a yellow pin in its box: must not count
    for (u, v), c in ((r0, 1), (r1, 1), (b0, 2), (b1, 2)): robot(fr, u, v, c)
    x, y = img(*r0); cv2.rectangle(fr, (int(x - 3), int(y - 50)), (int(x + 3), int(y - 25)), (40, 205, 235), -1)
    return fr
vw = cv2.VideoWriter('run/pins.mp4', cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
for i in range(FPS * 175): vw.write(scene(i / FPS))
vw.release()
import re
open('run/models/plate_chars.json', 'w').write(re.search(r'const PLATE_CHARS = (\{.*?\});', open('/home/claude/vex-scouting/vendor/vt-worker.js').read(), re.S).group(1))
eyes = T.Eyes(quiet=True)
def fake(frame, conf=T.CONF):
    out = []
    for lo, hi in (((0, 0, 180), (80, 80, 255)), ((180, 0, 0), (255, 90, 90))):
        n, _, st, _ = cv2.connectedComponentsWithStats(cv2.inRange(frame, np.array(lo, np.uint8), np.array(hi, np.uint8)))
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if 1400 <= a <= 2200 and w > 2.5 * h: out.append([float(x - 5), float(y - 60), 90.0, 90.0, 0.9, 0, None, 0])   # a robot's plate, not a toggle bar
    lb = T.letterbox(frame.shape[1], frame.shape[0]); sq = np.full((640, 640, 3), 114, np.uint8)
    sq[lb['py']:lb['py'] + lb['nh'], lb['px']:lb['px'] + lb['nw']] = cv2.resize(frame, (lb['nw'], lb['nh']))[:, :, ::-1]
    for b in out:
        s = [b[0] * lb['s'] + lb['px'], b[1] * lb['s'] + lb['py'], b[2] * lb['s'], b[3] * lb['s']]
        b[5] = T.color_of(sq, s); b[6] = T.sig_of(sq, s, b[5]) if b[5] else None
    return out
eyes.detect = fake
job = {'id': '77', 'name': 'Qualification 5', 'round': 2, 'num': 5, 'vid': 'abcdefghijk', 'off': START, 'red': ['66449A', '1A'], 'blue': ['2B', '3C'], 'rs': 150, 'bs': 20}
t0 = time.time()
QUAD = [FX0 / W, FY0 / H, FX1 / W, FY0 / H, FX1 / W, FY1 / H, FX0 / W, FY1 / H]
rec, why, _ = T.track_match(T.Video('run/pins.mp4', hw=False), eyes, job, 0, 300, False, {}, QUAD)
print('toggle looks', len(rec['tg']) // 9, 'last', rec['tg'][-8:])
assert rec, why
n = 0; i = 0
while i + 1 < len(rec['pn']): n += 1; i += 2 + 6 * rec['pn'][i + 1]
print('tracked in %.1fs; %d pin looks, %d ints, picture %dx%d' % (time.time() - t0, n, len(rec['pn']), rec['pw'], rec['ph']))
json.dump({'rec': rec, 'quad': [FX0 / W, FY0 / H, FX1 / W, FY0 / H, FX1 / W, FY1 / H, FX0 / W, FY1 / H]}, open('rec_pins.json', 'w'))
# the same picture through the website's own pin finder must agree: save one frame's pixels
fr = scene(START + 100); Wp, Hp, blobs = T.pin_blobs(fr, fake(fr))
small = cv2.resize(fr, (Wp, Hp), interpolation=cv2.INTER_AREA)
rgba = np.concatenate([small[:, :, ::-1], np.full((Hp, Wp, 1), 255, np.uint8)], 2); rgba.tofile('pinframe.rgba')
k = Wp / W
json.dump({'W': Wp, 'H': Hp, 'blobs': blobs, 'boxes': [[b[0] * k, b[1] * k, b[2] * k, b[3] * k] for b in fake(fr)]}, open('pinframe.json', 'w'))
print('blobs at t+100:', len(blobs), sorted(set(b[5] for b in blobs)))
