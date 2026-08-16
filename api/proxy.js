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

// Scraping the event page (racing three strategies) and then searching YouTube
// can exceed Vercel's 10s default. Raise it or auto-find dies on slow pages.
export const config = { maxDuration: 60 };

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

// ── Channel → the videos it broadcast during an event ──────────────────────
// A handle (@name) or /c/ vanity URL has to be resolved to a channel ID first;
// /channel/ID URLs already carry it. Then ask for that channel's completed,
// live and upcoming broadcasts, with completed ones bounded to the event's
// dates (±1 day for timezone slop and streams that start the night before).
async function resolveChannel(channelUrl, startISO, endISO, ytKey) {
  const yt = async (qs) => {
    const r = await fetch('https://www.googleapis.com/youtube/v3/' + qs + '&key=' + encodeURIComponent(ytKey),
      { signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : null;
  };

  let channelId = (channelUrl.match(/\/channel\/([\w-]+)/) || [])[1] || null;
  if (!channelId) {
    const handle = (channelUrl.match(/\/(?:@|c\/|user\/)([\w.-]+)/) || [])[1];
    if (!handle) return [];
    const j = await yt('search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(handle));
    channelId = j && j.items && j.items[0] && j.items[0].id && j.items[0].id.channelId;
    if (!channelId) return [];
  }

  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO || startISO);
  if (isNaN(startMs)) return [];
  const after = new Date(startMs - 86400000).toISOString();
  const before = new Date((isNaN(endMs) ? startMs : endMs) + 2 * 86400000).toISOString();

  const runs = await Promise.all(['completed', 'live', 'upcoming'].map(async (type) => {
    let qs = 'search?part=snippet&type=video&order=date&maxResults=10' +
             '&channelId=' + encodeURIComponent(channelId) + '&eventType=' + type;
    // A live or upcoming broadcast has no meaningful publishedAt window yet,
    // so only the finished ones get date-bounded.
    if (type === 'completed') qs += '&publishedAfter=' + after + '&publishedBefore=' + before;
    const j = await yt(qs);
    return (j && j.items) || [];
  }));

  const out = [];
  const seen = new Set();
  for (const item of runs.flat()) {
    const id = item.id && item.id.videoId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      url: 'https://www.youtube.com/watch?v=' + id,
      title: (item.snippet && item.snippet.title) || '',
      publishedAt: (item.snippet && item.snippet.publishedAt) || null
    });
  }
  // Oldest first, so day 1 of the event lines up with the first video.
  out.sort((a, b) => Date.parse(a.publishedAt || 0) - Date.parse(b.publishedAt || 0));
  return out;
}

function slimForPath(path, data) {
  if (path.startsWith('legacy:/seasons/') && path.includes('/skills')) return slimSeasonSkills(data);
  return data;
}

