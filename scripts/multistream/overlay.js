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

  const twitchPlayers = {}; // slotIdx → { iframe, slotIdx }
  const ytPlayers = {};     // slotIdx → YT.Player

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

  // ── Twitch embed (direct iframe — bypasses SDK visibility checks) ────────
  // The Twitch Embed SDK performs aggressive "style visibility" checks that
  // fail in OBS's offscreen CEF renderer. These checks run inside the
  // cross-origin player.twitch.tv iframe, so we cannot patch them.
  //
  // Solution: bypass the SDK entirely and use a direct <iframe> to
  // player.twitch.tv. This avoids the SDK's JavaScript visibility checks.
  // Autoplay with muted=true is honoured by CEF/Chrome browser policy.
  //
  // After the iframe loads, we simulate a user click on the iframe to
  // satisfy any remaining browser-level autoplay-gate that requires a
  // "user gesture" (OBS CEF sometimes enforces this).
  function buildTwitchEmbed(cell, slotIdx, stream, isFocused) {
    const leaving = Array.from(cell.querySelectorAll(LIVE_MEDIA));
    cell.querySelectorAll('[data-leaving]').forEach(el => el.remove());

    const twitchParent = ms.state.twitchParent || location.hostname || 'localhost';

    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; fullscreen';
    iframe.allowFullscreen = true;
    iframe.src = `https://player.twitch.tv/?channel=${encodeURIComponent(stream.embedId)}`
      + `&parent=${encodeURIComponent(twitchParent)}`
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

    twitchPlayers[slotIdx] = { iframe, slotIdx };
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
      if (entry && entry.iframe) {
        // Direct iframe — update muted parameter in the URL.
        // This reloads the player but is the only reliable way
        // without the SDK JS API.
        try {
          const url = new URL(entry.iframe.src);
          url.searchParams.set('muted', isFocused ? 'false' : 'true');
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
  }

  function handleSSE(msg) {
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
    connectSSE();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MultistreamApp = ms;
})();
