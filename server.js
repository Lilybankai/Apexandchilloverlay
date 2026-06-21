const express = require('express');
const fs = require('fs/promises');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
/** Optional: enables live titles, viewer counts, and YouTube likes on multistream overlay (server-side only). */
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
/** Optional: Twitch Helix for stream titles and viewer counts (likes are not exposed for live streams). */
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const SIMGRID_BASE = 'https://www.thesimgrid.com';
const SIMGRID_KEY = 'PhEDyzEVPztV4yMJYsmQjKWy';
const COMMUNITY_ID = 3846;
const CHAMPIONSHIP_ID = 23082;
const SLP_BASE = 'https://simleaguepro.com/api/v1';
const SLP_COMMUNITY_ID = 'eb1236b1-e469-4fe7-8f1a-a7d8a30d6c65';
/** Whitelisted Sim League Pro league UUIDs (past + current). Unknown IDs rejected on /api/gt7/data. */
const SLP_GT7_SEASONS = [
  { id: 'f2d6eae4-9591-4e29-bc77-ec2e0197c32e', label: 'Season 4' },
  { id: '448d65ed-d6dd-4087-bebb-6008c62a92ad', label: 'Season 3' }
];
const SLP_GT7_LEAGUE_ID_DEFAULT = SLP_GT7_SEASONS[0].id;
const slpGt7LeagueIdSet = new Set(SLP_GT7_SEASONS.map(s => s.id));

// ── Le Mans Ultimate local REST API (runs on the same machine as the game) ────
// The game exposes a localhost REST API (Swagger at <base>/swagger) that the
// in-game UI and community tools read live timing from. We only ever read it.
const LMU_API_BASE = (process.env.LMU_API_BASE || 'http://localhost:6397').replace(/\/+$/, '');
const LMU_MOCK = process.env.LMU_MOCK === '1'; // dev: serve data/lmu-live-sample.json instead of the game
const LMU_LIVE_CACHE_MS = 750;                 // collapse concurrent overlay polls into one upstream call
const LMU_BATTLE_GAP_SEC = 1.0;                // gapAhead at/under this = a battle
const LMU_OVERTAKE_DEBOUNCE_MS = 5000;         // per-car cooldown so one pass fires one call-out
// Live-timing endpoints. Confirm against <base>/swagger; override via env if the build differs.
const LMU_STANDINGS_PATH = process.env.LMU_STANDINGS_PATH || '/rest/watch/standings';
const LMU_SESSION_PATH = process.env.LMU_SESSION_PATH || '/rest/watch/sessionInfo';

// ── Stream bot (Twitch + YouTube chat bot) ───────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // gate the bot admin when not on localhost
const BOT_DRY_RUN = process.env.BOT_DRY_RUN === '1';
const bot = require('./scripts/bot')({
  broadcast,                                   // hoisted function declaration (defined below)
  twitchClientId: TWITCH_CLIENT_ID,
  twitchClientSecret: TWITCH_CLIENT_SECRET,
  googleClientId: GOOGLE_CLIENT_ID,
  googleClientSecret: GOOGLE_CLIENT_SECRET,
  publicBaseUrl: PUBLIC_BASE_URL,
  getTwitchAppToken: () => getTwitchAccessToken(),
  dryRun: BOT_DRY_RUN,
});

// Admin gate: open on loopback (frictionless local-during-stream); otherwise
// require ADMIN_TOKEN via X-Admin-Token header, admin_token cookie, or ?admin_token.
function botIsLocal(req) {
  const ip = (req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1';
}
function botCookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)admin_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function botAdminGate(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (botIsLocal(req)) return next();
  const tok = req.headers['x-admin-token'] || botCookieToken(req) || req.query.admin_token;
  if (tok && tok === ADMIN_TOKEN) return next();
  if (req.path === '/bot-controls.html') return res.status(401).send(botLoginPage());
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}
function botLoginPage() {
  return `<!doctype html><meta charset="utf8"><title>Bot Admin · Apex &amp; Chill</title>`
    + `<body style="font-family:system-ui;background:#06060f;color:#eaeaf5;display:grid;place-items:center;height:100vh;margin:0">`
    + `<form onsubmit="document.cookie='admin_token='+encodeURIComponent(t.value)+';path=/;max-age=2592000';location.reload();return false" `
    + `style="background:#0d0d22;padding:28px;border-radius:14px;border:1px solid rgba(0,212,255,.2)">`
    + `<h3 style="margin:0 0 12px;font-family:monospace;letter-spacing:2px">BOT ADMIN</h3>`
    + `<input id="t" type="password" placeholder="Admin token" autofocus style="padding:10px;border-radius:8px;border:1px solid #333;background:#111128;color:#fff;width:240px">`
    + `<button style="margin-top:10px;width:100%;padding:10px;border-radius:8px;border:1px solid #00d4ff66;background:#00d4ff14;color:#00d4ff;cursor:pointer">Enter</button>`
    + `</form></body>`;
}

// Behind nginx / Lilybank / similar — needed for correct client IPs if you log them later
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));

// ── Bot security guards — MUST precede express.static ────────────────────────
app.get('/data/bot-tokens.json', (_req, res) => res.status(404).end()); // never serve the token file
app.use((req, res, next) => { if (req.path.endsWith('.tmp')) return res.status(404).end(); next(); });
app.get('/bot-controls.html', botAdminGate, (_req, res) => res.sendFile(path.join(__dirname, 'bot-controls.html')));

app.use(express.static(__dirname)); // serves overlay.html, controls.html, podium-test.glb, data/, etc.


// ── SSE client list & server-side state ──────────────────────────────────────
let clients     = [];
let serverState = {
  league: 'lmu',
  classIdx: 0,
  paused: false,
  scrollPos: 0,
  screen: 'standings',
  gt7LeagueId: SLP_GT7_LEAGUE_ID_DEFAULT,
  leagueState: {
    lmu: { classIdx: 0, paused: false, scrollPos: 0, screen: 'standings' },
    gt7: {
      classIdx: 0,
      paused: false,
      scrollPos: 0,
      screen: 'standings',
      gt7LeagueId: SLP_GT7_LEAGUE_ID_DEFAULT
    }
  }
};
const simgridCache = {};
const slpCache = {};

