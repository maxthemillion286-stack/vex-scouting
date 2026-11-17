"""The faster versions give exactly what the slower ones gave."""
import sys, time, cv2, numpy as np
sys.path.insert(0, 'run'); sys.path.insert(0, 'oldmod')
import vex_trainer as N, old_trainer as O
img = cv2.resize(cv2.imread(sys.argv[1]), (1920, 1080), interpolation=cv2.INTER_AREA)
rng = np.random.default_rng(1)
eyes = N.Eyes(quiet=True); four = ['2499B', '66449A', '6722A', '8838C']
boxes = [b for b in eyes.detect(img, N.PROPOSE) if b[4] >= N.CONF]
bad = n = 0
def same(name, a, b):
    global bad, n
    n += 1
    if a != b: bad += 1; print('  DIFFERS', name)
# real frame, shifted and recoloured copies, and noise with coloured blocks
frames = [img, img[:, ::-1].copy(), cv2.convertScaleAbs(img, alpha=1.2, beta=-10), img[100:900, 200:1700].copy()]
for k in range(4):
    f = rng.integers(0, 255, (540, 960, 3), dtype=np.uint8)
    for _ in range(40):
        x, y, w, h = rng.integers(0, 880), rng.integers(0, 480), rng.integers(8, 80), rng.integers(8, 50)
        f[y:y + h, x:x + w] = [(30, 30, 220), (220, 60, 30), (20, 200, 230)][rng.integers(0, 3)]
    frames.append(f)
for i, f in enumerate(frames):
    same('pin_blobs %d' % i, N.pin_blobs(f, boxes), O.pin_blobs(f, boxes))
    for b in boxes + [[float(rng.integers(0, f.shape[1] - 300)), float(rng.integers(0, f.shape[0] - 300)), 280.0, 260.0] for _ in range(6)]:
        x, y, w, h = [int(round(v)) for v in b[:4]]
        crop = np.ascontiguousarray(f[y:y + h, x:x + w][:, :, ::-1])
        if crop.shape[0] < 8 or crop.shape[1] < 8: continue
        for col in (1, 2):
            same('plate_tilts', N.plate_tilts(crop, col), O.plate_tilts(crop, col))
            small = np.ascontiguousarray(cv2.resize(crop, (240, max(8, round(crop.shape[0] * 240 / crop.shape[1])))))
            same('plate_box', N.plate_box(small, col), O.plate_box(small, col))
old_eyes = O.Eyes(quiet=True)
for b in boxes: same('plate()', eyes.plate(img, list(b), four), old_eyes.plate(img, list(b), four))
# batched reading gives what one-at-a-time gives
c = np.ascontiguousarray(img[250:560, 250:560][:, :, ::-1]); ts = N.plate_tilts(c, 1)
strips = [N.plate_strip(c, t, fl, pad) for t in ts for fl in (0, 1) for pad in N.PLATE_PADS] or [N.plate_strip(c, [100, 100, 0.5, 60, 30], 0, 1.3)]
one = [eyes.read(*s) for s in strips]; many = eyes.read_many(strips)
same('read_many', [(t, round(cf, 5)) for t, cf in one], [(t, round(cf, 5)) for t, cf in many])
print('%d comparisons, %d differ' % (n, bad))
def tm(fn, k=10):
    fn(); t = time.perf_counter()
    for _ in range(k): fn()
    return (time.perf_counter() - t) / k * 1000
crop = np.ascontiguousarray(cv2.resize(img[347:584, 256:482], (400, 420))[:, :, ::-1])
print('pin_blobs   %5.1f → %5.1f ms' % (tm(lambda: O.pin_blobs(img, boxes)), tm(lambda: N.pin_blobs(img, boxes))))
print('plate_tilts %5.1f → %5.1f ms' % (tm(lambda: O.plate_tilts(crop, 1)), tm(lambda: N.plate_tilts(crop, 1))))
for i, b in enumerate(boxes): print('plate() %d   %5.1f → %5.1f ms (CPU: reads are not batched here)' % (i, tm(lambda: old_eyes.plate(img, list(b), four), 4), tm(lambda: eyes.plate(img, list(b), four), 4)))
sys.exit(1 if bad else 0)
