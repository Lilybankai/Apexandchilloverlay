const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
const SIMGRID_BASE = 'https://gridos.thesimgrid.com';
const SIMGRID_KEY = 'PhEDyzEVPztV4yMJYsmQjKWy';
const LEAGUE_ID = 23082;

// Behind nginx / Lilybank / similar — needed for correct client IPs if you log them later
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname)); // serves overlay.html, controls.html, data/, etc.

// ── SSE client list & server-side state ──────────────────────────────────────
let clients     = [];
let serverState = { classIdx: 0, paused: false, scrollPos: 0, screen: 'standings' };
const simgridCache = {};

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
    const { classIdx, paused, scrollPos, screen } = body;
    if (classIdx  != null) serverState.classIdx  = classIdx;
    if (paused    != null) serverState.paused    = paused;
    if (scrollPos != null) serverState.scrollPos = scrollPos;
    if (screen    != null) serverState.screen    = screen;
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

  // keep server state in sync so new clients get the right picture
  if (cmd === 'pause')       serverState.paused    = true;
  if (cmd === 'resume')      serverState.paused    = false;
  if (cmd === 'switchClass') serverState.classIdx  = args.idx;
  if (cmd === 'resetTop')    serverState.scrollPos = 0;
  if (cmd === 'setScreen')   serverState.screen    = args.screen;

  broadcast({ type: 'command', cmd, ...args });
  res.json({ ok: true, state: serverState });
});

app.get('/api/simgrid/league', async (_req, res) => {
  try {
    res.json(await simgridFetch(`/api/leagues/${LEAGUE_ID}`));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/simgrid/schedule', async (_req, res) => {
  try {
    res.json(await simgridFetch(`/api/leagues/${LEAGUE_ID}/events`));
  } catch (error) {
    res.status(502).json({ error: true, message: String(error?.message || error) });
  }
});

app.get('/api/simgrid/results/:eventId', async (req, res) => {
  try {
    res.json(await simgridFetch(`/api/events/${req.params.eventId}/results`));
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
