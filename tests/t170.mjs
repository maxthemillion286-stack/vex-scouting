// t170 — v185 (app 2.52): Ask (a chatbot over the event's numbers, answered by
// the app on this computer) and the robot finder teaching itself.
import fs from 'fs';
import { boot, settle } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); } };
const src = fs.readFileSync('../src/index.html', 'utf8'), app = fs.readFileSync('../desktop/vex_trainer.py', 'utf8');
console.log('t170 — v185');
const { win } = await boot();
await settle(win);
win.eval(`vtTeamSumsMany = async () => new Map()`);
const R = { ratings: new Map([['1', 30], ['2', 20]]), apRate: new Map([['1', 4]]), skill: new Map([['1', { off: 12, offSd: 4, def: 3, defSd: 2 }]]), event: { name: 'Excalibur' } };
const seeds = [{ id: 1, number: '66449A', eventRank: 1, wins: 5, losses: 1, ties: 0 }, { id: 2, number: '1234X', eventRank: 2, wins: 4, losses: 2, ties: 0 }];
const table = await win.eval('tAskTable')(R, seeds);
const lines = table.split('\n');
ok('the event as a table: what each column means, then a line a team', /^Columns: /.test(lines[0]) && lines.length === 4, table);
ok('with seed, record, rating, AP', /^66449A \| 1 \| 5-1-0 \| 30\.0 \| 4\.0 \|/.test(lines[2]), lines[2]);
ok('Ask has its own tab on the event page', /\$\{btn\('ask', 'Ask'\)\}/.test(src) && /async function renderTournamentAsk\(\)/.test(src));
ok('it asks only the app on this computer', /fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/ask`/.test(src) && !/api\.anthropic|openai\.com/.test(src.slice(src.indexOf('function tAskBlock'), src.indexOf('function tCompareBlock'))));
ok('the app answers only the website, from the table only', /ASK_ORIGINS = \('https:\/\/vex-scouting-by-max\.vercel\.app'/.test(app) && /Answer the question using ONLY the data below/.test(app) && /Access-Control-Allow-Private-Network/.test(app));
ok('the robot finder looks again at the frames it was sure of, mirrored too', /def teacher_look\(eyes, frame\)/.test(app) && /kept, dropped = teach_again\(\)/.test(app));
ok('their checks are there', fs.existsSync('../desktop/dev/ask.py') && fs.existsSync('../desktop/dev/teach.py'));
ok('app 2.52 or later', /VERSION = '2\.(5[2-9]|[6-9]\d)'/.test(app));
ok('a question stays, and what happens shows in the conversation', /t-ask-wait/.test(src) && /Could not reach the desktop app on this computer\. Check that/.test(src) && /Promise\.any\(T_ASK_PORTS\.map\(one\)\)/.test(src));
ok('release is v185 or later', /const APP_BUILD = 'v1(8[5-9]|9\d)'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
