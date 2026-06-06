# AGENTS.md

## Cursor Cloud specific instructions

This is a single-service Node.js/Express application (no monorepo, no build step, no TypeScript). The only runtime dependency is `express`.

### Running the server

```
node server.js          # starts on port 3000 (override with PORT env var)
```

Key pages served by the Express server:
- `/overlay.html` — main OBS championship standings overlay (1920×1080)
- `/controls.html` — admin control panel (SSE-synced with overlay)
- `/multistream-overlay.html` / `/multistream-controls.html` — multi-stream viewer
- `/api/health` — health check

### No lint / test / build

There is no linter, test framework, or build step configured. The project uses plain HTML/CSS/JS served as static files alongside API endpoints.

### External API dependencies

The server proxies requests to two external APIs (SimGrid and Sim League Pro). These are **optional** for local dev — the standings overlay loads local data from `data/standings.json`. Schedule, race results, GT7, and career screens require outbound internet access.

### SSE architecture

The overlay and control panel communicate via Server-Sent Events (`/api/events`). Opening both `overlay.html` and `controls.html` simultaneously and using the controls will update the overlay in real time.

### LMU live timing (multistream overlay)

The multistream overlay can show a live timing tower (full field — Hypercar & LMGT3) down the
left edge, plus automatic overtake/battle graphics, sourced from the **Le Mans Ultimate local
REST API**. This assumes the Node server runs **on the same machine as the game** so it can read
`http://localhost:6397` directly. It is armed once via the "LMU Live Timing" toggle in
`multistream-controls.html` and is then fully automatic (shows when a session is live, hides when
it ends); default OFF so GT7 streams are unaffected. Server endpoint: `GET /api/lmu/live`
(always HTTP 200; returns `{offline:true}`/`{sessionActive:false}` when the game/session is down).

Optional env vars:
- `LMU_API_BASE` — game API base (default `http://localhost:6397`)
- `LMU_STANDINGS_PATH` / `LMU_SESSION_PATH` — live-timing endpoint paths; confirm against
  `<base>/swagger` (defaults `/rest/watch/standings` and `/rest/watch/sessionInfo`)
- `LMU_MOCK=1` — serve `data/lmu-live-sample.json` instead of the game, for developing/styling
  the tower without LMU running
