const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname)); // serves overlay.html, controls.html, data/, etc.

// ── SSE client list & server-side state ──────────────────────────────────────
let clients     = [];
let serverState = { classIdx: 0, paused: false, scrollPos: 0 };

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

// ── Overlay reports its state back (so controls stays in sync) ───────────────
app.post('/api/state', (req, res) => {
  const { classIdx, paused, scrollPos } = req.body;
  if (classIdx  != null) serverState.classIdx  = classIdx;
  if (paused    != null) serverState.paused    = paused;
  if (scrollPos != null) serverState.scrollPos = scrollPos;
  broadcast({ type: 'stateUpdate', ...serverState });
  res.json({ ok: true });
});

// ── Controls sends a command ──────────────────────────────────────────────────
app.post('/api/command', (req, res) => {
  const { cmd, ...args } = req.body;

  // keep server state in sync so new clients get the right picture
  if (cmd === 'pause')       serverState.paused    = true;
  if (cmd === 'resume')      serverState.paused    = false;
  if (cmd === 'switchClass') serverState.classIdx  = args.idx;
  if (cmd === 'resetTop')    serverState.scrollPos = 0;

  broadcast({ type: 'command', cmd, ...args });
  res.json({ ok: true, state: serverState });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function broadcast(data) {
  clients.forEach(c => send(c.res, data));
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  Apex & Chill Standings Overlay');
  console.log('  ────────────────────────────────────────');
  console.log(`  OBS source  →  http://localhost:${PORT}/overlay.html`);
  console.log(`  Controls    →  http://localhost:${PORT}/controls.html`);
  console.log('  ────────────────────────────────────────');
  console.log('  Update standings: edit  data/standings.json');
  console.log('  then click "Reload Data" in the controls.\n');
});
