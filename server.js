const express = require('express');
const fs = require('fs/promises');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
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

// Behind nginx / Lilybank / similar — needed for correct client IPs if you log them later
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname)); // serves overlay.html, controls.html, data/, etc.

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
  send(res, { type: 'state', ...serverState });

  req.on('close', () => {
    clients = clients.filter(c => c.id !== id);
  });
});

// ── GET current state (controls polls this on load) ──────────────────────────
app.get('/api/state', (req, res) => res.json(serverState));

// ── Lightweight health check (use this to verify proxy → Node is wired) ──────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'apex-chill-overlay' });
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
  console.log('\n  Apex & Chill Standings Overlay');
  console.log('  ────────────────────────────────────────');
  console.log(`  OBS source  →  http://localhost:${PORT}/overlay.html`);
  console.log(`  Controls    →  http://localhost:${PORT}/controls.html`);
  console.log(`  Health      →  http://localhost:${PORT}/api/health`);
  console.log('  ────────────────────────────────────────');
  console.log('  Deploy: reverse-proxy /api/* and /api/events to this Node process.');
  console.log('  Static-only hosting cannot serve POST /api/state (502 = no upstream).');
  console.log('  ────────────────────────────────────────');
  console.log('  Update standings: edit  data/standings.json');
  console.log('  then click "Reload Data" in the controls.\n');
});
