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

  // Twitch.Embed instances keyed by slot index
  const twitchPlayers = {};

  function getStreamById(id) {
    return ms.state.streams.find(s => s.id === id) ?? null;
  }

  function updateLayout(layout) {
    const overlay = document.getElementById('multistream-overlay');
    if (overlay) overlay.dataset.layout = layout;
  }

  // ── Destroy any player (Twitch or YouTube iframe) in a slot ──────────────
  function destroySlot(slotIdx) {
    if (twitchPlayers[slotIdx]) {
      try { twitchPlayers[slotIdx] = null; } catch (_) {}
      delete twitchPlayers[slotIdx];
    }
    const cell = document.getElementById(`cell-${slotIdx}`);
    if (!cell) return;
    cell.querySelectorAll('iframe, .twitch-embed-container').forEach(el => el.remove());
  }

  // ── Build / rebuild a cell completely ────────────────────────────────────
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

    destroySlot(slotIdx);

    if (!stream) return;

    if (stream.type === 'twitch') {
      buildTwitchEmbed(cell, slotIdx, stream, isFocused);
    } else {
      buildYouTubeIframe(cell, stream, isFocused);
    }
  }

  function buildTwitchEmbed(cell, slotIdx, stream, isFocused) {
    if (!window.Twitch || !window.Twitch.Embed) {
      setTimeout(() => buildCell(slotIdx, stream.id), 500);
      return;
    }

    const containerId = `twitch-embed-${slotIdx}`;
    let container = document.getElementById(containerId);
    if (container) container.remove();

    container = document.createElement('div');
    container.id = containerId;
    container.className = 'twitch-embed-container';
    cell.appendChild(container);

    const twitchParent = ms.state.twitchParent || location.hostname || 'localhost';

    // Defer to after the browser's layout pass so the container has non-zero
    // offsetWidth/offsetHeight. The Twitch SDK checks element dimensions
    // synchronously at construction — a 0×0 container triggers its
    // "style visibility" autoplay block even in OBS browser sources.
    requestAnimationFrame(() => {
      // Guard: slot may have been recycled before RAF fired
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
      });

      twitchPlayers[slotIdx] = embed;
    });
  }

  function buildYouTubeIframe(cell, stream, isFocused) {
    const twitchParent = ms.state.twitchParent || location.hostname || 'localhost';
    const src = `https://www.youtube.com/embed/${stream.embedId}`
      + `?autoplay=1&mute=${isFocused ? 0 : 1}&enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;

    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; fullscreen';
    iframe.allowFullscreen = true;
    iframe.src = src;
    iframe.style.opacity = '0';
    iframe.addEventListener('load', () => { iframe.style.opacity = '1'; }, { once: true });
    cell.appendChild(iframe);
  }

  // ── Update focus only (no stream change) ─────────────────────────────────
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
        try {
          const player = embed.getPlayer();
          player.setMuted(!isFocused);
        } catch (_) {}
      }
    } else {
      // YouTube — rebuild iframe with updated mute param
      buildCell(slotIdx, streamId);
    }
  }

  // ── Full render (initial load or layout change) ───────────────────────────
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
