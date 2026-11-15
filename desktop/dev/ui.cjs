const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
const url = fs.readFileSync('ui.url', 'utf8');
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1180, height: 860 } });
const errs = []; pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let pass = 0, fail = 0; const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n + (c || !d ? '' : ' ' + d)); };
// no token: refused
const bare = await pg.request.get(url.split('?')[0] + 'api/state');
ok('without the window\'s token nothing is served', bare.status() === 403);
const wrongHost = await pg.request.get(url.replace('/?t=', '/api/state?t='), { headers: { Host: 'evil.example' } });
ok('a request under another site\'s name is refused', wrongHost.status() === 403);
await pg.goto(url); await pg.waitForTimeout(1500);
ok('three main buttons', await pg.locator('.card button').count() === 3);
ok('it asks for the admin key first', await pg.locator('#key').isVisible());
ok('tracking is not offered without the key', await pg.locator('#bTrack').isDisabled());
await pg.fill('#keyIn', 'nope'); await pg.click('#key button'); await pg.waitForTimeout(1200);
ok('a wrong key is refused, with a reason', /did not accept/.test(await pg.textContent('#keyMsg')));
await pg.fill('#keyIn', 'correct-horse'); await pg.click('#key button'); await pg.waitForTimeout(1800);
ok('the right key is saved and the box goes away', !(await pg.locator('#key').isVisible()) && /saved/.test(await pg.textContent('#keyPill')));
ok('the key is in config.json for the jobs to use', JSON.parse(fs.readFileSync('run/config.json', 'utf8')).key === 'correct-horse');
ok('frames waiting are counted', /4 waiting/.test(await pg.textContent('#revN')), await pg.textContent('#revN'));
ok('training waits for enough reviewed frames', await pg.locator('#bTrain').isDisabled() && /Review \d+ more/.test(await pg.textContent('#trainN')));
await pg.screenshot({ path: 'ui-home.png' });
// track: a real process, which finds no work and says so
await pg.waitForTimeout(9000);   // saving the key started tracking by itself
const log = await pg.textContent('#log');
ok('tracking started by itself once the key was saved, and reports back', /Waiting for the website to send work/.test(log), log.slice(-300));
ok('Stop is offered while it runs', await pg.locator('#bStop').isVisible());
await pg.screenshot({ path: 'ui-run.png' });
await pg.click('#bStop'); await pg.waitForTimeout(1500);
ok('Stop stops it', /Stopped\./.test(await pg.textContent('#log')) && !(await pg.locator('#bStop').isVisible()));
// learn from a file that is not there
await pg.fill('#src', 'C:\\nothing\\here.mp4'); await pg.click('#bAdd'); await pg.waitForTimeout(7000);
ok('a bad path is answered plainly', /neither a file on this computer nor a link/.test(await pg.textContent('#log')), (await pg.textContent('#log')).slice(-200));
// review
await pg.click('#bRev'); await pg.waitForTimeout(1200);
ok('Review opens on a frame', await pg.locator('#rev').isVisible() && /4 to review/.test(await pg.textContent('#revLeft')));
const box = await pg.locator('#c').boundingBox();
await pg.mouse.move(box.x + 60, box.y + 300); await pg.mouse.down(); await pg.mouse.move(box.x + 160, box.y + 380); await pg.mouse.up();
await pg.screenshot({ path: 'ui-review.png' });
const before = fs.readdirSync('run/data/labels').length;
await pg.keyboard.press('Enter'); await pg.waitForTimeout(800);
const files = fs.readdirSync('run/data/labels');
ok('Enter saves the frame and moves on', files.length === before + 1 && /3 to review/.test(await pg.textContent('#revLeft')));
const newest = files.map(f => ({ f, t: fs.statSync('run/data/labels/' + f).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
const lab = JSON.parse(fs.readFileSync('run/data/labels/' + newest, 'utf8'));
ok('the drawn box is in what was saved', lab.boxes.some(b => Math.abs(b[2] - 100 * (1280 / box.width)) < 6), JSON.stringify(lab.boxes.slice(-1)));
await pg.keyboard.press('s'); await pg.waitForTimeout(600);
ok('S skips a frame', /2 to review/.test(await pg.textContent('#revLeft')));
await pg.keyboard.press('Escape'); await pg.waitForTimeout(1500);
ok('back on the main page the counts follow', /2 waiting/.test(await pg.textContent('#revN')), await pg.textContent('#revN'));
await pg.click('header button'); await pg.waitForTimeout(300);
await pg.fill('#sWorkers', '8'); await pg.click('dialog .row button:last-child'); await pg.waitForTimeout(600);
ok('settings are saved', JSON.parse(fs.readFileSync('run/config.json', 'utf8')).workers === 8);
await pg.setViewportSize({ width: 700, height: 900 }); await pg.waitForTimeout(300);
ok('no sideways scroll when the window is narrow', await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
ok('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
})();
