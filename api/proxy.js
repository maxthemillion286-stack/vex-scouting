// Vercel Serverless Function — proxies requests to the VEX RobotEvents API
//
// UPDATED: As of 2026, the API moved from robotevents.com to events.vex.com
// due to the VEX/RECF split. Tokens transferred over and remain valid.
//
// Supports MULTIPLE TOKENS for higher rate limits:
//   - Set ROBOTEVENTS_TOKEN, ROBOTEVENTS_TOKEN_2, ROBOTEVENTS_TOKEN_3, etc.
//   - Tokens are rotated round-robin per request
//   - On 429 (rate limit), automatically falls over to the next token
//   - The response carries X-Token-Count so the frontend can scale its
//     request concurrency to match the available rate-limit headroom.

// Scraping the event page (racing several strategies) and then searching
// YouTube can exceed Vercel's 10s default. Raise it or auto-find dies on slow
// pages.
export const config = { maxDuration: 60 };

// Bumped whenever the streams lookup changes. Surfaced in `diag` and in every
// streams response so the debug page can prove WHICH proxy is actually live —
// a stale cached reply is otherwise indistinguishable from a fresh failure.
const PROXY_BUILD = 'v37';
// A failed stream lookup is expensive (page race + a YouTube search), and the
// answer rarely changes within a session. Cache the miss too, or every revisit
// pays the full cost again.
const NEG_TTL_MS = 60 * 60 * 1000;          // a live event might publish later
const NEG_TTL_PAST_MS = 24 * 60 * 60 * 1000; // a finished event never will
const STREAM_TTL_MS = 24 * 60 * 60 * 1000;   // a found stream doesn't move

const cache = new Map(); // path -> { data, status, expires }
const DEFAULT_TTL_MS = 60 * 1000;       // 1 min for general data
const LONG_TTL_MS = 5 * 60 * 1000;      // 5 min for stable data
const SHORT_TTL_MS = 15 * 1000;         // 15s for live match data

// Round-robin counter persists across requests in the same Vercel instance
let tokenCursor = 0;

function getTokens() {
  const tokens = [];
  for (let i = 1; i <= 10; i++) {
    const key = i === 1 ? 'ROBOTEVENTS_TOKEN' : `ROBOTEVENTS_TOKEN_${i}`;
    const val = process.env[key];
    if (val) tokens.push(val);
  }
  return tokens;
}

// Determine cache TTL based on what's being requested
function ttlFor(path) {
  // A TEAM's season match history changes only when they play — cache long.
  // (Previously this fell through to the generic '/matches' 15s rule, which
  // forced constant refetching of hundreds of near-static team histories.)
  if (/^\/teams\/\d+\/matches/.test(path)) return LONG_TTL_MS;
  // Event rosters are near-static once registration settles
  if (/^\/events\/\d+\/teams/.test(path)) return LONG_TTL_MS;
  // Skills rankings (legacy) and team details rarely change — cache longer
  if (path.startsWith('legacy:/seasons/') && path.includes('/skills')) return LONG_TTL_MS;
  if (path.match(/^\/teams\/\d+$/)) return LONG_TTL_MS;
  if (path.startsWith('/teams?')) return LONG_TTL_MS;
  if (path.startsWith('/seasons')) return LONG_TTL_MS;
  // LIVE data at a running event changes fast — keep these short
  if (path.includes('/matches')) return SHORT_TTL_MS;   // event/division matches
  if (path.includes('/rankings')) return SHORT_TTL_MS;
  return DEFAULT_TTL_MS;
}


// ── Payload slimming ───────────────────────────────────────────────────────
// The season skills standings return every team worldwide with fully nested
// team/event/season objects — several megabytes of JSON, most of which the app
// never reads. On a competition's wifi that download is the single slowest
// thing the app does. Strip it to the fields the client actually uses before it
// ever crosses the network. Everything is still computed from real data; we're
// only dropping fields nobody reads.
function slimSeasonSkills(data) {
  const items = Array.isArray(data) ? data : (data && data.data) || null;
  if (!items || !Array.isArray(items)) return data;
  const out = items.map(it => {
    const t = it.team || {};
    return {
      rank: it.rank,
      scoreDriver: it.scoreDriver ?? it.scores?.driver ?? 0,
      scoreProg: it.scoreProg ?? it.scores?.programming ?? 0,
      score: it.score ?? it.scores?.score ?? 0,
      team: {
        id: t.id,
        team: t.team,
        program: t.program,
        gradeLevel: t.gradeLevel,
        region: t.region,
        eventRegion: t.eventRegion,
        country: t.country
      }
    };
  });
  return Array.isArray(data) ? out : { ...data, data: out };
}