// ── Multi-stream state ────────────────────────────────────────────────────────
let multistreamState = {
  streams: [],                            // [{id, url, type, embedId, label}]
  visibleSlots: [null, null, null, null], // stream ids (or null) for each of the 4 grid slots
  rotationOffset: 0,                      // index cursor for rotation
  focusedId: null,                        // stream id with audio; null = mute all
  layout: 'grid',                         // 'grid' | 'pip' | 'dual'
  rotationEnabled: false,
  rotationIntervalSec: 30,
  twitchParent: 'ng008o88o0wo0k4c0w840skk.lilybankhost.co.uk',
  /** Per-stream metadata from YouTube/Twitch APIs (when env keys are set). */
  streamStats: {},
  /** Lower-third style ticker — text and timing from control panel. */
  banner: { enabled: false, text: '', durationSec: 40 },
  /** LMU live timing tower — armed once, then fully automatic. Off by default (GT7 unaffected). */
  lmuTiming: { enabled: false },
};
let msRotationTimer = null;
let msStatsTimer = null;
let twitchAccessToken = null;
let twitchTokenExpiresAt = 0;

// ── LMU live-timing runtime state ─────────────────────────────────────────────
let lmuLiveCache = { ts: 0, data: null }; // short-lived normalized snapshot
let lmuPollTimer = null;                  // server-side detection loop (overtakes/battles)
let lmuPrev = null;                       // previous snapshot, for diffing
let lmuApiOnline = true;                  // false after a failed fetch; re-probes on next poll
let lmuLastEventByCar = {};               // carNum → ts of last overtake call-out (debounce)
const lmuSectorBest = { field: [null, null, null], byCar: {} }; // best sector times for colouring

async function simgridFetch(pathname) {
  const url = `${SIMGRID_BASE}${pathname}`;
  const cached = simgridCache[url];
  if (cached && Date.now() - cached.ts < 15 * 60 * 1000) {
    return cached.data;
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${SIMGRID_KEY}` }
  });
  if (!response.ok) {
    const text = await response.text();
    const snippet = (text || '').slice(0, 220);
    throw new Error(`SimGrid request failed (${response.status}) ${snippet}`);
  }
  const data = await response.json();
  simgridCache[url] = { ts: Date.now(), data };
  return data;
}

async function simgridFetchFirst(paths) {
  let lastError = null;
  for (const pathname of paths) {
    try {
      return await simgridFetch(pathname);
    } catch (error) {
      lastError = error;
    }
  }
  const tried = paths.join(', ');
  throw new Error(`All SimGrid paths failed. Tried: ${tried}. Last error: ${String(lastError?.message || lastError)}`);
}

async function slpFetch(pathname, { bypassCache = false } = {}) {
  const url = `${SLP_BASE}${pathname}`;
  if (!bypassCache) {
    const cached = slpCache[url];
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      return cached.data;
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SimLeaguePro request failed (${response.status}) ${(text || '').slice(0, 220)}`);
  }
  const data = await response.json();
  slpCache[url] = { ts: Date.now(), data };
  return data;
}

function clearSlpCache() {
  Object.keys(slpCache).forEach(key => delete slpCache[key]);
}

async function slpFetchAllDrivers(communityId) {
  const perPage = 50;
  const first = await slpFetch(`/communities/${communityId}/drivers.json?page=1&per_page=${perPage}`);
  const all = Array.isArray(first?.drivers) ? [...first.drivers] : [];
  const totalPages = Number(first?.total_pages || 1);
  for (let page = 2; page <= totalPages; page += 1) {
    try {
      const next = await slpFetch(`/communities/${communityId}/drivers.json?page=${page}&per_page=${perPage}`);
      if (Array.isArray(next?.drivers)) all.push(...next.drivers);
    } catch (_) {
      break;
    }
  }
  return all;
}

function toTimestamp(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function aggregateDriverRoundResult(username, round) {
  const target = normalizeKey(username);
  const buckets = [
    ...(round.raceResults || []),
    ...(round.subRaces || []).flatMap(sub => sub.race_results || [])
  ];

  let hasData = false;
  let totalPoints = 0;
  let bestPosition = null;
  let dnf = false;
  let dns = false;

  buckets.forEach(entry => {
    if (normalizeKey(entry.username) !== target) return;
    hasData = true;
    totalPoints += Number(entry.points || 0);
    const pos = entry.position;
    if (pos != null && (bestPosition == null || pos < bestPosition)) bestPosition = pos;
    if (entry.dnf) dnf = true;
    if (entry.dns) dns = true;
  });

  if (!hasData) return { position: null, pointsTotal: null, dnf: null, dns: null };
  return { position: bestPosition, pointsTotal: totalPoints, dnf, dns };
}

function buildGt7Rounds(races) {
  const now = Date.now();
  const pastBufferMs = 3 * 60 * 60 * 1000;
  const rounds = races.map((race, idx) => {
    const date = race.start_datetime || null;
    const ts = toTimestamp(date);
    const mainResults = Array.isArray(race.race_results) ? race.race_results : [];
    const subRaces = Array.isArray(race.sub_races) ? race.sub_races : [];
    const hasResults = mainResults.length > 0 || subRaces.some(sub => (sub.race_results || []).length > 0);
    const isFinished = hasResults || (!!ts && ts < now - pastBufferMs);
    const displayName = (race.name && race.name.trim()) || race.track || `Round ${idx + 1}`;
    return {
      index: idx,
      eventId: race.id || null,
      name: displayName,
      track: race.track || null,
      date,
      isFinished,
      raceResults: mainResults,
      subRaces
    };
  });
  const nextRound = rounds.find(round => !round.isFinished);
  if (nextRound) nextRound.isNext = true;
  return rounds;
}

function buildGt7Class(className, entries, rounds, driverLookup) {
  const ranked = entries.map((entry, idx) => {
    const enriched = driverLookup.get(normalizeKey(entry.username)) || {};
    const displayName = String(
      entry.platform_username
      || entry.username
      || enriched.community_username
      || `Driver ${idx + 1}`
    ).trim();
    const car = [entry.constructor, entry.car].filter(Boolean).join(' ').trim() || entry.car || 'GT7';
    const points = Number(entry.points || 0);
    return {
      position: Number(entry.position) || null,
      id: displayName,
      carNum: entry.car_number || '--',
      car,
      championshipPoints: points,
      races: rounds.map(round => aggregateDriverRoundResult(entry.username, round))
    };
  });

  ranked.sort((a, b) => {
    if (b.championshipPoints !== a.championshipPoints) return b.championshipPoints - a.championshipPoints;
    if (a.position == null && b.position == null) return 0;
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });
  ranked.forEach((driver, idx) => { driver.position = idx + 1; });

  return { carClass: className, label: className, standings: ranked };
}

function normalizeGt7Data(driversList, leaguePayload) {
  const league = leaguePayload || {};
  const leagueResults = Array.isArray(league.league_results) ? league.league_results : [];
  const races = Array.isArray(league.races) ? league.races : [];

  const driverLookup = new Map();
  (Array.isArray(driversList) ? driversList : []).forEach(entry => {
    const key = normalizeKey(entry.username);
    if (key) driverLookup.set(key, entry);
  });

  const rounds = buildGt7Rounds(races);

  const byClass = new Map();
  leagueResults
    .filter(entry => !entry.reserve)
    .forEach(entry => {
      const cls = entry.vehicle_class || 'Overall';
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls).push(entry);
    });

  const vehicleClasses = Array.isArray(league.vehicle_classes) && league.vehicle_classes.length
    ? league.vehicle_classes
    : Array.from(byClass.keys());

  const classes = vehicleClasses
    .filter(cls => byClass.has(cls))
    .map(cls => buildGt7Class(cls, byClass.get(cls), rounds, driverLookup));

  if (classes.length === 0 && leagueResults.length) {
    classes.push(buildGt7Class('Overall', leagueResults, rounds, driverLookup));
  }

  const nextRound = rounds.find(round => round.isNext);
  const seasonName = league.season != null && league.name
    ? `${league.name} · Tier ${league.tier ?? '-'}`
    : (league.name || 'GT7 League');

  return {
    classes,
    meta: {
      seasonName,
      platform: league.platform || null,
      game: league.game || null,
      rounds: rounds.map(round => ({
        index: round.index,
        eventId: round.eventId,
        name: round.name,
        track: round.track,
        date: round.date,
        isFinished: round.isFinished,
        isNext: !!round.isNext
      })),
      nextRace: nextRound ? { name: nextRound.name, date: nextRound.date } : null
    }
  };
}

