const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  await p.goto(process.argv[2]); await p.waitForTimeout(3000);
  await p.click('button:has-text("Mark the field: Ab3dEfGh1Jk")'); await p.waitForTimeout(1200);
  let c = await p.$('#fc'); let bb = await c.boundingBox(); let at = (u, v) => [bb.x + u * bb.width, bb.y + v * bb.height];
  for (const [u, v] of [[0.066, 0.80], [0.86, 0.78], [0.81, 0.21], [0.21, 0.21]]) { const [x, y] = at(u, v); await p.mouse.click(x, y); await p.waitForTimeout(250); }
  await p.waitForTimeout(600); await p.click('#fSave'); await p.waitForTimeout(25000);
  await p.click('#bPcs'); await p.waitForTimeout(2500);
  c = await p.$('#c'); bb = await c.boundingBox();
  const W = await p.evaluate(() => c.width), H = await p.evaluate(() => c.height);
  const toPage = (px, py) => [bb.x + px * bb.width / W, bb.y + py * bb.height / H];
  const s = await p.evaluate(() => cur.spots.find(s => s.length > 8));
  const n0 = await p.evaluate(() => boxes.length);
  // press inside the goal column and drag: a set-size box placed and moved
  const [gx, gy] = toPage((s[6] + s[7]) / 2, s[8] - 40);
  await p.mouse.move(gx, gy); await p.mouse.down(); await p.mouse.move(gx, gy - 25, { steps: 4 }); await p.mouse.up();
  const after = await p.evaluate(() => boxes[boxes.length - 1]); const n1 = await p.evaluate(() => boxes.length);
  console.log('placed one:', n1 === n0 + 1, 'size set:', Math.round(after[2]), 'x', Math.round(after[3]), 'moved up:', after[1] < (s[8] - 40) - after[3] / 2 - 5);
  // drag it again
  const [bx, by] = toPage(after[0] + after[2] / 2, after[1] + after[3] / 2);
  await p.mouse.move(bx, by); await p.mouse.down(); await p.mouse.move(bx, by + 12, { steps: 3 }); await p.mouse.up();
  const after2 = await p.evaluate(() => boxes[boxes.length - 1]);
  console.log('dragging a box moves it, same size:', after2[1] > after[1] && after2[2] === after[2], '| count:', await p.evaluate(() => boxes.length) === n1);
  // click without moving removes it
  const [cx2, cy2] = toPage(after2[0] + after2[2] / 2, after2[1] + after2[3] / 2);
  await p.mouse.click(cx2, cy2); console.log('click removes:', await p.evaluate(() => boxes.length) === n0);
  // a press on the loose floor: nothing
  const [fx, fy] = toPage(W * 0.5, H * 0.95); await p.mouse.click(fx, fy); console.log('floor ignored:', await p.evaluate(() => boxes.length) === n0);
  // move the goals
  await p.click('#pMove'); await p.waitForTimeout(300);
  const g = await p.evaluate(() => cur.spots.find(s => s.length > 8));
  const [mx, my] = toPage((g[0] + g[2]) / 2, g[8] - 10);
  await p.mouse.move(mx, my); await p.mouse.down(); await p.mouse.move(mx + 30, my + 5, { steps: 4 }); await p.mouse.up();
  const g2 = await p.evaluate(k => cur.spots.find(t => t[5] === k), g[5]);
  console.log('goal moved, same size:', g2[0] > g[0] && Math.round(g2[2] - g2[0]) === Math.round(g[2] - g[0]));
  await p.screenshot({ path: './d1.png' });
  await p.click('#pMove'); await p.waitForTimeout(600);
  console.log('after save:', await p.evaluate(() => document.getElementById('pMsg').textContent.slice(0, 80)));
  await b.close(); })();
