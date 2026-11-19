# VEX Scout — handoff

Written for whoever (or whatever) picks this up next, including Claude Code
with no memory of the sessions that produced it. Read this before changing
anything in the Jumper or `api/proxy.js`; several of the bugs below were fixed,
regressed, and fixed again because the reasoning wasn't written down.

Current release: **v165**. Everything green: 112 test files.

**Since v132 the page is edited in `src/index.html` and `index.html` is BUILT** (`node tools/build.mjs`, needs `npm install`). Never edit `index.html` by hand; t122 fails if it is not exactly what the source builds. `APP_BUILD` lives in `src/index.html`. (The `v19` in §8's
example output is an example; the number in the three files is what counts.)

---

## 1. What this is

A single-file scouting web app for VEX Robotics teams. No framework, no build
step, no database.

```
index.html          ~8,900 lines. The entire app: markup, CSS, JS in one file.
api/proxy.js        Vercel serverless function. Proxies the RobotEvents API,
                    rotates tokens, caches, slims payloads, scrapes stream
                    links, talks to YouTube and Vimeo.
sw.js               Service worker. Network-first with timeouts.
anchors.json        Published Jumper anchors, read by every visitor.
anchor-tool.html    LOCAL ONLY. Never deployed. Produces anchors.json.
.vercelignore       Keeps anchor-tool.html and tests out of the deploy.
tests/              25 Node test files. See §7.
```

Deployed on Vercel from GitHub; push to `main` deploys.

Tabs: **Scout** (one team, or several compared), **Skills Rankings**,
**Tournament** (teams / matches / skills / awards / bracket), **Jumper** (jump
to a match inside an event's YouTube or Vimeo stream), **Simulator** (match
prediction, pick list, bracket odds, event scout).

### Environment variables (Vercel)

| Variable | Required | What breaks without it |
|---|---|---|
| `ROBOTEVENTS_TOKEN` | **Yes** | Everything. Proxy returns 500 "No API tokens configured". |
| `ROBOTEVENTS_TOKEN_2..10` | No | Nothing; more tokens = more rate-limit headroom, rotated round-robin. |
| `YOUTUBE_API_KEY` | Effectively yes | Jumper auto-find and auto-sync. Without it the stream link can still be pasted and anchored by hand. |

Confirm all of these live at `/?debug=1` → `server` block. It reports counts and
booleans only, never key values.

---

## 2. The single most important thing to know

**`events.vex.com` blocks Vercel's datacenter IPs.** Every attempt to read an
event's public page from the serverless function returns **403**, and the public
relays (`r.jina.ai`, `corsproxy.io`) are blocked too. Confirmed repeatedly in
production, most recently at v16.

That means **page scraping effectively never succeeds in production.** The path
still exists and runs first — it's free, it works locally, and it may start
working again — but the mechanism that actually finds streams today is the
**YouTube search by event name**. Treat scraping as a bonus, not the primary.

Do not "fix" this by adding a Googlebot user-agent. That was tried and it made
things *worse*: claiming to be a crawler from a datacenter IP fails the
reverse-DNS check every WAF runs, so the request is scored as an impostor and
blocked harder than an honest browser string. The code now sends a full, honest
Chrome identity including `sec-ch-ua` and the `sec-fetch-*` family, because
sending only a `User-Agent` is itself a bot tell.

---

## 3. How Jumper auto-find actually works

Ordered by cost. Each step only runs if the previous found nothing.

1. **The event object from the API** — `rwFindWebcasts()` scans every field for
   a stream URL. Free. Usually empty; the API exposes no webcast field.
2. **Scrape the event page** — `streams:<SKU>` in the proxy. Free. See §2: this
   currently always 403s in production.
3. **Resolve a channel link** — if the page yielded `youtube.com/@name` or
   `vimeo.com/name`. **3 YouTube units.**
4. **Search YouTube by event name** — **101 units.** The one that works.

### Quota — read this before touching any YouTube call

The default allowance is **10,000 units/day**. `search.list` costs **100**.
Everything else costs **1**.

An earlier version of `resolveChannel` spent **400 units per channel** (one
search to resolve the handle, three more for completed/live/upcoming) — 25
lookups exhausted the day. It now uses `channels.list` + `playlistItems.list` +
a batched `videos.list`: **3 units**. Never reintroduce `search.list` for
channel resolution.

`videos.list` takes **up to 50 ids in one request for one unit**. Always batch.
`tests/t60.mjs` counts real request costs and will fail if this regresses.

Caching is what keeps the quota alive:

- Found stream → cached 24h, plus a CDN `s-maxage`.
- Miss on a **finished** event → 24h (it can never gain a link).
- Miss on **today's** event → 1h (the broadcast may not be published yet).
- Auto-find is skipped entirely when every day already has an anchor.
- `?debug=1` reports `ytUnitsThisInstance`. A large number means something loops.

**Never re-add an unconditional cache-buster to the streams lookup.** A
`&_t=${Date.now()}` was added to chase a stale-proxy problem and quietly
defeated the CDN on every request — the single largest source of wasted quota.
It is now `rwDebugOn() ? ... : ''`.

### When auto-find comes back empty, read the panel

Since v50 a failed search reports **which gate refused each candidate** —
`title`, `aired`, `duration` or `grade` — with the query it used, the tokens it
matched on, and how many videos YouTube returned at all. `vsSelfCheck()` prints
it. Before that, every cause produced one identical sentence, which is why the
Maker Faire miss took a month: a query that returned nothing and the right video
thrown away on a grade veto were indistinguishable from outside.

Three things that miss came down to, all in one event name — *"Maker Faire OC -
MS/HS - Day 1 - robotics is ez: VEX V5 Robotics Competition - Override"*:

* **Blended events vetoed on the wrong grade.** `gradeOf()` returns the FIRST
  grade it finds and tests middle school first, so `MS/HS` read as `ms` and any
  HS-titled broadcast was refused. Use `eventGrade()` for the veto — it returns
  null when a name mentions two grades or none. `gradeOf()` is still right for a
  stream TITLE, which names one grade or none.
* **The season's game name was not a stopword.** `push`/`back`/`rapid`/`relay`
  were listed, `override` was not. Every event in a season carries it, so it was
  boilerplate posing as evidence. Add the new game name each season.
* **Organisers stream per field, and the field goes first in the title.**
  `"Obsessed Cuts and Color - Maker Faire OC - MS/HS - Day 1"` is the event
  completely named with a field in front, and the extra words dropped precision
  below the 0.8 bar. `scoreTitle()` now also accepts `recall >= 0.6` with two or
  more distinctive shared words (`via: 'names-event'`), and that weaker route is
  held to a 40-minute broadcast minimum rather than 20 — a clip can name an
  event, an afternoon of matches is what a stream looks like.

**The programme suffix is not always "…Competition".** RobotEvents appends it
after a colon in several shapes — `VEX V5 Robotics Competition`, `VEX V5 Event
Regional Championship`. `PROGRAM_SUFFIX` matches them all, and both `searchQuery`
and `bareQuery` use it. Miss one and the whole name goes to YouTube as the query.

**A number that IS the identity stays attached to its word.** `NUMBERED` fuses
`Region 3` into `region3` before tokenising, because single characters are
dropped and "California Region 3" would otherwise reduce to `[california]` plus
a `region` that says nothing. `Day N` is deliberately excluded — §4 owns days,
and a day1/day2 split here would lower recall on every multi-day title.

**A state code is the state.** `sameWord()` treats `ca` and `california` as equal
at compare time. Not a rewrite: rewriting could resurrect a token the stopword
list drops, since `IN` and `OR` are stopwords long before they are states. The
table deliberately omits every code that is an English word or a grade — `MS`,
`HS`, `IN`, `OR`, `OK`, `HI`, `DE`, `ME`, `LA`, `ID`. A missing code costs one
shared token; a wrong one invents evidence.

**A second, trimmed query.** If the full name reaches nothing, `bareQuery()`
strips the season, the day marker, the grade, the programme initials and the
"presented by" tail, and the search runs once more — *"2026 CA Region 3 State
Championship - High School: VEX V5 Robotics Competition"* becomes *"CA Region 3
State Championship"*. Only on a miss, only once, and only when the trimmed
string differs, so a hit never pays for it. It is lossier than the full name
(two events at one venue in a season can trim to the same string), which is why
it is never the first attempt.

**Bump `RW_STREAM_LOGIC` whenever any of this changes.** The proxy caches a miss
for an hour and a past event's miss much harder, keyed on that string — ship a
matching fix without bumping it and nobody sees the fix.

### Matching a video to an event — the rules and why

Getting this wrong is worse than finding nothing: a wrong video means every
match time is silently wrong with nothing on screen to say so.

- **Search with the event's real name**, not the tokenised version. Tokens are
  for *scoring*. Searching with them strips exactly the words organisers put in
  their titles — the club name. A real failure: event "Robotics is EZ @ 2025
  Maker Faire Orange County - MS" was searched as `"maker faire orange county
  middle school"`, which returns the actual Maker Faire. `searchQuery()` strips
  only the program suffix RobotEvents appends.
- **Score in both directions.** A stream title is a *shortened* event name, not
  a copy — venue prefixes, ordinals and in-jokes never survive. Requiring 80% of
  the *event's* words rejected 5 of 8 real events. `scoreTitle()` takes
  `max(precision, recall) >= 0.8` with at least 2 distinctive words in common.
- **Grade level is a veto, not a score.** Venues run high school one day and
  middle school the next under near-identical names. `gradeOf()` reads title
  *and description* for `high school`/`HS`/`middle school`/`MS`/`elementary`/
  `VEX U`. Conflict → reject outright. A video stating no grade is ambiguous,
  not wrong, so it's allowed.
- **Filter on `actualStartTime`, not `publishedAt`.** `publishedAt` is when a
  broadcast was *created*, routinely weeks before it airs — filtering on it
  silently discarded scheduled streams. Search wide, then confirm air time via
  the batched `videos.list`. This is also the strong discriminator that lets
  name matching be loose, because two events at the same venue read identically
  by name and only the date separates them.
- **Reject clips that aren't broadcasts.** A "Maker Faire Orange County 2025
  Highlights" reel shares four words and airs the same weekend, so neither name
  nor date separates it. `looksLikeEventBroadcast()` requires a live broadcast
  or a duration ≥ 20 minutes. Costs nothing — `contentDetails` rides along on
  the details call.

---

## 4. Multi-segment days — the thing that looks most like a bug

Organisers routinely stream one day as **several separate broadcasts**. A real
case: SKU `RE-V5RC-25-0816` had **six** videos for one day, starting 17:17,
20:31, 22:07, 22:34, 22:36 and 22:38 UTC.

The old model assumed one video per day. It picked the first, anchored the day's
first match against it, got a **negative** offset, and `rwTryAutoSync` bailed
with "these matches happened before this stream started". Because auto-sync runs
`quiet: true`, this failed **silently** — the stream box showed a correct link
while every match was inert. It looked like auto-find was broken. It wasn't.

Now: `rwSegmentsForDay()` collects every video whose `actualStartTime` falls on
that day into `cal[day].segments`, and `rwPickSegment()` resolves each match to
the segment that was recording at the time. `rwCalForMatch()` returns a
synthetic single-video calibration for that segment, so offsets, the embed and
the watch link all need no special case.

Details that matter:

- A match in a **gap** between segments falls back to the last segment that had
  begun.
- A match up to **15 minutes before** the first segment still opens it at 0:00 —
  organisers often start recording a minute into the first match.
- Earlier than that returns `null`, and the row says **"not in the stream"**,
  not "no stream for this day". The day *does* have a stream; that match just
  wasn't filmed.
- `rwOffsetFor` had a short circuit accepting any object that looked like a
  calibration, which skipped segment resolution. It now excludes `.segments`.

`tests/t63.mjs` uses the six real timestamps above.

---

## 5. Vimeo

- **Auto-find works** — Vimeo links are matched and classified.
- **Auto-sync is approximate at best.** Vimeo keeps the actual broadcast start
  behind its paid API. The public player config exposes
  `live_event.ingest.scheduled_start_time` — the *scheduled* start. A day synced
  from it is tagged **amber** ("≈ synced from Vimeo's scheduled start"), never
  green, and the earlier/later nudge corrects it.
- **Clip IDs are numeric.** `vimeo.com/ccisdrobotics` is a **channel**, not a
  video. The old pattern accepted any word after `vimeo.com/`, so channels were
  filled into the stream box as phantom videos that could never sync. Channels
  are now detected, resolved via the channel page where possible, and otherwise
  filtered out with an explanation.
- **A Vimeo *event* URL always plays whichever clip is currently featured.** So
  an anchor stored against `vimeo.com/event/123` starts showing the wrong day's
  footage the moment a second broadcast begins. Only
  `player.vimeo.com/video/<id>?h=<hash>` pins one recording — which is why the
  `vimeo:` proxy route resolves the clip id *and* its hash, and why the export
  saves both.
- The Live Viewer project referenced during development does **not** auto-sync
  Vimeo either. It has an admin anchor once per day and shares the result.

---

### Anything that re-times a day must move the preview

`ctx.playing.off` is computed when ▶ is pressed and is NOT derived on render, so
every path that changes a day's anchors has to call `rwRefreshPlaying(ctx, day)`
before `rewatchRender()`. The ±30s nudges, the minute shift, adding an anchor and
removing one all do.

Without it the match list's times updated and the player did not, so the buttons
looked like they did nothing — which is the whole point of nudging, since you
press it while watching to see the match come into frame.

It recomputes through `rwOffsetFor()` rather than adding the same delta to
`off`: with two or more anchors the matches between them are interpolated, so a
day does not move by a flat amount.

---

## 6. Anchors: the sharing model

Anchoring is per **video** and one-off: the recording runs in real time, so
`streamStart = matchTime − videoSec` and every other match follows by
arithmetic. One anchor per video; a two-day event with separate broadcasts needs
two.

- Anchors set in the app save to `localStorage` only — one browser, one device.
- `anchors.json` at the repo root is the **shared** copy, fetched by every
  visitor on load.
- Precedence: published anchors are the baseline, **local overrides win**. A
  slightly-off published anchor can be corrected on the spot without a redeploy.
- Published days show "✓ using a published anchor".

**Publishing is deliberately absent from the deployed app.** `anchor-tool.html`
runs locally and produces the JSON. Nothing in the public bundle mentions
exporting — `tests/t51.mjs` asserts that absence, including that no rendered
button contains the words.

Be clear about what protects this: **GitHub write access, not obscurity.**
Anchors only become public via a commit. Any client-side gate on a static app is
defeated by view-source. Hiding the tool is UX, not security — and it doesn't
need to be security, because the real boundary already exists.

Manual calibration remains available to ordinary users on purpose: when
auto-sync fails it's their only route, and it writes to their own
`localStorage`, so the worst case is they break it for themselves.

### Using the tool

1. `vercel dev`, open `http://localhost:3000/anchor-tool.html` (it needs
   `/api/proxy`). Or open the file directly and set `PROXY` at the top of its
   script to your deployed origin.
2. Enter the SKU → **Load**.
3. **Anchor** on a day → **Auto-find** or paste the link → **Load video**.
4. Scrub to when robots start moving → pick the match → **Set anchor**.
5. Check the "implies the broadcast began" line looks sane.
6. Repeat per day.
7. Paste the current `anchors.json` into the box → **Merge this event in** →
   **Copy all** → paste over the file → commit.

Merging is per-day, so re-anchoring one day leaves the others intact.

---

## 7. Tests

```bash
npm install jsdom          # once
node tests/run-all.mjs     # from the repo root
```

Individual: `node tests/t60.mjs`. Each exits non-zero on failure.

They're `.mjs` because `api/proxy.js` uses `export default` and the repo has no
`"type": "module"`. Paths inside assume `tests/` sits at the repo root and the
proxy is at `api/proxy.js`.

| File | Covers |
|---|---|
| t42 | Stream URL extraction: `&amp;` truncation, escaped-slash JSON URLs |
| t43 | `.input-label` overlap fix across all five tabs |
| t44 | Hidden Multi Scout shim selects must not render dropdowns |
| t45 | Skills row fits one line (arithmetic on declared min-widths) |
| t46 | Auto-find: Cloudflare, relays, URL candidates, webcast section |
| t47 | Per-day stream selection |
| t48 | Vimeo clip/hash resolution |
| t49 | Published anchors: merge precedence |
| t50 | Anchor capture across YouTube and Vimeo players |
| t51 | Publishing absent from the public bundle; tool not deployed |
| t52 | `?debug=1` gating |
| t53 | `diag` route leaks no key values |
| t54 | Build markers and cache busting |
| t55 | Vimeo channel vs broadcast |
| t56 | YouTube search fallback |
| t57 | Grade veto and match threshold |
| t58 | All three files report the same release number |
| t59 | Auto-find doesn't block the first render |
| t60 | **Quota costs (counts real units) and air-time correctness** |
| t61 | Anchor form stays collapsed |
| t62 | Request de-duplication |
| t63 | **Multi-segment days, with the six real timestamps** |
| t64 | 500s explain themselves |
| t65 | Auto-find reports itself; auto-sync runs per day |
| t66 | A description link must not short-circuit the search |
| t67 | `siblings:` — the other days of a multi-day event |
| t68 | A single rare word is evidence; day labels beat index order |
| t69 | Day ordinals come from the EVENT; a wrong video is refused |
| t70 | Channel listing reaches back to the event |
| t71 | The search's entry check and the scorer agree |
| t72 | Cache versioning, channel enumeration, grade by title |
| t73 | "Most day 2 events still show day 1" |
| t74 | vexworlds.tv is recognised, and said so honestly |
| t75 | The anchor form must not offer another day's recording |
| t76 | VEX TV is BoxCast; the day assignment is legible |
| t77 | A stream that starts a few minutes into the first match |
| t78 | **Every multi-day shape that actually occurs, swept in one place** |
| t79 | Running out of quota must not read as "nothing matches" |
| t80 | The app diagnoses itself; a reload can be forced |
| t81 | The Teams tab loads its own data, and never shows another event's |
| t82 | **End to end in a real DOM — see below** |
| t83 | Guarded storage; a boot no single step can cancel |
| t84 | The RobotEvents link — URL shape, and the proxy's copy of it agreeing |
| t85 | Grade must not drop teams; MS/HS badges; live tracking; the stuck-hover highlight |
| t90 | **California Region 3 — the programme suffix, the dropped number, the state code** |
| t89 | Nudging the calibration has to move the preview |
| t88 | Back / forward through where you have been |
| t87 | The team page: best result, phone layout |
| t86 | **Why Maker Faire never auto-found — blended grades, the game name, field-prefixed titles — and a search that explains its refusals** |
| t91 | Round trips through the memo; **stored XSS, driven against a poisoned fixture** |
| t92 | Offline save and replay; stepping and resuming the Jumper |
| t93 | The look, written as rules a change can be checked against |
| t94 | The Simulator's move into Tournament; the pick list and projected bracket |
| t95 | The legal pages, the link to them, **and whether the policy is still true of the code** |
| t96 | **A percentage must say what it is a percentage of** — the card's order, both labels, the column key |
| t97 | **The bracket is a bracket** — the projected tree, its slot arithmetic, predictions on unplayed slots, and watching the played ones |
| t98 | **Which region the Event Scout searched** — the funnel, the heading, and a fixture whose API ignores the filter |
| t99 | **The service worker always answers** — the four paths that could reject inside respondWith |
| t100 | **The v75 sweep** — every view poisoned, every site named, and the two blanket guards |
| t101 | **The INFO tab** — the trailer loads once, pauses on leaving, resumes on return |
| t102 | **An event's dates are dates** — §18, driven in another timezone and guarded statically |
| t103 | **The week before an event** — §19 |
| t104 | **v81** — round trips, the phone layout, favorites (incl. a poisoned list), and form at an event — §21 |
| t105 | **v82** — suggestions, live picks, last match, swipe, pull to refresh, automatic offline, the softer look — §22 |
| t106 | **v83** — Settings, my team, the version badge, season-wide suggestions, active/inactive, the Jumper's shift and late-match estimate, row alignment, the computer layout — §23 |
| t107 | **v84** — autonomous points in the event rating — §24 |
| t108 | **v85** — what you need to move up, the season line, the My team page, play all — §25 |
| t109 | **v86** — last time's answer painted at once; asking ahead of the tap — §26 |
| t110 | **v87** — comparing teams; every match of a team's in the Jumper — §27 |
| t111 | **v89** — win chances checked against results; season in the rating; play-style groups — §28 |
| t112 | **v91** — robot tracker stage 1: finder maths, queue, shared storage and passcode — §29 |
| t113 | **v99/v101** — robot report: summaries, team report, storage, browser Back; telling robots apart by plate and look — §30, §31 |
| t114 | **v106** — the stream's clock sets the periods; live tracking; late scores — §32b |
| t115 | **v107** — plate attention across all robots; per-stream learning (clock place, scenery, threshold) — §32c |
| t116 | **v109** — desktop app: jobs, import, published finder — §32d |
| t117 | **v112** — stream finding reads YouTube's search page before the paid search |
| t118 | **v114** — briefing, clips, review anywhere, organiser channels, tracking in win chances — §32e |
| t119 | **v115** — pins found by colour and size, counted on a marked field; the short report — §32f |
| t120 | **v120** — long descriptions fold to two lines with a "more" arrow; My team table by event name; app download speed limit |
| sanity | CSS braces balance, inline JS parses, tabs present |
| tool_sanity | Same for anchor-tool.html |

### t82 and `harness.mjs` — the app, driven

Everything above reads `index.html` as **text**: regexes over the source, or a
function pulled out with `new Function` and handed made-up arguments. That
catches a great deal, and it caught nothing about the bug that prompted t82 —
the Teams tab rendering a cache that the team-number route never filled. Both
halves were individually correct. Only walking from one screen to the next
shows the join.

`tests/harness.mjs` loads the real `index.html` into jsdom, stubs the one thing
that reaches the outside world (`fetch` → `/api/proxy`), and hands back the
window plus a list of everything that threw. Tests then call the same handlers
the buttons call.

```js
import { boot, settle, html } from './harness.mjs';
const { win, errors } = await boot();              // or boot({ noStorage: true })
win.switchTab('tournament');
win.document.getElementById('tournamentInput').value = '66449A';
await win.findTournament();
await settle(win);                                  // let fetches land
```

`boot()` options: `noStorage` makes every `localStorage` access throw, as
Safari private browsing and a managed school device do; `fail: { '/events': 500 }`
makes matching requests fail; `empty: ['/skills']` answers them with `[]`.
`router.seen` lists every path requested, which is usually the fastest way to
see why a screen came back blank.

Two bugs surfaced on its first run, neither visible in the source:

* With site data blocked, `window.onload` threw on its second line and took
  everything after it — no tab restore, no service worker, and no
  `enhanceAllSelects()`, so all twelve dropdowns stayed raw native controls.
  The page looked broken and said nothing.
* The Bracket view was the only sub-view rendering no nav, so opening it meant
  searching the event again to get anywhere else.

Add to it whenever a bug turns out to live in the join between two screens
rather than inside either one.

**Prefer the harness over `new Function` extraction.** Several older tests pull
a function out of the source and inject the globals it reads by hand. Every one
of those broke the next time the function gained a global — four times for
`renderTournamentTeams` alone, and each break was the *test* being stale, not
the code. t81 §7 was rewritten to drive the real page instead; do the same
rather than adding one more name to an injection list.

**A caveat that matters:** jsdom has no layout engine. `getBoundingClientRect`
returns zeroes, so t43 and t45 verify that the cascade resolves and that the
arithmetic fits — they **cannot** prove two boxes stopped overlapping. Check
layout changes in a real browser at a narrow width.

Also: several older tests asserted on `doc.body.innerHTML`, which produces false
positives because the app's own source sits inside a `<script>` tag. Scope
assertions to a results element instead.

---

### The event's public page

`reEventUrl(sku)` in `index.html` builds the link the RobotEvents button opens:

