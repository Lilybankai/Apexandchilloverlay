(() => {
  const app = window.OverlayApp;

  async function hydrateSchedule() {
    if (app.state.league !== 'lmu') return;
    try {
      const response = await fetch('/api/simgrid/schedule');
      const data = await response.json();
      if (data?.error) return;

      const rawEvents = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.events)
            ? data.events
            : Array.isArray(data?.results)
              ? data.results
              : [];
      if (!rawEvents.length) return;

      const rounds = rawEvents.map((event, idx) => ({
        index: idx,
        eventId: event.id ?? event.event_id ?? null,
        name: event.display_name || event.race_name || event.name || event.title || event.track_name || `Round ${idx + 1}`,
        date: event.start_date || event.starts_at || event.date || event.startDate || null,
        isFinished: event.ended === true || event.results_available === true || event.status === 'completed' || event.status === 'finished'
      }));
      rounds.sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : Number.POSITIVE_INFINITY;
        const tb = b.date ? new Date(b.date).getTime() : Number.POSITIVE_INFINITY;
        return ta - tb;
      });
      rounds.forEach((round, idx) => { round.index = idx; });
      const now = Date.now();
      rounds.forEach(round => {
        if (!round.isFinished && round.date) {
          const ts = new Date(round.date).getTime();
          if (!Number.isNaN(ts) && ts < now) round.isFinished = true;
        }
      });
      const nextRound = rounds.find(round => !round.isFinished);
      if (nextRound) {
        nextRound.isNext = true;
        app.state.meta.nextRace = { name: nextRound.name, date: nextRound.date };
      }

      if (!nextRound && rounds.length) {
        app.state.meta.nextRace = app.state.meta.nextRace || {
          name: rounds[rounds.length - 1].name,
          date: rounds[rounds.length - 1].date
        };
      }
      app.state.meta.rounds = rounds;
    } catch (_) {}
  }

  async function fetchData({ bust = false } = {}) {
    try {
      if (app.state.league === 'gt7') {
        const response = await fetch(`/api/gt7/data${bust ? '?refresh=1' : ''}`);
        const raw = await response.json();
        app.state.standings = raw.classes ?? [];
        app.state.meta = raw.meta ?? {};
      } else {
        const response = await fetch('/data/standings.json');
        const raw = await response.json();
        app.state.standings = raw.classes ?? raw;
        app.state.meta = raw.meta ?? {};
        app.state.meta.seasonName = app.state.meta.seasonName || 'LMU League';
        await hydrateSchedule();
      }
      if (app.state.classIdx >= app.state.standings.length) app.state.classIdx = 0;
      app.buildClassTags();
      return true;
    } catch (error) {
      console.error('standings fetch failed:', error);
      return false;
    }
  }

  function updateCountdown() {
    const nextRace = app.state.meta.nextRace;
    if (!nextRace?.date) return;

    const raceTs = new Date(nextRace.date).getTime();
    const diffMs = raceTs - Date.now();
    if (diffMs <= 0) {
      app.elements.footerInfo.textContent = '';
      return;
    }

    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const mins = totalMinutes % 60;
    app.elements.footerInfo.textContent = `NEXT RACE: ${days}d ${hours}h ${mins}m`;
  }

  function doPause() {
    app.state.isPaused = true;
    clearTimeout(app.state.timer);
    clearTimeout(app.state.podiumTimer);
    app.elements.pauseBadge.classList.add('show');
    app.reportState();
  }

  function doResume() {
    app.state.isPaused = false;
    app.elements.pauseBadge.classList.remove('show');
    if (app.state.screen === 'standings') {
      app.standings.continueScroll();
    } else {
      app.races.scheduleNextRound(500);
    }
    app.reportState();
  }

  function doResetTop() {
    app.state.scrollPos = 0;
    app.elements.tableBody.style.transform = 'translateY(0)';
    if (!app.state.isPaused && app.state.screen === 'standings') {
      app.standings.continueScroll();
    }
    app.reportState();
  }

  async function doReload() {
    const ok = await fetchData({ bust: true });
    if (!ok) return;
    app.standings.loadClass(app.state.classIdx);
    doSetScreen(app.state.screen, true);
  }

  function doSwitchClass(idx) {
    if (app.state.screen !== 'standings') {
      app.state.classIdx = idx;
      app.standings.loadClass(app.state.classIdx);
      return;
    }

    clearTimeout(app.state.timer);
    app.elements.veil.classList.add('show');
    setTimeout(() => {
      app.state.classIdx = idx;
      app.standings.loadClass(app.state.classIdx);
      setTimeout(() => app.elements.veil.classList.remove('show'), 150);
    }, app.config.switchAnimMs);
  }

  async function doSetLeague(league, nextState = {}) {
    const nextLeague = league === 'gt7' ? 'gt7' : 'lmu';
    if (app.state.league === nextLeague) return;
    app.state.league = nextLeague;
    app.state.classIdx = Math.max(0, Number(nextState.classIdx ?? 0) || 0);
    app.state.scrollPos = 0;
    app.state.isPaused = !!nextState.paused;
    const ok = await fetchData();
    if (!ok) return;
    app.standings.loadClass(app.state.classIdx);
    doSetScreen(nextState.screen || 'standings', true);
    app.reportState();
  }

  function doSetScreen(nextScreen, skipVeil = false) {
    app.state.screen = nextScreen === 'races' || nextScreen === 'schedule' ? nextScreen : 'standings';

    const switchViews = () => {
      app.elements.viewStandings.classList.toggle('active', app.state.screen === 'standings');
      app.elements.viewRaces.classList.toggle('active', app.state.screen === 'races');
      app.elements.viewSchedule.classList.toggle('active', app.state.screen === 'schedule');
      app.elements.hdrTitle.textContent =
        app.state.screen === 'races'
          ? 'Race Results'
          : app.state.screen === 'schedule'
            ? 'Race Schedule'
            : 'Championship Standings';

      if (app.state.screen === 'standings') {
        clearTimeout(app.state.podiumTimer);
        app.standings.continueScroll();
      } else if (app.state.screen === 'races') {
        clearTimeout(app.state.timer);
        app.races.startRacesCycle();
      } else {
        clearTimeout(app.state.timer);
        clearTimeout(app.state.podiumTimer);
        app.schedule.renderSchedule();
      }
      app.reportState();
    };

    if (skipVeil) {
      switchViews();
      return;
    }

    app.elements.veil.classList.add('show');
    setTimeout(() => {
      switchViews();
      setTimeout(() => app.elements.veil.classList.remove('show'), 150);
    }, app.config.switchAnimMs);
  }

  function handleSSE(message) {
    if (message.type === 'state') {
      app.state.league = message.league === 'gt7' ? 'gt7' : 'lmu';
      app.state.classIdx = message.classIdx ?? 0;
      app.state.isPaused = message.paused ?? false;
      app.state.screen = message.screen ?? 'standings';
      fetchData().then(ok => {
        if (!ok) return;
        app.standings.loadClass(app.state.classIdx);
        doSetScreen(app.state.screen, true);
      });
      return;
    }

    if (message.type === 'stateUpdate') {
      // Ignore on the overlay. This event fires after every POST /api/state (scroll sync) and
      // previously called doSetScreen → continueScroll, which cleared the scroll timer and
      // broke auto-scroll / pause. Controls page still consumes stateUpdate for its own UI.
      return;
    }

    if (message.type === 'command') {
      switch (message.cmd) {
        case 'setLeague': doSetLeague(message.league, message); break;
        case 'pause': doPause(); break;
        case 'resume': doResume(); break;
        case 'switchClass': doSwitchClass(message.idx); break;
        case 'switchNext': app.standings.switchClass(); break;
        case 'resetTop': doResetTop(); break;
        case 'reload': doReload(); break;
        case 'setScreen': doSetScreen(message.screen); break;
      }
    }
  }

  function connectSSE() {
    if (app.state.evtSource) app.state.evtSource.close();
    app.state.evtSource = new EventSource('/api/events');
    app.state.evtSource.onmessage = event => handleSSE(JSON.parse(event.data));
    app.state.evtSource.onerror = () => setTimeout(connectSSE, 3000);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    app.cacheElements();
    try {
      const stateRes = await fetch('/api/state');
      const remoteState = await stateRes.json();
      app.state.league = remoteState.league === 'gt7' ? 'gt7' : 'lmu';
      app.state.classIdx = remoteState.classIdx ?? app.state.classIdx;
      app.state.screen = remoteState.screen ?? app.state.screen;
      app.state.isPaused = remoteState.paused ?? app.state.isPaused;
    } catch (_) {}

    const ok = await fetchData();
    if (!ok) return;

    connectSSE();
    app.standings.loadClass(app.state.classIdx);
    doSetScreen(app.state.screen, true);
    updateCountdown();
    app.state.countdownTimer = setInterval(updateCountdown, 60000);
  });
})();