export default async function handler(req, res) {
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

    const cacheKey = 'streams:' + sku + '|' + startISO.slice(0, 10);
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(hit.data);
    }
    try {
      // Where the public event page actually lives is not stable. The API
      // moved from robotevents.com to events.vex.com after the VEX/RECF
      // split, program segments have been renamed (VRC → V5RC, VIQC → VIQRC),
      // and the trailing .html is not always present. A single guess returns a
      // clean 404 that looks exactly like "this event has no stream".
      //
      // So try the plausible shapes at once and keep whichever serves a real
      // page. Every attempt is recorded, so a miss says which URLs were tried
      // rather than leaving it to guesswork.
      const progs = [];
      if (/-(VIQRC|VIQC)-/.test(sku)) progs.push('vex-iq-competition', 'viqrc');
      else if (/-(VURC|VEXU)-/.test(sku)) progs.push('vex-u-robotics-competition', 'vurc');
      else if (/-(ADC|VAIC)-/.test(sku)) progs.push('aerial-drone-competition', 'adc');
      else progs.push('vex-robotics-competition', 'v5rc', 'vex-v5-robotics-competition');

      const urls = [];
      for (const host of ['www.robotevents.com', 'events.vex.com']) {
        for (const p of progs) {
          urls.push(`https://${host}/robot-competitions/${p}/${sku}.html`);
          urls.push(`https://${host}/robot-competitions/${p}/${sku}`);
        }
        urls.push(`https://${host}/${sku}.html`);
      }

      const looksReal = (html, src) => {
        // Under 500 chars is an error stub; the Cloudflare markers are a
        // challenge page, which arrives as a 200 with no links in it.
        if (!html || html.length < 500) throw new Error(src + ':too-short');
        if (html.includes('id="challenge-running"') ||
            html.includes('Just a moment...') ||
            html.includes('cf-browser-verification')) throw new Error(src + ':cloudflare');
        return html;
      };
      const attempt = async (url, headers, ms, src) => {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
        if (!resp.ok) throw new Error(src + ':' + resp.status);
        return { html: looksReal(await resp.text(), src), url, via: src };
      };

      // Googlebot first — crawlers are whitelisted past Cloudflare — with a
      // normal browser UA alongside. All candidates race together so a long
      // list costs one round trip, not one per URL.
      const tried = [];
      const note = (u, e) => { tried.push(u.replace(/^https:\/\//, '') + ' ' + e.message); throw e; };
      const race = [
        // Googlebot on every candidate; a browser UA only on the two likeliest
        // URLs, so a wide search doesn't become dozens of requests at once.
        ...urls.map(u => attempt(u, {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Referer': 'https://www.google.com/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }, 9000, 'googlebot').catch(e => note(u, e))),
        ...urls.slice(0, 2).map(u => attempt(u, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }, 9000, 'standard').catch(e => note(u, e)))
      ];

      let rawHtml = null, pageUrl = null, pageVia = null;
      try {
        const win = await Promise.any(race);
        rawHtml = win.html; pageUrl = win.url; pageVia = win.via;
      } catch (aggregate) {
        const out = { ok: false, reason: 'page-unreachable', tried: tried.slice(0, 24), streams: [] };
        cache.set(cacheKey, { data: out, status: 200, expires: Date.now() + SHORT_TTL_MS });
        return res.status(200).json(out);
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

      const STREAM_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/|player\.vimeo\.com\/video\/|vimeo\.com\/(?:event\/)?)[\w?=&\/-]+/gi;
      // Channel and handle URLs — not jumpable on their own, resolved below.
      const CHANNEL_URL_RE = /https?:\/\/(?:www\.)?youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w-]+|user\/[\w-]+)/gi;

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
      const webcastBlock = html.match(/(?:id|class)="[^"]*webcast[^"]*"[\s\S]{0,4000}/i);
      if (webcastBlock) {
        const m = webcastBlock[0].match(STREAM_URL_RE) || [];
        for (const u of m) add(u, 'webcast-section');
        for (const u of (webcastBlock[0].match(CHANNEL_URL_RE) || [])) addChannel(u, 'webcast-section');
      }
      // Then anywhere on the page
      const anywhere = html.match(STREAM_URL_RE) || [];
      for (const u of anywhere) add(u, 'page');
      for (const u of (html.match(CHANNEL_URL_RE) || [])) addChannel(u, 'page');

      // ── Channels have to be resolved into actual videos ──────────────────
      // Plenty of events publish "watch on our channel" rather than a link to
      // the broadcast itself. A channel URL can't be jumped into, so the old
      // code found nothing usable and fell back to asking the user. Ask
      // YouTube which videos that channel put out during the event instead.
      //
      // Only when no direct video turned up: `search` costs 100 quota units a
      // call against a 10,000/day default, so this stays a fallback.
      if (!found.length && channels.length) {
        const ytKey = process.env.YOUTUBE_API_KEY;
        if (ytKey && startISO && endISO) {
          for (const ch of channels.slice(0, 2)) {
            const vids = await resolveChannel(ch.url, startISO, endISO, ytKey);
            for (const v of vids) {
              add(v.url, ch.source === 'webcast-section' ? 'channel-webcast' : 'channel');
              const rec = found[found.length - 1];
              if (rec && rec.url === v.url) { rec.title = v.title; rec.publishedAt = v.publishedAt; }
            }
            if (found.length) break;
          }
        }
      }

      const out = {
        ok: found.length > 0,
        streams: found.slice(0, 12),
        // Which URL actually served the page, so a wrong-path guess shows up
        // in the debug panel instead of looking like "no stream published".
        pageUrl,
        pageVia,
        // Surfaced so the UI can distinguish "no stream published" from
        // "we found a channel but couldn't search it" — very different fixes.
        channels: channels.map(c => c.url).slice(0, 4),
        reason: found.length ? undefined
              : channels.length ? (process.env.YOUTUBE_API_KEY ? 'channel-no-videos' : 'channel-needs-yt-key')
              : 'no-links-on-page'
      };
      cache.set(cacheKey, { data: out, status: 200, expires: Date.now() + (found.length ? LONG_TTL_MS : SHORT_TTL_MS) });
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=3600');
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
      node: process.version
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
      const response = await fetch(url, { headers });
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
        return res.status(500).json({ error: err.message });
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
