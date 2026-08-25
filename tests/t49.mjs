// t49 — published anchors: load, merge precedence, and export shape.
import fs from 'fs';
let pass=0, fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?'\n         '+e:'')));};
const html = fs.readFileSync(process.argv[2]||'../index.html','utf8');
const src = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const grab = (re) => src.match(re)[0];
const ctxHolder = {};
const env = new Function('window','showError','navigator','document',
  grab(/let rwPublished = null;[\s\S]*?\nfunction rwMergePublished\(eid, local\)[\s\S]*?\n\}/) +
  '\nreturn { rwMergePublished, set p(v){ rwPublished = v; } };'
)(ctxHolder, ()=>{}, {}, { getElementById: () => null });

console.log('t49 — published anchors');

// ── anchors.json is well-formed and starts empty ─────────────────────────
{
  const j = JSON.parse(fs.readFileSync('../anchors.json','utf8'));
  ok('anchors.json parses', !!j);
  ok('anchors.json has an events object', j.events && typeof j.events === 'object');
}

// ── merge precedence ─────────────────────────────────────────────────────
const shared = { '2026-03-07': { videoId:'SHARED12345', platform:'youtube',
  anchors:[{matchId:1,name:'Qualification 1',matchMs:1000,videoSec:60}] } };

{
  env.p = { '99': shared };
  const out = env.rwMergePublished(99, {});
  ok('a published anchor is used when nothing is local',
     out['2026-03-07'].videoId === 'SHARED12345', JSON.stringify(out));
  ok('published anchors are flagged as such', out['2026-03-07'].published === true);
}
{
  env.p = { '99': shared };
  const local = { '2026-03-07': { videoId:'LOCAL123456', platform:'youtube',
    anchors:[{matchId:1,name:'Qualification 1',matchMs:1000,videoSec:75}] } };
  const out = env.rwMergePublished(99, local);
  ok('a local anchor overrides the published one',
     out['2026-03-07'].videoId === 'LOCAL123456', JSON.stringify(out));
  ok('the override is not flagged as published', !out['2026-03-07'].published);
}
{
  env.p = { '99': shared };
  const local = { '2026-03-08': { videoId:'DAY2', anchors:[{videoSec:1}] } };
  const out = env.rwMergePublished(99, local);
  ok('published and local days coexist',
     Object.keys(out).sort().join(',') === '2026-03-07,2026-03-08', JSON.stringify(Object.keys(out)));
}
{
  env.p = {};
  ok('no published file leaves local untouched',
     env.rwMergePublished(99, { a: 1 }).a === 1);
  ok('no published file and no local yields empty',
     Object.keys(env.rwMergePublished(99, null)).length === 0);
}
{
  env.p = { '99': shared };
  ok('a different event id gets nothing shared',
     Object.keys(env.rwMergePublished(1234, {})).length === 0);
  ok('numeric and string event ids both resolve',
     env.rwMergePublished('99', {})['2026-03-07'] !== undefined);
}

console.log(`\nt49: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
