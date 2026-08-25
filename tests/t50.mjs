// t50 — the scrubbing player must work for Vimeo as well as YouTube.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const html = fs.readFileSync(process.argv[2]||'../index.html','utf8');
const src = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const fn = src.match(/async function rwCalCurrentTime\(\)[\s\S]*?\n\}/)[0];

console.log('t50 — anchor capture across platforms');

const make = (win) => new Function('window', fn + '; return rwCalCurrentTime;')(win);

// YouTube: synchronous number
ok('reads a YouTube position', await make({ rwCalPlayer: { getCurrentTime: () => 312.9 } })() === 312);
// Vimeo: Promise
ok('reads a Vimeo position (Promise)',
   await make({ rwVimeoPlayer: { getCurrentTime: () => Promise.resolve(87.4) } })() === 87);
// Vimeo takes priority when both linger from a platform switch
ok('a live Vimeo player wins over a stale YouTube one',
   await make({ rwVimeoPlayer:{getCurrentTime:()=>Promise.resolve(5)},
                rwCalPlayer:{getCurrentTime:()=>999} })() === 5);
// Nothing loaded
ok('nothing loaded returns null, not 0', await make({})() === null);
ok('a player without getCurrentTime returns null', await make({ rwCalPlayer: {} })() === null);
// A rejected Vimeo promise must not throw out of the anchor button
ok('a failing Vimeo player returns null instead of throwing',
   await make({ rwVimeoPlayer: { getCurrentTime: () => Promise.reject(new Error('x')) } })() === null);
// Position 0 is a real answer, distinct from "not ready"
ok('position 0 is returned as 0, not null',
   await make({ rwCalPlayer: { getCurrentTime: () => 0 } })() === 0);

// The anchor button and preview must both be platform-aware
ok('rwSetAnchorHere awaits the position', /async function rwSetAnchorHere/.test(src));
ok('rwPreviewVideo branches on platform', /src\.platform === 'vimeo'/.test(src));
ok('the Vimeo SDK is loaded without a key',
   /player\.vimeo\.com\/api\/player\.js/.test(src) && !/vimeo[^\n]*api[_-]?key/i.test(src));

console.log(`\nt50: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
