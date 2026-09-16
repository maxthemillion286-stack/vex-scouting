# Features worth building next

Written at v58, after an optimise-and-audit pass. Ordered by how much each one
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

## 3. Real URLs

The app is one page with no addresses. That is why `vsNav` had to be built by
hand, and why you cannot send someone "look at 66449A at this event".

A hash route — `#/event/55001/team/66449A` — would give shareable links, real
browser Back and Forward for free, and a refresh that lands where you were
instead of at the top. `vsNav`'s restore closures are most of the work already
done; this turns them into something the URL bar can express.

## 4. Compare teams side by side

Pick two to four numbers, get one table: rank, record, average score, AWP rate,
skills, TrueSkill. Alliance selection is exactly this comparison made under time
pressure, and right now it means opening three cards and remembering.

## 5. Download this event for offline

The service worker caches what you have already opened. An explicit **download**
button — roster, full schedule, rankings, skills — would mean the schedule still
works in a gym with no signal, which is most gyms. The memo and the API cache
make this mostly a matter of pre-fetching the same five calls on purpose.

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

## 11. Jumper: resume where you left off

Remember the playback position per match, and offer **next match** at the end of
one. Watching your own six quals back should not mean scrubbing six times.

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
