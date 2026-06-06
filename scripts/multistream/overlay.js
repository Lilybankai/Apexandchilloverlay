(() => {
  const ms = {
    state: {
      streams: [],
      visibleSlots: [null, null, null, null],
      rotationOffset: 0,
      focusedId: null,
      layout: 'grid', // 'grid' | 'pip' | 'dual'
      rotationEnabled: false,
      rotationIntervalSec: 30,
      twitchParent: 'localhost',
      streamStats: {},
      banner: { enabled: false, text: '', durationSec: 40 },
      lmuTiming: { enabled: false },
    },
    prevSlots: [null, null, null, null],
    prevFocusedId: null,
    evtSource: null,
    // ── LMU live timing working state ──
    lmuTimer: null,
    lmuBattleSet: new Set(),
    lmuCalloutQueue: [],
    lmuCalloutActive: false,
    lmuCalloutTimer: null,
  };

  const twitchPlayers = {}; // slotIdx → { player, wrapper, iframe, slotIdx, streamId }
  const ytPlayers = {};     // slotIdx → YT.Player

  // ── Twitch embed parking ──────────────────────────────────────────────────
  // When a Twitch stream rotates off-screen we move its embed into a hidden
  // container instead of destroying it. When the same channel rotates back
  // in we re-attach the parked embed — no reload, no need to press play.
  const parkedTwitchEmbeds = {}; // streamId → { player, wrapper, iframe }

  function getPark() {
    return document.getElementById('twitch-park');
  }

  function parkTwitchEmbed(slotIdx) {
    const entry = twitchPlayers[slotIdx];
    if (!entry) return;
    const park = getPark();
    if (!park) return;

    const el = entry.wrapper || entry.iframe;
    if (!el) return;

    if (entry.player) {
      try { entry.player.setMuted(true); } catch (_) {}
    }

    park.appendChild(el);
    parkedTwitchEmbeds[entry.streamId] = {
      player: entry.player || null,
      wrapper: entry.wrapper || null,
      iframe: entry.iframe || null,
    };
    delete twitchPlayers[slotIdx];
  }

  function unparkTwitchEmbed(streamId) {
    const parked = parkedTwitchEmbeds[streamId];
    if (!parked) return null;
    delete parkedTwitchEmbeds[streamId];
    return parked;
  }

  function destroyParkedEmbed(streamId) {
    const parked = parkedTwitchEmbeds[streamId];
    if (!parked) return;
    const el = parked.wrapper || parked.iframe;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete parkedTwitchEmbeds[streamId];
  }

  // ── YouTube IFrame API readiness ──────────────────────────────────────────
  // The API script tag loads before this module, so onYouTubeIframeAPIReady
  // may have already fired. Detect that case and also install our own
  // callback for when it hasn't fired yet.
  let ytReady = !!(window.YT && window.YT.Player);
  const ytQueue = [];
  const _prevYTReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    if (typeof _prevYTReady === 'function') _prevYTReady();
    ytQueue.splice(0).forEach(fn => fn());
  };
  function waitForYT(fn) {
    if (ytReady) fn(); else ytQueue.push(fn);
  }

  // ── Twitch Embed API readiness ────────────────────────────────────────────
  const twitchQueue = [];
  function isTwitchReady() {
    return !!(window.Twitch && window.Twitch.Player);
  }
  function flushTwitchQueue() {
    twitchQueue.splice(0).forEach(entry => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      entry.fn();
    });
  }
  function waitForTwitch(fn, onUnavailable) {
    if (window.Twitch && window.Twitch.Player) {
      fn();
      return;
    }
    const entry = {
      fn,
      done: false,
      timer: setTimeout(() => {
        if (entry.done) return;
        entry.done = true;
        onUnavailable();
      }, 3000),
    };
    twitchQueue.push(entry);
  }
  window.onTwitchEmbedReady = flushTwitchQueue;
  const twitchReadyPoll = setInterval(() => {
    if (isTwitchReady()) {
      clearInterval(twitchReadyPoll);
      flushTwitchQueue();
    }
  }, 100);

  // ─────────────────────────────────────────────────────────────────────────

  function getStreamById(id) {
    return ms.state.streams.find(s => s.id === id) ?? null;
  }

  function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return '';
    const v = Number(n);
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v);
  }

  function updateMetaForSlot(slotIdx, streamId, state) {
    const cell = document.getElementById(`cell-${slotIdx}`);
    if (!cell) return;

    if (!streamId) {
      const bar = cell.querySelector('.stream-meta-bar');
      if (bar) bar.style.display = 'none';
      const label = cell.querySelector('.stream-label');
      if (label) {
        label.style.display = '';
        label.textContent = '';
      }
      return;
    }

    let bar = cell.querySelector('.stream-meta-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'stream-meta-bar';
      bar.innerHTML = '<div class="meta-title"></div><div class="meta-row"><span class="meta-views"></span><span class="meta-likes"></span></div>';
      const idx = cell.querySelector('.slot-index');
      if (idx && idx.nextSibling) cell.insertBefore(bar, idx.nextSibling);
      else cell.insertBefore(bar, cell.firstChild);
    }
    bar.style.display = '';

    const stream = getStreamById(streamId);
    const stats = (state.streamStats && state.streamStats[streamId]) || null;

    const titleEl = bar.querySelector('.meta-title');
    const viewsEl = bar.querySelector('.meta-views');
    const likesEl = bar.querySelector('.meta-likes');
    const bottomLabel = cell.querySelector('.stream-label');

    const title = (stats && stats.title) || (stream && stream.label) || '';
    if (titleEl) titleEl.textContent = title;

    if (stats && stats.viewers != null && stats.viewerLabel) {
      viewsEl.textContent = stats.viewerLabel === 'views'
        ? `${fmtNum(stats.viewers)} views`
        : `${fmtNum(stats.viewers)} watching`;
    } else if (stats && stats.offline) {
      viewsEl.textContent = 'Offline';
    } else {
      viewsEl.textContent = '';
    }

    if (stream && stream.type === 'youtube' && stats && stats.likes != null) {
      likesEl.textContent = `${fmtNum(stats.likes)} likes`;
    } else {
      likesEl.textContent = '';
    }

    if (bottomLabel) {
      bottomLabel.style.display = 'none';
    }
  }

  function updateBanner(banner) {
    const el = document.getElementById('ms-ticker');
    if (!el) return;
    const b = banner || { enabled: false, text: '', durationSec: 40 };
    const on = !!(b.enabled && String(b.text || '').trim());
    el.dataset.visible = on ? '1' : '0';
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
    const dur = Math.max(12, Math.min(180, Number(b.durationSec) || 40));
    el.style.setProperty('--ms-ticker-duration', `${dur}s`);
    const chunk = String(b.text || '').trim()
      ? `${String(b.text).trim()}     •     `
      : '';
    el.querySelectorAll('.ms-ticker-seg').forEach(s => { s.textContent = chunk; });
  }

  function refreshMetaAndBanner() {
    for (let i = 0; i < 4; i++) {
      updateMetaForSlot(i, ms.state.visibleSlots[i] ?? null, ms.state);
    }
    updateBanner(ms.state.banner);
  }

  function updateLayout(layout) {
    const overlay = document.getElementById('multistream-overlay');
    if (overlay) overlay.dataset.layout = layout;
  }

  // Fade an element out and remove it. Idempotent — won't double-fade.
  function fadeOut(el, duration = 450) {
    if (!el || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    el.style.transition = `opacity ${duration}ms ease`;
    el.style.opacity = '0';
    setTimeout(() => el.parentNode && el.parentNode.removeChild(el), duration);
  }

  // Selector for all live media in a cell (excludes elements already fading out)
  const LIVE_MEDIA = [
    'iframe:not([data-leaving])',
    '.twitch-embed-container:not([data-leaving])',
    '.yt-embed-container:not([data-leaving])',
  ].join(', ');

  // ── buildCell ─────────────────────────────────────────────────────────────
  function buildCell(slotIdx, streamId) {
    const cell = document.getElementById(`cell-${slotIdx}`);
    if (!cell) return;

    const stream = streamId ? getStreamById(streamId) : null;
    const isFocused = streamId !== null && streamId === ms.state.focusedId;

    cell.classList.toggle('focused', isFocused);
    cell.classList.toggle('empty', !stream);

    const label = cell.querySelector('.stream-label');
    if (label) label.textContent = stream ? (stream.label || '') : '';

    const badge = cell.querySelector('.audio-badge');
    if (badge) badge.style.display = isFocused ? 'flex' : 'none';

    // Park outgoing Twitch embed so it can be reused later
    parkTwitchEmbed(slotIdx);

    // Drop YT reference — schedule destroy so the player is still visible
    // during the crossfade (destroy() would remove its iframe immediately)
    if (ytPlayers[slotIdx]) {
      const old = ytPlayers[slotIdx];
      delete ytPlayers[slotIdx];
      setTimeout(() => { try { old.destroy(); } catch (_) {} }, 500);
    }

    if (!stream) {
      cell.querySelectorAll(LIVE_MEDIA).forEach(el => fadeOut(el));
      updateMetaForSlot(slotIdx, null, ms.state);
      return;
    }

    if (stream.type === 'twitch') {
      restoreOrBuildTwitchEmbed(cell, slotIdx, stream, isFocused);
    } else {
      buildYouTubePlayer(cell, slotIdx, stream, isFocused);
    }
    updateMetaForSlot(slotIdx, streamId, ms.state);
  }

  // ── Twitch embed restore / build ───────────────────────────────────────────
  // If the same Twitch channel was parked (rotated off-screen earlier), move
  // it back into the cell without reloading — playback continues seamlessly.
  function restoreOrBuildTwitchEmbed(cell, slotIdx, stream, isFocused) {
    const parked = unparkTwitchEmbed(stream.id);
    if (parked) {
      const leaving = Array.from(cell.querySelectorAll(LIVE_MEDIA));
      cell.querySelectorAll('[data-leaving]').forEach(el => el.remove());

      const el = parked.wrapper || parked.iframe;
      el.style.opacity = '0';
      cell.appendChild(el);
      el.style.transition = 'opacity 0.45s ease';
      requestAnimationFrame(() => { el.style.opacity = '1'; });
      leaving.forEach(old => fadeOut(old));

      if (parked.player) {
        applyTwitchAudioFocus(parked.player, isFocused);
      }
      twitchPlayers[slotIdx] = {
        player: parked.player,
        wrapper: parked.wrapper,
        iframe: parked.iframe,
        slotIdx,
        streamId: stream.id,
      };
      return;
    }
    buildTwitchEmbed(cell, slotIdx, stream, isFocused);
  }

  // ── Twitch embed ──────────────────────────────────────────────────────────
  // Browser-window capture can use Twitch's player API, which lets rotation
  // switch audio focus without reloading embeds. Keep a direct-iframe fallback
  // for OBS/browser-source environments where the SDK can be unreliable.

  // Twitch requires the embedding page's domain(s) as `parent`. Include the
  // configured domain AND the real host so the same overlay works on the hosted
  // domain and on localhost in OBS with no settings change.
  function twitchParents() {
    const list = [ms.state.twitchParent, location.hostname, 'localhost']
      .map(p => String(p || '').trim())
      .filter(Boolean);
    return [...new Set(list)];
  }

  function buildTwitchEmbed(cell, slotIdx, stream, isFocused) {
    const leaving = Array.from(cell.querySelectorAll(LIVE_MEDIA));
    cell.querySelectorAll('[data-leaving]').forEach(el => el.remove());

    const parents = twitchParents();
    const wrapperId = `twitch-target-${slotIdx}-${Date.now()}`;
    const wrapper = document.createElement('div');
    wrapper.id = wrapperId;
    wrapper.className = 'twitch-embed-container';
    wrapper.style.opacity = '0';
    cell.appendChild(wrapper);

    const isCurrentWrapper = () => document.getElementById(wrapperId) === wrapper;
    const buildFallback = () => {
      if (!isCurrentWrapper()) return;
      wrapper.remove();
      buildTwitchIframeFallback(cell, slotIdx, stream, isFocused, leaving, parents);
    };

    waitForTwitch(() => {
      if (!isCurrentWrapper()) return;

      try {
        const player = new window.Twitch.Player(wrapperId, {
          channel: stream.embedId,
          parent: parents,
          autoplay: true,
          muted: false,
          width: '100%',
          height: '100%',
        });

        twitchPlayers[slotIdx] = { player, wrapper, iframe: null, slotIdx, streamId: stream.id };
        player.addEventListener(window.Twitch.Player.READY, () => {
          applyTwitchAudioFocus(player, isFocused);
          wrapper.style.transition = 'opacity 0.45s ease';
          wrapper.style.opacity = '1';
          leaving.forEach(el => fadeOut(el));
        });
        return;
      } catch (_) {
        buildFallback();
      }
    }, buildFallback);
  }

  function buildTwitchIframeFallback(cell, slotIdx, stream, isFocused, leaving, parents) {
    const parentList = Array.isArray(parents) ? parents : [parents];
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; fullscreen';
    iframe.allowFullscreen = true;
    iframe.src = `https://player.twitch.tv/?channel=${encodeURIComponent(stream.embedId)}`
      + parentList.map(p => `&parent=${encodeURIComponent(p)}`).join('')
      + '&autoplay=true'
      + '&muted=true';
    iframe.style.opacity = '0';

    cell.appendChild(iframe);

    iframe.addEventListener('load', () => {
      iframe.style.transition = 'opacity 0.45s ease';
      iframe.style.opacity = '1';
      leaving.forEach(el => fadeOut(el));

      // Simulate a user click on the iframe — this satisfies any
      // browser-level autoplay-gate that requires a "user gesture".
      // In OBS CEF, dispatched events can count as user activation.
      setTimeout(() => {
        try {
          iframe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          iframe.focus();
        } catch (_) {}
      }, 1000);
    }, { once: true });

    twitchPlayers[slotIdx] = { player: null, wrapper: null, iframe, slotIdx, streamId: stream.id };
  }

  function applyTwitchAudioFocus(player, isFocused) {
    if (!player) return;
    try {
      player.setMuted(!isFocused);
      if (isFocused) player.setVolume(1);
    } catch (_) {}
  }

  // ── YouTube IFrame API player ─────────────────────────────────────────────
  function buildYouTubePlayer(cell, slotIdx, stream, isFocused) {
    const leaving = Array.from(cell.querySelectorAll(LIVE_MEDIA));
    cell.querySelectorAll('[data-leaving]').forEach(el => el.remove());

    // YT.Player(targetId, …) *replaces* the target element with an iframe.
    // Use a stable outer wrapper for opacity transitions and an inner
    // placeholder div as the replacement target so the wrapper survives.
    const ts = Date.now();
    const wrapperId = `yt-wrap-${slotIdx}-${ts}`;
    const targetId = `yt-target-${slotIdx}-${ts}`;

    const wrapper = document.createElement('div');
    wrapper.id = wrapperId;
    wrapper.className = 'yt-embed-container';
    wrapper.style.opacity = '0';

    const target = document.createElement('div');
    target.id = targetId;
    wrapper.appendChild(target);

    cell.appendChild(wrapper);

    // Sequence guard — if this slot is rebuilt before the YT API is ready,
    // the stale callback removes the orphaned wrapper and exits.
    cell.dataset.ytSeq = String((parseInt(cell.dataset.ytSeq || '0') + 1));
    const seq = cell.dataset.ytSeq;

    waitForYT(() => {
      if (cell.dataset.ytSeq !== seq || !document.getElementById(wrapperId)) {
        wrapper.remove();
        return;
      }

      const w = cell.offsetWidth || 960;
      const h = cell.offsetHeight || 479;

      new window.YT.Player(targetId, {
        videoId: stream.embedId,
        width: w,
        height: h,
        playerVars: {
          autoplay: 1,
          mute: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          iv_load_policy: 3,
          enablejsapi: 1,
          origin: location.origin || location.hostname || 'localhost',
        },
        events: {
          onReady(e) {
            if (cell.dataset.ytSeq !== seq) {
              try { e.target.destroy(); } catch (_) {}
              wrapper.remove();
              return;
            }
            e.target.playVideo();
            if (isFocused) {
              e.target.unMute();
              e.target.setVolume(100);
            }
            // Crossfade: wrapper is the stable outer div that survived
            // YT.Player's replacement of the inner target div
            wrapper.style.opacity = '1';
            leaving.forEach(el => fadeOut(el));

            ytPlayers[slotIdx] = e.target;
          },
          onError(e) {
            // Code 150 = embedding restricted but player may still load.
            // Only remove the wrapper if the player never became ready.
            if (!ytPlayers[slotIdx]) wrapper.remove();
          },
        },
      });
    });
  }

  // ── Focus update — no stream change, only mute state changes ─────────────
  function updateCellFocus(slotIdx, streamId) {
    const cell = document.getElementById(`cell-${slotIdx}`);
    if (!cell) return;

    const isFocused = streamId !== null && streamId === ms.state.focusedId;
    cell.classList.toggle('focused', isFocused);

    const badge = cell.querySelector('.audio-badge');
    if (badge) badge.style.display = isFocused ? 'flex' : 'none';

    const stream = streamId ? getStreamById(streamId) : null;
    if (!stream) return;

    if (stream.type === 'twitch') {
      const entry = twitchPlayers[slotIdx];
      if (entry && entry.player) {
        applyTwitchAudioFocus(entry.player, isFocused);
      } else if (entry && entry.iframe) {
        // Direct iframe — update muted parameter in the URL.
        // This reloads the player but is the only reliable way
        // without the SDK JS API.
        try {
          const url = new URL(entry.iframe.src);
          const nextMuted = isFocused ? 'false' : 'true';
          if (url.searchParams.get('muted') === nextMuted) return;
          url.searchParams.set('muted', nextMuted);
          entry.iframe.src = url.toString();
        } catch (_) {}
      }
    } else {
      // YouTube: instant mute/unmute via API — no iframe rebuild needed
      const player = ytPlayers[slotIdx];
      if (player) {
        try {
          if (isFocused) { player.unMute(); player.setVolume(100); }
          else player.mute();
        } catch (_) {}
      }
    }
  }

  // ── Full render ───────────────────────────────────────────────────────────
  function renderAll(state) {
    updateLayout(state.layout);
    for (let i = 0; i < 4; i++) {
      buildCell(i, state.visibleSlots[i] ?? null);
    }
  }

  // ── Diff-based update ─────────────────────────────────────────────────────
  function applyDiff(newState, oldLayout) {
    if (newState.layout !== oldLayout) updateLayout(newState.layout);

    for (let i = 0; i < 4; i++) {
      const oldId = ms.prevSlots[i];
      const newId = newState.visibleSlots[i] ?? null;
      const wasFocused = oldId === ms.prevFocusedId;
      const isFocused = newId === newState.focusedId;

      if (newId !== oldId) {
        buildCell(i, newId);
      } else if (wasFocused !== isFocused) {
        updateCellFocus(i, newId);
      }
    }
  }

  function applyState(newState) {
    const oldLayout = ms.state.layout;
    Object.assign(ms.state, newState);
    applyDiff(newState, oldLayout);
    ms.prevSlots = [...newState.visibleSlots];
    ms.prevFocusedId = newState.focusedId;
    pruneParkedEmbeds(newState);
    refreshMetaAndBanner();
    syncLmuTiming();
  }

  function pruneParkedEmbeds(newState) {
    const activeIds = new Set((newState.streams || []).map(s => s.id));
    for (const id of Object.keys(parkedTwitchEmbeds)) {
      if (!activeIds.has(id)) destroyParkedEmbed(id);
    }
  }

  // ── LMU live timing tower ───────────────────────────────────────────────────
  // Armed via the multistream controls toggle, then fully automatic: polls the
  // server's /api/lmu/live (which reads the local game API) once a second, shows
  // the tower only while a session is live, and renders overtake/battle graphics
  // pushed over SSE. Hidden + idle when disarmed or the game/session is offline.

  function fmtClock(sec) {
    if (sec == null) return '';
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function fmtLap(sec) {
    if (sec == null) return '--';
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      return `${m}:${(sec % 60).toFixed(3).padStart(6, '0')}`;
    }
    return sec.toFixed(3);
  }

  function fmtGap(gap) {
    if (!gap) return { text: '', leader: true };
    if (gap.laps != null) return { text: `+${gap.laps}L`, leader: false };
    if (gap.sec != null) return { text: `+${gap.sec.toFixed(3)}`, leader: false };
    return { text: '', leader: true };
  }

  function renderSession(si) {
    const el = document.getElementById('lmu-session');
    if (!el) return;
    if (!si) { el.innerHTML = ''; return; }
    const flag = String(si.flag || 'GREEN').toLowerCase();
    let flagCls = 'green';
    if (flag.includes('yellow') || flag.includes('fcy') || flag.includes('caution')) flagCls = 'yellow';
    else if (flag.includes('safety') || flag.includes('sc')) flagCls = 'sc';
    else if (flag.includes('red')) flagCls = 'red';
    const time = si.timeRemaining != null ? fmtClock(si.timeRemaining) : '';
    const temps = [];
    if (si.trackTemp != null) temps.push(`Trk ${Math.round(si.trackTemp)}°`);
    if (si.airTemp != null) temps.push(`Air ${Math.round(si.airTemp)}°`);
    el.innerHTML =
      `<span class="ls-type">${si.type || 'SESSION'}</span>`
      + `<span class="ls-flag ${flagCls}"></span>`
      + (time ? `<span>${time}</span>` : '')
      + (temps.length ? `<span class="ls-dim">${temps.join('  ')}</span>` : '');
  }

  function renderRow(row, entry, className) {
    row.dataset.cls = className;
    row.classList.toggle('battle', ms.lmuBattleSet.has(entry.num));
    const gap = fmtGap(entry.gapLeader);
    const secs = entry.sectors.map(s => `<span class="lmu-sec ${s.color || ''}"></span>`).join('');
    const right = entry.inPit
      ? '<span class="lmu-pit">PIT</span>'
      : `<span class="lmu-gap ${gap.leader ? 'leader' : ''}">${gap.leader ? '—' : gap.text}</span>`;
    row.innerHTML =
      `<span class="lmu-pos">${entry.classPos}</span>`
      + `<span class="lmu-num">${entry.num}</span>`
      + `<span class="lmu-drv">${entry.driver}</span>`
      + `<span class="lmu-sectors">${secs}</span>`
      + `<span class="lmu-last">${fmtLap(entry.lastLap)}</span>`
      + right;
  }

  function renderTower(model) {
    renderSession(model.sessionInfo);
    const wrap = document.getElementById('lmu-classes');
    if (!wrap) return;

    const seenClasses = new Set();
    model.classes.forEach(cls => {
      seenClasses.add(cls.name);
      let block = wrap.querySelector(`.lmu-class[data-cls="${cls.name}"]`);
      if (!block) {
        block = document.createElement('div');
        block.className = 'lmu-class';
        block.dataset.cls = cls.name;
        block.innerHTML = `<div class="lmu-class-hdr">${cls.name}</div><div class="lmu-rows"></div>`;
        wrap.appendChild(block);
      }
      const rowsEl = block.querySelector('.lmu-rows');
      const seenNums = new Set();
      cls.entries.forEach(entry => {
        seenNums.add(entry.num);
        let row = rowsEl.querySelector(`.lmu-row[data-num="${entry.num}"]`);
        if (!row) {
          row = document.createElement('div');
          row.className = 'lmu-row';
          row.dataset.num = entry.num;
          rowsEl.appendChild(row);
        }
        renderRow(row, entry, cls.name);
        rowsEl.appendChild(row); // re-append in finishing order so rows stay sorted
      });
      // Drop cars no longer in this class
      rowsEl.querySelectorAll('.lmu-row').forEach(r => {
        if (!seenNums.has(r.dataset.num)) r.remove();
      });
    });
    // Drop classes no longer present
    wrap.querySelectorAll('.lmu-class').forEach(b => {
      if (!seenClasses.has(b.dataset.cls)) b.remove();
    });

    // Auto-condense rows if the full field overflows the tower height
    const tower = document.getElementById('lmu-tower');
    tower.classList.remove('compact');
    if (tower.scrollHeight > tower.clientHeight) tower.classList.add('compact');
  }

  async function pollLmu() {
    try {
      const res = await fetch('/api/lmu/live');
      const model = await res.json();
      const tower = document.getElementById('lmu-tower');
      if (!tower) return;
      const overlay = document.getElementById('multistream-overlay');
      if (!model || model.offline || !model.sessionActive) {
        tower.dataset.visible = '0';
        tower.setAttribute('aria-hidden', 'true');
        if (overlay) overlay.dataset.lmu = '0';
        return;
      }
      tower.dataset.visible = '1';
      tower.setAttribute('aria-hidden', 'false');
      if (overlay) overlay.dataset.lmu = '1'; // reserve the tower strip; streams shift + shrink
      renderTower(model);
    } catch (_) {
      /* transient fetch error — keep last render */
    }
  }

  function startLmuTiming() {
    if (ms.lmuTimer) return;
    pollLmu();
    ms.lmuTimer = setInterval(pollLmu, 1000);
  }

  function stopLmuTiming() {
    clearInterval(ms.lmuTimer);
    ms.lmuTimer = null;
    const tower = document.getElementById('lmu-tower');
    if (tower) { tower.dataset.visible = '0'; tower.setAttribute('aria-hidden', 'true'); }
    const overlay = document.getElementById('multistream-overlay');
    if (overlay) overlay.dataset.lmu = '0';
    hideCallout();
    ms.lmuCalloutQueue = [];
    ms.lmuCalloutActive = false;
    ms.lmuBattleSet = new Set();
  }

  function syncLmuTiming() {
    if (ms.state.lmuTiming && ms.state.lmuTiming.enabled) startLmuTiming();
    else stopLmuTiming();
  }

  function applyBattles(msg) {
    const set = new Set();
    (msg.battles || []).forEach(b => { set.add(b.behind); set.add(b.ahead); });
    ms.lmuBattleSet = set;
    document.querySelectorAll('#lmu-classes .lmu-row').forEach(row => {
      row.classList.toggle('battle', set.has(row.dataset.num));
    });
  }

  function enqueueCallout(msg) {
    ms.lmuCalloutQueue.push(msg);
    if (!ms.lmuCalloutActive) nextCallout();
  }

  function hideCallout() {
    clearTimeout(ms.lmuCalloutTimer);
    const el = document.getElementById('lmu-callout');
    if (el) el.dataset.visible = '0';
  }

  function nextCallout() {
    const msg = ms.lmuCalloutQueue.shift();
    if (!msg) { ms.lmuCalloutActive = false; return; }
    ms.lmuCalloutActive = true;
    const el = document.getElementById('lmu-callout');
    if (!el) { ms.lmuCalloutActive = false; return; }
    el.querySelector('.co-move').textContent = `P${msg.fromPos} → P${msg.toPos}`;
    el.querySelector('.co-name').textContent = msg.driver || '';
    el.querySelector('.co-cls').textContent = msg.className || '';
    el.dataset.visible = '1';
    clearTimeout(ms.lmuCalloutTimer);
    ms.lmuCalloutTimer = setTimeout(() => {
      el.dataset.visible = '0';
      setTimeout(nextCallout, 500);
    }, 6000);
  }

  function handleSSE(msg) {
    if (msg.type === 'lmuOvertake') {
      if (ms.state.lmuTiming && ms.state.lmuTiming.enabled) enqueueCallout(msg);
      return;
    }
    if (msg.type === 'lmuBattle') {
      if (ms.state.lmuTiming && ms.state.lmuTiming.enabled) applyBattles(msg);
      return;
    }
    if (msg.type === 'state' && msg.multistream) {
      // SSE pushes full state on connect. Use diff-based update so we
      // don't tear down in-progress embeds that init() already started.
      applyState(msg.multistream);
      return;
    }
    if (msg.type === 'msCommand') {
      applyState(msg);
    }
  }

  function connectSSE() {
    if (ms.evtSource) ms.evtSource.close();
    ms.evtSource = new EventSource('/api/events');
    ms.evtSource.onmessage = e => {
      try { handleSSE(JSON.parse(e.data)); } catch (_) {}
    };
    ms.evtSource.onerror = () => {
      setTimeout(connectSSE, 3000);
    };
  }

  async function init() {
    try {
      const res = await fetch('/api/multistream/state');
      const data = await res.json();
      Object.assign(ms.state, data);
    } catch (_) {}
    renderAll(ms.state);
    ms.prevSlots = [...ms.state.visibleSlots];
    ms.prevFocusedId = ms.state.focusedId;
    refreshMetaAndBanner();
    syncLmuTiming();
    connectSSE();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MultistreamApp = ms;
})();
