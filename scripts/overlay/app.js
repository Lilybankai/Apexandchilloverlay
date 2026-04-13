(() => {
  const app = window.OverlayApp;

  async function hydrateSchedule() {
    try {
      const response = await fetch('/api/simgrid/schedule');
      const data = await response.json();
      if (!Array.isArray(data) || data.error) return;

      app.state.meta.rounds = data.map((event, idx) => ({
        index: idx,
        name: event.name || `Round ${idx + 1}`,
        date: event.start_date || event.date || null
      }));

      if (app.state.meta.rounds[0] && !app.state.meta.nextRace) {
        app.state.meta.nextRace = {
          name: app.state.meta.rounds[0].name,
          date: app.state.meta.rounds[0].date
        };
      }
    } catch (_) {}
  }

  async function fetchData() {
    try {
      const response = await fetch('/data/standings.json');
      const raw = await response.json();
      app.state.standings = raw.classes ?? raw;
      app.state.meta = raw.meta ?? {};
      await hydrateSchedule();
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
    if (diffMs <= 0) return;

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
    const ok = await fetchData();
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

  function doSetScreen(nextScreen, skipVeil = false) {
    app.state.screen = nextScreen === 'races' ? 'races' : 'standings';

    const switchViews = () => {
      app.elements.viewStandings.classList.toggle('active', app.state.screen === 'standings');
      app.elements.viewRaces.classList.toggle('active', app.state.screen === 'races');
      app.elements.hdrTitle.textContent = app.state.screen === 'races' ? 'Race Results' : 'Championship Standings';

      if (app.state.screen === 'standings') {
        clearTimeout(app.state.podiumTimer);
        app.standings.continueScroll();
      } else {
        clearTimeout(app.state.timer);
        app.races.startRacesCycle();
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
      app.state.classIdx = message.classIdx ?? 0;
      app.state.isPaused = message.paused ?? false;
      app.state.screen = message.screen ?? 'standings';
      app.standings.loadClass(app.state.classIdx);
      doSetScreen(app.state.screen, true);
      return;
    }

    if (message.type === 'command') {
      switch (message.cmd) {
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
    const ok = await fetchData();
    if (!ok) return;

    connectSSE();
    app.standings.loadClass(app.state.classIdx);
    doSetScreen(app.state.screen, true);
    updateCountdown();
    app.state.countdownTimer = setInterval(updateCountdown, 60000);
  });
})();
