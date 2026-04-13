(() => {
  const app = window.OverlayApp;

  function getRoundPodium(standings, raceIdx) {
    return standings
      .filter(driver => driver.races[raceIdx]?.position != null && !driver.races[raceIdx]?.dns)
      .sort((a, b) => a.races[raceIdx].position - b.races[raceIdx].position)
      .slice(0, 3)
      .map(driver => ({ ...driver, raceResult: driver.races[raceIdx] }));
  }

  function roundLabel(roundIdx) {
    const fallback = { name: `Round ${roundIdx + 1}`, date: null };
    const fromMeta = Array.isArray(app.state.meta.rounds) ? app.state.meta.rounds[roundIdx] : null;
    if (!fromMeta) return fallback;
    return {
      name: fromMeta.name || fallback.name,
      date: fromMeta.date || null
    };
  }

  function renderCard(element, title, entry) {
    if (!entry) {
      element.style.opacity = '0';
      element.innerHTML = '';
      return;
    }

    element.innerHTML = `
      <div class="card-title">${title}</div>
      <div class="card-driver">${entry.id}</div>
      <div class="card-meta">#${entry.carNum} · ${entry.car}</div>
      <div class="card-pts">${entry.raceResult?.pointsTotal ?? 0} PTS</div>`;
  }

  function scheduleNextRound(delayMs) {
    const { state, elements, config } = app;
    clearTimeout(state.podiumTimer);
    state.podiumTimer = setTimeout(() => {
      if (state.isPaused || state.screen !== 'races') return;
      const rounds = app.roundCount();
      if (!rounds) return;

      state.podiumRound = (state.podiumRound + 1) % rounds;
      elements.veil.classList.add('show');
      setTimeout(() => {
        revealPodium(state.podiumRound);
        setTimeout(() => elements.veil.classList.remove('show'), 150);
      }, config.switchAnimMs);
    }, delayMs);
  }

  function revealPodium(roundIdx) {
    const { state, elements } = app;
    if (state.isPaused || state.screen !== 'races') return;

    const selectedClass = state.standings[state.classIdx];
    const podium = getRoundPodium(selectedClass.standings, roundIdx);
    const race = roundLabel(roundIdx);
    const p1 = podium[0];
    const p2 = podium[1];
    const p3 = podium[2];

    elements.roundHead.classList.remove('show');
    [elements.cardP1, elements.cardP2, elements.cardP3].forEach(card => {
      card.className = card.id === 'card-p1' ? 'card' : 'card small';
      card.style.opacity = '0';
    });

    elements.roundTitle.textContent = `ROUND ${roundIdx + 1} · ${race.name}`;
    elements.roundSub.textContent = race.date ? new Date(race.date).toUTCString() : 'Date TBC';

    renderCard(elements.cardP1, 'Race Winner', p1);
    renderCard(elements.cardP2, '2nd Place', p2);
    renderCard(elements.cardP3, '3rd Place', p3);

    setTimeout(() => elements.roundHead.classList.add('show'), 50);
    setTimeout(() => elements.cardP3.classList.add('reveal-right'), 1200);
    setTimeout(() => elements.cardP2.classList.add('reveal-right'), 2200);
    setTimeout(() => elements.cardP1.classList.add('reveal-drop'), 3400);

    scheduleNextRound(10400);
  }

  function startRacesCycle() {
    const { state } = app;
    const selectedClass = state.standings[state.classIdx];
    if (!selectedClass) return;
    const rounds = Math.max(0, ...selectedClass.standings.map(driver => (driver.races || []).length));
    if (rounds === 0) return;

    state.podiumRound = state.podiumRound % rounds;
    revealPodium(state.podiumRound);
  }

  app.races = {
    startRacesCycle,
    scheduleNextRound
  };
})();
