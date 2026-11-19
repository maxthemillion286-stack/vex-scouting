// t138 — v149 (app 2.28): the tracker follows the camera. Asked: "what are they
// doing that we aren't" (the best tracker finds the field every frame, "even
// when the camera pans"), then "build whatever you can for now".
// The camera-following itself is checked on a real stream frame by
// desktop/dev/follow.py (known pans and zooms, a close-up, a whole stand-in match).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8'), api = fs.readFileSync('../api/tracker.js', 'utf8');
console.log('t138 — v149');
ok('app version 2.28 or later', /VERSION = '2\.(2[8-9]|[3-9]\d)'/.test(app));
ok('the website saves which moment the field was marked on', /async function vtFieldSet[\s\S]{0,600}await vtMarkTime\(vid\)/.test(src) && /\.\.\.\(all\[vid\]\.t != null \? \{ t: all\[vid\]\.t \} : \{\}\)/.test(src));
ok('asked of the paused YouTube player, which is told to answer', /enablejsapi=1/.test(src) && /event: 'listening'/.test(src) && /d\.event === 'infoDelivery'/.test(src) && /ev\.origin !== 'https:\/\/www\.youtube\.com'/.test(src));
ok('dragging the goals keeps the same moment', /spots && prev\.t != null \? prev\.t : await vtMarkTime\(vid\)/.test(src));
ok('the server keeps it, checked', /f\.t >= 0 && f\.t <= 200000/.test(api) && /\{ t: Math\.round\(f\.t \* 10\) \/ 10 \}/.test(api));
ok('the app fetches the few seconds it was marked on with the matches', /ws = sorted\(ws \+ \[\(max\(0, mt - 3\), mt \+ 3\)\]\)/.test(app));
ok('the camera is followed from that picture, every second and after each cut', /class CamFollow:/.test(app) && /follow\.look\(frame\)/.test(app) && /\(t >= cam\['at'\] \+ 1 or was_cut\)/.test(app));
ok('only the field and what stands on it is matched, never the overlays', /fillConvexPoly\(mask, hull, 255\)/.test(app) && /findHomography\(a, b, self\.cv2\.RANSAC/.test(app));
ok('boxes and pins are recorded where they stand on the marked picture', /boxes_to_marked\(boxes, cam\['Hinv'\], w, h\)/.test(app) && /blobs_to_marked\(blobs, cam\['Hinv'\], pw, ph_\)/.test(app));
ok('toggles and goal spots are looked for where the camera now puts them', /toggle_look\(frame, cur_quad\)/.test(app) && /spot_boxes\(frame\.shape\[1\], frame\.shape\[0\], cur_quad, cur_placed\)/.test(app));
ok('a close-up or replay records no robots', /put = \[\] if away else/.test(app) && /if cam\['view'\] and \(cam\['fails'\] >= 3 or by_cut\):/.test(app));
ok('nothing is dropped until the field has been found once', /cam = \{'H': None, 'Hinv': None, 'at': -1e9, 'fails': 0, 'view': None/.test(app));
ok('the log says how following went', /def cam_note\(cam\):/.test(app) && /cam = rec\.pop\('_cam', None\)/.test(app));
ok('release is v149 or later', /const APP_BUILD = 'v1(49|[5-9]\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
