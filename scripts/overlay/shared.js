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
        cardP3: document.getElementById('card-p3')
      };
    },
    roundCount() {
      const cls = this.state.standings[this.state.classIdx];
      if (!cls) return 0;
      return Math.max(0, ...cls.standings.map(driver => (driver.races || []).length));
    },
    buildClassTags() {
      const cls = this.state.standings[this.state.classIdx];
      if (!cls) return;
      this.elements.classTags.innerHTML = '<div class="class-tag">LMGT3</div>';
      this.elements.hdrSeason.textContent = `Season 1 · ${this.roundCount()} Rounds Complete`;
      this.elements.footerInfo.textContent = `LMGT3 · ${cls.standings.length} Drivers`;
    },
    reportState() {
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
        }).catch(() => {});
      }, 350);
    }
  };

  window.OverlayApp = app;
})();
