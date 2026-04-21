(() => {
  const app = {
    config: {
      rowHeight: 63,
      scrollDelayMs: 2400,
      bottomPauseMs: 4500,
      switchAnimMs: 380
    },
    state: {
      league: 'lmu',
      standings: [],
      meta: {},
      classIdx: 0,
      scrollPos: 0,
      isPaused: false,
      screen: 'standings',
      gt7LeagueId: 'f2d6eae4-9591-4e29-bc77-ec2e0197c32e',
      careerDrivers: [],
      careerMeta: {},
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
        viewCareer: document.getElementById('view-career'),
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
        scheduleList: document.getElementById('schedule-list'),
        careerWrap: document.getElementById('career-wrap'),
        careerBody: document.getElementById('career-body'),
        careerProgressBar: document.getElementById('career-progress-bar')
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
      if (this.state.screen === 'career') {
        this.elements.classTags.innerHTML = '';
        const seasons = (this.state.careerMeta.seasons || []).map(s => s.label).filter(Boolean).join(' · ');
        this.elements.hdrSeason.textContent = seasons || 'Career records';
        this.elements.footerInfo.textContent = `${this.state.careerDrivers.length} Drivers · GT7`;
        return;
      }
      const cls = this.state.standings[this.state.classIdx];
      if (!cls) return;
      const tags = this.state.standings
        .map((item, idx) => {
          const active = idx === this.state.classIdx ? ' style="border-color: var(--green); color: var(--green); background: rgba(0,255,136,0.09)"' : '';
          const label = (item.label || item.carClass || `Class ${idx + 1}`).replace(/\s+/g, ' ').trim();
          return `<div class="class-tag"${active}>${label.slice(0, 22)}</div>`;
        })
        .join('');
      this.elements.classTags.innerHTML = tags;
      const seasonName = this.state.meta.seasonName || (this.state.league === 'gt7' ? 'GT7 League' : 'LMU League');
      this.elements.hdrSeason.textContent = `${seasonName} · ${this.roundCount()} Rounds`;
      this.elements.footerInfo.textContent = `${cls.label || cls.carClass || 'Class'} · ${cls.standings.length} Drivers`;
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
            scrollPos: this.state.scrollPos,
            screen: this.state.screen,
            league: this.state.league,
            ...(this.state.league === 'gt7' ? { gt7LeagueId: this.state.gt7LeagueId } : {})
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
