import sys, json, subprocess, numpy as np, random
sys.path.insert(0, '/home/claude/vex-scouting/desktop')
import vex_trainer as T
rng = np.random.default_rng(3)
cases = []
for k in range(60):
    W, H = 640, 640
    img = rng.integers(0, 255, (H, W, 3), dtype=np.uint8)
    # paint strong red / blue patches and greys so every branch is hit
    for _ in range(12):
        x, y, w, h = [int(v) for v in (rng.integers(0, 560), rng.integers(0, 560), rng.integers(10, 80), rng.integers(6, 60))]
        col = [(220, 30, 30), (30, 40, 230), (200, 200, 200), (40, 40, 40), (30, 200, 60), (230, 200, 20)][int(rng.integers(0, 6))]
        img[y:y + h, x:x + w] = col
    box = [float(rng.uniform(0, 500)), float(rng.uniform(0, 500)), float(rng.uniform(20, 140)), float(rng.uniform(20, 140))]
    c = T.color_of(img, box)
    cases.append({'box': box, 'c': c, 'g1': T.sig_of(img, box, 1), 'g2': T.sig_of(img, box, 2), 'img': img.tolist() if k < 0 else None, 'seed': k})
    np.save('img%d.npy' % k, img)
    # plate crop
    crop = img[100:180, 100:340]
    cases[-1]['p1'] = T.plate_box(crop, 1); cases[-1]['p2'] = T.plate_box(crop, 2)
    rgba = np.concatenate([img, np.full((H, W, 1), 255, np.uint8)], 2); rgba.tofile('img%d.rgba' % k)
    np.concatenate([crop, np.full((80, 240, 1), 255, np.uint8)], 2).tofile('crop%d.rgba' % k)
boxes = [[10.4, 20.6, 55.5, 44.5, 0.876, 1, [1,2,3,4,5,6,7,8,9,10,11,12], 3], [300, 100, 30, 80, 0.5, 0, None, 0]]
json.dump({'cases': cases, 'pack': T.pack_frame(12.34, boxes, 1280), 'boxes': boxes,
  'who': [T.who_from_text(t, ['66449A', '6722A', '6722B', '1234X']) for t in ['66449A', '6G449A', '6722', '6722B', 'X1234X', 'ABC', '12']],
  'edit': T.edit('66449A', 'GG44QA'),
  'lab': [T.match_label(t) for t in ['Qualification 12', 'Q103', 'SF 1-1', 'hello', 'QUAL #7', 'Practice 3']],
  'tm': [T.timer_text(t) for t in ['1:45', '0:07', '15', '10:45']]}, open('py.json', 'w'))
