// YouTube adapter — raw fetch against the Data API v3 (no googleapis dep, keeping
// the runtime footprint to just tmi.js). Discovers the active live chat, polls it
// honoring pollingIntervalMillis, treats member joins as the "new sub" equivalent,
// and sends via liveChatMessages.insert. Only runs while enabled AND live.

const YT = 'https://www.googleapis.com/youtube/v3';

function createYoutubeAdapter({ getTokens, refreshGoogle, onMessage, onEvent, log, dryRun, getSettings }) {
  let liveChatId = null;
  let nextPageToken = null;
  let pollTimer = null;
  let polling = false;
  let started = false;
  let firstPoll = true;
  let selfChannelId = null;

  function status() {
    const g = getTokens().google;
    return {
      available: true,
      connected: !!(g && g.access),
      channelTitle: g ? g.channelTitle || null : null,
      liveChatId: liveChatId ? 'live' : null,
      polling,
    };
  }

  async function authHeader() {
    let g = getTokens().google;
    if (!g || !g.access) throw new Error('YouTube not connected');
    if (g.expiresAt && Date.now() > g.expiresAt - 60000) g = await refreshGoogle();
    return { Authorization: `Bearer ${g.access}` };
  }

  async function apiGet(pathQuery) {
    let res = await fetch(`${YT}/${pathQuery}`, { headers: await authHeader() });
    if (res.status === 401) {
      try { await refreshGoogle(); } catch (_) {}
      res = await fetch(`${YT}/${pathQuery}`, { headers: await authHeader() });
    }
    return res;
  }

  async function discoverLiveChatId() {
    const settings = getSettings();
    const g = getTokens().google;
    selfChannelId = g && g.channelId;
    if (settings.youtubeMode === 'video' && settings.youtubeVideoId) {
      const res = await apiGet(`videos?part=liveStreamingDetails&id=${encodeURIComponent(settings.youtubeVideoId)}`);
      if (!res.ok) return null;
      const data = await res.json();
      const item = data.items && data.items[0];
      return (item && item.liveStreamingDetails && item.liveStreamingDetails.activeLiveChatId) || null;
    }
    const res = await apiGet('liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&mine=true');
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items && data.items[0];
    return (item && item.snippet && item.snippet.liveChatId) || null;
  }

  function schedule(ms) {
    if (!started) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(loop, ms);
  }

  async function loop() {
    if (!started) return;
    try {
      if (!liveChatId) {
        liveChatId = await discoverLiveChatId();
        if (!liveChatId) { polling = false; schedule(60000); return; } // not live yet — probe slowly
        firstPoll = true;
        log({ kind: 'info', text: 'YouTube live chat connected' });
      }
      polling = true;
      const res = await apiGet(
        `liveChatMessages?liveChatId=${encodeURIComponent(liveChatId)}&part=snippet,authorDetails&maxResults=200`
        + (nextPageToken ? `&pageToken=${nextPageToken}` : '')
      );
      if (res.status === 403 || res.status === 404) {
        log({ kind: 'error', text: `YouTube poll ${res.status} — chat ended or quota; re-discovering` });
        liveChatId = null; nextPageToken = null; polling = false; schedule(60000); return;
      }
      const data = await res.json();
      nextPageToken = data.nextPageToken;
      const interval = Math.max(2000, data.pollingIntervalMillis || 5000);
      if (!firstPoll) (data.items || []).forEach(processItem); // skip backlog on (re)connect
      firstPoll = false;
      schedule(interval);
    } catch (e) {
      log({ kind: 'error', text: `YouTube poll error: ${e && e.message}` });
      schedule(15000);
    }
  }

  function processItem(it) {
    const sn = it.snippet || {};
    const ad = it.authorDetails || {};
    if (ad.channelId && selfChannelId && ad.channelId === selfChannelId) return; // skip our own messages
    if (sn.type === 'textMessageEvent') {
      onMessage({
        platform: 'youtube',
        user: ad.displayName,
        userId: ad.channelId,
        text: (sn.textMessageDetails && sn.textMessageDetails.messageText) || sn.displayMessage || '',
        isMod: !!ad.isChatModerator,
        isBroadcaster: !!ad.isChatOwner,
        isSub: !!ad.isChatSponsor,
      });
    } else if (sn.type === 'newSponsorEvent') {
      onEvent({ platform: 'youtube', type: 'youtubeNewMember', user: ad.displayName });
    } else if (sn.type === 'memberMilestoneChatEvent') {
      const d = sn.memberMilestoneChatDetails || {};
      onEvent({ platform: 'youtube', type: 'youtubeMemberMilestone', user: ad.displayName, months: d.memberMonth });
    }
  }

  function start() {
    if (started) return;
    started = true;
    firstPoll = true;
    loop();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    polling = false;
    liveChatId = null;
    nextPageToken = null;
  }

  async function say(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    if (dryRun()) { log({ kind: 'sent', text: `[dry·youtube] ${clean}` }); return; }
    if (!liveChatId) { log({ kind: 'error', text: 'YouTube send skipped (no live chat)' }); return; }
    try {
      const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
      const res = await fetch(`${YT}/liveChatMessages?part=snippet`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: clean } },
        }),
      });
      if (!res.ok) { log({ kind: 'error', text: `YouTube send ${res.status}` }); return; }
      log({ kind: 'sent', text: `[youtube] ${clean}` });
    } catch (e) {
      log({ kind: 'error', text: `YouTube send failed: ${e && e.message}` });
    }
  }

  return { start, stop, say, status };
}

module.exports = { createYoutubeAdapter };