function resolveGt7LeagueIdForDataQuery(raw) {
  if (raw == null || raw === '') return SLP_GT7_LEAGUE_ID_DEFAULT;
  const id = String(raw).trim();
  return slpGt7LeagueIdSet.has(id) ? id : null;
}

function usernameKeysFromRaceResults(payload) {
  const keys = new Set();
  for (const race of payload.races || []) {
    for (const e of race.race_results || []) {
      const k = normalizeKey(e.username);
      if (k) keys.add(k);
    }
    for (const sub of race.sub_races || []) {
      for (const e of sub.race_results || []) {
        const k = normalizeKey(e.username);
        if (k) keys.add(k);
      }
    }
  }
  return keys;
}

function findFirstRaceEntryForKey(payload, usernameKey) {
  for (const race of payload.races || []) {
    const buckets = [
      ...(race.race_results || []),
      ...(race.sub_races || []).flatMap(sr => sr.race_results || [])
    ];
    for (const e of buckets) {
      if (normalizeKey(e.username) !== usernameKey) continue;
      return {
        username: e.username || usernameKey,
        platform_username: e.platform_username || null
      };
    }
  }
  return { username: usernameKey, platform_username: null };
}

/** Each normal + reverse grid race row counts separately (P1 and top-3 finishes). */
function countRaceWinsAndPodiums(payload, usernameKey) {
  let wins = 0;
  let podiums = 0;
  for (const race of payload.races || []) {
    const buckets = [
      ...(race.race_results || []),
      ...(race.sub_races || []).flatMap(sr => sr.race_results || [])
    ];
    for (const e of buckets) {
      if (normalizeKey(e.username) !== usernameKey) continue;
      const pos = e.position;
      if (pos === 1) wins += 1;
      if (pos != null && pos >= 1 && pos <= 3) podiums += 1;
    }
  }
  return { wins, podiums };
}

function buildCareerStats(driversList, leagueBundles) {
  const driverLookup = new Map();
  (Array.isArray(driversList) ? driversList : []).forEach(entry => {
    const key = normalizeKey(entry.username);
    if (key) driverLookup.set(key, entry);
  });

  const byUser = new Map();

  for (const bundle of leagueBundles) {
    const results = Array.isArray(bundle.payload?.league_results) ? bundle.payload.league_results : [];
    for (const row of results) {
      if (row.reserve) continue;
      const key = normalizeKey(row.username);
      if (!key) continue;
      const enriched = driverLookup.get(key) || {};
      if (!byUser.has(key)) {
        byUser.set(key, {
          username: row.username,
          displayName: String(
            row.platform_username
            || row.username
            || enriched.community_username
            || row.username
          ).trim(),
          titles: 0,
          wins: 0,
          podiums: 0,
          qualifyingWins: 0,
          qualifyingPodiums: 0
        });
      }
    }
  }

  for (const bundle of leagueBundles) {
    const payload = bundle.payload || {};
    for (const key of usernameKeysFromRaceResults(payload)) {
      if (byUser.has(key)) continue;
      const enriched = driverLookup.get(key) || {};
      const hit = findFirstRaceEntryForKey(payload, key);
      byUser.set(key, {
        username: hit.username,
        displayName: String(
          hit.platform_username
          || enriched.community_username
          || hit.username
          || key
        ).trim(),
        titles: 0,
        wins: 0,
        podiums: 0,
        qualifyingWins: 0,
        qualifyingPodiums: 0
      });
    }
  }

  for (const bundle of leagueBundles) {
    const payload = bundle.payload || {};
    const results = Array.isArray(payload.league_results) ? payload.league_results : [];
    for (const row of results) {
      if (row.reserve) continue;
      const key = normalizeKey(row.username);
      if (!key) continue;
      const agg = byUser.get(key);
      if (!agg) continue;
      const nameFromRow = String(row.platform_username || '').trim();
      if (nameFromRow) agg.displayName = nameFromRow;
      else {
        const enriched = driverLookup.get(key) || {};
        if (enriched.community_username) {
          agg.displayName = String(enriched.community_username).trim();
        }
      }
      agg.qualifyingWins += Number(row.qualifying_wins || 0);
      agg.qualifyingPodiums += Number(row.qualifying_podiums || 0);
      if (Number(row.position) === 1) agg.titles += 1;
    }

    for (const [key, agg] of byUser) {
      const add = countRaceWinsAndPodiums(payload, key);
      agg.wins += add.wins;
      agg.podiums += add.podiums;
    }
  }

  const drivers = Array.from(byUser.values()).sort((a, b) => {
    if (b.titles !== a.titles) return b.titles - a.titles;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.podiums - a.podiums;
  });

  const metaSeasons = leagueBundles.map(b => ({
    id: b.id,
    label: b.label,
    season: b.payload?.season ?? null,
    name: b.payload?.name ?? null
  }));

  return {
    drivers,
    meta: {
      seasons: metaSeasons,
      winsPodiumsSource: 'race_results_per_race',
      winsPodiumsNote:
        'Wins and podiums count every race finish (normal + reverse grid). Titles = championship P1 from league_results.'
    }
  };
}

