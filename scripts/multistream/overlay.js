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

  function buildEmbedUrl(stream, isFocused) {
    const twitchParent = ms.state.twitchParent || location.hostname || 'localhost';
    if (stream.type === 'youtube') {
      return `https://www.youtube.com/embed/${stream.embedId}`
           + `?autoplay=1&mute=${isFocused ? 0 : 1}&enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
    }
    if (stream.type === 'twitch') {
      return `https://player.twitch.tv/?channel=${stream.embedId}`
           + `&parent=${twitchParent}&autoplay=true&muted=${!isFocused}`;
    }
    return '';
  }

  function getStreamById(id) {
    return ms.state.streams.find(s => s.id === id) ?? null;
  }

  function buildCell(slotIdx, streamId) {
    const cell = document.getElementById(`cell-${slotIdx}`);
    if (!cell) return;

    const stream = streamId ? getStreamById(streamId) : null;
    const isFocused = streamId !== null && streamId === ms.state.focusedId;

    cell.classList.toggle('focused', isFocused);
    cell.classList.toggle('empty', !stream);

    // Update label
    const label = cell.querySelector('.stream-label');
    if (label) label.textContent = stream ? stream.label : '';

    // Update audio badge
    const badge = cell.querySelector('.audio-badge');
    if (badge) badge.style.display = isFocused ? 'flex' : 'none';

    // Rebuild iframe only if stream changed
    const existing = cell.querySelector('iframe');
    const newSrc = stream ? buildEmbedUrl(stream, isFocused) : '';

    if (!stream) {
      if (existing) existing.remove();
      return;
    }

    if (!existing) {
      const iframe = document.createElement('iframe');
      iframe.allow = 'autoplay; fullscreen';
      iframe.allowFullscreen = true;
      iframe.src = newSrc;
      iframe.style.opacity = '0';
      iframe.addEventListener('load', () => { iframe.style.opacity = '1'; }, { once: true });
      cell.appendChild(iframe);
    } else {
      // Only rebuild if src meaningfully changed (muted/unmuted change or different stream)
      if (existing.src !== newSrc) {
        existing.style.opacity = '0';
        existing.src = newSrc;
        existing.addEventListener('load', () => { existing.style.opacity = '1'; }, { once: true });
      }
    }
  }

  function renderAll(state) {
    updateLayout(state.layout);
    for (let i = 0; i < 4; i++) {
      buildCell(i, state.visibleSlots[i] ?? null);
    }
  }

  function applyDiff(newState, oldLayout) {
    if (newState.layout !== oldLayout) updateLayout(newState.layout);

    // Apply slot + focus changes slot by slot
    for (let i = 0; i < 4; i++) {
      const oldId = ms.prevSlots[i];
      const newId = newState.visibleSlots[i] ?? null;
      const wasFocused = oldId === ms.prevFocusedId;
      const isFocused = newId === newState.focusedId;

      // Rebuild if stream changed or focus changed
      if (newId !== oldId || wasFocused !== isFocused) {
        // Temporarily update state so buildCell reads correct values
        ms.state.visibleSlots[i] = newId;
        ms.state.focusedId = newState.focusedId;
        ms.state.twitchParent = newState.twitchParent;
        buildCell(i, newId);
      }
    }

    // Update focus badge on slots that didn't change stream but changed focus role
    for (let i = 0; i < 4; i++) {
      const cell = document.getElementById(`cell-${i}`);
      if (!cell) continue;
      const id = newState.visibleSlots[i] ?? null;
      const isFocused = id !== null && id === newState.focusedId;
      cell.classList.toggle('focused', isFocused);
      const badge = cell.querySelector('.audio-badge');
      if (badge) badge.style.display = isFocused ? 'flex' : 'none';
    }
  }

  function updateLayout(layout) {
    const overlay = document.getElementById('multistream-overlay');
    if (!overlay) return;
    overlay.dataset.layout = layout;
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
