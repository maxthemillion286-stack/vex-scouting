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

## ~~6. Live alliance selection~~ — mostly built in v66

The pick list exists. During selection it should update as picks happen: cross
out teams as they are taken, recompute what is left, and show who is likely gone
before your turn comes. The bracket view already reads the alliance list from
the API, so the data is there.

**Mostly shipped.** `TOURNAMENT ▸ PICK LIST` projects the whole selection from
the seeds and the ratings, says where your team lands and who would call it, and
ranks your best available partners. What is still open is the *live* half —
crossing teams off as picks actually happen, which needs the API's alliance list
polled during selection.

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

# A second batch, asked for at v64

The list above was written at v58. These are new, and none of them overlap it.
Same ordering rule: how much it would change a Saturday, not how hard it is.

## 13. A screen for the match you are about to play

Not a list — **one screen, one match.** Your partner, both opponents, each with
their callouts and True Skill, your win probability, and the clock. Nothing
else on it.

The team view computes every part of this already and then buries it in a
scrollable schedule, so between matches you are scrolling to find the thing you
most need. This is the single highest-value screen the app does not have, and it
is mostly a re-layout of `md-next` and `md_teamBlock` at full size.

Pairs with §1: the notification tells you to look, this is what you look at.

## 14. Scouting notes that reach the rest of the team

§2 gives one person notes on one phone. Scouting is three people in the stands
splitting the field.

No accounts and no server — the app should stay a single file. A **share code**
would do it: notes for one event serialised, compressed, and shown as text to
paste or a QR code to scan. Import merges by team and timestamp, newest wins.
That is a self-contained feature with no backend, and it turns a solo tool into
a team one.

## 15. "If I win my last two, where do I finish?"

The app already projects your **record**. The question teams actually ask on
Saturday afternoon is about **rank**, and it is a much better question: run the
remaining schedule for every team, not just yours, and report the band — "win
both and you finish 3rd–5th; lose one and it is 9th–14th."

Everything needed is loaded: the rankings, the remaining matches, and a win
probability per match from True Skill.

## 16. Standings that show the tiebreakers

V5RC ranks on WP, then AP, then SP. The app shows rank and record, which means
two teams on 6–2 look identical when one of them is four places higher and
cannot be caught.

Add the columns, and mark which tiebreaker is currently deciding your position.
It is the difference between "we are 8th" and "we are 8th and one autonomous
win from 5th".

## 17. Tell me what changed

The live tick already refetches rankings and matches every 30 seconds and then
silently redraws. It knows the previous copy, so it could **diff** it:

* your Q14 moved 40 minutes earlier
* you dropped from 4th to 7th
* an opponent in your next match was swapped

A quiet line at the top of the view, dismissable. This is nearly free — the data
is already in hand twice — and a rescheduled match you did not notice is the
single worst thing that can happen to you at an event.

## 18. Head to head

Two team numbers → every match they have played against or alongside each other
this season, with scores. Alliance selection and elimination prep both turn on
this, and it is one filtered pass over data the Simulator already loads.

## 19. A skills run log

RobotEvents posts skills scores after the fact. During the event you want to
know what you have actually put up, and whether the next run needs to beat
something specific to move you up the ladder.

Log attempts yourself, compare against the live standings, and show the target.
Fits beside the ladder that already exists in the Scout card.

## 20. Who is likely to pick you

The pick list ranks who **you** should pick. The mirror question decides your
Saturday: if you are seed 9, which alliance captains above you would want you,
and roughly when should you expect to be called?

Same ratings, run the other direction.

## 21. A watchlist in the Jumper

Mark matches worth reviewing while you are still at the event — a scoring
mistake, a robot you want to see again — then walk the marked list at home.
v59 added per-match ticks and prev/next, so the storage and the stepping are
already there; this is one more flag and a filter.

## 22. Export everything

Your notes, saved events, Jumper anchors and settings, out as a single file, and
back in again. Cheap insurance for a tool that keeps everything on one device,
and the only way to move to a new phone without losing a season.

---

# Competition features, not app features

