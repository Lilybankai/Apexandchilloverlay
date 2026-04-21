(() => {
  const app = window.OverlayApp;

  function buildRows(list) {
    return list.map((d, i) => {
      const rank = i + 1;
      return `
        <div class="career-row ${rank === 1 ? 'p1' : rank === 2 ? 'p2' : rank === 3 ? 'p3' : ''}">
          <div><div class="pos-num">${rank}</div></div>
          <div class="career-driver-name">${d.displayName || d.username || '—'}</div>
          <div class="career-stat">${d.titles}</div>
          <div class="career-stat">${d.wins}</div>
          <div class="career-stat">${d.podiums}</div>
          <div class="career-stat">${d.qualifyingWins}</div>
          <div class="career-stat">${d.qualifyingPodiums}</div>
        </div>`;
    }).join('');
  }

  function continueScroll() {
    const { state, config, elements } = app;
    if (state.isPaused || state.screen !== 'career') return;
    clearTimeout(state.timer);

    const totalRows = state.careerDrivers.length;
    const wrap = elements.careerWrap;
    const body = elements.careerBody;
    if (!wrap || !body) return;

    const visibleRows = Math.floor(wrap.clientHeight / config.rowHeight);
    const maxStep = Math.max(0, totalRows - visibleRows);

    function step() {
      if (state.isPaused || state.screen !== 'career') return;
      if (state.scrollPos < maxStep) {
        state.scrollPos += 1;
        body.style.transform = `translateY(-${state.scrollPos * config.rowHeight}px)`;
        app.reportState();
        state.timer = setTimeout(step, config.scrollDelayMs);
      } else {
        state.timer = setTimeout(() => {
          if (!state.isPaused && state.screen === 'career') {
            state.scrollPos = 0;
            body.style.transform = 'translateY(0)';
            app.reportState();
            continueScroll();
          }
        }, config.bottomPauseMs);
      }
    }

    state.timer = setTimeout(step, config.scrollDelayMs);
  }

  function startScroll(totalRows) {
    const { state, config, elements } = app;
    clearTimeout(state.timer);
    state.scrollPos = 0;

    const wrap = elements.careerWrap;
    const body = elements.careerBody;
    const bar = elements.careerProgressBar;
    if (!wrap || !body || !bar) return;

    const visibleRows = Math.floor(wrap.clientHeight / config.rowHeight);
    const maxStep = Math.max(0, totalRows - visibleRows);
    const totalMs = maxStep * config.scrollDelayMs + config.bottomPauseMs;

    bar.style.transition = 'none';
    bar.style.width = '0%';
    requestAnimationFrame(() => {
      if (!state.isPaused && state.screen === 'career') {
        bar.style.transition = `width ${totalMs}ms linear`;
        bar.style.width = '100%';
      }
    });

    if (!state.isPaused && state.screen === 'career') {
      state.timer = setTimeout(continueScroll, config.scrollDelayMs * 1.5);
    }
  }

  async function load({ bust = false } = {}) {
    if (app.state.league !== 'gt7') return false;
    try {
      const q = bust ? '?refresh=1' : '';
      const response = await fetch(`/api/gt7/career${q}`);
      const raw = await response.json();
      if (raw?.error) return false;
      app.state.careerDrivers = raw.drivers ?? [];
      app.state.careerMeta = raw.meta ?? {};
      app.state.scrollPos = 0;
      const body = app.elements.careerBody;
      const bar = app.elements.careerProgressBar;
      if (body) {
        body.innerHTML = buildRows(app.state.careerDrivers);
        body.style.transform = 'translateY(0)';
      }
      if (bar) {
        bar.style.transition = 'none';
        bar.style.width = '0%';
      }
      app.buildClassTags();
      app.reportState();
      if (app.state.screen === 'career' && !app.state.isPaused) {
        startScroll(app.state.careerDrivers.length);
      }
      return true;
    } catch (e) {
      console.error('career fetch failed:', e);
      return false;
    }
  }

  app.career = {
    load,
    continueScroll,
    startScroll
  };
})();