```
https://events.vex.com/robot-competitions/<program segment>/<SKU>.html
```

`events.vex.com`, **not** `robotevents.com` — both the API and the public site
moved there in the VEX/RECF split, and §10-D records robotevents.com serving
clean 404s for these SKUs afterwards. §2's warning is about the *proxy* being
blocked from scraping that host; a link opens in the user's own browser, which
is not blocked.

The program segment must match the SKU's program or the page 404s.
`api/proxy.js` derives the same mapping for scraping, so **two copies of it now
exist** — t84 asserts they agree. Add a program to one and you must add it to
the other.

---

### Live tracking

`/matches` and `/rankings` already carry a 15s TTL in `ttlFor()` and are
deliberately left out of edge caching so a refresh is function-fresh. Until v47
the client never used that: nothing refetched, so a schedule opened at a running
event stayed frozen.

`tournamentLiveTick()` now repolls every 30s, but only when **all** of these
hold — a phone in a pocket at a competition should not refetch all day:

* the event is live (`tournamentIsLive()` — from an hour before the start until
  25h after the end, because finals and award entry run past the published end
  time, and the API's `end` is a date rather than a moment),
* the tab is visible,
* the current view is one of `matches` / `teams` / `team`,
* no tick is already in flight.

Only `tournamentMatchCache` and `tournamentTeamCache` are dropped per tick.
Awards, skills and the bracket refresh when opened; rebuilding the rolldown
every 30s would cost far more than it is worth.

**Note for tests:** the interval keeps node's event loop alive, so a test that
opens a running event never exits on its own. `boot()` returns a `stop()` — call
it, or rely on the `process.exit()` every test file already ends with.

### Grade at a mixed event

Community events often run **both grades in one division**. The division's
rankings then cover every team while the list is filtered to one grade, so the
rank order has holes exactly where the other grade placed — reported as
"sorting by rank I'm missing teams 1, 2 and 9". They were never missing from
the data.

**Nothing is filtered by default.** On opening an event the GRADE dropdown is
set from the roster: both grades present → All Grades, one grade → that grade.
Each card on a mixed list carries a small **MS** / **HS** badge
(`gradeBadge()`), so the two are told apart without hiding either.

Picking a grade from the dropdown is a deliberate act and sticks for that event
(`tournamentGradePicked`), including through a live refresh — the tick calls
`loadAndRenderTeamList()`, never `loadTournamentTeams()`, which is where the
flag resets. The flag is set in `enhanceSelect`'s option-click handler, not on
`change`: `setSelectValue()` dispatches `change` too, so a change listener
would record the app's own assignments as user choices.

When a deliberate filter does hide someone, the list says which ranks went with
them and offers SHOW ALL GRADES.

Under All Grades the world-skills column reads **both** grades' standings and
looks each team up in its own — a single call would rank a Middle School team
against High School.

Use `setSelectValue()` for any grade hand-off. Assigning a value a `<select>`
has no option for silently sets it to `''`, which then reads as "no grade"
everywhere downstream.

### Grade is matched, never used to hide someone

`gradeMatches()` normalises case and spacing, and **an unknown grade is kept**.
The old exact compare dropped teams whose grade came back differently cased or
absent — off the list, with the count line reporting the smaller number as
fact. A blank grade is not evidence of the other grade.

### :hover is always behind `@media (hover: hover)`

A touch device has no hover but latches the state onto the last element tapped
and holds it until something else is tapped — which reads as a team being
randomly highlighted. Every self-contained `:hover` rule in `index.html` is
wrapped; t85 fails if a bare one appears.

---

### Back / forward

The app is one page with no URLs, so the browser's Back button either leaves the
site or does nothing. `vsNav` is a small history of places you have been, driven
by the two arrows above the tabs.

Each entry carries a **closure that puts the app back**, not a description of a
state some future render would have to learn to rebuild. Replaying re-enters the
same functions a click does, so `vsNav.busy` is what stops a replay recording
itself as a new place — without it, going back would push the place you went
back to and the stack would never shrink.

The arrows carry no visible text — the page says where you are. The `label` is
for the tooltips, which name where each arrow LEADS.

A tab entry also remembers whether that tab's results panel was empty when you
arrived, and clears it on the way back. Without that, Tournament → search → back
landed on the tab with the search results still on screen and the only sign
anything had happened was the arrow greying out. It only ever clears what was
already empty, so it can never throw away something you navigated to.

To make something navigable, call `vsNavPush(key, label, restore)` from the
place that performs it, after it renders. Same `key` twice in a row is not a
move. Going somewhere new from halfway back drops what was ahead, like a
browser. Greying out is the `disabled` attribute, never a class, so an arrow can
never look dead and still work.

---

### Round trips: the Tournament tab memo

Opening an event used to re-ask the API for the same things on every view. The
event detail came back five times in one walk; each division's rankings three
times. The proxy caches all of it, so the answers were cheap — but the client
still paid a **round trip** for each, and on venue wifi the round trip is the
whole cost.

The Jumper has had `rwMemoed` since v30. The Tournament tab now has the same
thing:

```
tMemoReset(eventId)                   // at the top of loadTournamentTeams
tEventDetail / tEventTeams / tEventAwards / tDivisions
tDivRankings(eventId, divId) / tDivMatches(eventId, divId)
```

Two rules make it safe:

* **It refuses to answer for any other event.** `tMemoed` compares the id it was
  given against `tMemoKey` and falls through to a live fetch when they differ.
  `sim_buildRatingsFromEvent` walks events the Tournament tab never opened, so
  without that guard it would have been handed another event's rankings.
* **A rejected promise is not kept.** The `.catch` deletes the key and rethrows,
  so one failed call does not pin the failure for the rest of the visit.

`tMemoDropLive()` is the refresh path: it drops only `rank:` and `matches:`,
because divisions, the roster, the dates and the awards do not change while you
watch. It also evicts `_evCache` — the ratings snapshot is built **from** those
matches and keeps its own 60-second cache, so leaving it in place served a
minute-old table to a 30-second live tick.

Adding a view? Fetch through these, not `apiGet`. A typical walk is 12 calls,
down from 22; Matches and back-to-team are 0; a steady live tick is 2. t91 fails
if those numbers regress.

Two loops were also `for` with an `await` inside, which is serial — ten round
trips end to end for rankings at Worlds, and **one per team** for Simulator
skills, so an 80-team event spent eighty in a row. Both now go through
`sim_pool(items, worker, sim_poolSize())`, which keeps the progress counters and
catches per item so one bad division does not take the view down.

---

### API text is not markup

Team names, robot names, event names and award titles are typed by people — a
team enters its own name when it registers — and every one of them went into
`innerHTML` raw. A team called `<img src=x onerror=…>` would have run that in
the browser of anyone who opened an event it attended, with the page's
localStorage and its `/api/proxy` session in reach.

Two helpers, and which one to use is not a matter of taste:

* `esc(v)` — for text and for ordinary attributes. All five characters, `&`
  first so nothing double-escapes.
* `teamAttr(n)` / `listAttr(v)` — for a value going **inside an inline
  `onclick`**. `esc()` is the wrong tool there: the browser decodes entities
  *before* the JavaScript is parsed, so an escaped quote comes back as a quote
  and closes the string anyway. These narrow to a safe alphabet instead —
  `teamAttr` to letters, digits and hyphens, `listAttr` also allowing a space
  and a comma for a grade level or a comma-joined team list.

The one string here a **stranger** picks is a YouTube video title: the
self-check prints the titles auto-find refused, and anyone can upload a video
with any title they like. That path is remote, not stored, and it is escaped at
the render site in `rw-check`.

`JSON.stringify(x).replace(/"/g, '&quot;')` used to appear in four places as a
hand-rolled version of this. It happened to work for quotes and did nothing for
`&`; all four now use `esc(JSON.stringify(x))`. There was also a local
`const esc = s => (s || '').replace(/"/g, '&quot;')` inside the bracket builder
that **shadowed the real one** — removed, so nobody reaches for `esc` and gets
the weaker version.

t91 covers both the helpers and the driven case: a payload in a team name
renders as text, does not execute, and no raw tag reaches the DOM.

---

### The API cache has a ceiling

`sw.js` caches API responses as an offline fallback, and until v58 kept every
distinct URL for the life of the build. The app asks for a lot of distinct
things — a season of skills standings, every team a scout looks up, every
division's matches — so on a phone that grew until the browser evicted the whole
origin, taking the app shell with it and leaving nothing to open offline.
`API_CACHE_MAX` is 300, trimmed oldest-first after each write. The app shell
lives in `CACHE_NAME` and is never trimmed.

---

### Saved for offline

The service worker caches API answers, but only ones you happened to open, and
it trims oldest-first when it fills. Neither helps in a gym with no signal, where
what you want is the schedule you deliberately kept before you left.

So a save runs **the same calls the app makes** and stores each page body under
the exact path that produced it; `apiGet`'s fallback looks that path up when the
network fails. There is deliberately **no list of endpoints** to keep in step
with the views — whatever they ask for is what was saved. A new view needs
nothing added here.

Kept in IndexedDB, not the service worker's cache, because that one is capped
and evicts oldest-first: an event saved on Thursday should still be there on
Saturday.

Two things that are easy to get wrong:

* **Do not sit through the backoff.** The five-attempt retry is for a connection
  that is struggling. With a saved copy in hand it is thirty-one seconds of
  spinner to reach an answer we already have, so `fetchPage` asks **once** when
  a saved copy exists.
* **Do not read localStorage per request.** `vsOfflineAny()` caches whether
  anything is saved at all, so a device that has never used the feature does no
  extra work. Invalidate it in `vsOfflineNote`.

One known edge, left deliberately: a paginated endpoint is saved page by page,
and `apiGet` still fails the whole call if any page is missing. That can only
happen if the data grew between the save and the use — a roster that gained a
page — and in that case the stored copy was incomplete anyway. Making the later
pages optional would silently drop teams **online** too, which is worse.

`?debug=1` reports `offlineHits` and which events are kept.

---

### The Jumper, match to match

`rwPlayOrder()` returns the matches that can actually be opened, **in the
screen's order** — day, then round, then position. Any other sequence makes
"next" point somewhere the page never showed you. Matches on an unsynced day
have no position and are left out, or stepping onto one would leave the player
showing nothing.

`vex_rw_seen` keeps, per event, the ids you opened and the last one. Coming back
offers a button rather than autoplaying — arriving to a video you did not ask
for is worse than one click — and the offer is only made if that match is
**still** playable, so a cleared calibration cannot leave a dead link on screen.
Both lists are bounded (400 matches, 40 events) against the localStorage quota.

---

### Chrome, and how little of it there should be

v60 took a pass at the look. The rule it followed, if more is added: **a border
has to earn its place.** Almost everything here had one, so boxes sat inside
boxes inside boxes and nothing on the page looked more important than anything
else.

What replaced them:

* **Lists are lists.** `.match-row` and `.t-match-row` are a bottom hairline and
  nothing else — fifteen outlined rectangles is a wall, not a schedule. The
  win/loss stripe on the left stays, because that one carries information.
* **Panels keep their surface and lose their outline.** `.detail-block`,
  `.rw-block`, `.sched-summary`, `.md-headline` are a background and padding.
* **Lists that draw hairlines between their rows no longer also draw a frame
  around the set** (`.t-skills`, `.t-awards`, `.tournament-list`).
* **The event sub-nav speaks the same language as the tab strip above it** — an
  underline for the active view, no tray, no filled block. On a phone it scrolls
  sideways as one strip instead of wrapping into three full-width blocks before
  you can see a single match.
* **A solid near-white button is the loudest thing a dark page can contain.**
  `.btn-primary` is a quiet fill with a hairline of accent, and fills only on
  hover. Tracking came down from 3px to 1.5px everywhere.
* **Hints are text.** `.info-bar` and `.t-hidden-note` lost their panels; the
  latter keeps a 2px rule down its left side.

**Sizes, spacing and colour were fair game; the typefaces were not.** v60 also
moved `.t-nav-link` to the mono face in sentence case, which made the two links
the only items in that strip not set like the views beside them. v61 put the
face, the weight and the uppercasing back. If a future pass wants something
quieter, do it with size, tracking or colour — every label in a row should share
one typeface.

Two traps, both hit while doing this:

* **`box-shadow` glow reads as a box.** The tab indicator was a 2px line with an
  8px glow, which at the width of a tab looks exactly like a faint filled
  rectangle behind the label. Removed.
* **t85's hover guard is line-based.** Every `:hover` rule must have
  `@media (hover: hover)` on the same physical line — the file's existing
  one-line form. A correctly wrapped multi-line rule still fails it.

v62 carried the same rules through the other four tabs, because half an app in
one style is worse than either style applied everywhere. **t93 is the written
form of the rules** — it walks the stylesheet and fails if a set is both
hairlined and framed, if a panel regains an outline, if a row becomes a box, if
either sub-navigation turns back into a tray, or if a notice grows a box. Add a
component, and that is the checklist.

What deliberately kept its border, and why: **chips and tags** (`.award-tag`,
`.detail-pill`, `.md-tag`, `.sim-chip`, `.status-badge`, `.tournament-rank-badge`,
`.rolldown-team`, `.es-sig`) — the outline is what makes a chip a chip;
**buttons** (`.draft-btn`, `.bracket-size-btn`, `.multi-select-btn`); **meter
tracks** (`.bo-bar-wrap`, `.md-winbar`, `.sim-winbar`) — the border is the
track; **the bracket** (`.bracket-input-match`, `.bracket-adv-filled`) — a
bracket is drawn with boxes; the video frame, the logo, and the `?debug=1`
panel, which is meant to look like a warning.

### Two faces, two jobs (v63)

`--mono` (Share Tech Mono) is for **numbers, ids, clocks and short labels**.
`--body` (Rajdhani) is for **sentences a person reads**. The Jumper already
worked this way — `.rw-hint`, `.sim-caveat`, `.rw-miss` and `.rw-auto-fail` were
on the body face — and v63 finished the pattern across the other tabs, moving 26
rules. Monospace is tiring in prose, which is why a paragraph set in it reads as
shouting even at 11px.

Adding prose? Body face, and give it `line-height: 1.5` — Rajdhani sits smaller
than the mono face at the same pixel size and needs the leading.

### Digits that are compared must be tabular

Monospace digits already align, so this only matters where numbers are set in a
**proportional** face (`--display`, or inherited). Twenty such rules now carry
`font-variant-numeric: tabular-nums`. Without it `111` is narrower than `100`,
so a column of scores wobbles — and during live tracking, where they refresh
every 30 seconds, they visibly jitter.

**The trap when adding it:** a naive regex for `.foo {` also matches
`.foo.state .foo {` and `.parent .foo {`, so the declaration lands on a state
override that only sets a colour and never reaches the base rule. Check the rule
you edited is the one that sets `font-family` or `font-size`.

Screenshots are how this was checked, not guesswork: Chromium is preinstalled at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and `tests/harness.mjs`
exports `makeRouter`, so a throwaway script can serve `index.html` with the
fixtures behind `/api/proxy` and photograph any view at any width. Check a light
theme as well as a dark one; there are seven of each.

---

### The Simulator moved into the event (v66)

The Simulator asked for four team numbers, two opponents and a candidate list
before it would tell you anything — while the Tournament tab, one tab over,
already had the roster, the seeds, the whole schedule and the event's True Skill
ratings loaded for its own rank card. The tools moved to where the data is:

| was | is |
|---|---|
| Simulator ▸ Match | every unplayed match, everywhere, behind one toggle |
| Simulator ▸ Pick List | `TOURNAMENT ▸ PICK LIST`, run automatically |
| Simulator ▸ Bracket Odds | `TOURNAMENT ▸ BRACKET`, projected before elims start |
| Simulator ▸ Event Scout | the whole Simulator tab |
| typing four teams in | `PICK LIST ▸ mode: Manual match`, behind the switch |

**The switch (v67).** `tPredSwitch()` draws a real switch — a track and a knob,
`role="switch"` with `aria-checked` — and it sits in the summary row beside
SCOUT, on every view, not in the tab strip. A setting is not a place to go, and
in that strip it read as another tab. It is built from `--card2`, `--border`,
`--text-muted` and `--text`, so it inherits all fourteen themes rather than
importing a colour of its own; t94 fails if a hex literal appears in its rules.

**What it governs, and the one thing it does not.** Off means no match
predictions and no projected bracket or odds — those views have real results to
show, and the model is an *overlay* on them, so it can be taken away and
something still remains.

**The pick list is not gated** (v67 gated it, v68 took that back). That view IS
the model: projected alliances, your likely captain, your best partners. Gating
it leaves an empty screen asking to be switched on, which is a worse screen than
either state. If you add a view, the test is whether anything is left when the
switch is off — if nothing is, do not gate it.

**One prediction layer.** `tRatings()` fetches the open event's ratings;
`tPredict(R, red, blue, seed)` gives red's chance or `null` when fewer than two
of the six teams have played. `tPredClass()` picks the band so the same three
colours mean the same thing in every view. The toggle is `tShowPred`, rendered
by `tPredButton()` **into the nav strip** rather than one view's header, because
it governs all of them, and it re-renders whatever is open.

Building the ratings walks every match at the event, so the match list only does
it when the toggle is actually on.

**Two traps, both hit here.**

`R.ratings` is a Map keyed by **string** team ids — that is how they arrive from
the API — while `tournamentTeamCache` holds **numbers**. `Map.get` is
type-strict, so mixing them returns `undefined`, which reads as a rating of zero
and makes every alliance come out with an identical win probability. Everything
goes through `tRatingOf(R, id)` and `tIds(list)` now; t94 fails if the numbers
stop differing from each other.

`sim_seedOrder(n)` returns **zero-based** indices (`[0, 3, 1, 2]` for four), so
treating them as seed numbers and subtracting one walks off the front of the
array and silently drops the first pairing. The seed *label* is the index plus
one.

**Alliance projection** is how selection actually runs: captains are the highest
seeds not yet on an alliance, and each takes the strongest team still available.
`tProjectAlliances()` does that, `tModelledAlliances()` shapes it for
`sim_bracket()`, and the pick list and the bracket share both.

Deleted with the old UI, and confirmed unreferenced: `runSimulation`,
`runPickList`, `pickLoadAndRank`, `runBracket`, `bracketLoadEvent`,
`bracketReadInput`, `bracketBuildInput`, `bracketClear`, `clearSimulation`,
`simMode`, `sim_render`, `sim_runMonteCarlo`, and the `.sim-subnav` rules. The
maths the new views need — `sim_buildRatingsFromEvent`, `sim_allianceStats`,
`sim_matchupProb`, `sim_bracket`, `sim_seedOrder` — all stayed.

**Not done:** odds on a bracket whose eliminations have already started. The
real alliances would have to be reconstructed from the elim matches, and once
elims are running you can see the bracket anyway. The projected case, before
selection, is where the number changes a decision.

The harness gained `FIXTURES.playedThrough`: quals up to N played and the rest
not, which is the only state a prediction can be made in — a wholly unplayed
event rates nobody. It also suppresses the fixture's eliminations, so the
projected bracket has a state to exist in.

---

## 8. Versioning — please keep this up

`index.html` (`APP_BUILD`), `api/proxy.js` (`PROXY_BUILD`) and `sw.js`
(`CACHE_NAME`, `API_CACHE`, header comment) all carry the same release number.
`?debug=1` opens with:

```json
"build": { "app": "v19", "proxy": "v19", "serviceWorker": "vex-scout-v19" }
```

They must match. If one differs, that's the file that didn't deploy. The service
worker value is not read from the file — it's asked of the worker **actually
controlling the page** over a message channel, because an old worker can stay in
control long after a new `sw.js` deploys, which looks exactly like a fix that
didn't work.

`tests/t58.mjs` enforces agreement. **Bump all three together, or don't bump.**

This was not cosmetic. Several rounds were lost to a file that hadn't deployed,
and to a service worker serving a stale API response that made a fixed proxy
look unchanged. `sw.js` now marks `streams:`, `vimeo:` and `diag` **network
only** for that reason — they're slow by nature and useless when stale.

---

## 9. Debugging

DevTools are blocked in this app (right-click and Ctrl+Shift+I are disabled), so
diagnostics live in the page. Append `?debug=1` to any URL.

Reports: `build` (all three), `page` (URL, online, viewport, live SW version),
`server` (token count, whether `YOUTUBE_API_KEY` is set, region, commit,
`ytUnitsThisInstance`), `jumper` (the entire last auto-find response),
`apiCalls`, and `recentErrors` (last 12 failures with paths, statuses, and proxy
stack frames).

To extend it, push into `vsDebug` — it renders automatically.

Note honestly: blocking right-click stops casual poking and nothing more.
Ctrl+U, the browser menu, or fetching the URL all return the source, and it's a
single HTML file. Don't rely on it.

---

## 10. Open issues, in priority order

### A. Unreproduced 500 — **start here**

Reported at v18, no debug output captured yet. All nine proxy routes return 200
under stubs; it could not be reproduced in the sandbox.

v19 added a top-level catch: the proxy no longer returns a bare 500, and the
client now reads the error body instead of discarding it and throwing
`API error 500`.

**Next step:** reproduce it, then read `?debug=1` → `recentErrors`. It will name
the route, the message and the first stack frames. Check `ROBOTEVENTS_TOKEN` is
still set — a missing token is an explicit 500 in the existing code.

### B. Verify v18/v19 fixed the inert-matches case

The user reported auto-find succeeding while no match was jumpable — that's the
§4 segment bug, fixed but **not yet confirmed in production**.

**Next step:** open SKU `RE-V5RC-25-0816` with `?debug=1`. Confirm `build` reads
v19. Expect a day tagged "✓ 6 stream segments" and matches spread across
several videos rather than all pointing at the first. If some rows say "not in
the stream", check whether those matches really predate 17:17 UTC — that's
correct behaviour, not a bug.

### B2. Worlds and some championships are not on YouTube at all

The VEX Robotics World Championship streams on **vexworlds.tv**, e.g.
`https://www.vexworlds.tv/#/channels/jmhkmkbdwsh3fg4pfoqn`. Some other RECF-run
events do the same.

This matters more than it sounds. Several rounds went into tuning the YouTube
scorer against Worlds because the app reported "nothing on YouTube matches its
name and dates closely enough to trust" — a sentence that describes a near-miss.
It was an absence. There was never anything on YouTube to find.

As of v29 the app recognises a vexworlds.tv link (`rwParseSource` returns
`platform: 'vexworldstv'`, `kind: 'unsupported'`) and says so plainly instead of
"that doesn't look like a YouTube or Vimeo link". It cannot seek inside one.

**Deliberately not implemented further.** The site is a hash-routed app and how
it serves video has not been *observed* — the development sandbox's network
policy refuses the host (`gateway answered 403 to CONNECT`), so nothing about it
can be verified from here. Issue C below is already one integration written
against expected rather than observed markup; guessing a second would add a
second C.

**What a Network tab capture showed (Aug 2026), from request names only:**

| Request | What it tells us |
|---|---|
| `broadcasts?q=timeframe%…` | an API listing broadcasts by timeframe — the enumeration endpoint |
| `view?channel_id=…` | channel → broadcast resolution |
| `all-byteranges.m3u8`, `English.m3u8` | video is **HLS**, not an embeddable iframe |
| `webvtt?Policy=eyJTdGF0ZW…` | `eyJTdGF0ZW` decodes to `{"Statem…` — **CloudFront signed URLs**, with `Expires=` |

The signed URLs are the constraint that decides the design. They expire, and
they are issued against the viewer's own session, so there is nothing stable to
store or to point an iframe at — and the proxy could not fetch one even if it
had the URL. **An embed for VEX TV is not on the table.**

**What v31 does with that.** A vexworlds.tv link can now be anchored by hand:
`rewatchCalibrate` stores the page url (`cal.url`) and uses the channel id in
place of a video id. `rwEmbedSrc` returns `null` for it, and the player block
renders the computed position in large type with a link out, instead of a
broken iframe. `rwWatchUrl` returns the page url with **no** invented `#t=` —
the site's deep-link format for a position has not been observed, and a guessed
one would silently open at zero.

So the Jumper cannot jump inside VEX TV, but it will tell you a match is 3:12:44
in, which is most of the value against a nine-hour stream.

**Next step, to go further — needs a browser that can reach the site:** capture
the Request URL *and* Response body of `broadcasts?q=…` and `view?channel_id=…`.
The question that decides everything is whether either carries a broadcast's
**real start time**. With it, `vextv:` auto-sync is straightforward. Without it,
it can be no better than the Vimeo case in §5 — approximate, and tagged amber.
Also worth checking: whether the site's URL changes when you seek, which is what
would make a deep-link possible.

### C. Vimeo has never been tested against a live event

The player mount, clip/hash resolution and channel-page scraping are all written
against expected markup, not observed. `vimeo.com` is unreachable from the
development sandbox.

**Next step:** find an event with a Vimeo webcast, run auto-find, and check the
clip resolves with a hash. Then anchor it in `anchor-tool.html` and verify the
"implies the broadcast began" line against reality.

### D. `events.vex.com` scraping is dead in production

See §2. Worth periodically re-testing — the `tried` array in `?debug=1` shows
every URL with its status. If `direct:200` ever appears, scraping is viable
again and becomes the free primary path.

### E. Skills "VEX REGION" dropdown may under-report

`loadSubregions()` derives regions from teams *appearing on the skills
leaderboard this season*, not from an authoritative list. Early in a season most
regions are invisible. Also requires `t.region` to match the state string
exactly.

**Next step:** on the Skills tab with a state selected, run in the console:

```js
const d = await getFullSeasonSkills(
  document.getElementById('skillsSeasonSelect').value);
const tx = d.teams.filter(t => (t.region||'').trim() === 'Texas');
console.log('teams:', tx.length,
  [...new Set(tx.map(t => (t.eventRegion||'').trim()))].sort());
```

If it prints more regions than the dropdown shows, the filtering is wrong. If it
prints the same few, the API genuinely has no more and the dropdown is honest.
Compare against last season's id to rule out early-season sparsity.

### F. Cosmetic leftover

A stray `</section><!-- end #tab-scout -->` sits ~10 lines *before* `#tab-scout`
opens. Browsers drop unmatched end tags, so it's harmless and the nesting checks
out — but it's confusing to read. Left from removing Multi Scout.

---

## 11. House rules

- **Run `node tests/run-all.mjs` after every change.** Not optional.
- Prefer paraphrasing a fix in a comment over leaving it to be rediscovered. The
  comments in these files explain *why*, deliberately — most were written after
  a bug shipped twice.
- Don't remove a test to make a change pass. Several encode bugs that were
  subtle enough to reintroduce.
- When adding a diagnostic, put it behind `?debug=1` and in `vsDebug`.
- Watch for silent failures. The two worst bugs here — the negative offset and
  the unreachable YouTube search — both failed *quietly*, which is why they
  survived multiple rounds. If something can fail, make it say so.

---

## 12. Two things that cost a release each

### `border-style` is the four-sided shorthand

`.match-row.upcoming` said `border-style: dashed`, meaning "make the separator
I already have dashed". It does not mean that. It is the shorthand for all four
sides, and a side whose *width* was never declared then computes to `medium`
— 3px — in `currentColor`, which on a dark theme is white. Every unplayed match
grew a 3px white box on three sides, and the whole schedule read as a grid of
white cards. `.match-row.queue-now-row` did the same with `solid`.

`border-color` on its own is harmless: a side whose style is `none` stays 0px
however it is coloured. Only `border-style` turns sides on. Use
`border-bottom-style` (or whichever side you mean).

`t93` hunts for this sheet-wide: any rule using the bare shorthand must belong
to an element that really carries a four-sided border, checked through the
sibling classes the markup puts on it (`.bracket-bye-match` is always rendered
with `.bracket-match`, which declares one). It was verified by putting the bug
back and watching it fail.

### A percentage must say what it is a percentage of

The next-match card ran opponents → bar → your alliance, and the bar carried
nothing but `54%`. Sitting directly under the last opponent block it read as
that team's number, not the alliance's odds for the match. Reported exactly
that way: "hard to tell if it's the chance to win or the chance against that
individual team."

The card now runs **YOUR ALLIANCE → AGAINST → the bar**, and the bar carries a
sentence. The wording adapts: no partner, no "alliance". In the match list the
same number sits in an unheaded column, so the round label carries a key —
only for rounds that actually hold a prediction.

`t96` keeps the order, both labels, the wording and the key. The rule behind it:
**a number with no noun attached will be read as belonging to whatever is
nearest it on screen.**

---

## 13. The INFO tab

`trailer.html` is a standalone page at the repo root, shown in an **iframe**.
Not inline markup: the trailer's class names (`.a`, `.up`, `.left`, `.fade`…)
are short and generic, and would collide with the app's stylesheet the moment
the two shared a document.

The loading contract is the part that matters, because each third of it fails
silently:

- **It does not load until the tab is first opened.** The `<iframe>` ships with
  `data-src`, never `src`. An `src` in the markup would make every visitor
  download a video they never asked for, on venue wifi.
- **Leaving the tab pauses it.** A trailer playing behind the Tournament tab is
  a battery drain nobody can see to stop.
- **Coming back resumes it.** Re-setting `src` would restart it from zero and
  re-download it, so `infoTrailerFor()` sets `src` exactly once and thereafter
  only posts.

The page listens for `{vsTrailer: 'pause' | 'play'}` from the same origin, and
both `postMessage` calls name `location.origin` rather than `'*'`. Both are
wrapped, because a frame that has not finished loading must not be able to
break a tab switch.

The box is a padding-bottom ratio box — an iframe cannot size itself to its
content. `56.25%` is the 16:9 video and the `64px` is the trailer's own control
bar (54px) plus the 10px above it.

One wrinkle worth knowing: the `@media (min-width: 1101px)` rule pins the
height to `1100px * 0.5625`, but `.container` is `max-width: 1100px` with
`0 24px` padding, so the element never exceeds **1052px**. Past a 1101px
viewport the box is therefore about 27px taller than the video needs, and the
trailer letterboxes against its own `#050506`. Harmless, and left as specified
rather than quietly changed.

`t101` covers all of it, including that `trailer.html` **exists** — the iframe's
`src` is only as good as the file behind it, and the tab was once a merge away
from shipping without it. It also pins the trailer's own `54px` bar and `10px`
gap, because if either is restyled the app's `64px` reservation is wrong and
the video crops or floats.

The contract was driven in Chromium with the real file: 0 requests before the
tab is opened, 1 on open, `paused` on leaving, playing again on return with the
clock continuing rather than resetting, and still 1 request.

The trailer pulls its own Google Fonts URL, and it asks for **one face the rest
of the site does not use** (JetBrains Mono). No new host, so nothing broke — but
`t95`'s disclosure scan now covers `trailer.html` as well as `index.html`, and
the privacy policy no longer says "the three typefaces". The legal pages are
deliberately *not* scanned: they cite other companies' policies by URL, and the
scan cannot tell an `<a href>` a reader may follow from a `<link>` the browser
fetches on its own.

A sixth tab does not crowd the strip: `@media (max-width: 720px)` already makes
`.tabs-nav` a scroller with `flex-shrink: 0` on the buttons, so INFO scrolls
into reach on a phone exactly as SIMULATOR did, with no page overflow.

---

## 14. The v75 sweep, and how it was done

A website-wide bug hunt. Four methods, because each one had a blind spot the
others covered — which is the reusable lesson here.

### What it found

**Twelve stored-XSS holes.** Every one was an API string a team or an event can
choose, rendered into markup raw, usually on a line whose *neighbouring* field
was correctly escaped:

| where | what |
|---|---|
| Tournament ▸ Teams | the number cell |
| Tournament ▸ Matches | the alliance spans, handler argument **and** text |
| Tournament ▸ Skills | the number cell |
| Tournament ▸ Awards | the winners, plus a hand-rolled `\'` escape that never worked |
| the bracket | both alliance lists in both renderers, and the bye |
| Skills Rankings | the number and the location line |
| the awards rolldown | the doubled team and each recipient |
| Scout card / QuickScout | the team number |
| attended events | the "focused on X" hint |
| Event Scout | the city and region |
| the Jumper | the anchor it names |
| the grade badge | its `title` |

Measured in Chromium with a payload that fires rather than one that merely
looks wrong: **15 executions before, 0 after**. t91's v58 sweep covered the
Scout tab and never reached these.

**Fourteen inline-handler arguments** were escaped where they had to be
*stripped*. The rule has been in this file since v58 — the browser decodes
entities before the JS parses — but ten Jumper day keys, two event ids and two
match ids still went in raw. They all go through `teamAttr` now. `rwDayKey`
only ever emits `unknown` or `YYYY-MM-DD`, both of which `teamAttr` passes
through untouched; that was verified in a browser by comparing every handler's
argument against the live day keys, not assumed.

**Four service-worker paths that could reject.** `event.respondWith()` on a
rejected promise does not fall back — it gives the browser its own error page,
which is the screen sw.js exists to prevent. See §"the service worker" below.

**`vsAgo()` printed "NaN days ago"** on the offline button and the Jumper's
resume row whenever the stored timestamp was anything but a number.

**Two dead functions**, one of which could only ever have thrown: `setLoading`
reached for `#scoutBtn`, an id nothing has carried in a long time.

### The four methods, and what each one missed

1. **Static scan of dangling references** — found `#scoutBtn` and
   `#pickResults`, which no driven test could have found because nothing calls
   the code that uses them.
2. **A driven walk of every view in Chromium**, collecting page errors,
   unhandled rejections, overflow and rendering artefacts — found nothing on
   its own, which was worth knowing.
3. **A poisoned fixture** — found six of the twelve XSS holes. It missed the
   other six because the fixture never reached those templates: the Skills tab
   rendered no rows at all (the `legacy:` route answered `{data: []}`), and the
   Scout card was driven with an unpoisoned team.
4. **A static interpolation scan** — found the six the fixture missed.

**Neither scanning nor driving is sufficient.** A scan cannot tell a real hole
from an internal label; a drive cannot reach a template its fixture does not
populate. The fixture now returns real season-skills rows precisely so that tab
is never again invisible to a driven test.

### Keeping it

`t100` is the sweep, kept: it drives every view with every API string poisoned,
names each site that was open, and carries two blanket guards — no
API-controlled value between tags unescaped, no inline-handler argument merely
escaped. `t99` is the service worker. Both were verified by putting the bugs
back: **t100 goes red in 27 places, t99 in 11.** A test for a bug that has been
fixed is worth exactly as much as its failure on the unfixed code, so check
that before believing it.

Two older tests were **retargeted, not deleted**: `t61` read the day key's
literal source, and `t85` pulled `gradeBadge` out with `new Function` — which
broke the moment that function gained an `esc` dependency. §7 warns about
exactly that; it is now driven through the harness.

### The service worker: every branch must RESOLVE

`event.respondWith(p)` where `p` rejects does not fall back to the network and
does not reach any `catch` in the page — the browser shows its own error page.
So every branch in `sw.js` has to settle with a `Response`, including the ones
that exist because something already went wrong. Four did not:

1. **The timeout branch resolved with `cached().then(hit => hit || network)`
   and nothing else.** Cache misses, network later fails → that inner promise
   rejects, and `Promise.race` settles with whichever branch settles *first*.
   Venue wifi hangs and then drops, which is exactly that order. This is the
   one that mattered.
2. **The font branch's `.catch(() => cached)`** returned `cached` — on the only
   path that can reach it, `cached` is `undefined`, because a miss is *why* we
   were fetching. `respondWith(undefined)` fails the request outright.
3. **The static-asset branch had no failure path at all**, which now matters
   more than it did: `legal.css` is served through it.
4. **`cache.put()` rejects** on a partial or opaque response, and an unhandled
   rejection inside a worker is invisible.

`t99` loads the real `sw.js` in a `vm` with stubbed `caches`/`fetch`/`Response`
and an instant `setTimeout`, so the timeout branch is reachable at all, and
asserts that every combination **resolves**. It goes red in 11 places on the
old file.

---

## 15. The Event Scout's region

**"My region" means the VEX COMPETITION region** — `California - Region 4` —
not the state. That was the answer to a complaint the v74 diagnostics were
built to settle, and the diagnostics settled it.

The awkward part is where the data lives:

- RobotEvents records a sub-region on a **team**, as `eventRegion`, and only on
  the **legacy skills endpoint**. `loadSubregions()` has used it for a while;
  it is the official sub-region, not a guess.
- It records **nothing** on an event. `/events` can filter on `region`, and
  that `region` is a whole state or province.

So the state is the coarse filter the API can do, and the sub-region is worked
out from the teams who actually registered: **an event is placed in the
sub-region most of its roster belongs to.** Two teams is the threshold — one is
a coincidence, a team travelling or a stale registration.

This costs almost nothing. The Event Scout already fetches the season skills
standings and every candidate's roster for the strength model, so placing the
events it was going to analyse is free; only the shortlist beyond the analysis
cap (`SCAN = 60`, nearest first) is new work, and that is exactly what makes
"my region" mean Region 4 rather than all of California.

**Do not derive a sub-region from an event's name or from a state plus a
number.** t90 is what happens when that is guessed at.

Two ways there is no sub-region to narrow to, and they are different:

1. The team has no skills run this season, so nothing is recorded.
2. RobotEvents records the `eventRegion` as **just the state name with no
   number** — a shape it really does use, and one `loadSubregions()` has
   carried a note about for a long time.

Both fall back to the whole state, and the note **says which one happened**.
Claiming a sub-region was searched when it was the state would be the same
invisible-input problem v74 fixed.

`vsDebug.escout` carries the whole funnel: the team's state and sub-region,
what the API returned, what was dropped for being in another state, another
sub-region, or unplaceable, and `placed` — a tally of which sub-region each
in-state event landed in. That tally is the evidence; without it "why did that
event disappear" is unanswerable.

`t98` covers it with a California fixture split across Regions 1, 2 and 4, plus
both fallbacks.

**A note on the test drivers.** `makeRouter` takes the **full URL** and pulls
`?path=` out of it. Several Playwright drivers in this session handed it the
already-extracted path instead, which made `legacy:/seasons/.../skills` parse
with `legacy:` as a URL *scheme* — so `searchParams.get('path')` was null, the
fallback used `pathname`, and every skills request silently matched the
`/seasons` route. The standings came back empty and the Event Scout looked
broken when it was not. If a driven check shows no skills data, check that
first.

## 16. The bracket

One view, two states, and they now share a shape.

**Played bracket.** Columns of `.bracket-match` boxes with an SVG overlay;
`drawBracketConnectors()` measures the laid-out boxes and draws the elbows
between them. `padBracketByes()` reconstructs the real shape first, because a
10-alliance division only plays a few first-round matches and the rest are byes
— the connector maths assumes slots 2j and 2j+1 feed match j, so the byes have
to be in the right places or the lines are nonsense.

**Projected bracket**, for the hours before eliminations start. This used to be
a flat list of first-round pairings, which answered "who do I open against" and
left the shape of the event invisible. It is now the same tree, built by
`tProjectedBracket()` — deliberately separate from its markup so the shape can
be asserted on its own.

Three things about it that are easy to get wrong:

- **It is laid out over bracket SLOTS, not over the alliance count.** Six
  alliances play inside eight slots and seeds 1 and 2 get byes. `sim_seedOrder`
  returns ZERO-based indices, so a slot whose index is past the end of the list
  *is* one of those byes. Use the alliance count and the pairings come out
  plausible and wrong.
- **Rounds after the first are conditional.** They hold whoever the model
  favours in each preceding match. Chaining favourites is NOT "who wins the
  event" — it ignores every path where an underdog gets through — so
  `tOddsBlock` stays the authority on the champion and the key under the tree
  says as much. Do not add a "projected winner" box: it would contradict the
  odds sitting right below it.
- **Both branches must call `bracketPaint()`.** The lines can only be measured
  after layout, so they are drawn on a timeout and redrawn on resize. The
  projected branch shipped without that call and rendered as three columns
  floating apart, with the tree perfectly correct underneath.

**Predictions on a played bracket** go through `bracketPred()`, one helper for
both the single match and the best-of-3, so they cannot disagree about when a
slot shows a number. A series stops predicting the moment one game is in — the
scores are the better answer and the model should not argue with them. A 0-0
that never started is not a result: `sim_matchPlayed` knows the difference, and
without it every unplayed slot reads as a tie.

**Watching an elimination match.** The bracket is the view you open to see how
a run went, and until v73 it was the only one with no way to watch it — the
match list has had a ▶ since v40. `bracketPlayButtons()` builds them for both
renderers, so a single match and a best-of-3 cannot grow separate copies. A
best-of-3 is three separate matches with three separate moments on the stream,
so it gets one numbered button per game it actually played; a single match gets
one unnumbered button; nothing unplayed gets one. They call the same
`jumpToMatch` the match list does.

Two details worth keeping:

- Everything interpolated into those inline `onclick`s goes through `teamAttr`,
  never `esc` — §the XSS rule: the browser decodes entities *before* the JS
  parses. The event NAME is the one exception, and it uses the audited
  `esc(JSON.stringify(...))` pattern the match list already uses.
- The label strip is a flex row where `.bracket-label-text` truncates and
  `.bracket-plays` does not. Bracket columns are narrow by design, and a round
  name is recoverable from the column header above it — a missing play button
  is not. "Best of 3" became "Bo3" for the same reason: spelled out, it pushed
  the series result out to an ellipsis.

`t97` covers all of it, including the one check that would notice a tree built
over the wrong count (each round holds exactly half the slots of the one
before) and an end-to-end press of a play button that has to land on the
Jumper tab with the event and team carried over.

---

## 17. The legal pages

`privacy.html`, `terms.html` and the `legal.css` they share are the only pages
in the deploy besides `index.html`. Three things to know about them.

**The privacy policy is a requirement, not a courtesy.** The YouTube API
Services terms oblige a client to publish a privacy policy and *link* to it.
VEX Scout uses both the YouTube Data API (`api/proxy.js`) and the embedded
player (`rwEmbedUrl`), so this applies. A policy at a URL nothing links to does
not satisfy it — which is why the `.site-foot` link in `index.html` is part of
the same change and `t95` asserts it.

**A privacy policy is a claim about the code, and the code drifts.** Everything
the policy asserts, `t95` checks against the source: no analytics, no
`document.cookie`, no inlined API key, and — the one most likely to break — that
every external host `index.html` references is disclosed. Add a new third-party
host and that assertion goes red until the policy says so. That is the point.
Do not relax it; update the page.

**Two palettes, not sixteen.** The pages read `vex_theme` only to decide dark
or light, and use the neutral grey values either way. Copying all sixteen theme
blocks into `legal.css` would be sixteen more things to keep in sync with
`index.html`, for pages people read once.

Two things in these pages are the owner's decisions, not the code's: the contact
address, and the fact that they name Vercel as the host. Both need editing if
either changes.

**The foot is pinned with `position: sticky; top: 100vh`, not flex.** In normal
flow, a short page — Scout before you have searched anything — leaves the foot
hanging in the middle of an empty screen directly under the controls, where it
reads as part of the form rather than as a footnote. Sticky at a full viewport
height sinks it to the bottom instead; `body` already carries `min-height:
100vh`, which is the box it sinks into. On a long page the offset is already
behind it, so it just flows after the content and never floats over anything.

The alternative was `display: flex` on `body` with `margin-top: auto`. That
works too, and it changes the layout mode of every direct child of `body` — the
header, the container, the two hidden shim inputs — to buy the same two lines.
`t95` asserts the sticky pair and `body`'s `min-height` together, because the
pin silently stops working if either goes.

One knock-on in `sw.js`: the navigation handler's `/index.html` fallback is now
scoped with `isApp`. Without it, an uncached offline hit on `/privacy.html`
would render the entire scouting app under the URL of a legal page.

---

## 18. An event's dates are dates, not moments

Reported as "some of the dates on events are not perfectly accurate", and
**"some" was the whole clue.**

RobotEvents hands an event's `start` and `end` over as ISO 8601 carrying the
**venue's** offset:

```
"2026-10-11T00:00:00-04:00"   →  the 11th of October, in New York
```

The offset is what fixes which day the string names, so **the first ten
characters already are the answer.** What the app did instead was pass the whole
string to `new Date()` and format it with `toLocaleDateString()`, which
re-projects that instant into the **reader's** timezone. Midnight on the 11th in
New York is 9pm on the 10th in California, so an away event advertised the day
before it ran — while every local event looked right, because for those the two
zones agree.

Measured in node across five zones before the fix:

| reader | what came out wrong |
| --- | --- |
| `America/Los_Angeles` | every midnight-start event east of the Rockies, and every event the API records in plain UTC, a day early |
| `Pacific/Honolulu` | the above, plus midnight-start **California** events |
| `Asia/Tokyo` | every US event a day late |
| `America/New_York` | only the plain-UTC ones |
| `Europe/London` | none — which is why this was easy to miss |

Driven in Chromium with `timezoneId: 'America/Los_Angeles'` against a
midnight-start Connecticut event: `2/27/2026` before, `2/28/2026` after, in the
Tournament event list, the Scout filter rows and Events Attended alike.

### The rule

**Anything that answers "which day" or "how many days" works on the calendar
date. Never on the instant.** Five helpers sit beside `esc`/`teamAttr` in
`index.html`, and `evDayKey`/`evDayCount` are duplicated in `api/proxy.js`
because there is no shared module:

| helper | answers |
| --- | --- |
| `evDayKey(iso)` | the `YYYY-MM-DD` the string names, or `null` |
| `evDayDate(iso)` | that day as a local `Date` at **noon** — some zones move at midnight |
| `evTzOffMin(iso)` | the venue's offset in minutes east of UTC, `null` when the string carries none |
| `evDate(iso, opts)` | one date, formatted, with no timezone projection |
| `evDayCount(s, e)` | calendar days, both ends counted |
| `evTodayKey()` | today in the **reader's** calendar — "is this still ahead of me" is a question about your calendar, not the venue's |

`t102` guards it two ways. The driven half renders a real page in
`Pacific/Honolulu` and reads the dates back out of the DOM. The static half
asserts that **every `.toLocaleDateString(` in the script lives in one of four
functions** — `evDate`, `rwDayLabel`, `md_time` (a match's time really is a
moment on your own clock) and `vsDateReport` (which reproduces the old
rendering on purpose). A new one anywhere else is the bug coming back.

### Four other things this was also breaking

**Elapsed milliseconds cannot count days.** `dayCount` in the client and
`eventDays` in the proxy both did `Math.round((end - start) / 86400e3) + 1`. An
event running **08:00 to 21:00 on one day** is 13 hours, which rounds to a whole
day and came back as **two** — so the Jumper went shopping for a Day 2 video
that does not exist, and the proxy's targeted per-day search is 100 units a go
against §3's 10,000 a day. Both now call `evDayCount`.

**`rwDayKey` now reduces to the venue's day, not the reader's.** It buckets two
different things — a match's `scheduled`, which carries the venue's offset, and
a broadcast's `actualStartTime`, which YouTube reports in UTC. Reducing both to
the reader's day kept them agreeing *with each other*, so nothing looked wrong,
but it disagreed with `rwEventStartDay`, which is sliced straight out of the API
string and is therefore the venue's day. `rwEventDayOrdinal` compares those two,
so a mismatch asks for the wrong "Day N" video — §3's worst outcome. A
late-evening match on a US event read from Europe was also enough to split one
event day into two groups.

`rwEventTzOffMin` holds the offset, set in `rwRecordEventMeta` beside
`rwEventStartDay` and cleared in `rwResetEventState`. **It falls back to the
reader's own offset while it is null, which is exactly what the function used to
do** — so nothing moves for a reader sitting in the venue's timezone, which is
most readers most of the time. `await metaLoaded` had to move **earlier** in
`rewatchSelectEvent`, ahead of the first `rwDayKey` call: one event holding both
kinds of key would be worse than the old behaviour, which was at least
consistently one or the other. Both requests are still in flight together, so
nothing is serialised. `t102` asserts that ordering by source position.

`RW_STREAM_LOGIC` went to **`L5`** for this — it changes which day a broadcast
is matched to, so every cached answer older than it is suspect. `t86`'s pin was
retargeted.

**The manual-paste path sends the venue's day.** `rwTzSuffix()` renders the
offset so `&start=` carries `T00:00:00-05:00` rather than `T00:00:00Z`, matching
what the auto-find path sends straight off `e0.start`. It is now encoded whole,
because **a `+09:00` appended raw to a query string arrives as a space.**

**"Upcoming" in the Event Scout compares calendar days.** It used to parse the
end into a moment and allow a flat 24 hours of slack so that an event ending
this evening did not vanish at noon — but the slack also kept *yesterday's*
events on a list of events you can still go and register for.

**The Scout tab's fallback date is the first day.** Each event's date is seeded
from a match's own time until the `/events` lookup fills in the real one, and
the seed was whichever match the loop reached first. On a two-day event that was
a coin toss, so a failed lookup dated the event to day 2 about half the time. It
now keeps the earliest.

### The diagnostic

A wrong date is wrong in one of two ways and **on screen they look identical**:
the API sent a day we did not expect, or the right instant was rendered in the
wrong timezone. `?debug=1` now carries a `dates` block — `vsDateNote` records
every event's dates exactly as the API sent them, from the Jumper, the
Tournament tab, the Scout tab and the Event Scout, and `vsDateReport` prints the
raw string, the day sliced out of it, the venue's offset, the reader's zone and
offset, the day count, what is on screen now, and **what the old code would have
shown**. When those last two differ the timezone was the whole problem; when
they agree, the API sent a day we did not expect and the fix is not here.

**One correction to this section, made in v80.** `t102`'s "nobody divides
elapsed milliseconds" guard wrote the day literal by hand and **never matched
`86400e3`** — the spelling `api/proxy.js` uses — so the proxy half of it was
passing on nothing. It now matches every spelling, and exempts the one correct
construction: subtracting two days that have BOTH been pinned to the same time
of day (`+ 'T12:00:00Z'`) is how `evDayCount` and `tWhen` avoid the bug, so
flagging it would be flagging the fix. The guard self-checks that it would
still catch the original shape.

### The six test drivers this broke, and why

`t47`, `t63`, `t69`, `t73`, `t74` and `t78` all extract `rwDayKey` from source
with `new Function` and eval it — §7's anti-pattern. Giving the function one new
free variable broke all six at once, in the *driver*, not the app. Each already
pulls the declarations its slice needs out of source rather than restating them
(`grab(/const RW_PRESTART_GRACE_SEC = [^;]+;/)`), so each now also grabs `let
rwEventTzOffMin = [^;]+;`. `t74` slices between `rwDayKey` and `rwDayLabel` and
had to be re-anchored, because `rwTzSuffix` now sits between them.

### Deliberately not changed

`md_time` still formats a match's scheduled time as a moment in the reader's
zone. A match time genuinely is an instant, and at a venue your device is in the
venue's zone anyway.

**Event dates still show the start day only, not the range.** `evDayCount` and
the `dates` diagnostic both know the span, so showing `Oct 11 – 12` is a small
change — but it alters the shape of five meta lines nobody asked to have
altered, and the measured defect was the off-by-one. If it is wanted, that is a
look change to make deliberately.

---

## 19. The week before an event

Reported as: *"when the event date nears and i check it just says no matches
played and i can't see any tournament info."*

**That is the worst possible moment for this tab to be empty.** The match
schedule is set by the organiser and usually does not appear until the day
before or the morning of, so for the whole week you are actually deciding
things — who to scout, what you are walking into — every view was a dead end.

Measured against a realistic pre-event fixture, before the fix:

| view | what it rendered |
| --- | --- |
| the one you land on | 209 chars — *"No matches found for 66449A at this event."* |
| ▸ Matches | 203 chars — *"No match schedule posted for this event yet."* |
| ▸ Skills | 204 chars |
| ▸ Awards | 172 chars |
| ▸ Bracket | 246 chars |
| ▸ Pick List | 215 chars |
| ▸ Teams | 481 chars — a list with every column a dash |

Six of seven views, one grey line each.

### What there IS to say

RobotEvents has plenty before an event: **who registered**, **where they stand
on the world skills board**, and **how they have played at their other events
this season.** That last one is the model the Event Scout already ranks twenty
fields with — pointed at one event instead.

`tPreviewRender` builds the panel, shown on the two views that were dead ends
(the focused-team view and the all-matches view):

- **When** — `tWhen` places the event relative to today in the venue's calendar
  (§18): *Starts in 6 days* / *Starts tomorrow* / *Running now — day 2 of 2* /
  *Ended 3 days ago*, with the dates and the day count.
- **Where** — city, region, venue.
- **Who** — teams registered and the HS/MS split.
- **Where you land** — `~#4 / 16`.
- **The field** — every scanned team ranked by season True Skill, clickable
  through to Scout, with its world skills rank and grade.
- **Why the page is not full of matches** — one sentence naming the organiser
  as the one who posts the schedule, and saying the page fills in by itself.

The panel is named for where the event actually is — **Before the event** /
**The event is on** / **After the event** — and the sentence changes with it.
"Before the event" over a heading that reads *Ended 4 days ago* is the panel
contradicting itself, and telling someone standing at the venue that the
schedule "usually appears the day before" is advice about a day that has
already passed.

### The two numbers that needed care

**The scan is capped at `T_PREVIEW_SCAN` (16)**, taken off the top of the world
skills board, plus your own team wherever it sits. A field's character is set
by its top end; rating all 800 teams at Worlds would be a season of matches
each. The caveat says which teams were scanned and out of how many, so the
cap is never silent.

**The strength line is said as an average.** It is the mean True Skill of the
strongest eight — the same quantity the Event Scout calls "top-field TS". Under
that name, printed beside your own rating, it reads like a ceiling you are
somehow over. It now says *"The strongest 8 average 31 True Skill, and 66449A
rates 42."*

### Three things found on the way

**`renderEventTeamMatchesView` never set `tournamentView`.** Arriving at an
event through your own team — the common path, and the one `loadTournamentTeams`
takes — left the global on `'teams'` while the match view was on screen. The
live tick dispatches on that global, so **every 30 seconds at a running event
it rebuilt the whole TEAM LIST over the top of the match view you were
reading.** `tournamentFocusOn`, reached by clicking a team number in the match
list, had the same hole. One line fixes both.

**`sim_buildRatingsFromTeams` was split, not copied.** Its second half is now
`sim_buildRatingsFromIds`. Resolving a team number costs a request each, and a
caller holding ids already — an event's roster — has no business buying them
back. `t103` asserts the match-walking loop exists exactly once.

**An event that ran and posted nothing reaches the same empty shape from the
other side of the date.** Telling someone to "check back" for an event that
finished last week is wrong, so the past branch says the organiser did not
upload results instead.

**"No matches" is two different nothings.** `allMatches` holds every match at
the event once the ratings are built, so a non-empty one with an empty
`myMatches` means the schedule IS up and this team is not on it — withdrawn, a
late scratch, or a division not yet published. That person gets told exactly
that, with a button through to the full match list, rather than the preview.

### Cost

The panel runs **only when there are no matches** — `t103` asserts that a
played event buys no season match data at all. When it does run it is: the
roster (memoed per event), the season skills board (cached, and the Teams view
wants it anyway), and one `sim_teamMatchesCached` per scanned team. All of them
RobotEvents, none of them YouTube, so §3's quota is untouched.

### The fixture

`FIXTURES.scheduleUnposted = <event id>` puts one event in the pre-event state:
every per-event endpoint — matches, rankings, skills, awards, and a team's
matches filtered to that event — answers empty, while the roster and the season
board stay full. `FIXTURES.wideRoster = <n>` adds a field wide enough to rank,
each team with a season of matches at an event of its own, scored so True Skill
has a real order to find.

---

## 21. v81 — speed, phones, favorites, form

Asked for as: *"help improve speed … team lookup, event pages, Jumper video
finding"*, *"more mobile compatibility"* (iPhone), favorites, and trend and
consistency for alliance picks. Each was **measured first**; the numbers are
here so the next pass has something to compare against.

### Round trips

Measured in Chromium with a fixed 300ms on every `/api/proxy` request, so
elapsed ÷ 300 is how many requests ran **end to end** — which on venue wifi is
the whole cost (§"Round trips").

| walk | v80 | v81 |
| --- | --- | --- |
| Scout a team, first time | 3 deep | 2 deep |
| Scout the same team again | 3 deep, 6 requests | **0 requests** |
| Tournament: search a team number | 2 deep | 1 (0 once the number is known) |
| Tournament: open the event from that list | 3 deep | 1 deep |
| ▸ Teams | 2 deep | 1 deep |
| ▸ Skills | 2 deep | 1 deep |
| Jumper: find a team's events | 2 deep | 0 after any lookup of that team |
| Jumper: select the event | 3 deep | 2 deep (matches, then the stream search) |

Three things did it, all beside `apiGet`:

- **`apiFresh`** — answers kept in memory briefly, and shared while in flight.
  Only for paths that do not move while you watch (`API_FRESH_RULES`), and
  every lifetime is **at or under the proxy's own `ttlFor`** for that path, so
  nothing is staler than it already could be. **An event's matches and rankings
  are deliberately absent** — the Tournament memo owns the live half, and a
  refresh has to be able to refetch. Do not add them. A failed request is
  dropped, not remembered. Answers are handed out as a **copy of the array**,
  because callers sort what they are given.
- **`vex_team_ids`** — a team number resolved to its record, kept in
  localStorage for three days (80 teams, oldest out). Every walk in the app
  starts by turning `66449A` into an id; that was a full round trip before
  anything useful could begin. Only the exact one-number, one-programme lookup
  is remembered. The privacy page says so — t95's rule.
- **`vsKnownEvents`** — any FULL event record seen in a list (it must carry a
  SKU, a start and divisions; the stub nested in a match does not count).
  `tEventDetail` and `rwEventDetail` both read through `vsEventRecord`, so
  opening an event you just picked from a list does not ask for the record you
  were just handed.

The rest was ordering: the season skills board now starts **with** the team
lookup instead of after it; a team's events ride with its matches instead of
being asked for by id afterwards; rankings are requested before the ratings
are awaited; the Teams view warms both skills boards and the rankings while the
roster loads; the Jumper asks for every division's matches alongside the
team's own.

`vsOfflineSave` goes around all of it (`apiGetLive`) — a save exists to make
requests.

**Not done, and why:** the Jumper's stream search still starts after the
matches land. It is gated on which days still need an anchor, which is what
keeps §3's quota alive, and the days come from the matches. Starting it early
would mean spending 101 units before knowing whether anything is missing.

### Phones

Measured at 390px before: **155 rules** set text at 11px or under (several at 7
and 8); tab buttons were 27px tall and scrolled off the right edge; the event
sub-navigation was 709px wide; a team number in a match row was a 12px-tall
target; and the search form filled the first screen, so a team's rank began
640px down the page.

One block at the end of the stylesheet, inside one `max-width: 720px` query, so
**a desktop window is untouched**:

- **The tabs are a bar fixed to the bottom**, seven across, with an icon and a
  short label (`data-short`, drawn by `::after`; the button's own text is
  unchanged, which is what t101 and the screen readers see). The icon comes
  AFTER the label in the markup and is ordered first by the stylesheet, because
  t101 matches `onclick="switchTab('info')">INFO<`.
- **The search form folds away once it has answered.** `vsPhoneForms()` watches
  each tab's results panel with a `MutationObserver` and marks the section
  `has-results`; the stylesheet then hides the form behind one row
  (`.phone-find`) that says what was searched. Watching the panels, rather than
  hooking every function that fills one, means a new view needs nothing added.
  A new TAB does: add it to `VS_PHONE_PANELS`.
- **Nothing is under 11px.** The three long selector lists were generated from
  the sheet — every rule that resolved under 12px at this width, lifted one
  step. Add a small label and it needs adding there; t104 fails if the phone
  block itself sets anything smaller (the bar's 10px label is the one
  exemption). The bracket was left alone: it is a diagram that scrolls, and
  its arithmetic is tight.
- **44px targets**, and the team numbers in a match row get theirs by padding
  taken straight back as negative margin, so nothing moves.
- **The event's views are a 4-column grid**, all on screen.
- **Rank and record sit side by side.**
- **Smoothness:** `body::after` — a full-screen fixed scanline layer ABOVE the
  content — is off on phones, the gradient layer scrolls with the page instead
  of being fixed, list rows do not animate in, and long lists use
  `content-visibility: auto`.

§"Chrome" still holds: no typeface changes. t104 asserts it.

jsdom has no layout (§7), so the layout half of this was checked in Chromium at
390px, every view: 0 elements past the right edge, against 2–6 per view before.

### Favorites

Reported as: *"I have to go through a hassle of steps to even get to my team
match schedule."* Counted: seven actions and two waits.

`vex_favs` is a list of team numbers. The **FAVS** tab (first in the bar) shows
a card per team — name, the event that matters right now, when it is, rank and
record if it has started — and four buttons: **SCHEDULE** (the team's page at
that event), **STATS** (Scout), **EVENTS** (the season, each one tap from its
page), **WATCH** (Jumper). A ☆ beside a team's number in Scout and on its event
page adds or removes it.

- **"The event that matters"** is `favPickEvent`: the one running, else the
  next one coming, else the last one played — on calendar days, through
  `tWhen` (§18).
- **Phones only, on purpose** — asked for that way. The tab button and every
  star are `display: none` above 720px, and `favs` is not in the list of tabs
  the boot will restore. On a phone **with favorites saved**, it is the opening
  screen; with none, the last tab still wins.
- **A favorite is a stored string that reaches inline handlers.** `vsFavs()`
  narrows every value with `teamAttr` on the way OUT as well as in, because
  storage can be edited by hand. t104 boots with a poisoned list.
- `favsRender()` does nothing unless the tab is on screen, so a star tapped in
  Scout does not send a hidden list off to refetch every team's rank.

There is deliberately **no default team** — that was the answer when asked.

### Form at an event (IDEAS §26, §27)

`TOURNAMENT ▸ PICK LIST` ends with a table: each ranked team's qualification
scores as a line, its usual range, and two tags.

- **Trend** — least squares over match order; the fitted rise from first match
  to last as a share of the mean (`T_FORM_DRIFT`, 15%). It uses every match,
  so one bad game does not make a team "fading". Under `T_FORM_MIN` (4) scored
  matches nothing is claimed.
- **Floor / ceiling** — the 25th to 75th percentile, and a tag from the spread:
  a tight band is a floor pick, a wide one a ceiling pick.

**These are ALLIANCE scores**, and the caveat under the table says so. The API
does not publish what one robot scored (IDEAS, "what it does not give"), so
partners move every number. Do not reword any of it as a robot's own output.
No request is made for it: it reads `R.matches`, which the ratings loaded.

---

## 22. v82 — softer, and "imagine you were at a tournament"

### The look

Asked for as: *"I don't like how big the theme box is … how blocky everything
is — can it have a softer tone"*, then *fewer boxes and borders*, *rounded
corners*, on phone and computer both, and: *"research what vibe coded apps look
like … then check what good websites look like … and copy."*

What the reading agreed on (sources at the end of this section), as rules:

- **The tell is sameness, not any one style.** One radius, one outline and one
  shadow on every element is what reads as generated. So the radius is a
  **scale** — `--r-sm / --r-md / --r-lg / --r-pill`, by how much a thing holds:
  a chip, a control, a panel — and never one number. t105 asserts more than one
  step is in use.
- **Fewer borders.** Separate with spacing and a different surface; keep a line
  only where it says something. On a dark page depth is a *lighter surface*,
  not a shadow. So controls are filled surfaces with a transparent outline, and
  the outline comes back for **state**: the focused input, the active size.
- **Effects that carry no information go.** The scanline layer (`body::after`)
  is off at every width now, not only on phones.
- **Template chrome was not added**: no gradients, no glass, no new typeface
  (§"Chrome" still holds; t105 asserts the block sets no `font-family`), no
  entrance animations. The all-caps tracked labels that already exist were
  left — changing them is a typography decision nobody asked for yet.

All of it is one block, `SOFTER (v82)`, late in the sheet so it overrides by
order. **The bracket's boxes are rounded but otherwise untouched.**

**The theme control is a dot** — 32px, 36px on phones — with an `aria-label`,
since it no longer has a word in it.

**The top of an event page on a phone** lost three rows: REFRESH is hidden
(pull does it), and SAVE OFFLINE and the RobotEvents link fold behind a
**More** cell that completes the 4×2 grid of views. On a wide screen there is
room, so nothing moved.

### At the event

- **Suggestions while typing** (`vsSuggestInit`). From the third digit, under
  every team box. RobotEvents has no starts-with search — `number[]` is exact —
  but a V5RC number is digits and ONE letter, so everything that can follow
  `3050` is 26 names, and `number[]` takes a list: **one request**. Teams the
  device already knows (favorites, `vex_team_ids`, the open roster) also match
  on longer numbers, so `664` finds `66449A`. A chip fills the box and runs the
  search; in a comma list it completes the last entry and waits. V5RC only.
- **Live alliance selection** (`tLivePickBlock`). The partner list on PICK LIST
  has a **Taken** button per team; taken teams drop out, the best one still
  available is always the top row, and there is an undo and a Clear all.
  `vex_taken` is per event in localStorage, narrowed with `teamAttr` on the way
  out like `vex_favs`. The privacy page says so.
- **An opponent's last match** (`tLastMatchButtons`), on the next-match card
  above the win chance: one tap into the Jumper at that team's most recent
  played match here. Read from `R.matches`; no request.
- **Swipe between an event's views** (`tSwipeInit`). Phones. Mostly-sideways
  only, no wrap at the ends, and never from inside something that scrolls
  sideways itself (the bracket) or a control.
- **Pull to refresh** (`vsPullToRefresh` → `vsRefreshCurrent`). Drops
  `apiFresh` first, or the pull would be answered from memory. The browser's
  own pull-to-reload is held off with `overscroll-behavior-y: contain`, on
  phones only. The pill is the FIRST child of the body — t95 requires the foot
  to be the last.
- **A favorite's event saves itself** (`vsAutoOffline`). When the Favorites
  card for a team fills in, its event is saved if it is running, starts within
  three days, or ended yesterday, and the copy is stale (20 minutes at a
  running event, 6 hours otherwise). Never on Save-Data, never offline, at
  most three per visit, one at a time, never over a save somebody pressed the
  button for. The requests are `vsOfflineFetchAll`, shared with the button so
  the two cannot save different things. RobotEvents only — §3's quota is
  untouched.

**Checked in Chromium at 390px and 1280px. Not checked on a real iPhone**:
the swipe, the pull, and Safari's own edge gestures are the things to try.

Sources read for the look:
[Fountain Institute](https://www.thefountaininstitute.com/blog/signs-vibe-coded-ui) ·
[Utsubo](https://www.utsubo.com/blog/built-with-ai-trust-signals-2026) ·
[925 Studios](https://www.925studios.co/blog/ai-slop-design-tells) ·
[Capital & Compute](https://capitalandcompute.net/blog/fix-ai-slop-design/) ·
[Spot the slop](https://world.hey.com/kostac/spot-the-slop-a-ui-designer-s-guide-to-fixing-ai-defaults-4c448c9c) ·
[CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same) ·
[Refactoring UI notes](https://alexanderweichart.de/5_Archive/3_Resources/Library/Refactoring-UI/Refactoring-UI-design-principles) ·
[Atmos, dark mode](https://atmos.style/blog/dark-mode-ui-best-practices) ·
[Apple HIG, toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)

---

## 23. v83 — Settings, the computer, and a Jumper that can be corrected

### Settings, my team, the badge

- **A Settings tab.** My team, the colour themes (moved out of the header —
  `#themeDropdown` is now a grid on that tab, same ids, same `applyTheme`), and
  About. On a phone Settings takes Info's cell in the bar, so the bar stays
  seven wide; Info is one tap from Settings.
- **My team** (`vex_my_team`). It fills team boxes that are EMPTY at boot, sits
  first on Favorites starred or not (`vsFavList`), and is one click from the
  rail on a computer. Narrowed with `teamAttr` on the way out. No default.
- **The badge** is the version and `Live` / `Offline` (`setBadge`). It was
  "CONNECTED".

### Suggestions: any team, and whether it still competes

- "Automatic, not just for match day": `vsSuggestSeasonTeams` reads the season
  skills boards the app already keeps, so `305` finds `3050X` with no event
  open and nothing looked up. Bounded at 2.5s so a slow board cannot hold up
  the letters.
- **Active / Inactive** on each chip, from RobotEvents' `registered` flag (or
  presence on this season's skills board). Inactive letters sort last.

### The Jumper

Reported as: *"a way to shift the time forward if it's off by a few minutes —
that current feature doesn't work."* It did not, on the days that matter:

- on a **multi-segment day** each match resolves to a segment with a synthetic
  anchor (§4), so the anchors the buttons edited were never read;
- an anchor at 0:00 is clamped, so "earlier" was swallowed;
- a re-sync replaced the anchors and the shift with them.

**The shift is now its own number per day** (`ctx.shift`, `vex_rw_shift`),
applied in `rwOffsetFor` AFTER `rwOffsetRaw` has worked the position out. It
cannot be skipped by a path that resolves the video differently. The bar is six
buttons (±10s, ±1 min, ±5 min), a "Moved 1:10 later" readout and Undo. RESET
clears it with the stream. **Do not go back to editing anchors.**

**Late-running events** (`rwApplySlip`). A match with only a scheduled time was
the least accurate jump. It now borrows the slip (started − scheduled) of the
nearest match in the schedule that has both, same day, within 90 minutes. It
stays `exact: false` and the `~` tooltip says it is an estimate.

**Not changed: how a stream is FOUND** (§3). That needs a real event where it
failed — the name or SKU — because every rule in "Matching a video to an
event" came from one, and loosening them blind risks the worse failure: the
wrong video, silently.

### Rows line up

Five screenshots of the search rows showed labels, fields and buttons on
slightly different lines. Every control in a `.controls-row` is now 46px and
sits on the row's bottom edge; labels are in flow above their own field (t43's
mechanism, kept). Measured in Chromium: one height, one bottom edge and one
label line per row, on every tab.

### The computer (≥ 900px)

Asked for as a revamp "following how to not make a website look like AI". The
old desktop was a centred column under a logo-and-tagline header, tracked
ALL-CAPS tabs, and a tiny tracked mono label over everything.

- **A rail on the left**: name, tabs as a plain list with icons, my team, the
  version. Dimmer than the page.
- **The page is left-aligned and starts with its own name** as a 30px heading
  (`.section-label`). Field labels are sentence case in the reading face.
- No tagline, no gradient wash, nothing under 12px.
- Sentence case is done in CSS (`lowercase` + `::first-letter`), because the
  markup's capitals are matched by tests. That lowercases everything, so a
  label containing an initialism carries `.keep-case` (VEX, SKU) and the
  event's team view button is excluded.

**§"Chrome" said the typefaces were not fair game. This pass changed which of
the three a LABEL uses on a computer** (mono → body), because the owner asked
for the revamp. The three families are unchanged, and t106 asserts no fourth
appears. Buttons stay uppercase Oswald on purpose.

More sources read for this pass:
[Impeccable, anti-patterns](https://www.mintlify.com/pbakaus/impeccable/concepts/anti-patterns) ·
[Linear, behind the design refresh](https://linear.app/blog/behind-the-latest-design-refresh) ·
[Carbon, writing style](https://carbondesignsystem.com/guidelines/content/writing-style) ·
[DEV, breaking the AI-generated UI curse](https://dev.to/a_shokn/how-to-break-the-ai-generated-ui-curse-your-guide-to-authentic-professional-design-2en)

---

## 24. v84 — AP in the rating

Asked for as: *"include AP into weighing a team's capability."*

`sim_applyAP` runs at the end of `sim_buildRatingsFromEventUncached`. It reads
the AP column of the division rankings (requested alongside the matches, so no
extra wait) and nudges each team's rating by its **AP per qualification match
relative to the rest of the event**: a z-score capped at ±2, shrunk for teams
with few matches, worth at most `SIM_AP_WEIGHT` (15%) of the spread between
ratings.

- **Why a nudge and not more:** the autonomous bonus is already inside the
  alliance score the rating is built from. AP separates similar teams; it is
  not a second vote.
- **AP is an alliance result** credited to both teams. The pick list caveat
  says what the adjustment is. Do not word it as one robot's autonomous.
- **The spread (`stdByTeam`) is measured before the adjustment** — residuals
  are about scores.
- An event with no AP in its rankings, fewer than four ranked teams, or every
  team on the same AP changes nothing. `R.apUsed` says how many were adjusted.
- It is relative, so it does not need to know what a game's AP is worth.

Shown as "AP 4.0 a match" beside TS on the next-match card and on each row of
the live pick list.

---

## 25. v85 — move up, the season line, My team, play all

- **What you need to move up** (`tClimb`, `tClimbNote`) — on a team's event
  page while it has qualification matches left, and on the My team page at a
  running event. Rankings sort WP, AP, SP; a win is 2 WP. It compares your
  record after ONE more win with everyone else's **as it stands**, and the
  sentence says so, because the teams around you have matches left too (§12).
  The autonomous win point is deliberately not counted. Rankings with no `wp`
  column say nothing.
- **Season so far** (`seasonChart`) — one line, one axis: qualification win
  rate at each event, in date order. Win rate and not rank, because rank
  depends on how many teams came. Only the two ends are labelled; each dot has
  a `<title>` with the event, record and rank; the events are listed under it,
  which is the table view. Fewer than two events draws nothing. The classes are
  `ssn-*` — t88 guards the old `sc-*` names of a chart that was removed.
- **My team** (`homeRender`, tab `home`) — computers only (`.tab-desk-only`),
  and where the app opens on a computer with a team set. Event, rank and
  record, the climb note, season record and skills, the season line, and the
  ways in. Phones keep Favorites, which shows the same team first.
- **Play all my matches** (`rwPlayAllStart`) — the embed is a plain iframe, so
  the page cannot hear a video end: each match gets `RW_PLAYALL_SEC` (180s)
  and then the next opens. The timer checks the event and match are still the
  ones it was armed for; the countdown edits its own text and never
  re-renders, which would reload the video. ‹ and › keep it going.

---

## 26. v86 — a speed pass, measured first

Asked for as: *"just try to speed things up where you can and optimize it."*

**What was measured, and found already fine** — so nobody repeats it:
with the network free and the CPU throttled 4×, every view at a 40-team event
rendered in under 150ms with at most one long task. The page is 719KB raw,
about 200KB gzipped. Fonts load without blocking. The proxy already sets
`s-maxage`. There was no rendering or parsing problem to fix.

**What was left was waiting on requests**, in two places:

- **`vex_snap` — last time's answer, at once.** A Favorites card and the My
  team page showed "Loading…" for three requests. They now paint the name,
  event and rank they showed last time immediately, marked "as of 5 min ago",
  and the fresh answer replaces it. If the refresh fails, the old answer
  stays — in a gym with no signal that beats a spinner. A remembered rank is
  only shown for the event it was for (`rankEv`). Everything is escaped on the
  way out; t109 boots with a poisoned snapshot.
- **`apiWarm` — asking ahead of the tap.** The first Favorites card's event,
  and My team's, is the likeliest next page, so its matches and rankings are
  requested when the card draws (on idle). `apiGet` answers the tap from that
  request. **This is not a cache of the live half**: each answer is used once
  and is discarded after a minute, one event at a time. `API_FRESH_RULES`
  still must not contain matches or rankings.
- The Jumper preconnects to the video host when its tab opens.

Measured with 300ms per request, phone width, a team's card then SCHEDULE:

| | v85 | v86 |
| --- | --- | --- |
| rank on the card, first visit | 546ms | 553ms |
| rank on the card, later visits | 546ms | **25ms** |
| SCHEDULE tap → the page | 400ms, 4 requests | **90ms, 0 requests** |

**Not done:** minifying `index.html` (comments are a large share of it) would
cut the download, but there is no build step and adding one changes how this
deploys. Worth doing only deliberately.

---

## 27. v87 — comparing teams, and all of a team's matches

- **Compare teams** (`tCompareBlock`) — on `TOURNAMENT ▸ PICK LIST`. Type team
  numbers (several at once is fine; the box offers the event's roster) and up
  to four sit side by side: seed, record, rating, AP a match, usual low and
  high score, trend, world skills rank, and — with a team in focus — the win
  chance of pairing with you. The focused team leads the table without using
  one of the four slots. One metric per row, because the question is always
  "which is better at this". The best value in a row gets a ● and weight,
  never colour alone; ties are all marked; a row where everything is equal
  marks nothing. `null` is "no data"; `undefined` is "does not apply to this
  column" (your own win chance with yourself) and draws an empty cell.
  The list is per event and in memory only — nothing is stored.
  Only teams AT the event can be added: every number in the table comes from
  this event's matches.
  **v88:** every column header is two lines (the number, then "you" or
  Remove). A ✕ beside the number had pushed that number off the line the
  others sat on and off its own column of values. Measured: one top edge for
  all numbers, and each number's right edge equals its column's.
- **All matches** (`rwAllMatchesBlock`) — in the Jumper, after picking a
  team's event. Reported as: "I want it to show all the matches they played."
  They were on the page, but split under each day's stream box, and on a phone
  the day lists hide the teams and the score. This is one list, first on the
  page, in the order played: partner, opponents, score (this team's alliance
  first), the record, and ▶ Watch on every match that has video. The day lists
  under it are unchanged — they are where a stream is set.
  **A match posted as 0–0 with no start time is "not played"**, not a tie.

---

## 28. v89 — what the app learns from results

Asked for as "machine learning to implement". Two small models (a third, play-style groups, was removed in v90), each fitted
in the browser to the event in front of you, each saying on the page what it
did and on how much evidence. No library, no server, no stored model.

- **Self-checking win chances** (`sim_backtest`, `sim_calFit`, `sim_calApply`).
  A walk-forward backtest over the qualification matches already played: for
  each, ratings are refit from the matches BEFORE it (every fourth match), the
  match is predicted, and the call is compared with the result. One parameter
  is fitted by least log-loss, `p' = sigmoid(k · logit(p))`, and shrunk toward
  1 by `n / (n + 30)`. Under `SIM_CAL_MIN` (20) predictions nothing is
  corrected. `sim_matchupProb` is now a wrapper that applies `simCalK`;
  `sim_matchupProbRaw` is the simulator. **Only the backtest may call Raw** —
  checking the corrected number against results is marking its own work.
  `simCalK` is set in `sim_buildRatingsFromEvent` (cached path too), so it
  always belongs to the event whose ratings are in use. `R.cal = {n, hits, k}`.
- **The season, carried in** (`sim_seasonRecords`, `sim_applySeason`). One
  `/teams/{id}/rankings` request per team, kept six hours (`vex_season_rec`,
  capped at 400 teams, listed in `privacy.html`), this event excluded. What a
  season win rate is worth in points HERE is fitted by least squares on teams
  with 3+ matches at this event (needs 8); a slope that is not positive means
  the season teaches nothing and is ignored. Ratings blend as
  `(n·event + K·season) / (n + K)`, `SIM_SEASON_K = 2`. Before any match is
  played there is no scale to fit, so a nominal one is used and the page says
  "Season form only". The fetch is raced against 1.5 s (3 s when nothing is
  played): late answers are skipped now and cached for the next build. Fields
  over 120 teams are not fetched. `R.prior` holds each team's season rating;
  the next-match gate counts a team with a prior as rated.
- **Play-style groups — removed in v90.** v89 grouped teams by k-means into
  named cards on the pick list. The user asked for them to be taken out the
  same day. Do not add them back unasked.
- `sim_learnNote(R)` writes the plain-words line above the pick list.
- **Not verified against live data.** The tests use a synthetic field with
  known strengths. Whether k lands near 1 at real events is unknown.

---

## 29. v91 — the robot tracker (stage 1), and the top tabs back

**The computer layout.** v83's left rail was removed on request ("i liked the
tabs on the top and former design more"). The wide-screen CSS block is now a
few lines: it only places the My team tab and link. Do not bring the rail back
unasked.

**Wide screens.** With the rail gone, a 1920 monitor showed the phone layout
in a fixed 1100px column: 9px labels, a Taken button 900px from its team, an
uneven event toolbar. Reported as "the wider pc dynamic makes the current ui
you share with mobile weird". The reading (large-screen layout guides,
Refactoring UI's spacing and hierarchy rules, line-length research) came to:
size a control to its content, stop running text near 75 characters, keep
related things together, nothing under 12px, and spend a big screen on size
rather than margins. In the `WIDE SCREENS (v91)` block: the column is 1240px
from 1100px up; notes and lists have a maximum width; the event toolbar is one
44px line; the under-12px list is back; and from 1700px the whole page is
enlarged with `zoom` (1.18, then 1.45, then 1.9), so nothing needs re-laying
out. `positionTabIndicator` uses `offsetLeft`/`offsetWidth` because screen
rectangles are scaled by the zoom.

**The robot tracker.** The owner has a 12,000-line desktop tracker (Python,
OpenCV, a trained one-class YOLO robot finder) and asked for it inside the
site, watching the embedded player unattended, with results shared.

- A page cannot read a YouTube frame. The only route is `getDisplayMedia` on
  this tab plus Region Capture (`CropTarget`, `track.cropTo`) to the player
  element. Desktop Chromium only, one permission click per run. `vtSupported()`.
- The finder is the desktop app's own model, `models/robot_detector.onnx`
  (input 1×3×640×640, output 1×5×8400: cx, cy, w, h, score), run by ONNX
  Runtime Web vendored in `vendor/ort/` (1.31.1, wasm, one thread, in a
  worker). **Threads need cross-origin isolation, which would break the
  YouTube embed — leave `numThreads = 1`.** Both load only on Start. Output
  was compared with Python onnxruntime on the same input: identical.
- **Stage 1 stores evidence, not conclusions**: per match, every robot box a
  few times a second with its alliance colour (`vtPackFrame`: integers,
  640-wide coordinates). Jobs, parking and autonomous (stage 2) will be
  computed from stored boxes, so no match is watched twice.
- The run (`vtStart` → `vtWatch`): its own `YT.Player` at 2×, muted, from 5 s
  before the Jumper's position for 170 s. A worker-driven ticker (page timers
  slow to 1/s in a background tab). Wake lock held. Matches already tracked on
  this device or in shared storage are skipped, so stopping loses nothing. A
  match with under 30 frames containing a robot is recorded as "empty" and not
  saved.
- The queue is the Jumper's own (`vtQueueFrom` over `rwPlayOrder`): a team's
  matches when a team is loaded, the whole event otherwise. `Track robots` on
  an event page opens the Jumper on that event. YouTube only; practice skipped.
- The panel is `#vtPanel`, OUTSIDE `#rwResults`, because `rewatchRender`
  replaces that element's contents and would destroy a running player.
- **Shared storage** — `api/tracker.js`, Upstash Redis over REST
  (`KV_REST_API_URL`/`KV_REST_API_TOKEN`). Reads are public; writes need
  `TRACKER_PASSCODE` (compared as SHA-256 digests in constant time, 400 ms
  penalty on a miss, minimum 8 characters). `validRec` refuses anything that
  is not the known shape. The passcode is kept in `vex_tracker_pass`. The
  service worker never caches `/api/tracker`, `/vendor/` or `/models/`.
- **NOT VERIFIED:** the capture itself. No YouTube from the build sandbox, so
  the share prompt, the crop, playback at 2× in a hidden tab and the finder's
  accuracy on real streams have never been run. The first real run is the test.

**v92.**
- The whole-page enlargement was "way too big". It now starts at 2400px (1.12)
  and 3200px (1.4); the column is 1180px. Do not scale more than this unasked.
- The tracker watches up to four matches at once (`vtParallel`: half the
  cores, at most `VT_MAX_PARALLEL`). One capture of a grid of players; each
  player's tile is cut out of the captured frame by fractions of the stage. One
  finder worker per player (`vendor/vt-worker.js`), each with its own model
  copy. The per-match window is 150 s with a 3 s lead.
- `vtStart('history')`: for an event that has not been played, every earlier
  event this season that its teams attended (`vtHistoryPlan`, most teams
  first), and only the matches those teams were in. The Jumper is driven one
  event at a time to get video positions (`vtFeedHistory`), which changes
  `window._rwCtx` and the Jumper's page while it runs.
- Every example team number shown is 66449A.
- Still not run on real video.

**v93.** Reported: Track robots on an event that has not happened "only tries
to track the event". A schedule (and often a stream) is posted before an
event, so unplayed matches had video "positions". `vtQueueFrom` now takes only
played matches (`vtPlayed`); with none, the panel's one primary button is
"Track these teams' earlier matches". The history run says how many teams and
earlier events it found, waits up to 45 s per event for its video, and ends
with a reason when there is nothing to do.

**v94 — event codes are not always RE-.** A screenshot showed Track robots
answering: No events matching "VE-V5-26-65786". Events created since VEX took
them over have codes beginning VE-. Four places tested "starts with RE-"
(`reEventUrl`, the Tournament search, `sim_resolveEvent`, the proxy's streams
route); all now accept any two letters (`VS_SKU_RE`). `vtOpenEvent` takes the
event's ID and loads the Jumper directly instead of searching for the code.
**Never identify an event by the shape of its code when its ID is in hand.**

**v95 — one click.** `vtAuto(eventId)` is what Track robots calls: the share
prompt is requested first (it must come from the click), the event is opened
in the Jumper meanwhile, and the mode is chosen without asking — this event's
matches if any are played and have video, else its teams' earlier matches. A
run now shows a Stop tracking button, a progress bar, time running and a rough
time left, and puts progress and "Tracking finished" in the tab title.

**v96.** Reported "embeds are black" during an earlier-matches run. The
players are black until a match with video is queued, and the feeder waited 45
s per event after `rewatchSelectEvent` — which only resolves once stream
finding and day sync are over, so the wait could never help. The wait is gone;
an event with no stream is skipped at once and named in the summary. The
status line gives the phase per event, the sub-line counts events with and
without video, and an idle player says "Waiting for a match with video".
**How many earlier events have a stream the Jumper can find by itself is the
real limit of this mode, and is not yet known.**

**v97.** The owner showed the Jumper had found and synced the stream while the
tracker's players stayed black. The queue was checked in a real browser and
fills correctly, so the players themselves were not playing. Most likely cause:
four players beside the preview were about 300×168 each, and YouTube's embedded
player requires at least 200×200. The players now take the full width (preview
underneath), have a 200px minimum, and drop to one at a time on a narrow
panel. Each player reports its state in the status line (loading, buffering,
ready, not playing…) and is reloaded if two pushes to play do nothing.
**Unconfirmed until the owner runs it.**

**v98 — looks a second.** v97 made the players play; the owner then reported
about 3 fps and poor tracking. Three causes, three changes:
- A look was only taken when `getCurrentTime()` changed, and the YouTube API
  reports position about four times a second. Position between reports is now
  estimated from the clock and the playback rate (`est`).
- The finder ran on the processor only (150–350 ms a look). The worker now
  tries WebGPU first (`ort.webgpu.min.js` + the asyncify wasm), runs one real
  inference before trusting it, and falls back to the wasm build on any error.
  The page gives it `VT_GPU_WAIT_MS` (30 s) and then starts a `?cpu` worker;
  a failure sets `vtGpuBad` for the visit. **In the build sandbox the software
  GPU never finished loading, so the WebGPU path has only been exercised as
  far as "it times out and falls back correctly". Its output on a real
  graphics card has NOT been compared with Python.** The status line says
  which chip is in use; if boxes look wrong on "graphics card", force
  `vtGpuBad = true` and compare.
- "What the tracker sees" is painted every animation frame from the capture
  with the newest boxes, instead of once per look.
Stored looks are capped at `VT_MAX_LOOKS_PER_SEC` (12 per match-second), which
keeps a 150 s match under the server's 2,000-frame limit.

---

## 30. v99 — robot tracker stage 2: the robot report

Asked for as: "make it tell me what they're good at, their auto, their
strategy if they repeatedly do something and how they lose".

- `vtSummarise(rec)` turns one match's stored boxes into a SUMMARY: per
  alliance, robots that moved in autonomous (`am`), how far (`ap`), how far up
  the field (`ar`), driver speed (`act`), share of driver in the other half
  (`opp`), next to an opponent there (`prs`) or at home (`prd`), longest
  mid-match stop (`stp`), stationary at the end (`es`), partners' distance
  (`apt`), both in view (`vis`). Pipeline: `vtFrames` (box bottom-centre,
  normalised to the area robots used) → `vtSlots` (two slots per colour, least
  movement) → `vtBin` (one position per robot per second; **all measures come
  from these, because box jitter otherwise reads as distance**) → `vtPhases`
  (start and driver start from movement after three still seconds).
- `vtReport(team, sums)` needs three matches. Good at = better than the
  alliances it faced by a margin; habits = the same thing in 70% of matches;
  when it loses = the largest differences between its losses and wins (two of
  each needed); plus what to do with it. Every line carries its counts.
- **Limits, stated on the page:** alliance-level (a box has a colour, not a
  team number); no camera calibration; no scoring. **Built with no real
  recording available**: thresholds are guesses checked only on hand-drawn
  matches (t113). Bump `VT_SUM_V` when the arithmetic changes; `vtBackfill`
  recomputes summaries from stored boxes, nothing is re-watched.
- Storage: summaries in IndexedDB (`vt:sums`) and, with the passcode, in
  Redis as `vt:s:{event}` and `vt:team:{number}` hashes. `GET ?team=` returns
  a team's whole set in one read. `validSum` checks shape server-side.
- Shown on the Scout team page (`#vtReport`). Not yet in the next-match card
  or the win chances.
- Stored looks are capped at 6 per match-second (was 12) to keep records small.

**Routing.** Each place visited is now a browser history entry (`history
.pushState({vs: key})`); `popstate` walks the app's own `vsNav` list, so the
browser's Back/Forward and a phone's swipe-back move within the site. A
tracker run mutes `vsNavPush` so its event-hopping is not recorded.

**v100.**
- A team page listed only events with matches. `upcomingList` (from the
  team's registrations, minus events it has played, minus finished ones) is
  shown as "Upcoming Events" above "Events Attended".
- A screenshot showed the finder boxing a spectator at 48%. `vtRobotLike`
  drops boxes more than twice as tall as wide, and boxes with no plate colour
  unless squarish and at 60%+; `VT_CONF` is 0.45. A match is saved only when
  both alliances were seen in at least 10 looks each, so crowd shots and
  ceremonies are not stored as matches. **These are shape rules, not a better
  model; a retrain on such frames is the real fix.**

---

## 31. v101 — which robot is which

The owner noticed the report could not tell an alliance's two robots apart,
and set the design: robots are rebuilt between events and a season's robots
look alike, so "guess which robot a team is by seeing if the same thing shows
up every time they are in a match", and "it should also know if it catches a
glimpse of the license plate".

- **Recordings are v2**: ten numbers a box (was six) — plus a LOOK (twelve
  bins: eight hues and four greys of the box's middle, its own plate colour
  left out; `vtSigOf`, packed into three integers) and WHO (0, or 1/2 for
  which of the alliance's two teams a plate read named).
- **Plate reading.** Every other look, the biggest coloured box is cut from
  the capture at native size; `vtPlateBox` finds the band of alliance colour;
  it is scaled to a 160×48 strip and read in the worker by
  `models/plate_reader.onnx` (PP-OCRv3 recognition, the model the desktop
  tracker uses through RapidOCR; always on wasm, fixed shape). `vtWhoFromText`
  does not ask "what does it say" but "which of these two team numbers is it":
  edit distance with look-alike characters at half cost, close to one AND a
  full edit further from the other. In Chromium a drawn plate 9 px tall was
  read correctly in about 30 ms.
- **Slots** (`vtSlots`) match on position plus look, and collect each slot's
  mean look and plate votes. `vtSummarise` adds per-robot rows `Ra Rb Ba Bb`
  (same measure names as the alliance rows, plus `g0–g11`, `wa`, `wb`).
  `VT_SUM_V = 2`.
- **`vtIdentify(team, sums)`**, per match: (1) plate — at least two reads and
  clearly more for one answer; (2) else, WITHIN ONE EVENT, the look that
  recurs while the partner changes, seeded by that event's plate reads if any,
  otherwise found by iterating to the running average. Refused when the
  partner never changes, when there are under three matches at the event, or
  when the two robots' looks do not separate by `VT_LOOK_MARGIN`.
- **`vtReport`** is about the team's own robot when it was picked out in three
  or more matches and 60% of them; otherwise about its alliances, and the
  block says which and how (plate in N, look in M).
- **v1 recordings are not thrown away** but no longer count as done
  (`vtDone`, `VT_REC_V`; the server lists `vt:ev2:{event}`), so Track robots
  watches those matches once more.
- **Alliance colour is decided per track, not per look.** Reported: a
  red-alliance robot with blue-anodised metal was "tracked as blue". `vtSlots`
  now follows every box whatever colour it was called, cuts a track where it
  slid onto the other alliance's robot (eight looks running of the other
  colour), then colours each track: by plate reads if there are two or more
  (`who` is 1–4 = red[0], red[1], blue[0], blue[1], matched against all four
  teams, and a read also corrects the box's stored colour); otherwise by
  majority; and when one alliance has three long tracks and the other one, the
  track showing most of the other colour is moved across. Two slots a side are
  then filled from non-overlapping tracks, longest first.
- **Unverified on real footage**: whether stream resolution lets plates be
  read at four players at once, and whether robots' looks separate. Both are
  reported live ("N plates read" in the status line).

**v102.** A screenshot showed all four players on break slates (a countdown,
a crowd shot, a sponsor card). The tracker does not know what a break is: it
plays the Jumper's position for each match, and those can land in one. It now
abandons a match after `VT_GIVE_UP_SEC` (25 s of video) with fewer than five
looks containing a robot, instead of watching all 150 s and then discarding
it. The status line counts these. **Not fixed: the cause.** When the Jumper's
sync is off for part of a day every match there is skipped. The overlay often
shows the match name ("QUAL 47"); reading it with the plate reader to
re-sync is the real fix and is not built.

**v103 was reverted in v104.** v103 rearranged the Scout team page (a summary
sentence, fewer tiles, a folded stats table, empty sections hidden). Asked
which to keep, the owner chose "Whole team page as before". Do not re-apply
any of it unasked.

**v104 — the match name on the stream.** The tracker played the Jumper's
position for every match, so when a day's sync had drifted (lunch) it watched
break slates. It now reads the stream's overlay:
- `finder.findText` (worker, `models/text_finder.onnx`, PP-OCRv3 detection,
  2.4 MB, 640×352, flood-fill grouping) finds lines of text; each is cut from
  the capture at native size into a 320×48 strip and read by the plate reader;
  `vtMatchLabel` recognises "QUAL 47", "Qualification 12", "Q103", "SF 1-1".
- A few seconds into each qualification match (`probe`): the right name is
  counted as confirmed. A different qualification number calls `resync`: the
  schedule (`run.sched[event]`, match number → time played) gives the distance,
  the player is moved, checked again (up to four hops), then backed up in 30 s
  steps to where the right name first appears. The recording restarts there
  with `rec.wide = 1` and a 330 s window; `vtPhases(bins, wide)` finds the
  real start up to 260 s in.
- That start, minus where the Jumper put the match, becomes `run.shift[day]`
  and is applied to every later match of that event day.
- No robots after 25 s and no name: once per event day it looks +5, +10, +20,
  +30, +45, −5, −15 minutes for any match name and re-syncs from it.
- Checked in Chromium on drawn overlays (text 11–20 px): found in ~115 ms,
  read correctly. **Not run on a real stream.** Streams with no match name in
  the picture get no benefit; elimination names are read but not re-synced.

---

## 32. v105 — the tracker learns the game (Override)

The owner described the meta — one robot guards a toggle while its partner
stacks yellow in front of it, then they swap; pressure on the other side;
some teams go round all the toggles — and asked for the report in those terms.

- **The game model** (manual v2.1): four toggles at the wall midpoints, each
  owning the yellow pins of the quadrant in front of it (the triangles between
  the diagonals); a midfield diamond that matters in the last 10 s.
  `vtZone(a, b)` names a position from a robot's own wall: 1 own quadrant, 2/3
  side quadrants, 4 opponent's, 5 midfield, 6 own toggle, 7/8 side toggles, 9
  opponent's toggle. `VT_TOG_R`, `VT_MID_R` are guesses.
- **Field mapping.** Nothing above is knowable until the picture is tied to
  the field. Per stream VIDEO, four corners: clicked (`vtMarkField`, an
  overlay on the Jumper's player; any order; shared via `?field=`) or guessed
  from the hull of robots' positions (`vtQuadGuess`, flagged `auto`).
  `vtHomography` maps picture → unit square; `vtSummarise(rec, quad)` then
  turns the square a quarter at a time until red starts on the left. Applied
  at ANALYSIS time, so marking a field later re-does existing recordings
  (`vtBackfill` compares `fq`, the mark of the quad a summary was made with).
  A stream that cuts between cameras will be wrong while it is on another one.
- **`vtGame(bins, ph)`**, per robot: share of driver at own / side / opponent
  toggle and in each quadrant and midfield; toggle visits; CONTESTS (arriving
  at a toggle an opponent is on; won if alone on it 3 s within 12) and
  DEFENCES; guard stints (3 s+ at one toggle); RELEASE (its partner stops
  working in the guarded quadrant — does it leave within 6 s?); midfield in
  the last 10 s; the autonomous route as zone digits (`art`), six path points
  (`p0–p11`) and a 5×5 heat grid (`h0–h24`). Per alliance: role swaps (`sw`)
  and seconds worked in quadrants (`wk`).
- **`vtGameLines`** writes Strengths, Weaknesses, Autonomous routines (each
  with its count), Role and strategy, Toggles, Where it plays. Stacking pace
  is the alliance's score per ten seconds its robots worked in a quadrant — an
  estimate, since pins are not seen. `vtFieldSvg` draws routes and the heat
  map. Mid-match stops no longer count time on a toggle.
- **Your robot** (`vtCoachFill`, My team): the same report on the owner's
  team plus a per-event table of what a driver can change.
- `VT_SUM_V = 3`; summaries are up to 12 kB and 110 fields a robot.
- **Not built yet:** reading the timer for exact period timing; live mode;
  reading a toggle's colour (wins are judged by position only).
- **Checked only on hand-drawn matches** (t113: guard, stack, swap, a held
  and a lost defence, a won and a lost attack, routes, a field filmed from
  the other side). Zone sizes and time thresholds are untested on real play.

---

## 32b. v106 — the stream's clock, and live tracking

- **Clock.** `vtScan(slot, video, stage, tile)` is the old `probe` body made a
  function: every line of text in one player's picture, read. `vtLabelOf` picks
  the match name from it, `vtTimerText` the clock (`m:ss` only — a bare number
  is a score). While watching, the clock is read every 5 s of video into
  `rec.tm = [tenths, seconds on clock, …]` (server: `validRec` allows `tm`,
  ≤400 integers, in pairs). `vtPhases(bins, wide, clock)` uses it when there
  are ≥3 running driver readings: each says when driver began, the median is
  taken; autonomous the same from readings under 0:15. Clocks standing at
  1:45, 0:15 or 0:00 are waiting and ignored. Summary field `ck` = 1 when the
  periods came from the clock. `VT_SUM_V` not bumped: old recordings have no
  clock, so re-doing them would change nothing.
- **Live.** `vtStart('live')` → one player at 1× on today's stream
  (`ctx.cal[today].videoId`) → `vtLiveLoop`. Every 4 s it scans the overlay; a
  new qualification number closes the current recording (`vtKeep`, shared with
  `vtWatch`) and starts the next; 330 s is the ceiling. Recordings are `wide`
  with `rs/bs` null; the index entry gets `ns: 1` and `vtScoreFill(ev, ctx)`
  (run from `vtRender`) adds the score once posted and re-summarises.
- `vtPlateLook` is the plate read, shared by both loops.
- **Not built:** reading toggle colour from the video. Contests are still
  judged by position. It needs pictures of a toggle in each state on a real
  stream to know what to sample; guessing would put a robot's own colour into
  the answer whenever one sits on the toggle.
- **Unverified on real footage:** whether streams show the clock as `m:ss` in
  a place the text finder picks up; live streams' `getCurrentTime` behaviour.
  The status line shows "clock read N times" — zero after a few matches means
  the overlay is not being read.

### Also in v106

- **Jumper remembers the team.** `jumpToMatch(…, teamNumber)` built its context
  with `team: null`, so a ▶ from a team's page listed the whole event. It now
  resolves the team first and reloads when the team differs.
- **Shared stream links.** `rwSaveCal` → `rwShareCal` (1.5 s debounce, only
  with the admin key saved) → `POST { passcode, cal: { ev, days } }` →
  `HSET vt:cal:{ev} day json` (`validCalDay`). `rwSharedCal(ev)` (`GET ?cal=`,
  2.5 s at most, 5 min memo) folds them into `rwPublished` before
  `rwMergePublished`, so they behave exactly like anchors.json: local wins.
  Days marked `published` are not re-uploaded.
- **"Admin key"** is the on-screen name of what was the tracker passcode. The
  environment variable is still `TRACKER_PASSCODE` and the localStorage key
  still `vex_tracker_pass`; nobody has to re-enter anything.

## 32c. v107 — watching like a person, and learning

Asked for as: "think of how a person tracks a robot and knows, try to do the
same, look at the license plates as much as possible … have it actually get
better at tracking as you track matches".

- **Attention** (`vtAttend`, `vtPlates`): every coloured, robot-shaped box is
  followed look to look (nearest within 0.12 of the width). Each look the
  plates of up to 2 robots (1 on the processor) are read, ordered by fewest
  confirmed reads, then fewest tries, then size. Before: the biggest robot
  only, every other look. Only real reads are stamped as `who`; nothing is
  propagated into the recording, so one misread cannot multiply.
- **Learning**, per stream video, in idb `vt:learn` (this device only):
  `{ n, conf, still[], clock, hi, lo }`.
  - `clock`: where the clock was found (fractions of the picture). Known →
    `vtClockAt` reads that spot once a second; eight misses running forget it.
  - `still`: a 24×14 cell with a box in ≥80% of looks is a candidate; the same
    spot in ≥3 matches and ≥60% of matches since is scenery
    (`vtStillKnown`). `vtFrames(rec, quad, learn)` leaves those boxes out; the
    recording keeps them. Risk: a dead robot on the same spot in three
    matches would be learned as scenery.
  - `conf`: 75th percentile of coloured boxes per look, middle 60% of the
    match, scenery aside. Above 4 in two of three matches → +0.02, below →
    −0.02, within `VT_CONF_MIN..MAX` (0.38–0.55). Multi-camera streams will
    drift to the floor; that is the reason there is one.
- `vtLearnLine` / `#vtLearned` says what it has learned; `vtKnownTeams` counts
  robots with a plate read twice in some match.
- **Unverified on real footage**, like the rest of the tracker.

### v108 — learning is shared; a dead robot is not scenery

- `vtLearnSave(vid)` posts `{ passcode, learn: { vid, n, conf, clock, still } }`
  (`validLearn`, key `vt:learn:{vid}`); `vtLearnGet` asks `?learn=VID` once a
  session per video and adopts the shared copy when it has seen more matches.
  Last writer wins; with one tracking computer that is enough.
- `vtLearnFrom`: a still spot is not scenery if any plate was read on it (and
  an existing spot there is deleted), or if its look is within
  `VT_ROBOT_LOOK` (0.35) of the look of everything that moved in the match.

## 32d. v109 — the desktop app (`desktop/`)

Asked for as: an app that tracks as fast as the machine can and trains on it,
fed by "a video file, an actual stream, or just a stream link", synced with
the website. Owner's machine: RTX 5070 Ti, 9800X3D, Windows.

- `desktop/VEX_Trainer.bat` — the only file the owner keeps. Makes a venv in
  `VEX_Trainer/`, installs numpy, opencv-python, onnxruntime-directml, yt-dlp,
  and **fetches `/desktop/vex_trainer.py` from the live site on every start**,
  so merging a change to that file updates the app.
- `desktop/vex_trainer.py` — one file. Menu: track the website's jobs · add a
  video for training · watch a live stream for training · map a file to a
  stream · review · train · publish · settings. Models and `PLATE_CHARS` are
  fetched from the site (`/models/*.onnx`, `/vendor/vt-worker.js`).
- **Same arithmetic as the page.** letterbox, decode, NMS, `color_of`,
  `sig_of`, `plate_box`, `pack_frame`, `who_from_text`, `match_label`,
  `timer_text`, `attend` are ports; `desktop/dev/parity.*` compares them with
  the JS (0 of 305 differ). Change one side, change the other.
- **Sync, through `/api/tracker`:**
  - page → app: `vtJobsSend('here'|'history')` posts `jobs: { ev, list }`
    (`validJob`; keys `vt:jobs:{ev}`, set `vt:jobsets`). The app reads
    `?jobs=1`, `?jobs=EV`, skips ids already in `?event=EV`.
  - app → page: recordings posted exactly like the page's (`rec` only, v2,
    `rate: 4`, with `tm`). `vtAppImport` (quiet from `vtRender` once a minute
    with the admin key, or the button) pulls recordings for job events into
    idb, `vtBackfill(ev, true)` summarises and posts the sums, and clears a
    job set once every match in it is saved.
  - finder: `do_publish` posts the ONNX in 640 KB parts (`model: { tag, i, n,
    b64 }`; Upstash's free request limit is 1 MB). `vt:model:cur` flips on the
    last part. `vendor/vt-worker.js` `loadCustom`: uses it from the
    `vt-models` cache if present, else fetches it in the background for the
    next start; any failure → built-in. `sw.js` keeps `vt-models`.
- **Tracking** (`track_match`): 6 looks per second of video, plates on up to 2
  robots a look, clock from its learned place, name check 8 s in →
  `find_match` jumps by schedule spacing and backs up to the name's first
  appearance (`wide`). `ProcessPoolExecutor`, `workers` chunks per video.
- **Training**: reviewed frames are truth (85/15 split by name hash);
  unreviewed frames with exactly four boxes ≥0.6 join training only (≤2×).
  `yolov8n` (same size as the shipped finder), exported to ONNX, must answer
  `[1, 5, 8400]`. Old and new are scored on the held-back frames and the app
  recommends publishing only if the new F1 is higher.
- **Downloading streams is against YouTube's terms**; the owner was told and
  chose it. Files he already has can be mapped instead (menu 4).
- **Never run by me:** DirectML, yt-dlp, torch/ultralytics training, the .bat.

**v110:** the Desktop app row (`#vtAppRow`) is always rendered on a computer — also in a team's view and in browsers that cannot capture a tab — and without the admin key it says so with a link to Settings, instead of being absent.

**v111 — the app has a window.** Asked for as: "simpler … an actual ui … 2-4
actual main buttons and automate most of it". `vex_trainer.py` with no flags
runs `serve_ui`: one page (`UI_HTML`) on `127.0.0.1:8765+`, opened as an Edge
app window. Three cards: Track · Review · Train, one box to paste a link or a
file path, a status line with a log. Each button starts the same file again
with a flag (`--track`, `--add SRC`, `--train`, `--unpublish`) as a separate
process (`Job`), so Stop is a kill and a crash cannot take the window down.
Automated: tracking starts with the window once the key is saved and then
polls for work every minute; one box takes a file, a recorded link or a live
link (`add_source` works out which); Train measures and publishes only if the
new finder is better (`train_auto`). Every request needs the per-run token in
the URL and a local Host header. `--menu` is the old console menu.
`desktop/dev/ui.py` + `ui.cjs` drive the window in Chromium (22 checks).

**v112.** (1) Enter saves the admin key, on the website's Settings and in the
app's window; both only saved on the button. The app's key box always says
what happened. (2) Stream finding: `runQuery` in `api/proxy.js` now reads
`youtube.com/results` first (`ytPageSearch`, `parseYtResults`: free) and judges
those titles with the unchanged rules (`judge`); the 100-unit `search.list` is
made only when the page gives no accepted stream. Reason: 10,000 units a day
is ~100 name searches, and the tracker's history walk spends that in minutes,
after which every event fails until the reset. `RW_STREAM_LOGIC` is `L6` so
cached misses are asked again. **Not verified against the real page** (YouTube
is unreachable from the sandbox): if the page's markup differs from
`"videoRenderer":{"videoId":…"title":{"runs":[{"text":…` or Vercel's address
is shown a consent page, it reads as no results and the old path runs.
`?debug=1` → the jumper body's streams carry no `how` yet; add it if needed.

**v113 — the app, faster.** Profiled one match (`desktop/dev/prof.py`): with
detection aside, 12 of 17 s was the plate/clock reader on the processor. Now:
the reader runs on the graphics card when it accepts the model (one real read
at each width, else processor); `attend` stops re-reading a robot with three
confirmed reads (a glance every 3 s) and backs off to once a second on a plate
that has not shown in 12 tries; each worker's sessions and OpenCV get
`cores // workers` threads instead of all of them. Reads per match 1053 → 768
on the made-up video (plates there never read, so the real saving is larger).
The website's `vtAttend` still reads every look: it is bound by playback, not
by reading. Ideas not done: hardware video decode
(`CAP_PROP_HW_ACCELERATION`), stripping comments from index.html at build
(925 KB / 265 KB gzipped; needs a build step and tests against the built file).

## 32e. v114 — briefing, clips, review anywhere, channels, video in the chances

Asked for as: "add 1, 3, 5, 7, for 9 let it tell you autons of a team, brief
strategy they run, and scoring speed (study the game override …). 10, 11".

- **Briefing** (`vtBriefingOpen`, `vtBrief`). Tracker box → "Open the
  briefing" (the box now renders on a phone too, with only this). Every team
  at the event (`/events/{id}/teams`) in three lines: autonomous (routes where
  the field is marked, else moved/reach), strategy in Override's terms
  (Toggle defender / Stacker / Swaps / Does both, plus pressure, roaming,
  leaves-when-partner-finishes, defended-toggle record, endgame), scoring
  (points per 10 s of stacking where `wk` exists, else alliance average).
  Needs ≥2 tracked matches. `vtTeamSumsMany` → `GET ?teams=` (12 per call).
  Roles need **Mark the field**; the page says for how many teams it is missing.
- **Clips** (`vtClips`, `vtClipsOpen`). Summaries now carry `vid` and `of`
  (video id, match offset); a clip is `of + st − 3` for 22 s. One YT player
  steps through them. `VT_SUM_V` NOT bumped (a bump hides every shared summary
  until an admin device re-makes it): `vtBackfill` re-makes local ones lacking
  `vid`; `validSum` allows `vid`.
- **Review anywhere** (`vtReviewOpen`, Settings → Admin key). The app's
  `push_review` sends its ≤120 hardest unreviewed frames (960 px, q72, ~12–90
  KB) as `frame`; the page corrects with pointer events (`vtRevEdit`) and posts
  `label`, which deletes the picture; the app's `pull_labels` writes them into
  `data/labels` and posts `labelsdone`. Server cap 300 waiting frames.
  `sync_review` runs when the window opens, after each tracking pass, before
  training. Pictures are public to read (stream screenshots); writes need the key.
- **Organiser channels** (`rwVenueKey` = venue|city, `rwKnownChannel`,
  `rwRememberChannel`; localStorage `vex_rw_chan` + shared `vt:chan`). A found
  stream's `channelId` is remembered; next event at that venue asks the
  proxy's new `channel:UC…` path (`resolveChannel`, 2–3 units) before any search.
- **Video in the win chances** (`sim_trackScore`, `sim_trackIndex`,
  `sim_applyTracking`, `SIM_TRACK_K = 1`). Same shape as `sim_applySeason`:
  z-scores of pace, autonomous distance and (−) longest stop, averaged; a line
  fitted against ratings across ≥8 teams with both; applied only if the slope
  is positive; counted as one match. `sim_learnNote` says when it is in.
- **App**: workers default to `min(8, threads/2)` until the owner picks;
  `Video` tries `CAP_PROP_HW_ACCELERATION` and keeps it only after a real
  frame and a seek that lands; `hw_decode: false` in config.json turns it off.
- Unverified on real data, all of it. Rendered at phone width in Chromium.

## 32f. v115 — counting pins; the short report

Asked: "why is it unable to count pins scored? if a human can so should a
machine", then, with the manual's Figure P-1 (a pin: ~40 mm across, 165 mm
tall, two halves, each red, blue or yellow; four kinds: red/blue, red/yellow,
blue/yellow, yellow/yellow): "can it use this as a baseline? build it now …
and make the overviews simple and app simple".

- **Finding** — no trained model. `vtPinClass` (one pixel → red/blue/yellow),
  `vtPinBlobs` (4-connected patches, ≥10 px, ≤8% wide, ≤20% tall, not inside a
  robot's box grown 6%), on the tile drawn 960 wide, every 2 s of video.
  Python: `pin_blobs`, same numbers; on one picture both find the identical 14
  blobs. Recorded as `rec.pn = [tenths, n, (x, footY, w, h, area, colour)×n, …]`
  with `pw`, `ph`; ≤36,000 ints (`validRec` allows 40,000).
- **Counting** — `vtPinCount(rec, quad, turnK, track, ph)`, only with a marked
  field. A patch's foot → field place; its area ÷ the area half a pin has at
  that spot (camera scale from the homography; 0.75 × 40 mm × 82.5 mm × 0.9)
  → halves. 8×8 grid; per square, median of five looks minus the pre-match
  median = pins moved there and left. When a quadrant's total rises ≥0.4, the
  robot that came closest (12 s back) to where it rose is credited: `ys`
  yellow halves, `as` its own colour's (own alliance's robots only). Summary
  top level: `py`, `pr`, `pb`, `pk`. `VT_SUM_V` not bumped.
- **What it cannot do**, and the report says so: tell a pin on a goal from one
  beside it; see a stack a robot is parked in front of for long; know who
  owned the toggle, so "worth N" is "when its alliance holds that toggle".
  Elevated pins project further from the camera than their base, so a tall
  stack can land in a neighbouring square; the before/after difference still
  holds because it lands there every look.
- **Check**: `desktop/dev/pins.py` draws a match (six yellow pins by one red
  robot, two red-over-yellow by the other, four untouched, one carried), the
  app tracks it, `tests/fixtures/pins_rec.json` is that recording, t119 counts
  from it on the page: 15.9 / 2.9 yellow halves, 2.8 red, blue 0, untouched
  and carried pins not counted. Drawn pins are a pixel wide of true, hence
  ~1.3× high. **Never run on real footage**: the yellow test, the size limits
  and the half-pin area are from the manual's numbers, not from a stream. The
  preview draws a mark on everything it takes for a pin, and the status line
  counts "pin sightings" — that is how to see whether it is right.
- **Short report**: `vtReportHtml` opens with up to five lines (Autonomous,
  Strategy, Scoring from `rep.brief` = `vtBrief`; Best at; Watch for) and puts
  the whole previous report inside `<details class="vr-more">`. The main team
  page is untouched (v103's simplification of it was reverted on request).
- **App window**: shorter card text; the log and the paste box are inside
  `<details>`.

**v116.** Reported: the right admin key "doesn't work". Both clients said "not
accepted" for two different 403s: a wrong key, and a server with no
`TRACKER_PASSCODE` in the running deployment (missing, under 8 characters, or
added without a redeploy). They now say which (`vtPassSave`; the app's
`key_problem`, which also names a 404 and no connection). The server trims the
stored and the given key, so a trailing space or line break in Vercel no longer
makes a key unmatchable. The owner pasted the key into the chat while
reporting this; he was told to change it.

**v117 — app downloads.** Reported slow on a gigabit line. The launcher
installed bare `yt-dlp`; since late 2025 YouTube support needs `yt-dlp[default]`
(the yt-dlp-ejs component) and a JavaScript runtime (Deno by default), without
which yt-dlp runs on a deprecated path with fewer formats
(github.com/yt-dlp/yt-dlp/issues/15012). `ensure_downloader` pip-installs the
former and fetches `deno.exe` into `tools/` (added to PATH) from Deno's GitHub
release. Also: 16 concurrent fragments, 10 MB range requests, 720p ≤30 fps
avc1 preferred (half the bytes of 60 fps), speed printed every 5 s. Not run:
no YouTube from the sandbox. If it is still slow, the printed MB/s is the
number to ask for.

**v118 — parallel download.** Owner's screenshot: "13% of 6232 MB at 11.6
MB/s" on a gigabit line. That is YouTube's per-connection rate; yt-dlp's
`concurrent_fragment_downloads` only helps fragmented formats and this was one
plain file. `fetch_parallel` asks for it in 8 MB ranges over 24 connections
and writes each where it belongs; `download` uses it when the chosen format is
a plain http(s) file and falls back to yt-dlp on any failure.
`desktop/dev/par.py` checks it against a local range server (identical file,
20 at once, nothing left behind on a refusal). Not run against YouTube; if it
answers 403 to parallel ranges the fallback is the old speed.

**v119 — "push it to its limits".** Measured first; changed only what waited
on something it did not need to.
- App: the next video downloads while the current one is tracked (`fetch`
  thread, one ahead); 32 connections per download.
- Page: `vtAppImport` fetches recordings 6 at a time (was one; a season took
  minutes) and still saves them one by one (shared index); `vtBackfill` posts
  summaries 6 at a time after saving them locally. `vtParallel` gives 6
  players (3 across, stage widened to `min(96vw, 1680px)`) when
  `hardwareConcurrency ≥ 12`, window ≥1700×760; else as before.
- Measured and left alone: summarising a match is 45 ms (19 of it `vtSlots`);
  the page head already defers fonts; index.html is 950 KB / ~270 KB gzipped
  and cached by the service worker after one visit — shrinking it needs a
  build step, and the tests would then be testing a file that is not served.

**v120 — short first, more on request.** Asked: "most descriptions on the
website … are wayy too long … if you click an expanding arrow it can explain
furthermore". `vsShorten` (run by a MutationObserver on body) folds any
`VS_SHORT_SEL` element (`.rw-hint, .sim-caveat, .sim-hint, .set-p, .info-blurb,
.rw-miss, .rw-warn, .vt-note, .ladder-caveat, .bracket-key, .vr-cap,
.fav-empty`) of ≥150 characters to two lines (CSS line-clamp) with a
`.vs-more` button after it. Skipped: elements with an id (live status lines),
with a button/link/input/details inside (a control must stay visible), inside
`.vs-why`. No text was reworded or removed — to shorten a particular
description for real, edit its string; to exempt one, give it an id. New long
text should use one of those classes and it folds by itself.
**My team table** (`vtCoachFill`): event names and dates via `vsEventRecord`,
newest first; "alliance" instead of an asterisk; column meanings in
`<details class="vs-why">`; `.vt-coach-table` has real padding.
**App**: Settings → Download speed (full / 40 / 15 / 5 MB/s; `max_mbps` in
config.json). Reported: the download hurt ping in games. `fetch_parallel`
paces reads against the ceiling and opens fewer connections; yt-dlp fallback
gets `ratelimit`. Applies from the next download.

**v121:** on a phone (≤600 px) the My team table is cards, not a table: the header row is hidden, each row is a 3-column grid, each cell shows its `data-label` above its number. Reported: it had to be scrolled sideways.

**v122 — the My team table says useful things.** Told: "these metrics are
basically all useless, i want to know what their autonomous does, how many
points/pins and cups it scores, and how long it takes them to stack 5 pins (or
just general scoring speed)", then: "the repeated strategy they like to do,
like they mostly only score alliance pins or they mostly only score yellows".
Columns are now Event · Matches · Autonomous (`vtBrief(...).auto` + pins set
down in it) · Goes for (`vtPinStyle`: ≥70% yellow / ≥70% own colour / both,
needs 4 halves) · Pins a match · Points from pins (10 × yellow halves + 5 ×
own, the most they could be worth: yellow needs the toggle) · 5 pins stacked
in. `vtPinCount` now also returns per robot `ya` (halves credited before
driver control) and `t5` (seconds into driver control when its credited total
reached ten halves); `vtBackfill` re-makes summaries that have `pk` but no
`ya`. `vtCoachPins(rows, per)` averages per match. With no pins counted the
cells say "not counted yet" and a note says why. `vtBrief`'s strategy line
leads with the pin habit. **"Cups" is not built: the owner used the word and
it is not something this code knows about in Override — asked what he means.**
Stop, pinned, distance and speed are still in the full report below.

**v123:** the app showed "1285 to review · 8 done" and the owner took that as the job. It never was: training needs 150 reviewed, and the queue is hardest-first. The window and the review screen now count toward the next goal (150, then 300, then steps of 150) and say when it is enough; the website's review says the same. Nothing about what is kept or trained changed.

**v124.** The owner sent a frame of two robots side by side under what the
finder took for one, with: "the gap in between robot drivebases … that's how
you can tell separate robots apart". Both review screens now say so (one box
each, split at the gap). An automatic split was looked at and NOT built: on
his picture the plate finder returns nothing (robots there are full of red
parts, the plates are small), so there is no reliable second signal to split
on. The fix is the labels: frames boxed as two teach the finder to give two.
Also seen in that frame, for the pin counter: pins have dark bases, and red
robots carry a lot of red besides the plate.

**v125 — first real frame, and scene changes.** The owner sent a review frame
taken mid-fade between two fields (two scenes overlaid) and said it might
confuse the tracker. Looks are now passed over while the scene is changing:
`CutWatch` (app) and `vtCut` (page) compare a small grey copy of the picture
with the last look and one ~1 s back; mean change >20/255 holds for 1 s. A
moving robot does not trip it; a hard cut and a 1 s fade both do (tested with
his frame as one of the scenes). The app also never keeps such a frame for
review. Frames already in his queue from before: press S.
**What his frame showed, the first real footage seen** (not committed: it has
faces in it):
- The robot finder found all four robots (0.73, 0.65, 0.52, 0.33 — the far one
  below the 0.45 line). Only ONE of the four got a colour; the other three were
  "cannot tell". The frame is a blend, which washes colour out, so this may
  not hold on a clean frame — but if it does, `vtColorOf`'s thresholds are too
  strict for real plates and identity suffers. Ask for a clean frame.
- The pin finder marked 60 patches (26 yellow, 14 red, 20 blue): pin tops on
  the field, plus shirts and screens outside it (dropped by the field test).
  Sizes pass the limits. Real pins sit on black posts, and there are clear
  cups and large red/blue cone-shaped pieces on the field that this code
  knows nothing about — likely the "cups" he asked about.
- **Open problem:** a broadcast that switches between fields has one field
  mark per VIDEO, but each field has its own camera. Matches on the second
  field are placed with the first field's corners. Needs a mark per camera
  view and a way to tell which view a look is of. Not built.

**v126 — what the manual says about cups** (vexrobotics.com/override-manual,
read 2026-11-16; the owner asked for "cups" to be counted and said only "they
score with a lift mechanism"):
- **Cup:** ~80 mm across, 164.5 mm tall, two halves, one transparent and one
  opaque. 56 on the field (20 match loads). **Pin:** 63 (4 red/blue, 20
  red/yellow, 20 blue/yellow, 19 yellow/yellow).
- A pin is Placed when nested in a goal or in a cup that is itself placed;
  stacks go goal → pin → cup → pin … which is what the lifts are for. One pin
  half per cup half.
- **A pin half scores only while fully visible**; a half inside a cup's opaque
  half does not. The pin counter counts what it can see, so it agrees with
  this by construction.
- Yellow halves score for the alliance whose colour the quadrant's toggle
  shows at the end; in midfield, for the alliance with more robots there.
- 9 goals: 4 alliance-coloured (82.5 mm tall; the other alliance may not touch
  them), 4 neutral in the quadrants (146.5 mm), 1 centre (222.7 mm). Each
  quadrant has two goals and one toggle. Robots hold at most one pin and one
  cup.
- Nothing read says a cup is worth points by itself. Cups have no colour to
  find them by (clear and grey), so counting them needs the trained finder:
  a second label in review. Not built; offered.

**v127 — review variety.** Reported: "i keep getting the same frames if not a little different". The queue was hardness only, and hard frames come in runs from one moment of one match. `review_queue` now sends a frame to the back if its robots stand where they did (`same_layout`, within 6% of the picture, same count, same video) in a frame already reviewed or ahead of it, and the front of the queue takes turns between videos. Frames sent to the website for phone review follow the same order. Nothing is deleted.

**v128 — knowing training finished.** Asked: "how do i know if it finished training? have something that tells me amount of info it has been trained off of". `do_train` prints `training: round N/M` each epoch (ultralytics `on_fit_epoch_end` callback; the window's bar reads N/M), then `TRAINING FINISHED after N rounds: learned from A frames you reviewed and B the finder was already sure of; tested on C`. `trained_latest.json` keeps frames/auto/test/rounds/when/published, and the Train card shows it permanently, plus how many frames have been reviewed since. Owner's first real numbers: 392 reviewed; downloads at 110 MB/s (2.9 GB in 29 s), so `fetch_parallel` works against YouTube. The ultralytics callback is untested (no torch here); it is wrapped so a failure only loses the progress lines.

**v129 — the official score checks the pin counts.** Asked: "for old matches
try to match the score up with the officially released score to see if youre
right". `vtPinCheck(sums)`: per tracked match with `pk` and both scores,
`(rs + bs − 12 − 8 × robots with eg)` against `5 × (pr + pb) + 10 × py`; the
median ratio `k` (clamped 0.4–2.5) corrects every displayed pin number
(`vtCoachPins`, `vtPinLine`), and the median distance from it is the "±" shown.
Needs 4 matches. Shown per event in the My team table ("checked: ±15%" / "not
checked yet"), in the briefing/report pin line, and over everything on the
device in the tracker box. Limits, stated in the code: it checks the two
alliances together, not each (toggle ownership is unknown), and unowned yellow
looks like over-counting and is absorbed by `k`. Point values (10/5/12/8) are
from the owner and an earlier reading of the manual; the manual page fetched
on 2026-11-16 mentioned a 10-point autonomous bonus for qualification matches,
so `VT_PTS_AUTO` may be 2 high — negligible against match totals, but check.
Matches tracked before v115 have no pins and cannot be checked without being
tracked again.

**v165 (app 2.41) — pins & cups screen simplified.** Reported: "it feels
crammed and too much stuff". Top line: Back, count, Skip, Save. A row of four
big colour buttons (`#pBar`, keys still 1–4) with one small link "Boxes in
the wrong place?" that opens Move the goals / Mark the field on this picture
(`#pFix`, opened by itself when a frame has no spots). One line of help, the
rest behind "Help". Robots' outlines are no longer drawn there; goal and
loader boxes at 30% unless moving goals; foot dots only when moving goals.

**v164 (app 2.40) — the vision model put to work; people off the field.**
Asked what the vision model does and to "utilize as much as you can with it
as long as its reasonable", and about people being boxed as robots. Off the
field: `field_inverse`/`on_field` drop boxes whose bottom middle maps outside
the field (± `FIELD_MARGIN` 0.06) in tracking when the field is marked;
`vtFrames` does the same for every recording (`VT_FIELD_MARGIN`,
`VT_REMAKE` → 164). The vision model (too slow for every box, a second or
more a question): `do_vreview` (button "Let the vision model review first",
task `--vreview`) asks per waiting frame (`vlm_review_frame`, numbered
picture as `think_picture`) what each box is (`VLM_WHAT`) and for boxes of
robots without one ("missed", 0–1000 of the whole picture, scaled back to
the frame); notes kept in the frame's props `vlm`. `vlm_verdict`: all
robots, none missed, 1–6 → labelled `by: 'vlm'` (trained on, ≤ 3× human,
never in val; `reviewed()` is human only). Otherwise review opens with its
changes applied (`/api/next` → `vlm: {removed, added}`), and those frames
come first in the queue. `vlm_find_field` ("Find it for me" on the field
screen, `/api/ffind`): corners, goal and loader feet as points; each slot
takes the nearest point (≤ 0.15) from the drawing's guess. Only the plumbing
is tested (desktop/dev/vlm.py, 23, a stand-in Ollama); the real model's
accuracy at this is unknown. Tests: t150.

**v163 — Points a match.** Asked: "can it be the average of what the teams
score per match". The My team column is now its alliance's official score,
averaged over the tracked matches at that event (`r.mine[].pts`), with how
many matches; the pin-points estimate is gone from the table.

**v162 — "Points from pins" said what it is.** Asked whether 209 was the
event's total or a match's: it is per match (`vtCoachPins` divides by
matches) and an upper bound (every yellow half at 10). Column now "Pin
points a match (at most)", with the note saying so.

**v161 (app 2.39) — loaders small; goals by the stack, not a column.**
Reported: loader boxes "ridiculously huge" (they were 0.20 × 0.33 field,
2.4 × 4 ft) → `SPOTS` loaders (0.035, 0.12, 0.025). Then, with a picture of a
tall stack leaning out of its column: "not gonna work". The column (v160)
is gone from counting: goal boxes are wider (half-width 0.11, centre 0.12)
and `stacked(pieces, k, sb)` keeps pieces touching the goal's base (0.09
field square at the foot) and then any touching one already kept (gap 0.025
field), so a stack is followed however it leans and loose pieces apart from
it are left out; loaders keep everything in their box. Used by the colour
guesses (`keep_stacked`) and `PieceFinder.find_spots` (tracking counts).
Training keeps every piece the person marked inside a box. The review draws
goal boxes faintly with a dot at the foot (`spot_foot_px`), clicks land
anywhere in a box. `spot_column`/`on_spot` remain but are not used for
counting. Checks: desktop/dev/spots.py (16), t149.

**v160 (app 2.37–2.38) — pins & cups only on goals and loaders, and boxes
that fit.** Reported: guesses on loose pieces ("make it so i only have to mark
towers and loaders"), the yellow boxes off the goals (with a picture), then
"make it so box sizes are set and i can drag the box over where it should
be". `spot_column`/`on_spot`/`on_spots`: on a goal a piece must be in its
column (`COLUMN` 0.44 of the spot width, centred on the foot) and its bottom
not below the base (+4% of the spot height); a loader is its whole box. Used
by the colour guesses, `PieceFinder.find_spots` (so tracking's goal counts
too), training (`pieces_marked`) and clicks (`spotAt`). Goals draw as their
column. `frame_geom`/`frame_spots`: when the field was marked in the app on a
saved frame (`fieldrefs.json` {vid: {id, q}}, valid while the stream's mark
is that q), each other frame is matched to it with `CamFollow` and the mark
moved; a frame that does not match gets no spots ("not the view the field
was marked on: skip it"). "Boxes off? Mark the field on this picture" opens
the field screen on the current frame. Pins mode: boxes are placed at the
set size on press and dragged into place; a press without moving on a box
removes it; drag-to-draw is gone. "Move the goals": drag the dotted shapes
(size kept), "Save goals" → `/api/fmove` → `move_spots` turns the boxes
into feet (`spot_foot`) and saves the stream's mark on this frame
(`save_field`, this frame as reference). `flash` messages no longer restore
each other. Checks: desktop/dev/spots.py (15), browser runs in
desktop/dev/fieldmark, t149.

**v159 (app 2.36) — mark the field in the app.** Asked: "can i mark the
field in the app??". Under pins & cups, each stream with reviewed frames but
no field mark gets a "Mark the field: <vid>" button → screen `#fld`:
`/api/fframe` picks the stream's saved frame (reviewed, most boxes);
four clicks; `/api/fspots` returns the 13 starting spots (`first_spots`:
`quad_fwd` of `SPOTS`); circles dragged; `/api/fsave` → `save_field` posts
{field: {vid, q, g, l, t}} with the admin key, exactly as the website does,
and updates `_QUADS`/quads.json. Frames now store `t` (stream seconds) so a
mark made on one gives camera-follow its picture. The pins & cups line is
written with `setHtml` (only when changed): rebuilding it every second lost
clicks on its buttons. Checks: desktop/dev/fieldmark (end to end in
Chromium against a stand-in website), t148.

**v158 (app 2.34) — one bar for the whole job.** Reported: the bar showed
the step on hand (a video's download 0–100%, then tracking moving only when
a worker's whole batch came in). `do_jobs` sets `_PROG['all']` (matches
done of all to do) before the first download; `progress(minor=True)` keeps
a download as `_PROG['dl']` and reports it as `u` (the step) under the job's
bar instead of replacing it. Workers get a `multiprocessing.Manager` dict
(one per video) through the chunk args; `track_match` writes each match's
fraction every 2 s of video (`share_set`, ≤ 0.98, 1.0 when done) and the
loop waits with `concurrent.futures.wait(timeout=1.5)` to update the bar from
the sum. The window shows "stage · step" and "N of M matches". Checks:
desktop/dev/bar.py (9, the real loop with stand-in workers), t147.
App 2.35, same release: reported "cant click cups and pins" (the button greyed
out, 0 of 60). It is enabled only when `pieces_queue` has a frame, which
needs reviewed robot frames from streams whose field is marked.
`pieces_why` (computed with the count when the queue is empty) gives the
reviewed count and the streams with reviewed frames but no field mark; the
window says which, or "Counting the frames…" (button not greyed while
counting). Owner's cause not confirmed. Checks: desktop/dev/window.py (20).

**v157 — the accuracy test.** Tracker panel: "Mark robots here" (on a
tracked match paused in the player: `vtMarkTime` for the moment, then four
clicks on the video where each robot's wheels meet the floor, red then blue
in the recording's order, or "Not in view"; "Next: 5 s on" seeks the embed by
postMessage `seekTo` + `pauseVideo`) and "Score the tracker". Marks live on
this device in IndexedDB `vt:truth` {ev:id → {vid, s: [{t, p: 4 × [x,y] or
null]}]}. `vtAccuracy(rec, quad, samples)` runs `vtFrames` + `vtSlots`,
maps marks through the same `vtHomography`, pairs each alliance's marks with
its two slots the best way, and gives found (within 0.1 field ≈ 1.2 ft),
median error in feet, swaps (pairing changed between moments). Tracker
distances now live in `VT_TRACK` {gate0, gateK, weak0, slack, smooth} (same
values as before). `vtTune(items)` tries each ×0.6/0.8/1.25/1.6, keeps what
raises found − 0.02·swaps over all marks, up to 3 rounds, restores
`VT_TRACK`, and the page shows the better settings as a line to send back
(only from ≥ 40 marked robots); they are not applied by themselves. Tests:
t146.

**v156 (app 2.33) — review screen: blank box, streaks.** Reported with
screenshots: an empty black 300×150 box, then a 300×150 box of yellow
streaks with a green box. 300×150 is a canvas left at its default size
(`c.width = cur.w` with a missing/invalid saved size) showing the picture's
corner. Now `loadFrame` sizes the canvas from `img.naturalWidth/Height`
(boxes, robots and spots rescaled if the saved width differs), hides the
canvas until the picture is drawn, and the counter says "Loading the next
frame…" while `/api/next` works. `looks_broken(frame)` (> 25% of rows the
same as the row above while not flat: a decoder smear) is skipped in
tracking and `keep_frame`; `/api/next` sets an already-saved garbled frame
aside (`broken: True`, up to 40 in a row) and reports the picture's real
size. Not reproduced on the owner's frames. Checks: desktop/dev/window.py
(18), t145.

**v155 (app 2.32) — frames the tracker labels itself.** Pseudo-labels
already joined training (4 boxes ≥ 0.6, ≤ 2× reviewed, never in val). Now
`steady_four` marks a look certain: exactly four sure boxes, colours
[1,1,2,2], no unsure box, each within 3% of the width of a box a look ago at
0.75–1.33× its width. Harvested frames carry `steady`; up to
`AUTO_PER_MATCH` 6 extra certain frames a match, `AUTO_GAP` 15 s apart, are
kept with `auto: 1` (no more than `AUTO_MAX` 1500 on disk) and skipped by
`review_queue`. `build_dataset` drops frames with `steady: 0` and takes
steady ones first. Checks: desktop/dev/selflabel.py (13), t144.

**v154 — goal counts by the game's rules.** `vtGoalPath(ser)`: Viterbi over
counts 0..max+2 (halves, ≤ 30). Emission: reading low costs 0.8 a half (a
robot in front hides pieces), high 1.0; missing looks cost nothing.
Transition: hold 0; up 1.2 + 0.4·(d−1) up to `VT_GOAL_UP` 4 a look; down
3 + (d−1) up to `VT_GOAL_DOWN` 6 (descore). Used for the nine goals in
`vtSpotCount` (loaders keep the 5-look median: they empty as used) and in
`vtPinCount` goals mode (baseline = median of the path before the start);
the field-squares count keeps its median (pins lie loose). 0.5 for low reads
put stacks a look early; 0.8 does not. `VT_REMAKE` → 154. Tests: t143.

**v153 — lookalikes.** Owner: rebuilds, and the meta robot makes many
teams look alike; plates are what tell them apart. `vtIdentify` already
named by look only within one event and only where no plate (or vision
read) settled the match. Now each entry also keeps the looks of the robots it
faced (`crowd`); a look pick is made only if the chosen robot's distance to
the team's look is below the 10th percentile of the crowd's (≥ 6 of them).
t142's meta event (opponents sharing the look) was named wrong — the
partner, in 6 of 6 — before this; now nothing is named there, and plates
still name it. Tests: t142.

**v152 (app 2.31) — the stream's score, as a check.** Owner: live scorers
make mistakes and some events show none. App: while `learn['score']` is
unknown and the job has official finals (not a tie), every 3 s all numbers on
screen (`score_text`, 1–3 digits) are kept by place; at the end
`score_spots` takes the places that showed red's and blue's official finals
in the last 40 s → `learn['score']` (per video chunk only, never uploaded)
and that match's readings. With a place known, `number_at` reads both every
second → `rec.sc` [tenths, red, blue] (−1 unreadable; server validates). A
match whose last 40 readings miss the official finals forgets the place.
Website: `vtScoreFlow` believes a value read twice running, rejects the match
if > 30% unreadable or the held value near the end ≠ official `rs/bs`, and
gives net points in autonomous and each driver third → alliance fields
`sa/s1/s2/s3`, top-level `sl: 1`. Report: "When its alliance scores" (≥ 3
such matches). Not used to change pin counts. `VT_REMAKE` → 152. Checks:
desktop/dev/score.py (8), t141.

**v151 (app 2.30) — more looks at key moments.** Asked to keep the usual
rate and still see fast teams better. `LOOKS_PER_SEC` 6 stays the least;
after a look where `key_moment` holds (a robot's foot within a goal box's own
size of a goal — goals from `spot_boxes(cur_quad, cur_placed)[:9]` — or two
robot boxes closer than a quarter of the smaller's width) the step drops to
`ceil(fps / BURST_PER_SEC)` (12 → 10 a second at 30 fps) for `BURST_HOLD`
1.5 s. Looks off the base clock (`next_base`) are marked `extra` and dropped
first, evenly, when a recording is over the 2000-look ceiling. The website
needs nothing: every look carries its time. Checks: desktop/dev/burst.py (11),
t140.

**v150 (app 2.29) — unsure boxes, whole-match slots, smoothing.** App:
up to 3 boxes with PROPOSE ≤ conf < threshold, robot-like, not IoU ≥ 0.3 on
a sure box, are recorded with conf capped below `rec.cf` (the threshold ×100;
server validates 1–100). Plates are not read on them; the app's "both
alliances seen" counts skip them. Website: `vtSure(rec, fr, o)`; `vtFrames`
puts unsure boxes in `f.weak`; `vtRecStats`, `vtLearnFrom` (scenery) and the
backfill skip them. `vtSlots` second pass (ByteTrack): a track missing ≤ 2 s
may take a weak box within 0.06 + 0.3·dt of `vtAhead`, colour matching; weak
boxes never start a track. Step 3: plate-anchored tracks first, then longest;
slot cost = look + 3 × teleport excess (distance beyond 0.1 + VT_VMAX·gap to
the pieces before/after) + 2 for a plate conflict; a piece < 3 s, no plate,
whose best slot still needs > 0.25 of teleporting is dropped. Step 4: seen
points smoothed ±0.5 s, weight (1−dt)·exp(−(d/0.03)²) so wobble goes and
real moves stay sharp (a plain window blurred t113's instant park).
`VT_VMAX` comment now 600 rpm × 2.75 in = 7.2 ft/s. `VT_REMAKE` → 150.
Tests: t139; desktop/dev/follow.py (33).

**v149 (app 2.28) — the tracker follows the camera.** The field was marked
once per stream, so a pan, zoom or close-up moved robots, pins, toggles and
goal spots off the mark. Website: Mark the field saves `t`, the moment of the
stream it was marked on (`vtMarkTime`: the match embed now has
`enablejsapi=1` and is asked by postMessage, `infoDelivery.currentTime`);
dragging goals keeps it; the server validates and stores `t` (0–200000 s).
App: `windows_of` also fetches t±3 s; `make_follow` builds a `CamFollow` from
the frame at t (or, for marks without t, the first look with 3+ robots).
Every second and after each cut, `look()` matches ORB features of the marked
picture (masked to the field and a quarter of its height above, never the
overlays) against the frame, RANSAC homography, sanity on area/convexity.
`H` changes only when the quad moves > `MOVE` 0.004. Robot boxes
(`boxes_to_marked`, by bottom-middle, size scaled by local zoom) and pin blobs
(`blobs_to_marked`) are recorded in the marked picture's coordinates, so the
website needs no change; toggles and goal spots are read at `cur_quad` /
`cur_placed` (the mark moved by H). When the field is not found 3 checks
running, or once straight after a cut, nothing is recorded (`away`) until it
is back; nothing is dropped before the field has been found once. The log
line says "camera: followed N% …, K camera moves, S s off the field left out".
`cfg['follow']` (default on) turns it off. Checks: desktop/dev/follow.py
(31, on a real stream frame: four pans/zooms within 0.6%, box feet within
0.6%, close-up and noise rejected, a stand-in match with a pan and a
close-up), t138. Not yet seen on a real stream with real camera moves.

**v148 — robots followed by speed and heading.** Asked: "can't it get more
accurate by predicting trajectory from speed and stuff". `vtSlots` step 1:
each track keeps a smoothed velocity (`vtTrackAdd`, 0.6/0.4, capped at
`VT_VMAX` 0.6 field widths/s, reset after a 1.5 s gap) and is looked for at
`vtAhead` (last place + velocity, up to 1 s ahead) inside the old gate; all
track–box pairs of a look are sorted by cost and taken cheapest first (was:
each track in turn by recency). Two same-alliance robots that overlap show as
one box: the track left without a box follows it too (no point pushed, so it
stays unseen) for up to 4 s, and neither track's velocity is updated from the
merged box (`merged`), so they come apart the right way. Step 4: a gap of up
to 3 s is filled along the line between sightings (unseen), not held at the
last place. `VT_REMAKE` → 148 so every device remakes summaries. t137 (an X
crossing with a merged box fails on v147, passes now).

**v147 (app 2.27) — the app window froze.** Reported: "the app is kind of
frozen i cant really click into settings or anything". `quad_for` did not
remember a video with no field marked, so `pieces_queue` asked the website
about it once per saved frame, and `/api/state` (polled every second with
`setInterval`, not waiting for the answer) recomputed that every 20 s in the
request thread; asks piled up past the browser's six connections per host and
clicks queued behind them. Now: unmarked videos are cached like marked ones
(10 min), a website error keeps what was known and backs off, `pieces_queue`
asks once per video, review/pin counts are worked out on a background thread
(`later`, one at a time) and the status returns what is counted already
(`wait=True` only for the review screens' first list), the window's poll
waits for each answer (`tick`), and a pin frame just marked leaves the list
at once. Training starts from YOLO11 (`newest_yolo`: yolo11n for robots,
yolo11s for pins, falls back to YOLOv8; ultralytics < 8.3 is upgraded);
ONNX output is still [1, 4+classes, 8400], so the website reads it unchanged.
Checks: desktop/dev/window.py (13), t136.

**v146 — "it just says its not timed yet now".** The My team table read
summaries from before v145 (only the report ran `vtSumsRefresh`); now
`vtCoachFill` refreshes stale ones too and redraws, and the cell says why a
time is missing. `vtPinPick` keeps the field count's `vs/vh` when the goal
count has no `ovs/ovh`. `vtVisitAdd` accepts the credited robot up to 0.5
field widths from where the pins showed up. `VT_REMAKE` → 146. Not seen on
the owner's data (the live API is not reachable from the build machine).
Tests: t135.

**v145 — stacking timed at the goal.** Reported: "5 pins … about 103 s" while
the team stacks 5 in 20–30 s. Pins are seen only after the robot leaves the
stack, in one lump per visit, so the gaps between sightings (`cy`) were
mostly driving. Now each credited gain also finds the robot's visit to that
spot (`vtVisitAdd`: the robot's closest point to the gain in the 12 s before
the sighting, then as long as it stayed within `VT_VISIT_R` 0.1 of there,
before and after, 1.5 s unseen allowed; one visit's time counted once, capped
`VT_VISIT_MAX` 25 s) → per robot `vs` (seconds at the goal in visits
that added pins) and `vh` (halves added); goal count `ovs/ovh` (mapped by
`vtPinPick`), the trained finder's spot count too. `vtStackPace(rows, fix)` =
vs / (vh·fix/2), from 3 pins. Five pins = 5 × that, else the fastest window
(k*); the gap-based "about" figure is gone. Table: "N s" + "a pin every X s at
the goal"; Scoring line "5 pins in N s · X s a pin". `VT_REMAKE` → 145.
Tests: t134.

**v144 — app 2.26: no blank review screen.** The owner's screenshot showed the
robot review with a black 300×150 canvas and no counter: `/api/next` either
failed (an exception dropped the connection, the window's fetch threw, nothing
was shown) or the picture failed to load. Not reproduced here. Now the window
server wraps do_GET/do_POST (`_get`/`_post`) and answers `{error}` with a 500
and a log line; the window shows "Could not load a frame: …" with Try again
(`revTrouble`); a picture that fails to load sets that frame aside (saved as
skipped) and moves on (`loadFrame`). If it happens again the message says why.
Tests: t133.

**v143 — app 2.25: mark pins & cups by clicking** ("can it have me select a
color and i click a point on the pin and cups"). In Mark pins & cups, a click
inside a dotted spot (not on a box) places a box of the chosen class centred
on the click, sized from `spot_units` (px per field width at that spot, sent
as a 5th number on each spot): halves 70×95 mm, cups 95×165 mm. Click on a box
removes it; a drag still draws an exact box; a click outside spots flashes why.
Tests: t132.

**v142 — app 2.24: an old pin finder is not loaded.** A pin & cup finder trained
before 2.22 (whole frame, 1280) cannot read the 320 goal/loader crops;
`pieces_ready()` now needs `size == PIECE_SIZE` in pieces_latest.json (written
by training since 2.24), and a previous finder is only kept if it is the same
kind. Nothing is deleted: robot reviews, pin & cup marks and published robot
finders are untouched; old marks outside the goal/loader spots are simply not
used for training.

**v141 — goals and loaders dragged into place (app 2.23)**
Reported with a picture: "these are very clearly not the goals...". Goal
columns from four hand-clicked corners + the manual's layout landed beside
the goals (a near-side corner a few % off moves a goal off its base). The
layout itself was checked against the owner's Excalibur frame: with the goal
feet read off the picture, every goal sits where the drawing says, within the
corner error.
- Field marking now has a second step, `vtMarkSpots`: 9 yellow + 4 pink
  circles (drawing positions, or the last saved ones) to drag onto each goal's
  base and each loader; Done saves `g` (18 numbers) and `l` (8) with the
  corners (`vtFieldSet(vid, q, by, {g, l})`, kept when only corners are marked
  again); Skip keeps the drawing's. Server stores/validates g and l.
- `vtGoalColumns(q, turnK, aspect, placed)`: foot at the placed point (raw
  spot nearest the un-turned goal), size still from the corners.
- App: `spot_boxes(W, H, q, placed)`; `_QUADS` holds {q, g, l, at}, refetched
  after 10 min (`quad_for`), `placed_for(vid)`. Spot heights raised (goals
  0.30, centre 0.38) for tall stacks seen from the far end.
- **The owner needs to place them once per stream** (Jumper → Mark the field).
- Tests: t131; desktop/dev/pieces.py +3.

**v140 — pins & cups only on goals and loaders; cups and match-load speed (app 2.22)**
Owner: "it doesnt need to track stuff on the field only in the goals for pin
and cups. maybe matchloader too to count matchload speeds."
- App `SPOTS`: 9 goal columns + 4 corner loader columns in the marked square
  (u, v, half-width, height, depth in field widths); `spot_boxes(W, H, q)`
  projects them with `quad_fwd`. Goal feet checked against the owner's
  Excalibur frame (they land on the goal bases). **Loader spots are a guess
  (corners, on the perimeter) and unchecked.** The goal set looks the same
  turned a quarter, so the app stays turn-agnostic; the website maps spots
  with turnK (`VT_SPOTS_RAW`, same order — t130 checks).
- Review "Mark pins & cups": only frames whose video has a field mark
  (`quad_for`, cached in data/quads.json, fetched from `?field=`); spots drawn
  dotted; colour proposals only inside spots; marks outside spots are ignored
  for training. Earlier full-frame marks still count (filtered to spots).
- Training: `build_pieces_dataset` writes one crop per spot per marked frame
  (empty spots included); yolov8s at 320, batch 32. `PieceFinder.find_spots`,
  `spot_counts` → [red, blue, yellow halves, cups] per spot (-1 off-picture).
  Scored within spots vs the colour finder; used only if better.
- Tracking (finder in use + quad known): every second `rec['gs'] += [tenths]
  + 13×4`. The full-frame `cu`/`pf` path from v135 is gone (pins on the
  field keep using the colour finder for `pn`).
- Website `vtSpotCount(rec, turnK, track, ph)`: per spot per class, median of
  five looks; a change counts once it holds for three looks; rises credited
  to the nearest robot within 0.22 (own-colour halves only to that alliance;
  yellow and cups to anyone) over the 8 s before; falls on goals → `kn`
  (knocked off). Loaders: pieces = halves/2 + cups; falls credited to that
  alliance's robot within 0.3 → `ld`, and `lds` = median seconds between loads
  in one visit (≤10 s apart). End state → gy/gr/gb (absolute, i.e. what scores)
  and `gc` cups, `gs: 1`. Replaces the colour goal count's fields (oy, oa,
  oya, ocy, ot5, n*) when present, so `vtPinPick` compares it with the field
  count against official scores. Report: "· N cups" in Scoring, a "Match
  loads" row. `VT_REMAKE` → 140.
- Tests: t130 (24), desktop/dev/pieces.py rewritten for spots (15).

**v139 — five pins always has a figure; a real-time autonomous replay**
- "the scoring doesnt show how much anymore for 5 pins": when no match has a
  stretch of five pins (`vtFastFiveOf` null — likely more often with the
  goal count), the Scoring line and the My team table show "about 5 × pace"
  from the timed pace, marked "about".
- "have it literally replay on like the same field format type as the
  heatmap": the replay is the robot (a box to scale, 18 in) on the same field
  drawing, driven by `vtReplayPlay` with requestAnimationFrame in real time
  (15 s), a trail behind it and the autonomous clock counting down; no SMIL.
  Points in `data-pts` on the svg. Still only for a routine it repeats.
  Tests: t129.

**v138 — drawings on phones** ("some things dont show up on mobile like the
heatmap"). SVG colours were given as `fill="var(--x)"` presentation
attributes; Safari (iPhone) does not resolve CSS variables there, so the heat
map, goals, toggles, replay and the stat radar drew in no colour. All moved to
`style="fill:var(--x)"`; t128 keeps any `="var(` out of the page. `.vr-grid`
columns no longer force 300 px on narrow phones. Chromium rendered fine, so
this is the likely cause but was not seen on a real iPhone (no WebKit here).

**v137 — short Scoring line** ("way too much info for scoring"): `vtPinLine`
returns `short` ("4.0 yellow halves a match (±21%) · a pin every 15 s · 5 pins
in 32 s"); the report's top Scoring line (`B.speed`) uses it; the full sentence
sits under "Everything it measured" as "Scoring, in full". Strength/weakness
pin lines shortened too. Tests: t127.

**v136 — pins counted on the goals; each event uses the closer count**
Owner: "pins and cups can also only be scored in set spots" → "build".
- `vtPinCount(..., mode)`: mode `'goals'` counts at the nine goals
  (`VT_GOALS_FIELD`, red's wall left, from the manual drawing) instead of the
  8×8 field squares. `vtGoalColumns(q, turnK, aspect)` projects each goal's
  foot with `vtHomographyFwd` (un-turning `turnK`) and sizes a column
  (`VT_GOAL_HALFW` across, `VT_GOAL_TALL` = 0.3 field widths up, a little
  below the foot). `vtGoalLook` takes only UPRIGHT blobs (h ≥ 0.6·w) whose
  foot is in a column, nearest column wins, halves by area as before. Steps
  2–3 (smoothing, baseline, credit) are shared; spots carry `spotU/V`.
- Summaries keep both: per robot `oy, oa, oya, ocy, ot5, n4…n40`; top level
  `gy, gr, gb, gk, oer, oeb`. `VT_REMAKE` → 136.
- `vtPinPick(sums)`: per event, if the goal count's `vtPinCheck` error is
  lower than the field count's (or only it can be checked), the goal fields
  are copied over the field ones in a new Map (originals untouched) with
  `goalEvents`. Applied at the end of `vtTeamSums` and per team in
  `vtTeamSumsMany`, so every report reads it unchanged. Check text says
  "Counted on the goals".
- **Not checked on real footage**: goal positions, column sizes and the
  upright rule are estimates; the official-score check decides per event.
  Cups (`cu` from the app's trained finder) are still not used.

**v135 — marking pins & cups, and a finder trained on them (app 2.21)**
Asked: "how can i make it recognize pin and cups?" → "build it".
- Review card has a second button, **Mark pins & cups** (`openReview(true)`,
  `pm`): frames whose robots are reviewed (not skipped), queued alternating
  videos (`pieces_queue`). Pre-drawn: the trained finder's guesses once it is
  in use, else `pieces_from_colour` (the colour blobs as frame boxes). Classes
  `PIECE_NAMES` = red half, blue half, yellow half, cup — one box per pin HALF
  (matches how scoring counts). Keys 1–4 pick the class, wheel zooms, robots
  shown dashed. Saved in the frame's label file as `pieces` ([x,y,w,h,class])
  or `pskip`; `lab_write` merges so robot saves / website labels keep them.
- Train: `train_auto` now trains the pin & cup finder when ≥`PIECE_NEED` (60)
  frames are marked, even if robots are short of 150. `do_train_pieces`:
  yolov8s at 1280, 150 rounds, patience 30; scored by `score_pieces` (same
  class, IoU ≥ 0.3) on held-back marked frames against the colour finder and
  the current trained one; copied to `models/pieces.onnx` and `use: true` in
  `pieces_latest.json` only if its pin-half F1 beats both.
- Tracking: `Eyes.pieces` (`PieceFinder`) replaces `pin_blobs` when in use,
  giving the same blob shape (area ≈ 0.55·w·h), no boxes on robots; cups go
  into the recording as `cu` [tenths, n, (x, bottom, w, h)…] at 960 wide, and
  `pf: 1`. `validRec` accepts both. **The website does not use `cu` yet.**
- Tested: `desktop/dev/pieces.py` (23 checks, stand-in ONNX finder) and the
  window driven in Chromium. **Not tested: real training, real accuracy.**
- App-only: the website's own tab tracker still uses the colour finder.

**v134 — fastest five pins; speed with identical answers**
- Reported: "48 seconds is way too slow for 5 pins, this team has proven to
  stack 2 full 7 pin stacks in under 50 seconds alone". `t5` was the time from
  the start of driver control to the fifth pin. Now `vtFastWindows(ev, driver)`
  stores per robot `k4…k40` (`VT_FAST_N`): the shortest time in which N more
  counted halves went down after a set-down (or after driver control starts;
  set-downs <0.5 s apart merged). `vtFastFive(row, fix)` reads the window for
  10 / fix counted halves (fix = the official-score correction), between the
  two nearest sizes; `vtFastFiveOf` = median over matches (≥2). Used by the
  My team table and the report. `t5` is still stored but no longer shown.
  `VT_REMAKE` → 134 so every device remakes summaries.
- App 2.20 speed, all checked identical against 2.19 by `desktop/dev/same.py`
  (317 comparisons on the real frame and synthetic ones, 0 differ):
  `pin_blobs` 3–4× (per-pixel max/min by `np.maximum` chains, not
  `.max(2)`), `plate_tilts` ~5× (box fitted to the convex hull, angles
  vectorised), `Eyes.read_many` reads strips in one call on a graphics card
  (plate ways, and `scan`'s lines), the vision model and the upload run in a
  background thread while the next match is tracked (`work_chunk.finish`).
- `tools/build.mjs`: `minifySyntax: true` (names still kept): 616 KB.

**v133 — a vision model on the tracking computer (free), UNTESTED WITH A REAL MODEL**
Asked: "work on building for the open vision model that's free with no fees".
- App 2.19, off by default (Settings → "Vision model"). Turning it on runs
  `--think-setup`: `ensure_ollama` (winget, else Ollama's installer, on
  Windows) and `ensure_think` (pulls `THINK_MODEL` = `qwen3-vl:8b`, ~6 GB, with
  the progress bar). `cfg['think_model']` / `['think_looks']` override.
- `track_match(..., think=N)` keeps N frames (default 6, spread through the
  match, two or more coloured robots) as JPEGs from `think_picture`: the frame
  with robots outlined and numbered, and each robot enlarged underneath.
  `think_match` asks Ollama (`/api/chat`, `format` = a JSON schema, `think`
  off, temperature 0) for each robot: `plate` ∈ the four teams or
  "unreadable", `doing` ∈ `THINK_DOING`. Guards: a number given to two robots
  counts for neither; a plate of the wrong alliance for the box's colour is
  dropped; three failures and it stops asking.
- Stored in the recording as `vo`: 5 ints a robot a look [tenths, box x, box
  y, doing 0-8, plate 0-4] (`validRec`, ≤600). The model's plate reads are NOT
  written into the boxes' `who`: they are kept apart.
- Website: `vtFrames` returns `acts`; `vtSeenJoin` gives each to the slot at
  that spot → per-robot `v1..v8` (counts) and `xa`/`xb` (vision plate votes).
  `vtIdentify` uses them only when the reader has none: ≥3 and clear by 2,
  `how: 'vision'`. Report: "Seen doing" bars (`vtReportSeen`, ≥8 looks, own
  robot only), labelled as the model's and fallible.
- Tested: `desktop/dev/think.py` against a stand-in Ollama (18 checks), t123
  (28). **Not tested: a real Ollama install, a real model's answers, speed,
  or whether its "doing" picks are any good.** First real run is the owner's.
- `VT_REMAKE` not raised: old recordings have no `vo`.

**v132 — slanted plates, a timed pace, old matches re-read anywhere, heat contrast, no comments in the served page**
- **First clean real frame** (Excalibur 2026, a corner camera, kept as
  `tests/fixtures/plate_tilt.json`): detector found all 4 robots; clock and
  scoreboard text read; **no plate read** — plates are ~55×35 px and slanted.
  `vtPlateTilts`/`vtPlateStrip` (app: `plate_tilts`/`plate_strip`) find each
  solid patch of plate colour, fit the smallest box round it (every 3°),
  resample it level (bilinear, both ways up, pads `1.3` and `1.15` along it,
  none in height) and read it; the patch's colour narrows the answer to that
  alliance's two teams. On the frame: 66449A read ("8449A", 0.8) at full, ¾
  and ½ size; the other three robots' plates were not legible. Website and
  app agree to the pixel (`desktop/dev/plates.mjs`). One robot's colour was
  still read as none (blue plate, top-left) — not fixed.
- Identity already also used: the partner by elimination and the look that
  recurs across a team's matches (`vtIdentify`). Nothing new there.
- `vtPinCycle`: seconds a pin, timed between set-downs (median), stored as
  `cy`. The divided figures (time ÷ pins, `105 / pins`, "points per 10 s of
  stacking") are gone.
- `rv: VT_REMAKE` on every summary; `vtStale`. `vtSumsRefresh` re-reads stale
  summaries on ANY device from the shared recordings when a report opens
  (4 at a time, 40 a visit, saved locally, shared with the admin key).
  Bump `VT_REMAKE` whenever `vtSummarise` measures something new.
- Heat map: colour only above the average square; flat → nothing.
- `tools/build.mjs` (esbuild: whitespace only, names kept): 978 KB → 626 KB,
  296 → 179 KB gzipped. The harness boots the built page, so the whole suite
  runs against what is served (`VS_SRC=1` boots the source).
- Owner confirmed: the driver-station side is the wall with the alliance's two
  loaders (red: left wall), as assumed. LLM idea dropped unless free; a local
  open model on their card would be free but was not built.
- App 2.18. Tests: t122.

**v131 — the report says what was asked for; the app's bar is real** (asked:
"i also dont want to know their autonomous route just the amount of pins. and
toggles switched to their color. make an actual heatmap and for role and
stradegy just pu the amount of time scoring on alliance goals, neutral goals,
and going for toggles, or sitting at their own toggle … replay auton only for
an auto they consistently do … remove how to use this" and "the progress bar
doesnt move … actual progress bar with estimayted countdown").
- `vtGame` adds per robot: `ga`/`gn` (share of driver control within
  `VT_GOAL_R` of its alliance's goals / a neutral goal, toggles excluded),
  `sd` (1 = starts in its drivers' quadrant, 2 = elsewhere) and an 8×8 heat
  grid `g0..g63` in thousandths, zeros left out. Goal positions are
  `VT_GOALS_OWN/OPP/NEUTRAL`, read off the manual's field drawing in the own
  frame. **Not checked against real footage.** `validSum` allows 200 fields
  per robot. Old summaries are remade by themselves (the `ga === undefined`
  clause in the remake loop); until then the report falls back to the 5×5 grid
  and shows "—" for goal time.
- `vtToggleAuto(rec, ph)` → toggles that are a colour at the end of autonomous
  and were not before the match; stored as `tga` on both robots of an alliance
  (the tracker cannot say which robot turned it; the page says so).
- `vtAutoFacts`/`vtAutoText`/`vtAutoSide`: pins, toggles, start side. Used by
  the My team table (no route any more), `vtBrief` and the report.
- `vtAutoReplay(rows)`: a routine is ≥3 matches and ≥60% whose six-point paths
  stay within 0.125 of each other; returns their average with timings, else
  null. `vtReportAuto` draws the replay (SMIL `<animate>`, started by
  `vtReplayPlay`) only then; with no routine there is no replay markup at all.
- `vtReportRole`: four bars (alliance goals, neutral goals, going for toggles,
  own toggle) and the toggle-fight lines; the Toggles, Autonomous routines and
  How to use this sections are gone. `vtFieldSvg(heat, paths, replay)` draws
  the real field (goals, toggles, loaders) and a blurred single-hue heat map.
- **"Driver-station side" is a guess**: the user defined it as "the side with 2
  match loaders"; taken to be the triangular quadrant on the alliance's own
  wall. Asked the user to confirm.
- App 2.17: `progress(stage, done, total, wait, minor)` prints `@@P {json}`
  lines when `VEX_UI` is set; `Job.note`/`Job.progress` turn them into share
  done and seconds left (pace since the stage was first seen); `/api/state`
  carries `progress`. Window: real bar + "N of M · %" + time left; a moving
  stripe when there is nothing to measure; no bar while waiting for work, with
  the seconds until it looks again.
- Tests: t121.

**v130 — toggles, part-downloads, and a one-press field mark** (asked: "add
1, 4, 6" from the list in v129's reply).
- **Toggles (1).** `vtTogglePoints` lays 24×5 points above the middle of each
  wall (lifts 0.035–0.085 of a field width × the local picture scale; forward
  homography `vtHomographyFwd`), `vtToggleLook` records red% and blue% per
  wall every 2 s as `rec.tg` (9 ints a look; `validRec` allows it), needing the
  field's corners AT CAPTURE (`slot.quad`; the app asks `?field=VID`).
  `vtToggleRead` decides at the end of the match (≥8% and 2× the other), maps
  walls to quadrants through the same quarter-turns as everything else.
  Summary: `tw` (owners, base 3), `er`/`eb` (each alliance's pins: 5 × own
  halves + 10 × yellow in quadrants it holds + midfield yellow if it has more
  robots there), `mr`/`mb`. `vtPinCheck` adds `side`: each alliance's
  corrected estimate + midfield + half the auto bonus against its real score,
  median error, ≥4 matches — so a wrong reading shows up as a large number
  rather than hiding. Red/blue patches at wall middles are no longer counted
  as pins. App: `quad_fwd`, `toggle_look`; both give the same eight numbers on
  the same picture. **The band's place is derived, not observed**: the one
  real frame is too blended to check it. First thing to verify on real video.
- **Part-downloads (4).** YouTube's DASH mp4 starts ftyp · moov · sidx; the
  sidx lists every ~5 s segment's size and length. `parse_index` reads it from
  the first 2 MB, `needed_ranges` picks segments overlapping each job's window
  (off −120 … +450 s), `fetch_parallel(ranges=, head=)` writes ftyp+moov
  (`strip_index`) then the segments back to back: a valid shorter fragmented
  mp4. `VID.mp4.have.json` records `spans`; `Video` turns stream time into
  file time (file time has no gaps; the reader reports time from the first
  span's start) and gives nothing outside the spans. Tested on an
  ffmpeg-made DASH file through a local range server (`desktop/dev/sparse.py`):
  29% of the bytes, frames identical to the whole file's. First tried leaving
  segments at their own offsets with holes: ffmpeg cannot seek across holes.
  Whole file when ≥80% is needed anyway, or the format has no sidx.
- **Field mark (6).** Finding corners from the picture was tried two ways on
  the owner's frame (floor grey; flood from the centre stopped by white walls)
  and both were wrong — grey shirts, white floor tape — so NOT shipped as
  automatic. Instead `vtMarkField` draws the outline the tracker already has
  (`vtQuadGuess`, from where robots drove) and offers "It is right: keep it";
  otherwise four clicks as before.

## 33. Feature ideas

`IDEAS.md` holds the list of things worth building next, with what each one
would cost against what already exists. It also records three things **not** to
build, and why — all three have already cost a release.
