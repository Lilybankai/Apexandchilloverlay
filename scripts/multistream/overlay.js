(() => {
  const ms = {
    state: {
      streams: [],
      visibleSlots: [null, null, null, null],
      rotationOffset: 0,
      focusedId: null,
      layout: 'grid',
      rotationEnabled: false,
      rotationIntervalSec: 30,
      twitchParent: 'localhost',
    },
    prevSlots: [null, null, null, null],
    prevFocusedId: null,
    evtSource: null,
  };

  const twitchPlayers = {}; // slotIdx → Twitch.Embed
  const ytPlayers = {};     // slotIdx → YT.Player

  // ── YouTube IFrame API readiness ──────────────────────────────────────────
  // The YT script fires window.onYouTubeIframeAPIReady when loaded.
  // We chain onto it (don't replace it outright) and queue any player
  // creation requests that arrive before the API is ready.
  let ytReady = false;
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

  // ─────────────────────────────────────────────────────────────────────────

  function getStreamById(id) {
    return ms.state.streams.find(s => s.id === id) ?? null;
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

    // Drop Twitch reference — buildTwitchEmbed will set a new one
    if (twitchPlayers[slotIdx]) delete twitchPlayers[slotIdx];

    // Drop YT reference — schedule destroy so the player is still visible
    // during the crossfade (destroy() would remove its iframe immediately)
    if (ytPlayers[slotIdx]) {
      const old = ytPlayers[slotIdx];
      delete ytPlayers[slotIdx];
      setTimeout(() => { try { old.destroy(); } catch (_) {} }, 500);
    }

    if (!stream) {
      cell.querySelectorAll(LIVE_MEDIA).forEach(el => fadeOut(el));
      return;
    }

    if (stream.type === 'twitch') {
      buildTwitchEmbed(cell, slotIdx, stream, isFocused);
    } else {
      buildYouTubePlayer(cell, slotIdx, stream, isFocused);
    }
  }

  // ── Twitch embed ──────────────────────────────────────────────────────────
  function buildTwitchEmbed(cell, slotIdx, stream, isFocused) {
    if (!window.Twitch || !window.Twitch.Embed) {
      setTimeout(() => buildCell(slotIdx, stream.id), 500);
      return;
    }

    const leaving = Array.from(cell.querySelectorAll(LIVE_MEDIA));
    cell.querySelectorAll('[data-leaving]').forEach(el => el.remove());

    // Unique ID so old containers can coexist during crossfade
    const containerId = `twitch-embed-${slotIdx}-${Date.now()}`;
    const container = document.createElement('div');
    container.id = containerId;
    container.className = 'twitch-embed-container';
    container.style.opacity = '0';
    cell.appendChild(container);

    const twitchParent = ms.state.twitchParent || location.hostname || 'localhost';

    // Defer to after layout pass — SDK checks element dimensions at construction
    requestAnimationFrame(() => {
      if (!document.getElementById(containerId)) return;

      const w = container.offsetWidth || cell.offsetWidth || 960;
      const h = container.offsetHeight || cell.offsetHeight || 479;

      const embed = new window.Twitch.Embed(containerId, {
        channel: stream.embedId,
        parent: [twitchParent],
        autoplay: true,
        muted: true,
        layout: 'video',
        width: w,
        height: h,
      });

      embed.addEventListener(window.Twitch.Embed.VIDEO_READY, () => {
        const player = embed.getPlayer();
        player.play();
        player.setMuted(!isFocused);

        container.style.transition = 'opacity 0.45s ease';
        container.style.opacity = '1';
        leaving.forEach(el => fadeOut(el));
      });

      twitchPlayers[slotIdx] = embed;
    });
  }

  // ── YouTube IFrame API player ─────────────────────────────────────────────
  function buildYouTubePlayer(cell, slotIdx, stream, isFocused) {
    const leaving = Array.from(cell.querySelectorAll(LIVE_MEDIA));
    cell.querySelectorAll('[data-leaving]').forEach(el => el.remove());

    const containerId = `yt-embed-${slotIdx}-${Date.now()}`;
    const container = document.createElement('div');
    container.id = containerId;
    container.className = 'yt-embed-container';
    container.style.opacity = '0';
    cell.appendChild(container);

    // Sequence guard — if this slot is rebuilt before the YT API is ready,
    // the stale callback removes the orphaned container and exits.
    cell.dataset.ytSeq = String((parseInt(cell.dataset.ytSeq || '0') + 1));
    const seq = cell.dataset.ytSeq;

    waitForYT(() => {
      if (cell.dataset.ytSeq !== seq || !document.getElementById(containerId)) {
        container.remove();
        return;
      }

      new window.YT.Player(containerId, {
        videoId: stream.embedId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          mute: 1,           // always start muted — unmuted via API in onReady
          controls: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          iv_load_policy: 3, // hide annotations
          disablekb: 1,      // no keyboard shortcuts captured by iframe
          fs: 0,             // no fullscreen button
          enablejsapi: 1,
          origin: location.hostname || 'localhost',
        },
        events: {
          onReady(e) {
            if (cell.dataset.ytSeq !== seq) {
              try { e.target.destroy(); } catch (_) {}
              container.remove();
              return;
            }
            e.target.playVideo();
            if (isFocused) {
              e.target.unMute();
              e.target.setVolume(100);
            }
            // Crossfade: fade new container in, fade old content out
            container.style.opacity = '1';
            leaving.forEach(el => fadeOut(el));

            ytPlayers[slotIdx] = e.target;
          },
          onError() {
            container.remove();
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
      const embed = twitchPlayers[slotIdx];
      if (embed) {
        try { embed.getPlayer().setMuted(!isFocused); } catch (_) {}
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
  }

  function handleSSE(msg) {
    if (msg.type === 'state' && msg.multistream) {
      Object.assign(ms.state, msg.multistream);
      renderAll(ms.state);
      ms.prevSlots = [...ms.state.visibleSlots];
      ms.prevFocusedId = ms.state.focusedId;
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
    connectSSE();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MultistreamApp = ms;
})();