Asked for at v65: things that help you **at a VEX event**, rather than more
plumbing for the website. Everything below is derivable from data the app
already loads — worth stating, because it is easy to design a feature the
RobotEvents API cannot feed.

**What the API actually gives**, confirmed against the code:
`match.autonomous_winner` (which alliance won auton, per match),
`alliance.autonomous_win_point`, and per-team `wp` / `ap` / `sp` / `high_score`
in the rankings, plus every match score. That is a lot more than final scores,
and it is what makes most of these possible.

**What it does not give**, so do not design for it: element-by-element scoring,
penalties, defensive play, or anything separating the driver from the robot.

## 23. Find the undervalued picks

The classic alliance-selection mistake is picking by event rank. A team with
**top-ten skills and a mediocre qual record** is usually a good robot that drew
bad partners — the best second pick in the room, and the one nobody else has
noticed.

The app already has all three numbers per team: event rank, skills rank and
True Skill. The feature is the *disagreement* between them, sorted by how large
it is. "Ranked 22nd, skills 4th, True Skill 6th — this is the pick."

## 24. Auton specialists

An autonomous win point is **two ranking points**, the same as winning the
match. A partner who reliably wins auton is therefore worth more than one who
scores ten more points, and nothing in the app says who those teams are.

`autonomous_winner` is on every match, so per team you can have: auton win rate,
AWP rate, and whether it is trending up. Then sort the roster by it. This is the
single most decision-relevant number in VEX that the app does not currently
surface per opponent.

## 25. Auton call for your next match

Same data, pointed at one match: your alliance's auton record against theirs,
as a probability. It answers the question actually asked in the queue — do we
run the AWP route or the safe one?

## 26. Does this team fade?

Every match score, in time order, is loaded. Some teams start strong and drop
after lunch (battery, driver fatigue, a part working loose); some climb all day.
A sparkline per team, and a tag — **improving**, **steady**, **fading** — from
the trend across the day.

At 2pm on a Saturday, "they have dropped 15 points a match since Q20" changes
who you pick and how you play them.

## 27. Floor or ceiling

`consistency` and `highScore` are both computed already and shown as two
unrelated rows. They are really one decision: a high floor wins qualification
matches, a high ceiling wins eliminations.

Label it that way — "floor pick" / "ceiling pick" — and let the pick list sort
by whichever you need. Two numbers you already have, framed as the choice they
actually represent.

## 28. What one autonomous win is worth

V5RC ranks on WP, then AP, then SP. The app shows rank and record, so two teams
on 6–2 look identical when one of them is four places higher and uncatchable.

Show the three columns, and then the useful part: **what moves you**. "One AWP
takes you from 8th to 5th." "You cannot catch 4th without winning both." The
arithmetic is small and the data is in the rankings call.

## 29. Run up the score

SP is the **losing** alliance's score, so a blowout win gives you fewer SP than
a narrow one — and SP is the second tiebreaker. Teams routinely lose a seed
because nobody on the drive team knows this.

A one-line note on the standings when SP is what is deciding your position.

## ~~30. Bracket path~~ — built in v66

Given the current seeds, who you meet in each elimination round, and your
modelled odds at each step. The bracket view draws the bracket and the Simulator
computes championship odds; this is the two of them joined, from *your* seat.

**Shipped for the case that matters.** `TOURNAMENT ▸ BRACKET` now draws the
bracket the event is heading for *before* eliminations start, with championship
odds per projected alliance and your own marked. Odds on a bracket already
underway are not done: the real alliances would have to be reconstructed from
the elimination matches, and once elims are running you can see the bracket
anyway.

---

## Not recommended

* **Accounts and a server-side database.** The whole app is one HTML file and a
  proxy; everything valuable about it — no build, no deploy story, works from a
  cache — comes from that. Notes and preferences belong in IndexedDB.
* **Scraping events.vex.com for anything.** §2 of HANDOFF.md: Vercel's IPs are
  blocked and every attempt has cost a release.
* **More YouTube search routes.** §3: the quota is 10,000 units a day and
  `search.list` is 100 of them. A wrong video is worse than no video.
