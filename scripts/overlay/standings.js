(() => {
  const app = window.OverlayApp;

  function raceCell(result) {
    if (!result || (result.position === null && result.dnf === null && result.dns === null)) {
      return '<div class="rpt none">–</div>';
    }
    if (result.dns) return '<div class="rpt dns">DNS</div>';
    if (result.dnf) return '<div class="rpt dnf">DNF</div>';
    const pts = result.pointsTotal ?? 0;
    if (pts === 0) return '<div class="rpt zero">0</div>';
    return `<div class="rpt">${Math.round(pts)}</div>`;
  }

  function dotClass(race) {
    if (!race || race.position === null) return 'blank';
    if (race.dns || race.dnf) return 'none';
    if (race.position === 1) return 'win';
    if ((race.pointsTotal ?? 0) > 0) return 'pts';
    return 'none';
  }

  function buildRows(list) {
    const leaderPoints = list[0]?.championshipPoints ?? 0;
    return list.map(driver => {
      const races = driver.races || [];
      const gap = leaderPoints - (driver.championshipPoints ?? 0);
      const gapHtml = driver.position === 1
        ? '<div class="gap-val leader">—</div>'
        : `<div class="gap-val">-${gap}</div>`;
      const dots = [races[races.length - 3], races[races.length - 2], races[races.length - 1]]
        .map(item => `<span class="dot ${dotClass(item)}"></span>`)
        .join('');

      return `
        <div class="row ${driver.position === 1 ? 'p1' : driver.position === 2 ? 'p2' : driver.position === 3 ? 'p3' : ''}">
          <div><div class="pos-num">${driver.position}</div></div>
          <div><div class="car-num">${driver.carNum}</div></div>
          <div class="driver-cell">
            <div class="driver-name">${driver.id}</div>
            <div class="car-name">${(driver.car || '').trim()}</div>
            <div class="form-dots">${dots}</div>
          </div>
          ${raceCell(races[0])}
          ${raceCell(races[1])}
          ${raceCell(races[2])}
          ${gapHtml}
          <div><div class="pts-val">${driver.championshipPoints}</div><div class="pts-lbl">pts</div></div>
        </div>`;
    }).join('');
  }

  function continueScroll() {
    const { state, config, elements } = app;
    if (state.isPaused || state.screen !== 'standings') return;
    clearTimeout(state.timer);

    const totalRows = state.standings[state.classIdx]?.standings?.length || 0;
    const visibleRows = Math.floor(elements.tableWrap.clientHeight / config.rowHeight);
    const maxStep = Math.max(0, totalRows - visibleRows);

    function step() {
      if (state.isPaused || state.screen !== 'standings') return;
      if (state.scrollPos < maxStep) {
        state.scrollPos += 1;
        elements.tableBody.style.transform = `translateY(-${state.scrollPos * config.rowHeight}px)`;
        app.reportState();
        state.timer = setTimeout(step, config.scrollDelayMs);
      } else {
        state.timer = setTimeout(() => {
          if (!state.isPaused && state.screen === 'standings') {
            switchClass();
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

    const visibleRows = Math.floor(elements.tableWrap.clientHeight / config.rowHeight);
    const maxStep = Math.max(0, totalRows - visibleRows);
    const totalMs = maxStep * config.scrollDelayMs + config.bottomPauseMs;

    elements.progressBar.style.transition = 'none';
    elements.progressBar.style.width = '0%';
    requestAnimationFrame(() => {
      if (!state.isPaused && state.screen === 'standings') {
        elements.progressBar.style.transition = `width ${totalMs}ms linear`;
        elements.progressBar.style.width = '100%';
      }
    });

    if (!state.isPaused && state.screen === 'standings') {
      state.timer = setTimeout(continueScroll, config.scrollDelayMs * 1.5);
    }
  }

  function loadClass(idx) {
    const { state, elements } = app;
    const selected = state.standings[idx];
    if (!selected) return;

    state.classIdx = idx;
    state.scrollPos = 0;
    elements.tableBody.innerHTML = buildRows(selected.standings);
    elements.tableBody.style.transform = 'translateY(0)';
    app.buildClassTags();
    app.reportState();

    if (state.screen === 'standings') {
      startScroll(selected.standings.length);
    }
  }

  function switchClass() {
    const { state } = app;
    state.classIdx = (state.classIdx + 1) % state.standings.length;
    loadClass(state.classIdx);
  }

  app.standings = {
    loadClass,
    switchClass,
    continueScroll
  };
})();
