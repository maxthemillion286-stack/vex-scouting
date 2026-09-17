# Features worth building next

Written at v58, after an optimise-and-audit pass. **5 and 11 were built in v59**
and are struck through below. **3 was built in v59 and removed in v60** — what
it did and what it cost to work out is kept with it, in case it is ever wanted
again. Ordered by how much each one
would change a Saturday at an event, not by how hard it is. Everything here is
costed against what already exists — most of them are re-using a number the app
already computes.

---

## 1. Tell me when I'm queuing, even when the app is closed

**The app already knows.** The team view computes `next.away` (how many matches
ahead of yours) and sets `queueNow` — it just only says so while that one view
is on screen. If you are in the pits with the phone in your pocket, it never
reaches you.

A web push notification at *N matches out*, with N a setting (default 3), plus a
second at *queue now*. The service worker is already installed and already wakes
on `visibilitychange`; this needs a push subscription and a small Vercel
function to fire it, or — much simpler and probably enough — a foreground-only
version using the Notifications API while the tab is open in the background.

**Start with the foreground version.** It is about thirty lines and covers the
common case (phone locked, tab still open).

## 2. My own scouting notes

The app reads RobotEvents. It cannot record what *you* saw — tips over on
contact, good descorer, slow cycle, drops loads under pressure. That is the
thing a scouting app is for, and it's the biggest gap in this one.

Per team, per event: a few tags and a free-text line, stored in IndexedDB (the
Jumper's `idbSet`/`idbGet` already exist), shown on the team card and in the
pick list, and exported as text so you can hand it to a partner. Notes should
survive a season and show up the next time you meet that team.

## 3. Real URLs — built in v59, removed in v60

The app is one page with no addresses. That is why `vsNav` had to be built by
hand, and why you cannot send someone "look at 66449A at this event".

A hash route — `#/event/55001/team/66449A` — would give shareable links, real
browser Back and Forward for free, and a refresh that lands where you were
instead of at the top. `vsNav`'s restore closures are most of the work already
done; this turns them into something the URL bar can express.

**Built and then taken out again.** v59 put `#/event/55001/team/66449A` in the
bar, one-to-one with the nav keys, with the arrows driving `history.go()` so
there was one history rather than two, and pasted links opening cold. It worked
— t92 drove all of it — and it was removed in v60 because it was not wanted.

If it comes back, the two things that cost the most time to work out are worth
knowing:

* The opening address must be read **at parse time**. The boot steps rewrite the
  bar within milliseconds — `restore tab` switches to whichever tab you used
  last and `nav history` records it — so by `window.onload` the link that
  brought you here is gone.
* Drive the browser's history rather than keeping a second stack beside it.
  `vsNav` already holds restore closures; let the arrows call `history.go()` and
  have `popstate` replay the matching closure. Any other arrangement lets the
  arrows and the browser's own Back button disagree about where you are.

The code is in the v59 commit if it is ever wanted again.

## 4. Compare teams side by side

Pick two to four numbers, get one table: rank, record, average score, AWP rate,
skills, TrueSkill. Alliance selection is exactly this comparison made under time
pressure, and right now it means opening three cards and remembering.

## ~~5. Download this event for offline~~ — built in v59

The service worker caches what you have already opened. An explicit **download**
button — roster, full schedule, rankings, skills — would mean the schedule still
works in a gym with no signal, which is most gyms. The memo and the API cache
make this mostly a matter of pre-fetching the same five calls on purpose.

**Shipped.** A SAVE OFFLINE button on every event view; the save runs the app's
own calls and keys each page body by the path that produced it, so `apiGet`
falls back to it with no endpoint list to maintain. Stored in IndexedDB rather
than the trimmed service-worker cache, and a saved copy answers on the FIRST
failure rather than after thirty-one seconds of retries. See HANDOFF § "Saved
for offline".

## 6. Live alliance selection

The pick list exists. During selection it should update as picks happen: cross
out teams as they are taken, recompute what is left, and show who is likely gone
before your turn comes. The bracket view already reads the alliance list from
the API, so the data is there.

## 7. A printable match-day sheet

One page: your next three matches, partners and opponents with their callouts,
your record, what you need for a rank. Paper still beats a phone in a pit at a
signature event.

## 8. "What score gets me in?"

The skills ladder says where you stand. It should also say what combined score
would move you above the cut — the standings are already loaded, so it is one
lookup into a sorted array.

## 9. Season trend for a team

Rank, TrueSkill and skills across every event this season, as one line. Useful
for a team you are thinking of picking: are they improving, or was one good day
in October doing all the work?

## 10. Event finder

Search events by region and date range rather than by name or SKU. "What's near
me in the next month" is a question the app cannot currently answer, and the
RobotEvents API answers it directly.

## ~~11. Jumper: resume where you left off~~ — built in v59

Remember the playback position per match, and offer **next match** at the end of
one. Watching your own six quals back should not mean scrubbing six times.

**Shipped, with one part still open.** Prev / next buttons with a position
counter, greyed out at the ends; a tick on every match you have opened; and a
"pick up there" row when you come back to an event. What is NOT done is the
position *within* a match — the embed is a plain `<iframe>`, and reading a
viewer's current time needs the YouTube IFrame API, which would only ever work
for YouTube and not for Vimeo or VEX TV. Worth doing only if scrubbing within a
match turns out to be the part that still hurts.

## 12. Venue mode

Bigger type, higher contrast, fewer things on screen — for reading a phone at
arm's length across a pit, in a gym with bad light. Theming already goes through
CSS variables, so this is a class on `<body>` and a few overrides.

---

## Not recommended

* **Accounts and a server-side database.** The whole app is one HTML file and a
  proxy; everything valuable about it — no build, no deploy story, works from a
  cache — comes from that. Notes and preferences belong in IndexedDB.
* **Scraping events.vex.com for anything.** §2 of HANDOFF.md: Vercel's IPs are
  blocked and every attempt has cost a release.
* **More YouTube search routes.** §3: the quota is 10,000 units a day and
  `search.list` is 100 of them. A wrong video is worse than no video.
