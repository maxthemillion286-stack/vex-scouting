// t136 — v147 (app 2.27): the app's window keeps answering clicks; finders train from YOLO11.
// Reported: "the app is kind of frozen i cant really click into settings or anything".
// The behaviour itself is checked by desktop/dev/window.py (a slow count, a status asked six times).
import fs from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8'), src = fs.readFileSync('../src/index.html', 'utf8');
console.log('t136 — v147');
ok('app version 2.27 or later', /VERSION = '2\.(2[7-9]|[3-9]\d)'/.test(app));
ok('a video with no field marked is remembered as unmarked, not asked about again each time', /_QUADS\[vid\] = \{'q': q, 'g': fld\.get\('g'\) if q else None, 'l': fld\.get\('l'\) if q else None, ('t': fld\.get\('t'\) if q else None, )?'at': time\.time\(\)\}/.test(app) && /fresh = isinstance\(f, dict\) and time\.time\(\) - f\.get\('at', 0\) < 600/.test(app));
ok('when the website does not answer, what was known is kept', /if r\.get\('error'\):[^\n]*\n\s+_QUADS\[vid\] = dict\(/.test(app));
ok('the pin list asks once per video, not once per frame', /if vid not in marked:\s+marked\[vid\] = quad_for\(vid, site\) is not None/.test(app));
ok('counting happens off to one side, one at a time', /def later\(name, fn\):/.test(app) && /later\('review', count_review\)/.test(app) && /later\('pins', count_pieces\)/.test(app));
ok('the status check uses what is counted already', /c, P = counts\(\), pcounts\(\)/.test(app));
ok('the window waits for each status answer before asking again', /let polling=0;async function tick\(\)/.test(app) && !/setInterval\(\(\)=>\{if\(!inReview\)poll\(\)\},1000\)/.test(app));
ok('a pin frame just marked leaves the list straight away', /if name in pcache\['queue'\]:[^\n]*\n\s+pcache\['queue'\]\.remove\(name\)/.test(app));
ok('both finders start from YOLO11, with YOLOv8 to fall back on', /newest_yolo\(YOLO, 'yolo11n\.pt'\)/.test(app) && /'yolo11s\.pt'/.test(app) && /def newest_yolo\(YOLO, name\):/.test(app) && !/YOLO\('yolov8/.test(app));
ok('old training tools are updated for YOLO11', /\(major, minor\) < \(8, 3\)/.test(app));
ok('the website still reads only the shape it knows', /list\(shape\) != \[1, 5, 8400\]/.test(app));
ok('release is v147 or later', /const APP_BUILD = 'v(1(4[7-9]|[5-9]\d)|[2-9]\d\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
