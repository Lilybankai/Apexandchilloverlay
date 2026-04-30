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
