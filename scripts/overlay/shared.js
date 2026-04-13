(() => {
  const app = {
    config: {
      rowHeight: 63,
      scrollDelayMs: 2400,
      bottomPauseMs: 4500,
      switchAnimMs: 380
    },
    state: {
      standings: [],
      meta: {},
      classIdx: 0,
      scrollPos: 0,
      isPaused: false,
      screen: 'standings',
      timer: null,
      evtSource: null,
      reportTick: null,
      podiumTimer: null,
      podiumRound: 0,
      countdownTimer: null
    },
    elements: {},
    cacheElements() {
      this.elements = {
        viewStandings: document.getElementById('view-standings'),
        viewRaces: document.getElementById('view-races'),
        viewSchedule: document.getElementById('view-schedule'),
        colHeaders: document.getElementById('col-hdrs'),
        hdrTitle: document.getElementById('hdr-title'),
        hdrSeason: document.getElementById('hdr-season'),
        classTags: document.getElementById('class-tags'),
        footerInfo: document.getElementById('footer-info'),
        pauseBadge: document.getElementById('pause-badge'),
        tableWrap: document.getElementById('tbl-wrap'),
        tableBody: document.getElementById('tbl-body'),
        progressBar: document.getElementById('progress-bar'),
        veil: document.getElementById('veil'),
        roundHead: document.getElementById('round-head'),
        roundTitle: document.getElementById('round-title'),
        roundSub: document.getElementById('round-sub'),
        cardP1: document.getElementById('card-p1'),
        cardP2: document.getElementById('card-p2'),
        cardP3: document.getElementById('card-p3'),
        scheduleList: document.getElementById('schedule-list')
      };
    },
    roundCount() {
      const scheduleRounds = Array.isArray(this.state.meta.rounds) ? this.state.meta.rounds.length : 0;
      if (scheduleRounds > 0) return scheduleRounds;
      const cls = this.state.standings[this.state.classIdx];
      if (!cls) return 0;
      return Math.max(0, ...cls.standings.map(driver => (driver.races || []).length));
    },
    completedRoundCount() {
      if (Array.isArray(this.state.meta.rounds) && this.state.meta.rounds.length) {
        return this.state.meta.rounds.filter(round => round.isFinished).length;
      }
      return 0;
    },
    buildClassTags() {
      const cls = this.state.standings[this.state.classIdx];
      if (!cls) return;
      this.elements.classTags.innerHTML = '<div class="class-tag">LMGT3</div>';
      this.elements.hdrSeason.textContent = `Season 1 · ${this.roundCount()} Rounds Complete`;
      this.elements.footerInfo.textContent = `LMGT3 · ${cls.standings.length} Drivers`;
    },
    reportState() {
      if (this.state.skipApiReport) return;
      clearTimeout(this.state.reportTick);
      this.state.reportTick = setTimeout(() => {
        fetch('/api/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            classIdx: this.state.classIdx,
            paused: this.state.isPaused,
            scrollPos: this.state.scrollPos,
            screen: this.state.screen
          })
        })
          .then(res => {
            if (!res.ok) {
              this.state.apiReportFailCount = (this.state.apiReportFailCount || 0) + 1;
              if (this.state.apiReportFailCount >= 3) this.state.skipApiReport = true;
            } else {
              this.state.apiReportFailCount = 0;
            }
          })
          .catch(() => {
            this.state.apiReportFailCount = (this.state.apiReportFailCount || 0) + 1;
            if (this.state.apiReportFailCount >= 3) this.state.skipApiReport = true;
          });
      }, 350);
    }
  };

  window.OverlayApp = app;
})();
