const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  await p.goto(process.argv[2]); await p.waitForTimeout(4000);
  const btn = await p.$('button:has-text("Mark the field: Ab3dEfGh1Jk")'); console.log('button:', !!btn, 'pins button disabled:', await p.$eval('#bPcs', e => e.disabled));
  await p.screenshot({ path: './f0.png', clip: { x: 0, y: 0, width: 1200, height: 900 } });
  await btn.click(); await p.waitForTimeout(1500);
  const c = await p.$('#fc'); const bb = await c.boundingBox();
  const at = (u, v) => [bb.x + u * bb.width, bb.y + v * bb.height];
  for (const [u, v] of [[0.066, 0.80], [0.86, 0.78], [0.81, 0.21], [0.21, 0.21]]) { const [x, y] = at(u, v); await p.mouse.click(x, y); await p.waitForTimeout(300); }
  await p.waitForTimeout(800);
  console.log('say:', await p.$eval('#fSay', e => e.textContent), '| save enabled:', !(await p.$eval('#fSave', e => e.disabled)));
  await p.screenshot({ path: './f1.png' });
  // drag the centre goal a little
  const spots = await p.evaluate(() => F.spots); const [cx, cy] = at(spots[8][0], spots[8][1]);
  await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx + 30, cy + 10, { steps: 5 }); await p.mouse.up();
  const moved = await p.evaluate(() => F.spots[8]); console.log('centre goal moved:', moved[0] > spots[8][0]);
  await p.click('#fSave'); await p.waitForTimeout(1200);
  console.log('after save:', await p.$eval('#fSay', e => e.textContent));
  await p.waitForTimeout(2500); console.log('back home:', await p.$eval('#home', e => e.style.display !== 'none'));
  await b.close(); })();
