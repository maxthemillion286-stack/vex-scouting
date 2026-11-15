import sys, time, cProfile, pstats, numpy as np, cv2
sys.path.insert(0, 'run')
import vex_trainer as T
eyes = T.Eyes(quiet=True)
def fake(frame, conf=T.CONF):
    out = []
    for col, lo, hi in ((1, (0, 0, 180), (80, 80, 255)), (2, (180, 0, 0), (255, 90, 90))):
        mask = cv2.inRange(frame, np.array(lo, np.uint8), np.array(hi, np.uint8))
        n, _, st, _ = cv2.connectedComponentsWithStats(mask)
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if a < 600: continue
            out.append([float(x - 5), float(y - 60), 90.0, 90.0, 0.9, 0, None, 0])
    lb = T.letterbox(frame.shape[1], frame.shape[0])
    sq = np.full((640, 640, 3), 114, np.uint8)
    sq[lb['py']:lb['py'] + lb['nh'], lb['px']:lb['px'] + lb['nw']] = cv2.resize(frame, (lb['nw'], lb['nh']))[:, :, ::-1]
    for b in out:
        s = [b[0] * lb['s'] + lb['px'], b[1] * lb['s'] + lb['py'], b[2] * lb['s'], b[3] * lb['s']]
        b[5] = T.color_of(sq, s); b[6] = T.sig_of(sq, s, b[5]) if b[5] else None
    return out
eyes.detect = fake
job = {'id': '77', 'name': 'Qualification 5', 'round': 2, 'num': 5, 'vid': 'abcdefghijk', 'off': 20, 'red': ['66449A', '1A'], 'blue': ['2B', '3C'], 'rs': 30, 'bs': 12}
video = T.Video('run/test.mp4')
pr = cProfile.Profile(); t0 = time.time(); pr.enable()
rec, why, _ = T.track_match(video, eyes, job, 0, 300, False, {})
pr.disable(); print('total %.1fs, looks %d, clock %d' % (time.time() - t0, len(rec['f']), len(rec['tm']) // 2))
pstats.Stats(pr).sort_stats('cumulative').print_stats(22)
