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
| sanity | CSS braces balance, inline JS parses, tabs present |
| tool_sanity | Same for anchor-tool.html |

**A caveat that matters:** jsdom has no layout engine. `getBoundingClientRect`
returns zeroes, so t43 and t45 verify that the cascade resolves and that the
arithmetic fits — they **cannot** prove two boxes stopped overlapping. Check
layout changes in a real browser at a narrow width.

Also: several older tests asserted on `doc.body.innerHTML`, which produces false
positives because the app's own source sits inside a `<script>` tag. Scope
assertions to a results element instead.

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