// The player config is the only unauthenticated place Vimeo exposes a
// broadcast's schedule, duration and live status. Purely a nice-to-have: if it
// fails we still have the clip id, which is what actually matters for playback.
async function vimeoClipDetails(configUrl, ua) {
  if (!configUrl) return {};
  try {
    const r = await fetch(configUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return {};
    const d = await r.json();
    const v = d.video || {};
    const live = v.live_event || null;
    return {
      hash: (String(v.embed_code || '').match(/\/video\/\d+\?h=([a-z0-9]+)/i) || [])[1] || v.unlisted_hash || null,
      title: v.title || null,
      // 0 while a stream is live or pending — it only settles once archived.
      duration: v.duration ?? null,
      // 'pending' | 'streaming' | 'ended', or absent for an ordinary upload.
      liveStatus: (live && live.status) || null,
      // SCHEDULED, not actual. Vimeo does not publish the actual start for
      // free, so anything derived from this is an estimate.
      scheduledStart: (live && live.ingest && live.ingest.scheduled_start_time) || null
    };
  } catch (e) { return {}; }
}


// ── Fetching a page that doesn't want to be fetched ────────────────────────
// events.vex.com blocks datacenter IPs, so a direct fetch from a serverless
// function gets a 403 no matter how the request is dressed up. The relays
// below fetch from their own (unblocked) addresses and hand back the content.
//
// Deliberately NO Googlebot user-agent: claiming to be a crawler from a
// datacenter IP fails the reverse-DNS check every WAF runs, so it reads as an
// impostor and gets blocked harder than an honest browser string.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  // Real Chrome always sends these; a request without them scores as a bot.
  'Sec-Ch-Ua': '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

const RELAYS = [
  u => ({ url: 'https://r.jina.ai/' + u, src: 'jina' }),
  u => ({ url: 'https://corsproxy.io/?url=' + encodeURIComponent(u), src: 'corsproxy' })
];

function looksRealPage(html, src) {
  // Under 500 chars is an error stub; the Cloudflare markers arrive as a 200
  // with no links in it, which is worse than an error because it looks fine.
  if (!html || html.length < 500) throw new Error(src + ':too-short');
  if (html.includes('id="challenge-running"') ||
      html.includes('Just a moment...') ||
      html.includes('cf-browser-verification')) throw new Error(src + ':cloudflare');
  return html;
}

// Race a set of candidate URLs, directly and through relays. Resolves with the
// first response that looks like a real page; rejects with the attempt log.
async function fetchPageRacing(urls, { relayCount = 2, tried = [] } = {}) {
  const short = u => u.replace(/^https?:\/\//, '').slice(0, 90);
  const note = (label, e) => { tried.push(label + ' ' + e.message); throw e; };
  const attempt = async (url, headers, ms, src, reportAs) => {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    if (!resp.ok) throw new Error(src + ':' + resp.status);
    return { html: looksRealPage(await resp.text(), src), url: reportAs || url, via: src };
  };

  const race = [
    ...urls.map(u => attempt(u, BROWSER_HEADERS, 5000, 'direct').catch(e => note(short(u), e))),
    // Relays only for the likeliest URLs — they are doing us a favour, and a
    // wide fan-out across all candidates would be rude and slow.
    ...urls.slice(0, relayCount).flatMap(u => RELAYS.map(mk => {
      const { url: ru, src } = mk(u);
      return attempt(ru, { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Accept': 'text/html,*/*' }, 7000, src, u)
        .catch(e => note(short(u) + ' via ' + src, e));
    }))
  ];
  return Promise.any(race);
}

// ── A Vimeo channel/user page → the clips on it ────────────────────────────
// A team's webcast link is often vimeo.com/<name>, which is a CHANNEL, not a
// video: it can't be embedded or seeked. The clip ids are in the JSON the page
// embeds, so pull them out and let the caller pick by date.
async function resolveVimeoChannel(channelUrl, startISO, endISO, tried) {
  let page;
  try {
    page = await fetchPageRacing([channelUrl, channelUrl + '/videos'], { relayCount: 2, tried });
  } catch (e) { return []; }
  const html = page.html.replace(/\\\//g, '/');

  const out = [];
  const seen = new Set();
  // Clip ids appear as /video/NNNNNNNNN, "clip_id":NNNNNNNNN and similar.
  for (const m of html.matchAll(/(?:\/videos?\/|"(?:clip_)?id"\s*:\s*)(\d{7,12})/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ url: 'https://vimeo.com/' + id, videoId: id, title: null, publishedAt: null });
  }
  // A live event embedded on the channel page is a better answer than a clip,
  // so surface those first.
  for (const m of html.matchAll(/vimeo\.com\/event\/(\d{6,12})/g)) {
    const id = m[1];
    if (seen.has('e' + id)) continue;
    seen.add('e' + id);
    out.unshift({ url: 'https://vimeo.com/event/' + id, eventId: id, title: null, publishedAt: null });
  }
  return out.slice(0, 12);
}

// ══════════════════════════════════════════════════════════════════════════
// YouTube
//
// Quota is the binding constraint. The default allowance is 10,000 units/day
// and search.list costs 100 of them, so a naive implementation runs dry after
// ~100 lookups. The cheap endpoints cost 1 unit each and do most of the work:
//
//   search.list        100     unavoidable for "find by name"
//   channels.list        1     handle/ID → uploads playlist
//   playlistItems.list   1     up to 50 recent uploads
//   videos.list          1     up to 50 videos AT ONCE, with live details
//
// The old channel resolver spent 400 units (one search for the handle, three
// more for completed/live/upcoming). The version below does the same job for
// 3 — a 130x reduction — by listing the channel's uploads playlist instead.
let ytUnitsUsed = 0;   // per-instance, surfaced in diag for monitoring

async function ytGet(path, cost, ytKey) {
  ytUnitsUsed += cost;
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '&key=' + encodeURIComponent(ytKey),
      { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// Details for up to 50 videos in ONE request, for one unit.
//
// This is what makes date filtering trustworthy. A livestream's `publishedAt`
// is when the broadcast was CREATED, which is routinely days or weeks before
// it airs — filtering on it silently discards streams that were scheduled
// early. `actualStartTime` is when it really began, and it is also exactly
// what auto-sync needs, so fetching it here means no second round trip later.
async function ytVideoDetails(ids, ytKey) {
  const out = new Map();
  let anyOk = false;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const j = await ytGet('videos?part=snippet,liveStreamingDetails,contentDetails&maxResults=50&id=' +
      encodeURIComponent(batch.join(',')), 1, ytKey);
    if (j) anyOk = true;
    for (const it of (j && j.items) || []) {
      const d = it.liveStreamingDetails || {};
      const cd = it.contentDetails || {};
      out.set(it.id, {
        durationSec: iso8601Seconds(cd.duration),
        title: (it.snippet && it.snippet.title) || '',
        description: (it.snippet && it.snippet.description) || '',
        channelTitle: (it.snippet && it.snippet.channelTitle) || '',
        // Already in the snippet we're paying for. It's the cheapest lead there
        // is to the OTHER days of a multi-day event: organisers put one
        // broadcast in the event description and the rest sit on the same
        // channel. See the `siblings:` route.
        channelId: (it.snippet && it.snippet.channelId) || null,
        publishedAt: (it.snippet && it.snippet.publishedAt) || null,
        actualStartTime: d.actualStartTime || null,
        scheduledStartTime: d.scheduledStartTime || null,
        isLiveBroadcast: !!(d.actualStartTime || d.scheduledStartTime)
      });
    }
  }
  // null means the CALL failed, which is different from "no such video" and
  // must not be treated as "none of these aired during the event" — that would
  // throw away every candidate over a transient blip.
  return anyOk ? out : null;
}

// YouTube reports duration as ISO-8601 ("PT1H41M57S").
function iso8601Seconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(d || ''));
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}

// Is this plausibly an event broadcast at all?
//
// The remaining false positives are real videos ABOUT the same occasion — a
// "Maker Faire Orange County 2025 Highlights" reel shares four words with
// "Robotics is EZ @ 2025 Maker Faire Orange County" and airs the same weekend,
// so neither name nor date separates them. What does: a competition stream is
// a live broadcast running for hours, and a highlights reel is a short upload.
// This costs nothing — contentDetails rides along on the details call we
// already make.
function looksLikeEventBroadcast(v) {
  if (v.actualStartTime || v.scheduledStartTime) return true;   // an actual broadcast
  if (v.durationSec === null || v.durationSec === undefined) return true;  // unknown: don't punish
  return v.durationSec >= 20 * 60;   // an upload long enough to be a session
}

// When did this video actually air? Prefer the real start, fall back to the
// scheduled one, then to the upload time.
const airTime = v => Date.parse(v.actualStartTime || v.scheduledStartTime || v.publishedAt || 0);

// Did it air during the event? Generous by a day either side: streams often
// begin the evening before, and timezones drift the boundary.
function airedDuringEvent(v, startMs, endMs) {
  const t = airTime(v);
  if (isNaN(t)) return false;
  return t >= startMs - 36 * 3600e3 && t <= (endMs || startMs) + 36 * 3600e3;
}

// ── Channel → the videos it broadcast during an event ──────────────────────
// Three units total: resolve the channel, list its uploads, fetch live details.
async function resolveChannel(channelUrl, startISO, endISO, ytKey, eventName) {
  let channelId = (channelUrl.match(/\/channel\/(UC[\w-]+)/) || [])[1] || null;
  let uploads = null;

  if (!channelId) {
    const handle = (channelUrl.match(/\/(?:@|c\/|user\/)([\w.-]+)/) || [])[1];
    if (!handle) return [];
    // forHandle/forUsername are 1 unit each; the old search-for-a-channel
    // cost 100.
    for (const q of [`channels?part=contentDetails&forHandle=@${encodeURIComponent(handle)}`,
                     `channels?part=contentDetails&forUsername=${encodeURIComponent(handle)}`]) {
      const j = await ytGet(q, 1, ytKey);
      const item = j && j.items && j.items[0];
      if (item) {
        channelId = item.id;
        uploads = (item.contentDetails && item.contentDetails.relatedPlaylists &&
                   item.contentDetails.relatedPlaylists.uploads) || null;
        break;
      }
    }
    if (!channelId) return [];
  }

  // Every channel's uploads playlist id is its channel id with UC → UU.
  const uploadsId = uploads ||
    (typeof channelId === 'string' && channelId.startsWith('UC') ? 'UU' + channelId.slice(2) : null);
  if (!uploadsId) return [];

  const startMs = Date.parse(startISO);
  if (isNaN(startMs)) return [];
  const endMs = Date.parse(endISO || startISO);
  const windowLo = startMs - 60 * 86400e3;

  // Walk back through the uploads playlist until it predates the event.
  //
  // This used to read a single page of 50 and stop, which silently broke every
  // PAST event on an active channel: a club that posts a couple of videos a
  // week has pushed a February event off the end of that page long before
  // August, so the broadcast existed, the channel was right, and the lookup
  // still came back empty. Nothing said so — it read as "no stream published".
  //
  // The playlist is newest-first, so stopping as soon as a page ends older
  // than the window costs nothing on recent events (one page, as before) and
  // reaches back roughly a year on busy ones. Capped at six pages: six units
  // against the 101 a name search costs, and a hard bound on a channel that
  // uploads daily.
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 6; page++) {
    const j = await ytGet('playlistItems?part=snippet&maxResults=50&playlistId=' +
      encodeURIComponent(uploadsId) +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), 1, ytKey);
    const batch = (j && j.items) || [];
    if (!batch.length) break;
    for (const it of batch) items.push(it);
    const times = batch
      .map(it => Date.parse((it.snippet && it.snippet.publishedAt) || 0))
      .filter(n => !isNaN(n));
    // Everything from here back is older than anything we could want.
    if (times.length && Math.min(...times) < windowLo) break;
    pageToken = (j && j.nextPageToken) || '';
    if (!pageToken) break;
  }
  if (!items.length) return [];

  // Cheap pre-filter on upload time before spending a unit on details. Wide,
  // because a scheduled broadcast is created well before it airs.
  const nearby = items.filter(it => {
    const t = Date.parse((it.snippet && it.snippet.publishedAt) || 0);
    return !isNaN(t) && t >= windowLo && t <= (isNaN(endMs) ? startMs : endMs) + 7 * 86400e3;
  }).slice(0, 50);
  if (!nearby.length) return [];

  const ids = nearby.map(it => it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId).filter(Boolean);
  const details = await ytVideoDetails(ids, ytKey);
  const byId = new Map(nearby.map(it => [it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId, it.snippet || {}]));

  const wantGrade = gradeOf(eventName);
  const out = [];
  for (const id of ids) {
    const sn = byId.get(id) || {};
    // A failed details call falls back to the playlist snippet rather than
    // discarding the whole channel.
    const v = (details && details.get(id)) || (details === null ? {
      title: sn.title || '', description: sn.description || '',
      publishedAt: sn.publishedAt || null, actualStartTime: null
    } : null);
    if (!v) continue;
    if (!airedDuringEvent(v, startMs, isNaN(endMs) ? startMs : endMs)) continue;
    if (!looksLikeEventBroadcast(v)) continue;
    // A channel that broadcast both the high school and middle school days
    // would otherwise hand back whichever came first, and every match time
    // would be wrong with nothing on screen saying so.
    // Title first, description only when the title is silent — same rule as
    // the name search. This is the path that enumerates a channel, so it is
    // the one where a description naming the other grade would drop a day.
    const gotGrade = gradeOf(v.title) || gradeOf(v.description.slice(0, 400));
    if (wantGrade && gotGrade && gotGrade !== wantGrade) continue;
    out.push({
      url: 'https://www.youtube.com/watch?v=' + id,
      title: v.title,
      publishedAt: v.actualStartTime || v.publishedAt,
      actualStartTime: v.actualStartTime || null,
      durationSec: v.durationSec ?? null,
      grade: gotGrade || null
    });
  }
  // Oldest first, so day 1 of the event lines up with the first video.
  out.sort((a, b) => Date.parse(a.publishedAt || 0) - Date.parse(b.publishedAt || 0));
  return out.slice(0, 12);
}

// Grade level is NOT a scoring word — it's a veto.
//
// Most venues run high school one day and middle school the next, under
// near-identical names. If "high"/"middle"/"school" were merely scored, the two
// would look almost the same and an HS event could quietly match the MS
// broadcast: worse than finding nothing, because every match time would be
// wrong with no sign anything had gone astray.
function gradeOf(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:middle\s*school|ms\b|m\.s\.|viqrc?\s*ms)\b/.test(t)) return 'ms';
  if (/\b(?:high\s*school|hs\b|h\.s\.)\b/.test(t)) return 'hs';
  if (/\b(?:elementary|es\b)\b/.test(t)) return 'es';
  if (/\b(?:college|university|vex\s*u|vurc)\b/.test(t)) return 'u';
  return null;
}

// Words in almost every event name or stream title, carrying no evidence.
// "Katy Regional Event" reduces to just "katy" — correctly too thin to search.
const STOPWORDS = new Set([
  'the','and','of','a','an','for','at','vs','is','it','to','in','on','by','no','or','as','be','we',
  'ms','hs','es','jr','sr','div','pm','am','st','nd','rd','th',
  // 'v5' and 'iq' survived as tokens because only the '…rc' forms were listed,
  // so "VEX V5 Robotics Competition" left a v5 behind to dilute recall.
  'vex','v5','v5rc','iq','vrc','viqrc','viqc','vurc','vexu','robotics','robot','robots','competition',
  'tournament','tourney','event','events','meet','scrimmage','scrim','open','challenge',
  'regional','regionals','state','championship','championships','invitational','classic',
  'signature','league','qualifier','qualifiers','quals','finals','elims','elimination',
  'presented','by','hosted','powered',
  'high','school','schools','middle','elementary','college','university',
  'live','livestream','stream','streaming','webcast','broadcast','replay','full',
  'day','days','division','divisions','field','fields','matches','match','round','rounds',
  'push','back','over','under','rapid','relay','season',
  '2023','2024','2025','2026','2027','20242025','20252026'
]);

function nameTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // 2 characters are allowed: club names like "EZ" and "JR" are exactly the
    // distinctive bit. Filler of that length is stopworded explicitly instead.
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// How well does a video title correspond to an event name?
//
// Measured in BOTH directions, because a stream title is usually a shortened
// event name, not a copy of it. "Katy Cypress Showdown High School" is streamed
// as "Cypress Showdown - HS Field 1": only two of the event's three distinctive
// words appear, so a one-directional 80% rule rejected it — and rejected most
// real events, which carry venue prefixes, ordinals and organiser in-jokes that
// no stream title repeats.
//
// Precision (how much of the TITLE the event explains) catches the shortened
// case; recall (how much of the EVENT the title covers) catches the padded one.
// Taking the better of the two accepts both without accepting noise, because a
// video about something else shares no distinctive words at all.
//
// The date window does the heavy lifting for near-misses: two events at the
// same venue read almost identically by name, and it is airing on the right day
// that tells them apart — see airedDuringEvent.
function scoreTitle(want, title) {
  const got = nameTokens(title);
  if (!got.length) return null;
  const gotSet = new Set(got);
  const shared = want.filter(t => gotSet.has(t));
  const overlap = shared.length;
  if (!overlap) return null;
  const precision = overlap / got.length;
  const recall = overlap / want.length;
  const best = Math.max(precision, recall);
  if (best < 0.8) return null;

  // Two words in common used to be required, always, on the grounds that one
  // is a coincidence. Usually true — but it threw away the strongest matches
  // there are: events whose distinctive content is a single rare word.
  //
  // Real rejection: "Excalibur Robotics Challenge 2025 PUSH BACK" streamed as
  // "Excalibur Robotics Challenge 2025 PUSH BACK". Every other word in both is
  // boilerplate this file already stopwords, so want=[excalibur,v5] against
  // got=[excalibur] scored overlap 1 and was refused — an exact title match,
  // on the right date, seven hours long, reported as "nothing matches closely
  // enough to trust".
  //
  // So a lone word is accepted when it is genuinely rare: six characters or
  // more and not a bare number. "excalibur" qualifies; "katy" does not, which
  // keeps the case the STOPWORDS comment calls correctly too thin. The date
  // window and looksLikeEventBroadcast still have to agree separately, and
  // between them a wrong video would have to share a rare word AND air inside
  // the event's 36-hour window AND run like a broadcast.
  // Note precision, not `best`. With a single wanted word recall is 1.0 by
  // construction, so `best` can never reject anything — "Excalibur plus nine
  // unrelated words" would sail through on a recall of 1/1. Precision is the
  // half that still means something: the shared word has to be most of what
  // the TITLE says too, not just most of what the event name says.
  if (overlap < 2) {
    if (!distinctiveWord(shared[0])) return null;
    if (precision < 0.5) return null;
  }
  return { overlap, precision, recall, best, solo: overlap < 2 };
}

// Is one word, on its own, enough to hang a match on?
//
// Five characters, not a bare number. Shared by the scorer and by the search
// entry check below, which MUST agree: they disagreeing is what made the v23
// fix unreachable for the events it was written for.
//
// Five rather than six because the VEX World Championship reduces to exactly
// one token — "world" — every other word in it being programme boilerplate
// this file already stopwords. Six characters excluded Worlds by one letter.
// "katy" is four and still rejected, which keeps the case the STOPWORDS
// comment calls correctly too thin.
function distinctiveWord(tok) {
  const t = String(tok || '');
  return t.length >= 5 && !/^\d+$/.test(t);
}

// The event name as a search query: intact, minus the program boilerplate
// RobotEvents appends to every event ("...: VEX V5 Robotics Competition :Push
// Back"). Everything distinctive — club, venue, city — is deliberately kept.
function searchQuery(name) {
  return String(name || '')
    .replace(/:\s*VEX\s+[^:]*Competition\s*:?[^:]*$/i, '')
    .replace(/\((?:high|middle|elementary)\s*school\)/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120) || String(name || '').slice(0, 120);
}

// ── Find the event's broadcast by name ─────────────────────────────────────
// 101 units: one search, plus one batched details call for every candidate.
//
// The details call is what makes this reliable. search.list can only filter on
// publishedAt — the moment a broadcast was CREATED — so a stream scheduled two
// weeks ahead of the event falls outside any sane window and is never seen.
// Searching wide and then filtering on actualStartTime fixes that, and costs
// a single extra unit.
async function searchYouTubeByName(name, startISO, endISO, ytKey) {
  const want = nameTokens(name);
  // Nothing distinctive left to match on — a search would be a coin flip.
  //
  // This used to demand two tokens, which quietly made v23's single-rare-word
  // rule in scoreTitle unreachable for the very events it was written for:
  // "Excalibur Robotics Challenge" reduces to [excalibur] and the VEX World
  // Championship to [world], so both returned here and the scorer was never
  // called. The search cost nothing and found nothing because it never ran.
  //
  // Same shape as the three bugs before it: a path returning before it reaches
  // the code that would have worked. The two checks now share distinctiveWord()
  // precisely so they cannot drift apart again.
  //
  // Note the QUERY is not thin even when the token list is — searchQuery()
  // keeps the whole event name, so "VEX Robotics World Championship" is what
  // actually goes to YouTube. Only the scoring works on tokens.
  if (!want.length) return [];
  if (want.length === 1 && !distinctiveWord(want[0])) return [];
  const wantGrade = gradeOf(name);

  const startMs = Date.parse(startISO);
  if (isNaN(startMs)) return [];
  const endMs = isNaN(Date.parse(endISO || startISO)) ? startMs : Date.parse(endISO || startISO);

  // Query with the event's own name, not the tokenised version.
  //
  // Tokens are for SCORING; they are the wrong thing to search with. Stopwords
  // strip exactly the words an organiser puts in their stream title — the team
  // or club name — leaving a query like "maker faire orange county" that
  // returns the actual Maker Faire and never the VEX broadcast. Appending
  // "middle school" made it worse, since those titles say "MS".
  //
  // YouTube's own ranking copes with the boilerplate; only the program suffix
  // RobotEvents appends is worth removing, because no stream title repeats it.
  // 50 rather than 25: the cost is the same 100 units either way (search.list
  // is priced per call, not per result), and a club that streams two grades
  // across two days puts four near-identical titles in the running at once.
  const j = await ytGet('search?part=snippet&type=video&maxResults=50&order=relevance' +
    '&q=' + encodeURIComponent(searchQuery(name)) +
    '&publishedAfter=' + new Date(startMs - 60 * 86400e3).toISOString() +
    '&publishedBefore=' + new Date(endMs + 7 * 86400e3).toISOString(), 100, ytKey);
  const items = (j && j.items) || [];
  if (!items.length) return [];

  // Score on the search snippet first, so only plausible videos cost a unit.
  const shortlist = [];
  for (const it of items) {
    const id = it.id && it.id.videoId;
    const sn = it.snippet || {};
    if (!id) continue;
    // Score the TITLE alone. Folding in the channel name adds tokens the event
    // name can never match ("KR", "Robotics Live"), which drags precision down
    // and rejects correct videos — the query already found the right channel.
    const sc = scoreTitle(want, sn.title || '');
    if (!sc) continue;
    shortlist.push({ id, sc });
  }
  if (!shortlist.length) return [];

  const details = await ytVideoDetails(shortlist.map(x => x.id), ytKey);
  // If the details call itself failed, fall back to what the search gave us.
  // Less precise — publishedAt is when a broadcast was created, not when it
  // aired — but far better than discarding every candidate.
  const snippets = new Map(items.map(it => [it.id && it.id.videoId, it.snippet || {}]));
  const degraded = details === null;

  const scored = [];
  for (const { id, sc } of shortlist) {
    const sn = snippets.get(id) || {};
    const v = (details && details.get(id)) || (degraded ? {
      title: sn.title || '', description: sn.description || '',
      publishedAt: sn.publishedAt || null, actualStartTime: null, scheduledStartTime: null
    } : null);
    if (!v) continue;
    // The real test: did this video actually air while the event was running?
    if (!airedDuringEvent(v, startMs, endMs)) continue;
    // ...and is it a broadcast rather than a clip about the same occasion?
    if (!looksLikeEventBroadcast(v)) continue;
    // The TITLE decides the grade; the description is consulted only when the
    // title is silent.
    //
    // Reading both as one string let a description settle it, and descriptions
    // routinely name the other grade — "our High School stream is here too" on
    // a Middle School broadcast. Whichever pattern appeared first in the
    // concatenation won, which is not a rule so much as a coin toss, and it
    // decides whether a video is dropped outright.
    const gotGrade = gradeOf(v.title) || gradeOf(v.description.slice(0, 400));
    if (wantGrade && gotGrade && gotGrade !== wantGrade) continue;
    scored.push({
      url: 'https://www.youtube.com/watch?v=' + id,
      title: v.title,
      publishedAt: v.actualStartTime || v.publishedAt,
      actualStartTime: v.actualStartTime || null,
      match: sc.overlap + '/' + want.length,
      score: sc.best,
      durationSec: v.durationSec ?? null,
      grade: gotGrade || null,
      // The channel that broadcast it. This is the lead that finds the OTHER
      // days without depending on the relevance ranking to have surfaced them.
      channelId: v.channelId || null
    });
  }
  // Best match first, then oldest, so day 1 leads when several tie.
  scored.sort((a, b) => (b.score - a.score) ||
    (Date.parse(a.publishedAt || 0) - Date.parse(b.publishedAt || 0)));
  // 6 was too tight for a multi-day event that also runs several grades: four
  // Bristol broadcasts (MS and HS, two days each) plus any near-miss fills it
  // before the day that matters gets in.
  return scored.slice(0, 16);
}

function slimForPath(path, data) {
  if (path.startsWith('legacy:/seasons/') && path.includes('/skills')) return slimSeasonSkills(data);
  return data;
}

// Every response goes through here, so a crash anywhere becomes a readable
// answer instead of Vercel's bare 500. A 500 with no body is the one failure
// mode that tells you nothing at all — and this app's DevTools are blocked, so
// the message has to travel in the response.
export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (err) {
    const detail = {
      error: 'proxy-crashed',
      build: PROXY_BUILD,
      path: String((req && req.query && req.query.path) || '').slice(0, 120),
      message: String((err && err.message) || err).slice(0, 300),
      // First few frames only — enough to locate it, not a wall of noise.
      at: String((err && err.stack) || '').split('\n').slice(1, 4).map(l => l.trim()).join(' | ').slice(0, 400)
    };
    try { return res.status(500).json(detail); } catch (e) { return; }
  }
}

async function handleRequest(req, res) {
  const path = req.query.path;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  let url;
  let useAuth = true;
  if (path.startsWith('legacy:')) {
    // Legacy endpoints (used for season skills standings) — public, no auth needed
    url = `https://events.vex.com/api${path.slice(7)}`;
    useAuth = false;
  } else if (path.startsWith('streams:')) {
    // ── Finding an event's stream link ───────────────────────────────────
    // The RobotEvents API does NOT expose an event's description or its
    // webcast section, so there is nothing in the API to read. The links are
    // only on the event's public web page, which the browser can't fetch
    // itself (no CORS). So we fetch the page here and pull the links out.
    //
    // Deliberately regex rather than a DOM parser: it needs no dependency and
    // the page's markup changes more often than URL formats do.
    const sku = path.slice(8).toUpperCase();
    if (!/^RE-[A-Z0-9-]{3,40}$/.test(sku)) {
      return res.status(400).json({ ok: false, reason: 'bad-sku' });
    }
    // The event's date window, passed by the client (which already has the
    // event loaded). Without it a channel search returns whatever that channel
    // uploaded most recently, which has nothing to do with this event.
    const startISO = typeof req.query.start === 'string' ? req.query.start : '';
    const endISO = typeof req.query.end === 'string' ? req.query.end : startISO;
    // Used only as a last resort, to search YouTube when the event page
    // publishes no link at all.
    const evName = typeof req.query.name === 'string' ? req.query.name.slice(0, 160) : '';

    // PROXY_BUILD is part of the key so a deploy cannot serve answers computed
    // by the previous one.
    //
    // This masked several rounds of real fixes. A found stream is cached for
    // 24 hours with a matching CDN s-maxage, and the CDN is keyed by URL — a
    // URL that does not change when the proxy does. So every improvement to
    // the lookup shipped, and then the edge kept handing out the answer from
    // before it, for a day. Testing right after a deploy is the worst case,
    // and it is exactly when anyone tests. The body carried "build": "v24"
    // through it all, which is the only reason it was catchable at all.
    //
    // ?debug=1 hid it too, since that path adds a cache-buster — so debug
    // captures looked fresh while ordinary use was a day stale.
    const cacheKey = 'streams:' + PROXY_BUILD + '|' + sku + '|' + startISO.slice(0, 10);
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(hit.data);
    }
    try {
      // CONFIRMED page shape, taken from a live event (Aug 2026):
      //   https://events.vex.com/robot-competitions/vex-robotics-competition/RE-V5RC-25-0209.html
      // ...with the stream links inside a #webcast section on that page.
      //
      // events.vex.com is the public front end; the API moved there too during
      // the VEX/RECF split, and robotevents.com now serves clean 404s for these
      // SKUs — which is exactly what made this look like "no stream published".
      // The extra candidates cover a program-segment rename and a lingering
      // redirect; they cost nothing, since every URL races in parallel.
      const progs = [];
      if (/-(VIQRC|VIQC)-/.test(sku)) progs.push('vex-iq-competition', 'viqrc');
      else if (/-(VURC|VEXU)-/.test(sku)) progs.push('vex-u-robotics-competition', 'vurc');
      else if (/-(ADC|VAIC)-/.test(sku)) progs.push('aerial-drone-competition', 'adc');
      else progs.push('vex-robotics-competition', 'v5rc', 'vex-v5-robotics-competition');

      // Only two candidates. The first is the confirmed live shape; the second
      // covers a lingering robotevents.com redirect. The earlier scattergun of
      // five URLs multiplied the fan-out (and the wait) for no gain once the
      // real URL was known.
      const urls = [
        `https://events.vex.com/robot-competitions/${progs[0]}/${sku}.html`,
        `https://www.robotevents.com/robot-competitions/${progs[0]}/${sku}.html`
      ];

      const tried = [];
      // An unreachable page is NOT the end of the lookup. events.vex.com blocks
      // datacenter IPs and the relays are blocked too, so this is the normal
      // case rather than the exception — bailing out here meant the YouTube
      // search below never ran at all, which is why nothing was ever found.
      let rawHtml = null, pageUrl = null, pageVia = null;
      try {
        const win = await fetchPageRacing(urls, { relayCount: 2, tried });
        rawHtml = win.html; pageUrl = win.url; pageVia = win.via;
      } catch (aggregate) {
        rawHtml = '';
      }

      // ── Decode BEFORE matching, not after ────────────────────────────────
      // Two ways a perfectly good URL used to get lost here:
      //
      //   1. `&amp;` — in markup, `?v=ABC&amp;t=90` is a single URL, but the
      //      regex sees `&`, `a`, `m`, `p`, `;` and stops dead at the `;`,
      //      because `;` is not in the character class. Decoding afterwards
      //      was too late: the match had already been truncated to `?v=ABC&`.
      //
      //   2. `https:\/\/...` — inside the inline JSON blobs the page embeds,
      //      slashes are backslash-escaped. `\/` never matches `\/` in the
      //      pattern's literal `//`, so those URLs were skipped entirely —
      //      and on many event pages the JSON blob is the ONLY place the
      //      webcast link appears.
      //
      // Normalising the whole document up front means the matcher only ever
      // sees plain URLs, and one code path handles every source on the page.
      const html = rawHtml
        .replace(/\\\//g, '/')        // escaped slashes in inline JSON
        .replace(/\\u0026/gi, '&')    // JSON-escaped ampersand
        .replace(/&amp;/gi, '&')      // HTML-entity ampersand
        .replace(/&#0*38;/g, '&')     // numeric-entity ampersand
        .replace(/&#x0*26;/gi, '&');  // hex-entity ampersand

      // Vimeo clip ids are NUMERIC. The old pattern accepted any word after
      // vimeo.com/, so a team's channel — vimeo.com/ccisdrobotics — was
      // captured as though it were a video, filled into the stream box, and
      // then failed to sync because there is no clip there to seek.
      const STREAM_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/|player\.vimeo\.com\/video\/\d+|vimeo\.com\/(?:event\/)?\d+)[\w?=&\/-]*/gi;
      // Channel and handle URLs — not jumpable on their own, resolved below.
      const CHANNEL_URL_RE = /https?:\/\/(?:www\.)?youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w-]+|user\/[\w-]+)/gi;
      // vimeo.com/<name> where <name> isn't numeric and isn't one of Vimeo's
      // own sections. These are channels: real, common, and unusable as-is.
      const VIMEO_CHANNEL_RE = /https?:\/\/(?:www\.)?vimeo\.com\/(?!event\/|video\/|channels\/|groups\/|ondemand\/|user\d|\d)([a-z0-9][\w.-]{2,40})/gi;

      const found = [];
      const channels = [];
      const seenCh = new Set();
      const addChannel = (url, source) => {
        const u = url.replace(/[\\"'<>).,;]+$/, '');
        // The site's own header/footer link to VEX's channels on every page;
        // treating those as the event's webcast would send everyone to the
        // wrong video.
        if (/\/(@?vexrobotics|@?recf|@?roboticseducation)/i.test(u)) return;
        if (seenCh.has(u)) return;
        seenCh.add(u);
        channels.push({ url: u, source });
      };
      const seen = new Set();
      const add = (url, source) => {
        // Entities are already gone; this only trims punctuation the URL
        // picked up from the markup around it (quotes, a closing paren, a
        // sentence-ending period).
        let u = url.replace(/[\\"'<>).,;]+$/, '');
        if (seen.has(u)) return;
        seen.add(u);
        found.push({ url: u, source });
      };

      // Anything inside a webcast-ish block gets priority
      // The event page anchors its stream section as #webcast. Attributes may
      // be double-quoted, single-quoted or bare, and the id can sit on the
      // heading rather than the container, so take a generous window after the
      // first mention rather than trying to parse the element.
      const webcastBlock = html.match(/(?:id|class|name)\s*=\s*["']?[^"'>\s]*webcast[^"'>\s]*["']?[\s\S]{0,6000}/i)
                        || html.match(/webcast[\s\S]{0,6000}/i);
      if (webcastBlock) {
        const m = webcastBlock[0].match(STREAM_URL_RE) || [];
        for (const u of m) add(u, 'webcast-section');
        for (const u of (webcastBlock[0].match(CHANNEL_URL_RE) || [])) addChannel(u, 'webcast-section');
        for (const u of (webcastBlock[0].match(VIMEO_CHANNEL_RE) || [])) addChannel(u, 'webcast-section');
      }
      // Then anywhere on the page
      const anywhere = html.match(STREAM_URL_RE) || [];
      for (const u of anywhere) add(u, 'page');
      for (const u of (html.match(CHANNEL_URL_RE) || [])) addChannel(u, 'page');
      for (const u of (html.match(VIMEO_CHANNEL_RE) || [])) addChannel(u, 'page');

      // ── Channels have to be resolved into actual videos ──────────────────
      // Plenty of events publish "watch on our channel" rather than a link to
      // the broadcast itself. A channel URL can't be jumped into, so the old
      // code found nothing usable and fell back to asking the user. Ask
      // YouTube which videos that channel put out during the event instead.
      //
      // Only when no direct video turned up: `search` costs 100 quota units a
      // call against a 10,000/day default, so this stays a fallback.
      if (!found.length && channels.length) {
        // Vimeo first: it needs no API key, just the channel page.
        for (const ch of channels.filter(c => /vimeo\.com/i.test(c.url)).slice(0, 2)) {
          const vids = await resolveVimeoChannel(ch.url, startISO, endISO, tried);
          for (const v of vids) {
            add(v.url, ch.source === 'webcast-section' ? 'channel-webcast' : 'channel');
            const rec = found[found.length - 1];
            if (rec && rec.url === v.url) { rec.videoId = v.videoId || null; rec.eventId = v.eventId || null; }
          }
          if (found.length) break;
        }

        const ytKey = process.env.YOUTUBE_API_KEY;
        if (!found.length && ytKey && startISO && endISO) {
          for (const ch of channels.filter(c => /youtube\.com/i.test(c.url)).slice(0, 2)) {
            const vids = await resolveChannel(ch.url, startISO, endISO, ytKey, evName);
            for (const v of vids) {
              add(v.url, ch.source === 'webcast-section' ? 'channel-webcast' : 'channel');
              const rec = found[found.length - 1];
              if (rec && rec.url === v.url) {
                rec.title = v.title;
                rec.publishedAt = v.publishedAt;
                rec.actualStartTime = v.actualStartTime || null;
                rec.durationSec = v.durationSec ?? null;
              }
            }
            if (found.length) break;
          }
        }
      }

      // Still nothing — either the page lists no stream, or (more often) it
      // could not be fetched at all. Search YouTube for the event by name,
      // scored so a weak match is dropped rather than presented as the answer.
      let searched = false;
      if (!found.length && evName && process.env.YOUTUBE_API_KEY) {
        searched = true;
        for (const v of await searchYouTubeByName(evName, startISO, endISO, process.env.YOUTUBE_API_KEY)) {
          add(v.url, 'yt-search');
          const rec = found[found.length - 1];
          if (rec && rec.url === v.url) {
            rec.title = v.title;
            rec.publishedAt = v.publishedAt;
            rec.match = v.match;
            // Carried through so the client can sync immediately rather than
            // spending another round trip asking for what we already fetched.
            rec.actualStartTime = v.actualStartTime || null;
            // Duration tells the client which segment covers a given match when
            // an organiser streams a day in several parts.
            rec.durationSec = v.durationSec ?? null;
            rec.channelId = v.channelId || null;
          }
        }
      }

      // ── Expand to the whole channel ────────────────────────────────────
      //
      // The relevance search is a good way to FIND an event and a poor way to
      // enumerate it. Bots @ Bristol published four broadcasts — Middle School
      // and High School, two days each — and the search returned only the one
      // with the most views. The others existed, on the same channel, under
      // near-identical titles; nothing was wrong with them.
      //
      // Once any one video is known, its channel is authoritative and complete.
      // Listing it costs 2-3 units against the 101 already spent, needs no
      // second round trip from the client, and is cached with the rest of this
      // answer. So it runs whenever the search found something and the event
      // could have more days than the search returned.
      //
      // resolveChannel applies the same date window and grade veto, so this
      // widens what is found without loosening what is accepted.
      const expandKey = process.env.YOUTUBE_API_KEY;
      const seedChannel = found.map(f => f.channelId).find(Boolean);
      const eventDays = Math.max(1, Math.round(
        (Date.parse(endISO || startISO) - Date.parse(startISO)) / 86400e3) + 1);
      let expanded = 0;
      if (expandKey && seedChannel && startISO && found.length < eventDays * 2) {
        try {
          const sibs = await resolveChannel(
            'https://www.youtube.com/channel/' + seedChannel, startISO, endISO, expandKey, evName);
          for (const v of sibs) {
            if (found.some(f => f.url === v.url)) continue;
            add(v.url, 'yt-channel');
            const rec = found[found.length - 1];
            if (rec && rec.url === v.url) {
              rec.title = v.title;
              rec.publishedAt = v.publishedAt;
              rec.actualStartTime = v.actualStartTime || null;
              rec.durationSec = v.durationSec ?? null;
              rec.grade = v.grade || null;
              rec.channelId = seedChannel;
              expanded++;
            }
          }
        } catch (e) { /* the search result still stands on its own */ }
      }

      // ── One targeted search per day still missing ──────────────────────
      //
      // Asked for directly, more than once: "in the youtube search just search
      // day 2". It is the right instinct. A search for the event name alone
      // ranks by relevance, and relevance is mostly views — so on an event
      // whose days are published under near-identical titles, the popular day
      // wins and the other never appears. Naming the day in the query puts it
      // first instead.
      //
      // Days are compared in the EVENT's own timezone, taken from the offset on
      // its start date, rather than the server's UTC. A broadcast that begins
      // at 5pm local is already tomorrow in UTC, and counting it as the next
      // day is what makes a covered day look missing.
      //
      // Bounded hard, because each of these is another 100 units (§3): only
      // when a day is genuinely uncovered, at most two, and never before the
      // free channel listing above has had its go. The whole answer is then
      // cached for 24h, so a second visitor pays nothing.
      const tzOffMin = (() => {
        const m = /([+-])(\d{2}):(\d{2})$/.exec(startISO || '');
        if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
        return 0;
      })();
      const dayKeyLocal = ms => {
        const d = new Date(ms + tzOffMin * 60000);
        return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      };
      const eventDayKeys = [];
      {
        const s0 = Date.parse(startISO);
        for (let i = 0; i < eventDays && i < 8; i++) {
          const k = dayKeyLocal(s0 + i * 86400e3);
          if (k) eventDayKeys.push(k);
        }
      }
      const coveredDays = () => new Set(found
        .map(f => (f.actualStartTime || f.publishedAt) ? dayKeyLocal(Date.parse(f.actualStartTime || f.publishedAt)) : null)
        .filter(Boolean));
      let targeted = 0;
      //
      // Gated on `searched`, so a link found on the event page still costs
      // ZERO YouTube quota — §3's rule, and t60 counts real request costs to
      // enforce it. The first draft of this ran unconditionally and turned the
      // free page path into 200 units; the test caught it before it shipped.
      // When the page yielded links there is no reason to buy more.
      if (searched && expandKey && evName && eventDayKeys.length > 1) {
        const have = coveredDays();
        const missing = eventDayKeys.map((k, i) => ({ k, n: i + 1 })).filter(d => !have.has(d.k));
        for (const miss of missing.slice(0, 2)) {
          try {
            const hits = await searchYouTubeByName(
              `${searchQuery(evName)} Day ${miss.n}`, startISO, endISO, expandKey);
            for (const v of hits) {
              if (found.some(f => f.url === v.url)) continue;
              add(v.url, 'yt-day-search');
              const rec = found[found.length - 1];
              if (rec && rec.url === v.url) {
                rec.title = v.title;
                rec.publishedAt = v.publishedAt;
                rec.actualStartTime = v.actualStartTime || null;
                rec.durationSec = v.durationSec ?? null;
                rec.grade = v.grade || null;
                rec.channelId = v.channelId || null;
              }
            }
            targeted++;
          } catch (e) { /* the days already found still stand */ }
        }
      }

      const out = {
        ok: found.length > 0,
        build: PROXY_BUILD,
        streams: found.slice(0, 16),
        // How the day list was arrived at. Several rounds went into guessing
        // whether the channel expansion had run and what it returned; saying so
        // costs a few bytes and answers it outright (§9).
        expand: {
          eventDays,
          seedChannel: seedChannel || null,
          added: expanded,
          ran: !!(expandKey && seedChannel && startISO),
          // Which event days ended up with a broadcast, in the event's own
          // timezone, and how many targeted per-day searches it took. This is
          // the question every round of this has turned on.
          eventDayKeys,
          coveredDays: [...coveredDays()],
          targetedSearches: targeted
        },
        // Which URL actually served the page, so a wrong-path guess shows up
        // in the debug panel instead of looking like "no stream published".
        pageUrl: pageUrl || null,
        pageVia: pageVia || null,
        tried: pageUrl ? undefined : tried.slice(0, 12),
        // Surfaced so the UI can distinguish "no stream published" from
        // "we found a channel but couldn't search it" — very different fixes.
        channels: channels.map(c => c.url).slice(0, 4),
        reason: found.length ? undefined
              : channels.length ? (process.env.YOUTUBE_API_KEY ? 'channel-no-videos' : 'channel-needs-yt-key')
              : searched ? (pageUrl ? 'no-link-and-no-yt-match' : 'page-blocked-and-no-yt-match')
              : !pageUrl ? 'page-unreachable'
              : !evName ? 'no-links-on-page'
              : 'no-links-and-no-yt-key'
      };
      // An event that finished can never gain a stream link, so a miss on a
      // past event is cached hard. A miss on today's event is retried within
      // the hour, because the broadcast may not have been published yet.
      const eventOver = Date.parse(endISO || startISO) < Date.now() - 36 * 3600e3;
      const ttl = found.length ? STREAM_TTL_MS : (eventOver ? NEG_TTL_PAST_MS : NEG_TTL_MS);
      cache.set(cacheKey, { data: out, status: 200, expires: Date.now() + ttl });
      // Edge caching matters more than the in-memory map: a serverless instance
      // is short-lived, so without this every visitor pays the full cost again
      // — and each miss on a streamless event is another 101 YouTube units.
      const edge = Math.floor(ttl / 1000);
      res.setHeader('Cache-Control', `public, s-maxage=${edge}, stale-while-revalidate=${edge}`);
      return res.status(200).json(out);
    } catch (err) {
      return res.status(200).json({ ok: false, reason: 'fetch-failed', detail: err.message, streams: [] });
    }
  } else if (path === 'diag') {
    // ── Server-side diagnostics for the in-app debug page ─────────────────
    // Reports only whether things are CONFIGURED, never their values. A key
    // that leaks through a debug endpoint is worse than the bug it diagnoses.
    return res.status(200).json({
      ok: true,
      time: new Date().toISOString(),
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      robotEventsTokens: getTokens().length,
      youtubeKey: !!process.env.YOUTUBE_API_KEY,
      cacheEntries: cache.size,
      node: process.version,
      build: PROXY_BUILD,
      // YouTube units spent by THIS instance since it started. Instances are
      // short-lived, so this is a sample rather than a daily total — but a
      // large number here means something is looping.
      ytUnitsThisInstance: ytUnitsUsed
    });
  } else if (path.startsWith('vimeo:')) {
    // ── Vimeo, without the paid API ──────────────────────────────────────
    // A Vimeo "event" is a recurring live channel; each broadcast session
    // becomes its own clip. Nothing here needs a key — it all comes off the
    // public embed page and the player config it names:
    //
    //   • which clip the event is showing right now
    //   • that clip's unlisted `h=` hash, which is the ONLY way to pin one
    //     specific recording (the event embed ignores ?video= and always
    //     serves whatever is currently featured, so yesterday's day would
    //     silently start playing today's footage)
    //   • the broadcast's SCHEDULED start, duration and live status
    //
    // What is NOT available: the actual moment the broadcast began. That sits
    // behind Vimeo's paid tier. Scheduled start is the closest free proxy for
    // it, and it is only as accurate as the event running on time.
    const arg = path.slice(6);
    const [kind, id] = arg.includes('=') ? arg.split('=') : ['event', arg];
    if (!/^\d{6,15}$/.test(id || '')) {
      return res.status(400).json({ ok: false, reason: 'bad-id' });
    }
    const vKey = 'vimeo:' + kind + ':' + id;
    const vHit = cache.get(vKey);
    if (vHit && vHit.expires > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(vHit.data);
    }
    const VUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
    try {
      let clipId = kind === 'clip' ? id : null;
      let out = { ok: false, reason: 'no-clip' };

      if (kind === 'event') {
        const er = await fetch(`https://vimeo.com/event/${id}/embed`, {
          headers: { 'User-Agent': VUA, 'Accept': 'text/html' },
          signal: AbortSignal.timeout(9000)
        });
        if (!er.ok) return res.status(200).json({ ok: false, reason: 'event-' + er.status });
        const ehtml = await er.text();
        clipId = (ehtml.match(/player\.vimeo\.com\/video\/(\d+)\//) || [])[1] || null;
        if (!clipId) {
          const miss = { ok: false, reason: 'no-clip-attached', eventId: id };
          cache.set(vKey, { data: miss, status: 200, expires: Date.now() + SHORT_TTL_MS });
          return res.status(200).json(miss);
        }
        // The config URL carries a short-lived signature, so it has to come
        // from the embed HTML rather than be rebuilt.
        const cfgUrl = ((ehtml.match(/data-config-url="([^"]+)"/) || [])[1] || '')
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        out = { ...(await vimeoClipDetails(cfgUrl, VUA)) };
      }

      // The hash pins this specific clip. Prefer the one in the config; fall
      // back to the clip's own page. Anchored to the requested id, because a
      // Vimeo page also lists related clips' player URLs and grabbing one of
      // those would pin the wrong recording with nothing on screen to say so.
      let hash = out.hash || null;
      if (!hash && clipId) {
        try {
          const cr = await fetch(`https://vimeo.com/${clipId}`, {
            headers: { 'User-Agent': VUA, 'Accept': 'text/html' },
            signal: AbortSignal.timeout(9000)
          });
          if (cr.ok) {
            const anchored = new RegExp('/video/' + clipId + '\\?h=([a-z0-9]+)', 'i');
            hash = ((await cr.text()).match(anchored) || [])[1] || null;
          }
        } catch (e) {}
      }

      const body = {
        ok: !!clipId,
        eventId: kind === 'event' ? id : null,
        videoId: clipId,
        hash: hash || null,
        title: out.title || null,
        duration: out.duration ?? null,
        liveStatus: out.liveStatus || null,
        scheduledStart: out.scheduledStart || null
      };
      // The featured clip flips when a broadcast starts or ends, so an event
      // lookup is only briefly true; a resolved clip's hash is permanent.
      cache.set(vKey, { data: body, status: 200,
        expires: Date.now() + (kind === 'clip' ? LONG_TTL_MS : SHORT_TTL_MS) });
      return res.status(200).json(body);
    } catch (err) {
      return res.status(200).json({ ok: false, reason: 'vimeo-failed', detail: err.message });
    }
  } else if (path.startsWith('youtube:')) {
    // ── Stream start lookup ──────────────────────────────────────────────
    // A livestream's `actualStartTime` is the wall-clock moment the broadcast
    // began. With it, a match's position in the video is pure arithmetic:
    //     videoSeconds = (match.started - actualStartTime) / 1000
    // ...which removes the need for a manual anchor entirely.
    //
    // The key stays server-side deliberately. A YouTube key shipped to the
    // browser is readable by anyone and can be scraped and abused against your
    // quota; proxying keeps it private and lets us cache the result.
    const ytKey = process.env.YOUTUBE_API_KEY;
    const videoId = path.slice(8);
    if (!ytKey) return res.status(200).json({ ok: false, reason: 'no-key' });
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ ok: false, reason: 'bad-id' });
    }
    try {
      const r = await fetch(
        'https://www.googleapis.com/youtube/v3/videos' +
        '?part=liveStreamingDetails&id=' + encodeURIComponent(videoId) +
        '&key=' + encodeURIComponent(ytKey)
      );
      const j = await r.json();
      const item = (j.items || [])[0];
      const d = item && item.liveStreamingDetails;
      if (!d) return res.status(200).json({ ok: false, reason: 'not-a-livestream' });

      if (d.actualStartTime) {
        // Lookups are immutable once a broadcast has ended — cache hard.
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
        return res.status(200).json({ ok: true, status: 'started', actualStartTime: d.actualStartTime });
      }
      if (d.scheduledStartTime) {
        // Scheduled but not yet live — no offset exists yet.
        return res.status(200).json({ ok: false, reason: 'not-started', scheduledStartTime: d.scheduledStartTime });
      }
      return res.status(200).json({ ok: false, reason: 'not-a-livestream' });
    } catch (err) {
      return res.status(200).json({ ok: false, reason: 'lookup-failed' });
    }
  } else if (path.startsWith('boxcast:')) {
    // ── VEX TV is BoxCast ────────────────────────────────────────────────
    //
    // Confirmed from a broadcast object captured off vexworlds.tv:
    //
    //   { "id": "efkb0bx8283bgyqvm396",
    //     "name": "Qualification Matches (Science)",
    //     "starts_at": "2026-04-24T13:15:00Z",
    //     "stops_at":  "2026-04-24T20:34:00Z",
    //     "description": "V5RC (HS)",
    //     "channel_id": "qualification-matches-science-pjiswvniyktygr4misw0",
    //     "account_id": "jm81brqcwqhlenmnd1ub",
    //     "preview": "https://recordings.boxcast.com/…" }
    //
    // starts_at is the thing that matters. It is the real broadcast start, in
    // UTC, which is exactly what auto-sync needs — the same role
    // actualStartTime plays for YouTube. stops_at gives the duration, so the
    // past-the-end check in rwTryAutoSync works here too, and `description`
    // carries the grade for the §3 veto.
    //
    // So VEX TV can sync itself. What it still cannot do is embed: the media
    // is HLS behind CloudFront signed URLs (Policy/Signature/Expires on every
    // asset above), issued per viewer. Times, yes. Jumping, no.
    //
    // The exact query shape of BoxCast's list endpoint has NOT been observed —
    // the capture showed the request name, not its URL, and this sandbox's
    // network policy refuses the host. So every candidate is recorded in
    // `tried` with its status, the way §2 does for the event page. A wrong
    // guess shows up as a diagnosable line rather than a silent empty answer.
    const rest = 'https://rest.boxcast.com';
    const chan = path.slice(8).replace(/[^\w-]/g, '').slice(0, 80);
    if (!chan) return res.status(400).json({ ok: false, reason: 'bad-channel', broadcasts: [] });
    const startISO = typeof req.query.start === 'string' ? req.query.start : '';
    const endISO = typeof req.query.end === 'string' ? req.query.end : startISO;
    const tried = [];
    let list = null;
    for (const u of [
      `${rest}/channels/${encodeURIComponent(chan)}/broadcasts?l=100`,
      `${rest}/broadcasts?q=${encodeURIComponent('channel_id:' + chan)}&l=100`
    ]) {
      try {
        const r = await fetch(u, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(9000) });
        tried.push(`${u.replace(rest, '')} -> ${r.status}`);
        if (!r.ok) continue;
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j.broadcasts) ? j.broadcasts : null);
        if (arr && arr.length) { list = arr; break; }
      } catch (e) {
        tried.push(`${u.replace(rest, '')} -> ${String(e && e.message || e).slice(0, 60)}`);
      }
    }
    if (!list) {
      return res.status(200).json({ ok: false, reason: 'no-broadcasts', tried, broadcasts: [] });
    }
    const sMs = Date.parse(startISO), eMs = Date.parse(endISO || startISO);
    const within = b => {
      const t = Date.parse(b.starts_at || 0);
      if (isNaN(t) || isNaN(sMs)) return true;   // no window given: keep it
      return t >= sMs - 36 * 3600e3 && t <= (isNaN(eMs) ? sMs : eMs) + 36 * 3600e3;
    };
    const out = list.filter(within).map(b => ({
      id: b.id,
      name: b.name || '',
      // Named to match what the client already consumes for YouTube, so the
      // per-day picker and auto-sync need no special case for this platform.
      title: [b.name, b.description].filter(Boolean).join(' — '),
      actualStartTime: b.starts_at || null,
      publishedAt: b.starts_at || null,
      durationSec: (b.starts_at && b.stops_at)
        ? Math.max(0, Math.round((Date.parse(b.stops_at) - Date.parse(b.starts_at)) / 1000)) : null,
      grade: gradeOf(`${b.name || ''} ${b.description || ''}`),
      channelId: b.channel_id || chan,
      url: `https://www.vexworlds.tv/#/broadcasts/${b.id}`
    })).sort((a, b) => Date.parse(a.actualStartTime || 0) - Date.parse(b.actualStartTime || 0));
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: out.length > 0, build: PROXY_BUILD, tried, broadcasts: out });
  } else if (path.startsWith('siblings:')) {
    // ── The other days of a multi-day event ──────────────────────────────
    //
    // Organisers stream one broadcast PER DAY but publish only one of them in
    // the event description — in practice the last. The client used to apply
    // that single link to every day, so day 1 was anchored against day 2's
    // video: a negative offset, auto-sync refusing, and no match jumpable.
    //
    // Given one video of the event we already know its channel (the snippet
    // rides along on the details call we pay for anyway), and the rest of the
    // days are almost always sitting on it. Resolving that channel costs 2-3
    // units against the 101 a name search costs, and it is far more reliable:
    // the channel is confirmed rather than guessed at from a title.
    //
    // resolveChannel() takes a channel URL and already parses /channel/UC…,
    // so the id goes straight back in without a second code path — and its
    // date window and grade veto (§3) apply unchanged.
    const ytKey = process.env.YOUTUBE_API_KEY;
    const videoId = path.slice(9);
    const startISO = typeof req.query.start === 'string' ? req.query.start : '';
    const endISO = typeof req.query.end === 'string' ? req.query.end : '';
    const evName = typeof req.query.name === 'string' ? req.query.name : '';
    if (!ytKey) return res.status(200).json({ ok: false, reason: 'no-key', streams: [] });
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ ok: false, reason: 'bad-id', streams: [] });
    }
    if (!startISO) return res.status(200).json({ ok: false, reason: 'no-dates', streams: [] });
    try {
      const details = await ytVideoDetails([videoId], ytKey);
      const me = details && details.get(videoId);
      const channelId = me && me.channelId;
      if (!channelId) {
        return res.status(200).json({ ok: false, reason: 'no-channel', streams: [] });
      }
      const vids = await resolveChannel(
        'https://www.youtube.com/channel/' + channelId, startISO, endISO, ytKey, evName);
      const out = {
        ok: vids.length > 0,
        build: PROXY_BUILD,
        channelId,
        // Same shape as the `streams:` route, so the client merges the two
        // without a special case.
        streams: vids.map(v => ({ ...v, source: 'yt-siblings' })),
        reason: vids.length ? undefined : 'channel-no-videos'
      };
      // A finished event's channel listing cannot change; cache it hard. One
      // that is still running is retried within the hour, because the later
      // days may not have been broadcast yet.
      const eventOver = Date.parse(endISO || startISO) < Date.now() - 36 * 3600e3;
      const ttl = out.ok ? STREAM_TTL_MS : (eventOver ? NEG_TTL_PAST_MS : NEG_TTL_MS);
      const edge = Math.floor(ttl / 1000);
      res.setHeader('Cache-Control', `public, s-maxage=${edge}, stale-while-revalidate=${edge}`);
      return res.status(200).json(out);
    } catch (err) {
      return res.status(200).json({ ok: false, reason: 'lookup-failed', streams: [] });
    }
  } else {
    // Main authenticated v2 API
    url = `https://events.vex.com/api/v2${path}`;
  }

  const tokens = useAuth ? getTokens() : [];
  if (useAuth && tokens.length === 0) {
    return res.status(500).json({ error: 'No API tokens configured' });
  }
  // Tell the frontend how much parallel headroom exists
  res.setHeader('X-Token-Count', String(Math.max(1, tokens.length)));

  // Check cache
  const cached = cache.get(path);
  if (cached && cached.expires > Date.now()) {
    res.setHeader('X-Cache', 'HIT');
    if (ttlFor(path) === LONG_TTL_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
    }
    return res.status(cached.status).json(cached.data);
  }

  const baseHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://events.vex.com/'
  };

  // Try each token until one succeeds (or we run out)
  const attempts = useAuth ? tokens.length : 1;
  let lastResponse = null;
  let lastText = '';

  for (let i = 0; i < attempts; i++) {
    const headers = { ...baseHeaders };
    if (useAuth) {
      const tokenIndex = (tokenCursor + i) % tokens.length;
      headers['Authorization'] = `Bearer ${tokens[tokenIndex]}`;
    }

    try {
      // A timeout is essential here: without one a hanging upstream holds the
      // function open until the platform kills it, and the caller sees a bare
      // 500 with no clue why. 12s leaves room for a retry on the next token
      // inside a 60s budget.
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      const text = await response.text();
      lastResponse = response;
      lastText = text;

      // If rate-limited or server error, try next token
      if (useAuth && (response.status === 429 || response.status >= 500) && i < attempts - 1) {
        continue;
      }

      if (useAuth) {
        tokenCursor = (tokenCursor + 1) % tokens.length;
      }

      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);

      let data;
      try {
        data = slimForPath(path, JSON.parse(text));
      } catch (e) {
        data = {
          error: 'Non-JSON response from events.vex.com',
          status: response.status,
          preview: text.slice(0, 300)
        };
      }

      // Cache successful responses with smart TTL
      if (response.status >= 200 && response.status < 300) {
        cache.set(path, {
          data,
          status: response.status,
          expires: Date.now() + ttlFor(path)
        });
        if (cache.size > 1500) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
        }
        // EDGE CACHING — STABLE DATA ONLY. Team histories, rosters, and skills
        // standings (5-min TTL) are served by Vercel's CDN without invoking this
        // function. Live data (event matches/rankings) deliberately gets NO edge
        // caching, so a Match Day refresh is always function-fresh.
        if (ttlFor(path) === LONG_TTL_MS) {
          res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
        }
      }

      res.setHeader('X-Cache', 'MISS');
      return res.status(response.status).json(data);
    } catch (err) {
      lastResponse = null;
      lastText = err.message;
      if (i === attempts - 1) {
        // Distinguish "we couldn't reach the API" from "we're broken". A 500
        // says the fault is here and gives the client nothing to act on; the
        // gateway codes say the upstream failed, and the client already
        // retries them with backoff.
        const timedOut = err.name === 'TimeoutError' || /abort|timeout/i.test(err.message || '');
        return res.status(timedOut ? 504 : 502).json({
          error: timedOut
            ? 'The VEX API did not respond in time.'
            : 'Could not reach the VEX API.',
          detail: String(err.message || err).slice(0, 200),
          upstream: 'events.vex.com',
          build: PROXY_BUILD
        });
      }
    }
  }

  if (lastResponse) {
    let data;
    try {
      data = JSON.parse(lastText);
    } catch (e) {
      data = { error: 'All tokens rate-limited', status: lastResponse.status };
    }
    const retryAfter = lastResponse.headers.get('Retry-After');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    return res.status(lastResponse.status).json(data);
  }

  return res.status(500).json({ error: 'Request failed' });
}
