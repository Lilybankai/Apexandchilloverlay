(() => {
  const app = window.OverlayApp;

  function fmtDate(value) {
    if (!value) return 'Date TBC';
    const ts = new Date(value);
    if (Number.isNaN(ts.getTime())) return 'Date TBC';
    return ts.toUTCString();
  }

  function renderSchedule() {
    const rows = Array.isArray(app.state.meta.rounds) ? app.state.meta.rounds : [];
    const container = app.elements.scheduleList;
    if (!container) return;

    if (!rows.length) {
      container.innerHTML = '<div class="schedule-row"><div class="sched-name">No schedule data available</div></div>';
      return;
    }

    container.innerHTML = rows.map((round, idx) => {
      const cls = round.isNext ? 'next' : round.isFinished ? 'done' : '';
      const status = round.isNext ? 'next race' : round.isFinished ? 'completed' : 'upcoming';
      return `
        <div class="schedule-row ${cls}">
          <div class="sched-round">Round ${idx + 1}</div>
          <div class="sched-name">${round.name || `Round ${idx + 1}`}</div>
          <div class="sched-date">${fmtDate(round.date)}</div>
          <div class="sched-status">${status}</div>
        </div>`;
    }).join('');
  }

  app.schedule = { renderSchedule };
})();