function persistLeagueSlice() {
  const base = {
    classIdx: serverState.classIdx,
    paused: serverState.paused,
    scrollPos: serverState.scrollPos,
    screen: serverState.screen
  };
  if (serverState.league === 'gt7') {
    return { ...base, gt7LeagueId: serverState.gt7LeagueId };
  }
  return base;
}

// ── SSE endpoint  (overlay + controls both connect here) ─────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');   // disable nginx buffering if proxied
  res.flushHeaders();

  const id = `${Date.now()}-${Math.random()}`;
  clients.push({ id, res });

  // immediately push current state so new connections sync up
  send(res, { type: 'state', ...serverState, multistream: multistreamState, bot: bot.getPublicState() });

  req.on('close', () => {
    clients = clients.filter(c => c.id !== id);
  });
});

// ── GET current state (controls polls this on load) ──────────────────────────
app.get('/api/state', (req, res) => res.json(serverState));

// ── Lightweight health check (use this to verify proxy → Node is wired) ──────
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'apex-chill-overlay',
    multistreamMeta: {
      youtubeApi: !!YOUTUBE_API_KEY,
      twitchApi: !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET),
    },
    botMeta: {
      twitchOAuth: !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET),
      googleOAuth: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      publicBaseUrl: PUBLIC_BASE_URL,
      adminGate: !!ADMIN_TOKEN,
      dryRun: BOT_DRY_RUN,
    },
  });
});

// ── Overlay reports its state back (so controls stays in sync) ───────────────
app.post('/api/state', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { classIdx, scrollPos, screen, league, gt7LeagueId } = body;
    if (league === 'lmu' || league === 'gt7') serverState.league = league;
    if (classIdx  != null) serverState.classIdx  = classIdx;
    // Pause/resume is command-authoritative only (/api/command). Overlay scroll ticks POST
    // often; accepting paused here races with pause commands and can undo pause.
    if (scrollPos != null) serverState.scrollPos = scrollPos;
    if (screen    != null) serverState.screen    = screen;
    if (gt7LeagueId != null && slpGt7LeagueIdSet.has(String(gt7LeagueId).trim())) {
      serverState.gt7LeagueId = String(gt7LeagueId).trim();
    }
    serverState.leagueState[serverState.league] = persistLeagueSlice();
    broadcast({ type: 'stateUpdate', ...serverState });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/state', err);
    res.status(500).json({ ok: false });
  }
});

