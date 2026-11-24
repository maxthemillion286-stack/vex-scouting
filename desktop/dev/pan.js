// Dev check (v199, app 2.57): middle-drag pans the marking picture and never marks.
// Run: python3 -c "<write UI_HTML to ui.html>" then node desktop/dev/pan.js ui.html
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  await p.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('file://' + process.argv[2]);
  const r = await p.evaluate(async () => {
    $('home').style.display = 'none'; $('rev').style.display = 'block'; inReview = true; pm = true;
    cur = { id: 'x', spots: [[0, 0, 1600, 900, 3658]] };
    c.width = 1600; c.height = 900; c.style.visibility = 'visible'; boxes = [];
    setZoom(3); await new Promise(r => setTimeout(r, 50));
    return { cw: $('cw').scrollWidth, vis: $('cw').clientWidth };
  });
  const box = await p.locator('#c').boundingBox();
  const x0 = 600, y0 = 400;
  await p.mouse.move(x0, y0); await p.mouse.down({ button: 'middle' }); await p.mouse.move(x0 - 300, y0 - 100, { steps: 5 }); await p.mouse.up({ button: 'middle' });
  const after = await p.evaluate(() => ({ l: $('cw').scrollLeft, t: $('cw').scrollTop, n: boxes.length }));
  await p.mouse.click(x0, y0);
  const left = await p.evaluate(() => boxes.length);
  console.log(JSON.stringify({ r, after, leftClickAdds: left }));
  await b.close();
})();
