# VEX Scout — handoff

Written for whoever (or whatever) picks this up next, including Claude Code
with no memory of the sessions that produced it. Read this before changing
anything in the Jumper or `api/proxy.js`; several of the bugs below were fixed,
regressed, and fixed again because the reasoning wasn't written down.

Current release: **v19**. Everything green: 25 test files, 316 assertions.

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
| t88 | Back / forward through where you have been |
| t87 | The team page: best result, phone layout |
| t86 | **Why Maker Faire never auto-found — blended grades, the game name, field-prefixed titles — and a search that explains its refusals** |
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

To make something navigable, call `vsNavPush(key, label, restore)` from the
place that performs it, after it renders. Same `key` twice in a row is not a
move. Going somewhere new from halfway back drops what was ahead, like a
browser. Greying out is the `disabled` attribute, never a class, so an arrow can
never look dead and still work.

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