// ── Controls sends a command ──────────────────────────────────────────────────
app.post('/api/command', (req, res) => {
  const { cmd, ...args } = req.body;

  if (cmd === 'setGt7League') {
    const raw = args.leagueId;
    const id = raw != null && raw !== '' ? String(raw).trim() : '';
    if (!slpGt7LeagueIdSet.has(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_gt7_league' });
    }
    serverState.gt7LeagueId = id;
    serverState.leagueState.gt7 = {
      ...serverState.leagueState.gt7,
      gt7LeagueId: id
    };
  }

  // keep server state in sync so new clients get the right picture
  if (cmd === 'setLeague') {
    serverState.leagueState[serverState.league] = persistLeagueSlice();
    const nextLeague = args.league === 'gt7' ? 'gt7' : 'lmu';
    serverState.league = nextLeague;
    const leagueState = serverState.leagueState[nextLeague] || {
      classIdx: 0,
      paused: false,
      scrollPos: 0,
      screen: 'standings',
      gt7LeagueId: SLP_GT7_LEAGUE_ID_DEFAULT
    };
    serverState.classIdx = leagueState.classIdx;
    serverState.paused = leagueState.paused;
    serverState.scrollPos = leagueState.scrollPos;
    serverState.screen = leagueState.screen;
    if (nextLeague === 'gt7') {
      serverState.gt7LeagueId = leagueState.gt7LeagueId || SLP_GT7_LEAGUE_ID_DEFAULT;
    }
  }
  if (cmd === 'pause')       serverState.paused    = true;
  if (cmd === 'resume')      serverState.paused    = false;
  if (cmd === 'switchClass') serverState.classIdx  = args.idx;
  if (cmd === 'resetTop')    serverState.scrollPos = 0;
  if (cmd === 'setScreen')   serverState.screen    = args.screen;
  serverState.leagueState[serverState.league] = persistLeagueSlice();

  broadcast({
    type: 'command',
    cmd,
    ...args,
    classIdx: serverState.classIdx,
    screen: serverState.screen,
    paused: serverState.paused,
    gt7LeagueId: serverState.gt7LeagueId
  });
  res.json({ ok: true, state: serverState });
});

app.get('/api/simgrid/league', async (_req, res) => {
  try {
    res.json(await simgridFetchFirst([
      `/api/v1/championships/${CHAMPIONSHIP_ID}`,
      `/api/v1/championships?community_id=${COMMUNITY_ID}`
    ]));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/simgrid/schedule', async (_req, res) => {
  try {
    res.json(await simgridFetchFirst([
      `/api/v1/races?community_id=${COMMUNITY_ID}`,
      `/api/v1/rounds?community_id=${COMMUNITY_ID}`,
      `/api/v1/championships?community_id=${COMMUNITY_ID}`
    ]));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/simgrid/results/:eventId', async (req, res) => {
  try {
    res.json(await simgridFetchFirst([
      `/api/v1/races/${req.params.eventId}`,
      `/api/v1/events/${req.params.eventId}`
    ]));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/lmu/data', async (_req, res) => {
  try {
    const standingsPath = path.join(__dirname, 'data', 'standings.json');
    const standings = JSON.parse(await fs.readFile(standingsPath, 'utf8'));
    const schedule = await simgridFetchFirst([
      `/api/v1/races?community_id=${COMMUNITY_ID}`,
      `/api/v1/rounds?community_id=${COMMUNITY_ID}`,
      `/api/v1/championships?community_id=${COMMUNITY_ID}`
    ]);
    res.json({ standings, meta: { roundsSource: schedule } });
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/gt7/seasons', (_req, res) => {
  res.json({ seasons: SLP_GT7_SEASONS });
});

app.get('/api/gt7/data', async (req, res) => {
  try {
    const leagueId = resolveGt7LeagueIdForDataQuery(req.query.leagueId);
    if (!leagueId) {
      return res.status(404).json({ error: true, message: 'Unknown GT7 league id' });
    }
    if (req.query.refresh === '1') clearSlpCache();
    const [drivers, league] = await Promise.all([
      slpFetchAllDrivers(SLP_COMMUNITY_ID),
      slpFetch(`/leagues/${leagueId}.json?include_results=true`)
    ]);
    res.json(normalizeGt7Data(drivers, league));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/gt7/career', async (req, res) => {
  try {
    if (req.query.refresh === '1') clearSlpCache();
    const drivers = await slpFetchAllDrivers(SLP_COMMUNITY_ID);
    const bundles = await Promise.all(
      SLP_GT7_SEASONS.map(async season => {
        const payload = await slpFetch(`/leagues/${season.id}.json?include_results=true`);
        return { id: season.id, label: season.label, payload };
      })
    );
    res.json(buildCareerStats(drivers, bundles));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

// ── LMU live timing ───────────────────────────────────────────────────────────
// Reads the Le Mans Ultimate localhost REST API for whole-session live timing.
// All reads are offline-safe: any failure resolves to {offline:true} rather than
// throwing, so the overlay can show a clean "waiting" state and other features
// (GT7, multistream grid) are never affected.

/** First defined value among several candidate field names (handles API naming drift). */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function lmuFetch(pathname) {
  const res = await fetch(`${LMU_API_BASE}${pathname}`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`LMU ${res.status}`);
  return res.json();
}

/** Cached + offline-safe. Returns the normalized tower model, or {offline:true}. */
async function lmuFetchLive() {
  if (lmuLiveCache.data && Date.now() - lmuLiveCache.ts < LMU_LIVE_CACHE_MS) {
    return lmuLiveCache.data;
  }
  if (LMU_MOCK) {
    try {
      const raw = await fs.readFile(path.join(__dirname, 'data', 'lmu-live-sample.json'), 'utf8');
      const data = JSON.parse(raw);
      lmuLiveCache = { ts: Date.now(), data };
      return data;
    } catch (_) {
      return { offline: true, sessionActive: false, sessionInfo: null, classes: [] };
    }
  }
  try {
    const [standings, session] = await Promise.all([
      lmuFetch(LMU_STANDINGS_PATH),
      lmuFetch(LMU_SESSION_PATH).catch(() => null) // session info is a nice-to-have
    ]);
    const data = normalizeLmuLive(standings, session);
    lmuLiveCache = { ts: Date.now(), data };
    lmuApiOnline = true;
    return data;
  } catch (_) {
    lmuApiOnline = false;
    const data = { offline: true, sessionActive: false, sessionInfo: null, classes: [] };
    lmuLiveCache = { ts: Date.now(), data };
    return data;
  }
}

/** Map an LMU class name to a friendly group label. */
function lmuClassLabel(raw) {
  const k = normalizeKey(raw);
  if (!k) return 'Other';
  if (k.includes('hyper') || k.includes('lmh') || k.includes('lmdh') || k === 'hc') return 'Hypercar';
  if (k.includes('gt3') || k.includes('lmgt3')) return 'LMGT3';
  return String(raw).trim();
}

/** Colour a sector time vs the field best / this car's personal best. */
function sectorColour(time, carNum, sectorIdx) {
  if (time == null) return null;
  const field = lmuSectorBest.field[sectorIdx];
  if (field == null || time <= field) {
    lmuSectorBest.field[sectorIdx] = field == null ? time : Math.min(field, time);
    return 'purple';
  }
  const car = lmuSectorBest.byCar[carNum] || [null, null, null];
  if (car[sectorIdx] == null || time <= car[sectorIdx]) {
    car[sectorIdx] = car[sectorIdx] == null ? time : Math.min(car[sectorIdx], time);
    lmuSectorBest.byCar[carNum] = car;
    return 'green';
  }
  return 'yellow';
}

/** Lap/sector time → number, or null when the game reports "no time" (<= 0, often -1 or 0). */
function lapOrNull(value) {
  const n = toNum(value);
  return n != null && n > 0 ? n : null;
}

/** Repair UTF-8 text that arrived Latin-1-decoded (mojibake), e.g. accented driver/team names. */
function fixMojibake(value) {
  if (typeof value !== 'string') return value;
  let suspect = false;
  for (let i = 0; i < value.length - 1; i++) {
    const c = value.charCodeAt(i);
    const n = value.charCodeAt(i + 1);
    if ((c === 0xC2 || c === 0xC3) && n >= 0x80 && n <= 0xBF) { suspect = true; break; }
  }
  if (!suspect) return value;
  try { return Buffer.from(value, 'latin1').toString('utf8'); } catch (_) { return value; }
}

/** Raw LMU watch/standings + sessionInfo → clean tower model. Defensive about field names. */
function normalizeLmuLive(rawStandings, rawSession) {
  const list = Array.isArray(rawStandings)
    ? rawStandings
    : Array.isArray(rawStandings?.standings) ? rawStandings.standings
    : Array.isArray(rawStandings?.entries) ? rawStandings.entries
    : [];

  if (!list.length) {
    return { offline: false, sessionActive: false, sessionInfo: null, classes: [] };
  }

  const session = rawSession || {};
  const endTime = toNum(pick(session, 'endEventTime', 'maximumTime'));
  const curTime = toNum(pick(session, 'currentEventTime'));
  const sessionInfo = {
    type: pick(session, 'session', 'sessionType', 'name') || null,
    timeRemaining: endTime != null && curTime != null ? Math.max(0, endTime - curTime) : null,
    flag: pick(session, 'sectorFlag', 'phase', 'gamePhase') || null,
    trackTemp: toNum(pick(session, 'trackTemp', 'trackTemperature')),
    airTemp: toNum(pick(session, 'ambientTemp', 'airTemperature', 'ambientTemperature')),
    totalLaps: toNum(pick(session, 'maximumLaps', 'totalLaps')),
    currentLap: toNum(pick(session, 'currentLap', 'leaderLap'))
  };

  const byClass = new Map();
  list.forEach((entry, idx) => {
    const className = lmuClassLabel(pick(entry, 'carClass', 'carClassName', 'class', 'vehicleClass'));
    const num = String(pick(entry, 'carNumber', 'carNo', 'number', 'carID', 'slotID') ?? idx + 1);

    // LMU exposes only S1 & S2 live (S3 is implicit). Use current-lap splits, fall back to last lap.
    const s1 = lapOrNull(pick(entry, 'currentSectorTime1', 'lastSectorTime1'));
    const s2 = lapOrNull(pick(entry, 'currentSectorTime2', 'lastSectorTime2'));

    // Class-relative gaps for the in-class tower (fall back to overall fields if class ones are absent).
    const lapsBehind = toNum(pick(entry, 'lapsBehindClassLeader', 'lapsBehindLeader'));
    const timeBehind = toNum(pick(entry, 'timeBehindClassLeader', 'timeBehindLeader'));
    const lapsBehindNext = toNum(pick(entry, 'lapsBehindNext'));
    const timeBehindNext = toNum(pick(entry, 'timeBehindNext'));

    const row = {
      pos: toNum(pick(entry, 'position', 'place')) || idx + 1,
      classPos: null, // assigned per class below
      num,
      driver: fixMojibake(String(pick(entry, 'driverName', 'fullName', 'name') || `Car ${num}`).trim()),
      team: fixMojibake(pick(entry, 'fullTeamName', 'teamName', 'team') || '') || null,
      car: pick(entry, 'vehicleName', 'carName', 'fullVehicleName') || null,
      gapLeader: lapsBehind > 0 ? { laps: lapsBehind } : (timeBehind != null && timeBehind > 0 ? { sec: timeBehind } : null),
      gapAhead: lapsBehindNext > 0 ? { laps: lapsBehindNext } : (timeBehindNext != null && timeBehindNext > 0 ? { sec: timeBehindNext } : null),
      lastLap: lapOrNull(pick(entry, 'lastLapTime', 'lastLap')),
      bestLap: lapOrNull(pick(entry, 'bestLapTime', 'fastestLapTime', 'bestLap')),
      sectors: [
        { time: s1, color: sectorColour(s1, num, 0) },
        { time: s2, color: sectorColour(s2, num, 1) },
        { time: null, color: null } // LMU has no live S3 field
      ],
      inPit: !!(pick(entry, 'pitting', 'inPits') || pick(entry, 'inGarageStall')),
      pitCount: toNum(pick(entry, 'pitstops', 'pitStops')) || 0
    };

    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className).push(row);
  });

  // Hypercar first, then LMGT3, then anything else.
  const order = ['Hypercar', 'LMGT3'];
  const classNames = [...byClass.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const classes = classNames.map(name => {
    const entries = byClass.get(name).sort((a, b) => a.pos - b.pos);
    entries.forEach((e, i) => { e.classPos = i + 1; });
    if (entries[0]) entries[0].gapLeader = null; // class leader shows "—", not "+0.000"
    return { name, entries };
  });

  return { offline: false, sessionActive: true, sessionInfo, classes };
}

app.get('/api/lmu/live', async (_req, res) => {
  res.json(await lmuFetchLive()); // always 200, even offline — overlay renders a waiting state
});

// Connection sanity check. Probes the REAL game API directly (bypasses the mock and
// the cache) so you can confirm reachability + see the raw field names before going live.
app.get('/api/lmu/health', async (_req, res) => {
  const out = {
    ok: false,
    mock: LMU_MOCK,            // true => the overlay is currently serving fixture data
    base: LMU_API_BASE,
    standingsPath: LMU_STANDINGS_PATH,
    sessionPath: LMU_SESSION_PATH,
    reachable: false
  };
  const started = Date.now();
  try {
    const standings = await lmuFetch(LMU_STANDINGS_PATH);
    out.reachable = true;
    out.ok = true;
    out.latencyMs = Date.now() - started;
    out.rawShape = Array.isArray(standings) ? 'array' : typeof standings;
    const list = Array.isArray(standings) ? standings
      : Array.isArray(standings?.standings) ? standings.standings
      : Array.isArray(standings?.entries) ? standings.entries
      : [];
    out.entryCount = list.length;
    out.sampleRaw = list[0] || null; // ← real field names live here; paste this to me if mapping looks off
    try {
      const session = await lmuFetch(LMU_SESSION_PATH);
      out.sessionKeys = session && typeof session === 'object' ? Object.keys(session) : null;
      out.sampleSession = session || null;
    } catch (e) {
      out.sessionError = String(e?.message || e);
    }
    try {
      // Snapshot/restore sector-best state so this diagnostic can't perturb live colouring.
      const snap = { field: [...lmuSectorBest.field], byCar: { ...lmuSectorBest.byCar } };
      const norm = normalizeLmuLive(standings, null);
      lmuSectorBest.field = snap.field;
      lmuSectorBest.byCar = snap.byCar;
      out.normalized = {
        sessionActive: norm.sessionActive,
        classes: (norm.classes || []).map(c => ({ name: c.name, entries: c.entries.length }))
      };
    } catch (_) {}
  } catch (e) {
    out.error = String(e?.message || e);
    out.hint = LMU_MOCK
      ? 'LMU_MOCK=1 is set — the overlay shows fixture data. This probe still tries the real game API, so this error just means the game/API is not reachable from the server.'
      : `Could not reach ${LMU_API_BASE}${LMU_STANDINGS_PATH}. Is LMU running on this machine, and is LMU_API_BASE reachable from the server? Check ${LMU_API_BASE}/swagger on the game PC.`;
  }
  res.json(out);
});

// ── LMU overtake / battle detection (server-side, broadcast over SSE) ─────────
function lmuPosByCar(snapshot) {
  const map = {};
  (snapshot.classes || []).forEach(cls => {
    cls.entries.forEach(e => { map[e.num] = { classPos: e.classPos, className: cls.name }; });
  });
  return map;
}

function detectAndBroadcast(curr) {
  if (!curr || curr.offline || !curr.sessionActive) { lmuPrev = null; return; }
  const prev = lmuPrev;
  lmuPrev = curr;
  const battles = [];

  (curr.classes || []).forEach(cls => {
    cls.entries.forEach(e => {
      // Battle: within the gap threshold of the car ahead in the same class.
      if (e.gapAhead && e.gapAhead.sec != null && e.gapAhead.sec <= LMU_BATTLE_GAP_SEC && e.classPos > 1) {
        const ahead = cls.entries.find(o => o.classPos === e.classPos - 1);
        if (ahead) battles.push({ className: cls.name, behind: e.num, ahead: ahead.num, pos: e.classPos });
      }
    });
  });

  if (prev) {
    const prevPos = lmuPosByCar(prev);
    const now = Date.now();
    (curr.classes || []).forEach(cls => {
      cls.entries.forEach(e => {
        const was = prevPos[e.num];
        if (!was || was.className !== cls.name) return;
        if (e.classPos < was.classPos) { // gained at least one place in class
          if (now - (lmuLastEventByCar[e.num] || 0) < LMU_OVERTAKE_DEBOUNCE_MS) return;
          lmuLastEventByCar[e.num] = now;
          broadcast({
            type: 'lmuOvertake',
            num: e.num, driver: e.driver, className: cls.name,
            fromPos: was.classPos, toPos: e.classPos
          });
        }
      });
    });
  }

  broadcast({ type: 'lmuBattle', battles });
}

function startLmuPoll() {
  clearInterval(lmuPollTimer);
  lmuPrev = null;
  lmuLastEventByCar = {};
  lmuSectorBest.field = [null, null, null]; // fresh purple/green baseline per arming
  lmuSectorBest.byCar = {};
  lmuPollTimer = setInterval(async () => {
    const curr = await lmuFetchLive();
    if (curr.offline || !curr.sessionActive) return; // no session yet — quietly wait
    detectAndBroadcast(curr);
  }, 1000);
}

function stopLmuPoll() {
  clearInterval(lmuPollTimer);
  lmuPollTimer = null;
  lmuPrev = null;
  lmuLastEventByCar = {};
  lmuSectorBest.field = [null, null, null];
  lmuSectorBest.byCar = {};
}

// ── Multi-stream helpers ──────────────────────────────────────────────────────
function generateStreamId() {
  return Math.random().toString(36).slice(2, 9);
}

function parseStreamUrl(rawUrl) {
  let u;
  try {
    const normalized = rawUrl.trim().startsWith('http') ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    u = new URL(normalized);
  } catch (_) { return null; }

  const host = u.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const videoId = u.pathname.slice(1).split('?')[0];
    if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return { type: 'youtube', embedId: videoId, label: `YouTube · ${videoId}` };
    }
  }

  if (host === 'youtube.com') {
    if (u.pathname === '/watch') {
      const videoId = u.searchParams.get('v') || '';
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return { type: 'youtube', embedId: videoId, label: `YouTube · ${videoId}` };
      }
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'live' || parts[0] === 'embed') && parts[1]) {
      const videoId = parts[1];
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return { type: 'youtube', embedId: videoId, label: `YouTube · ${videoId}` };
      }
    }
  }

  if (host === 'twitch.tv') {
    const channel = u.pathname.split('/').filter(Boolean)[0] || '';
    if (/^[a-zA-Z0-9_]{1,25}$/.test(channel)) {
      return { type: 'twitch', embedId: channel.toLowerCase(), label: `Twitch · ${channel}` };
    }
  }

  return null;
}

function rebalanceSlots(ms) {
  const visibleSet = new Set(ms.visibleSlots.filter(Boolean));
  const pool = ms.streams.filter(s => !visibleSet.has(s.id));
  ms.visibleSlots = ms.visibleSlots.map(id => {
    if (id !== null) return id;
    return pool.shift()?.id ?? null;
  });
}

function advanceRotation(ms) {
  // Swap visible streams only when there are more than 4 configured
  if (ms.streams.length > 4) {
    ms.rotationOffset = (ms.rotationOffset + 1) % ms.streams.length;
    ms.visibleSlots = Array.from({ length: 4 }, (_, i) =>
      ms.streams[(ms.rotationOffset + i) % ms.streams.length]?.id ?? null
    );
  }
  // Always cycle audio focus to the next visible stream
  const visible = ms.visibleSlots.filter(Boolean);
  if (visible.length > 0) {
    const cur = visible.indexOf(ms.focusedId);
    ms.focusedId = visible[(cur + 1) % visible.length];
  }
}

async function getTwitchAccessToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  if (twitchAccessToken && Date.now() < twitchTokenExpiresAt - 60_000) return twitchAccessToken;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  twitchAccessToken = data.access_token || null;
  twitchTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return twitchAccessToken;
}

async function fetchYouTubeVideoStats(videoId) {
  if (!YOUTUBE_API_KEY) return null;
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,statistics,liveStreamingDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', YOUTUBE_API_KEY);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items && data.items[0];
  if (!item) return null;
  const snippet = item.snippet || {};
  const statistics = item.statistics || {};
  const liveDet = item.liveStreamingDetails || {};
  const live = snippet.liveBroadcastContent === 'live';
  let viewers = null;
  let viewerLabel = null;
  if (live && liveDet.concurrentViewers != null) {
    viewers = Number(liveDet.concurrentViewers);
    viewerLabel = 'watching';
  } else if (statistics.viewCount != null && statistics.viewCount !== '') {
    viewers = Number(statistics.viewCount);
    viewerLabel = 'views';
  }
  let likes = null;
  if (statistics.likeCount != null && statistics.likeCount !== '') {
    likes = Number(statistics.likeCount);
  }
  return {
    title: snippet.title || null,
    viewers,
    viewerLabel,
    likes,
    source: 'youtube',
  };
}

async function fetchTwitchStreamStats(login) {
  const token = await getTwitchAccessToken();
  if (!token || !TWITCH_CLIENT_ID) return null;
  const headers = {
    'Client-ID': TWITCH_CLIENT_ID,
    Authorization: `Bearer ${token}`,
  };
  const ur = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    { headers }
  );
  if (!ur.ok) return null;
  const uj = await ur.json();
  const user = uj.data && uj.data[0];
  if (!user) return null;

  const sr = await fetch(
    `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(user.id)}`,
    { headers }
  );
  const sj = sr.ok ? await sr.json() : { data: [] };
  const stream = sj.data && sj.data[0];
  if (stream) {
    return {
      title: stream.title || null,
      viewers: stream.viewer_count != null ? Number(stream.viewer_count) : null,
      viewerLabel: 'watching',
      likes: null,
      source: 'twitch',
      offline: false,
    };
  }

  const cr = await fetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(user.id)}`,
    { headers }
  );
  const cj = cr.ok ? await cr.json() : { data: [] };
  const ch = cj.data && cj.data[0];
  return {
    title: ch && ch.title ? ch.title : `${login} (offline)`,
    viewers: null,
    viewerLabel: null,
    likes: null,
    source: 'twitch',
    offline: true,
  };
}

async function rebuildMultistreamStats() {
  const next = {};
  for (const s of multistreamState.streams) {
    try {
      if (s.type === 'youtube' && YOUTUBE_API_KEY) {
        const meta = await fetchYouTubeVideoStats(s.embedId);
        if (meta) next[s.id] = { ...meta, fetchedAt: Date.now() };
      } else if (s.type === 'twitch' && TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET) {
        const meta = await fetchTwitchStreamStats(s.embedId);
        if (meta) next[s.id] = { ...meta, fetchedAt: Date.now() };
      }
    } catch (_) {
      /* keep slot empty until next poll */
    }
  }
  multistreamState.streamStats = next;
}

async function refreshMultistreamStatsAndBroadcast() {
  await rebuildMultistreamStats();
  broadcast({ type: 'msCommand', cmd: 'statsRefresh', ...multistreamState });
}

function startMsStatsPolling() {
  clearInterval(msStatsTimer);
  msStatsTimer = setInterval(() => {
    if (multistreamState.streams.length === 0) return;
    void refreshMultistreamStatsAndBroadcast();
  }, 45_000);
}

function startMsRotation() {
  clearInterval(msRotationTimer);
  msRotationTimer = null;
  if (multistreamState.rotationEnabled && multistreamState.streams.length >= 2) {
    msRotationTimer = setInterval(() => {
      advanceRotation(multistreamState);
      broadcast({ type: 'msCommand', cmd: 'rotateNow', ...multistreamState });
    }, multistreamState.rotationIntervalSec * 1000);
  }
}

// ── Multi-stream API ──────────────────────────────────────────────────────────
app.get('/api/multistream/state', (_req, res) => res.json(multistreamState));

app.post('/api/multistream/command', async (req, res) => {
  const { cmd, ...args } = req.body || {};
  let statsDirty = false;

  if (cmd === 'addStream') {
    if (multistreamState.streams.length >= 8) {
      return res.status(400).json({ ok: false, error: 'max_streams' });
    }
    const parsed = parseStreamUrl(args.url || '');
    if (!parsed) return res.status(400).json({ ok: false, error: 'invalid_url' });
    const stream = { id: generateStreamId(), url: args.url, ...parsed };
    multistreamState.streams.push(stream);
    rebalanceSlots(multistreamState);
    if (!multistreamState.focusedId) {
      multistreamState.focusedId = multistreamState.visibleSlots[0] ?? null;
    }
    startMsRotation(); // stream count may have crossed the >4 threshold
    statsDirty = true;
  }

  if (cmd === 'removeStream') {
    const id = args.id;
    multistreamState.streams = multistreamState.streams.filter(s => s.id !== id);
    multistreamState.visibleSlots = multistreamState.visibleSlots.map(s => (s === id ? null : s));
    rebalanceSlots(multistreamState);
    if (multistreamState.focusedId === id) {
      multistreamState.focusedId = multistreamState.visibleSlots[0] ?? null;
    }
    if (multistreamState.rotationOffset >= Math.max(1, multistreamState.streams.length)) {
      multistreamState.rotationOffset = 0;
    }
    startMsRotation(); // stream count may have dropped to ≤4
    statsDirty = true;
  }

  if (cmd === 'setFocus') {
    const id = args.id;
    if (id === null || multistreamState.visibleSlots.includes(id)) {
      multistreamState.focusedId = id ?? null;
    } else {
      return res.status(400).json({ ok: false, error: 'unknown_stream' });
    }
  }

  if (cmd === 'setLayout') {
    if (args.layout === 'grid' || args.layout === 'pip' || args.layout === 'dual') {
      multistreamState.layout = args.layout;
    }
  }

  if (cmd === 'setRotation') {
    multistreamState.rotationEnabled = !!args.enabled;
    if (args.intervalSec != null) {
      multistreamState.rotationIntervalSec = Math.max(5, Number(args.intervalSec) || 30);
    }
    startMsRotation();
  }

  if (cmd === 'rotateNow') {
    advanceRotation(multistreamState);
  }

  if (cmd === 'setTwitchParent') {
    multistreamState.twitchParent = String(args.parent || 'localhost').trim();
  }

  if (cmd === 'setBanner') {
    if (args.enabled != null) multistreamState.banner.enabled = !!args.enabled;
    if (typeof args.text === 'string') multistreamState.banner.text = args.text.slice(0, 800);
    if (args.durationSec != null) {
      multistreamState.banner.durationSec = Math.max(12, Math.min(180, Number(args.durationSec) || 40));
    }
  }

  if (cmd === 'setLmuTiming') {
    multistreamState.lmuTiming.enabled = !!args.enabled;
    if (multistreamState.lmuTiming.enabled) startLmuPoll();
    else stopLmuPoll();
  }

  if (statsDirty) {
    await rebuildMultistreamStats();
  }

  broadcast({ type: 'msCommand', cmd, ...multistreamState });
  res.json({ ok: true, multistream: multistreamState });
});

// ── Stream bot: admin API + OAuth (all admin-gated) ──────────────────────────
app.get('/api/bot/state', botAdminGate, (_req, res) => res.json(bot.getPublicState()));

app.post('/api/bot/command', botAdminGate, async (req, res) => {
  try {
    const { cmd, ...args } = req.body || {};
    const state = await bot.applyCommand(cmd, args);
    res.json({ ok: true, bot: state });
  } catch (e) {
    res.status(400).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.get('/auth/twitch/login', botAdminGate, (_req, res) => {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return res.status(400).send('TWITCH_CLIENT_ID/SECRET not configured');
  res.redirect(bot.twitchLoginUrl());
});
app.get('/auth/twitch/callback', botAdminGate, async (req, res) => {
  try { await bot.twitchCallback(req.query.code, req.query.state); res.redirect('/bot-controls.html'); }
  catch (e) { res.status(400).send(`Twitch auth failed: ${(e && e.message) || e}`); }
});
app.get('/auth/google/login', botAdminGate, (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(400).send('GOOGLE_CLIENT_ID/SECRET not configured');
  res.redirect(bot.googleLoginUrl());
});
app.get('/auth/google/callback', botAdminGate, async (req, res) => {
  try { await bot.googleCallback(req.query.code, req.query.state); res.redirect('/bot-controls.html'); }
  catch (e) { res.status(400).send(`YouTube auth failed: ${(e && e.message) || e}`); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function broadcast(data) {
  clients.forEach(c => send(c.res, data));
}

// Malformed JSON body — body-parser signals via err.type
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  console.error(err);
  res.status(500).json({ ok: false });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  startMsStatsPolling();
  bot.init().then(() => bot.autoStartIfReady()).catch(err => console.error('bot init failed:', err));
  console.log('\n  Apex & Chill Standings Overlay');
  console.log('  ────────────────────────────────────────');
  console.log(`  OBS source  →  http://localhost:${PORT}/overlay.html`);
  console.log(`  Controls    →  http://localhost:${PORT}/controls.html`);
  console.log(`  Stream bot  →  http://localhost:${PORT}/bot-controls.html`);
  console.log(`  Health      →  http://localhost:${PORT}/api/health`);
  console.log('  ────────────────────────────────────────');
  console.log('  Deploy: reverse-proxy /api/* and /api/events to this Node process.');
  console.log('  Static-only hosting cannot serve POST /api/state (502 = no upstream).');
  console.log('  ────────────────────────────────────────');
  console.log('  Update standings: edit  data/standings.json');
  console.log('  then click "Reload Data" in the controls.\n');
});
