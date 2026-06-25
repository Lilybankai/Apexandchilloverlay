// Twitch adapter — wraps tmi.js for chat read/write plus sub/resub/gift/raid/
// cheer events (delivered over IRC USERNOTICE, so no EventSub needed).
// Normalizes messages/events for the engine and refreshes the user token on
// auth failure.

let tmi = null;
try { tmi = require('tmi.js'); } catch (_) { tmi = null; }

function createTwitchAdapter({ getTokens, refreshTwitch, onMessage, onEvent, log, dryRun }) {
  let client = null;
  let channel = null;
  let connected = false;
  let refreshing = false;

  function status() {
    const t = getTokens().twitch;
    return {
      available: !!tmi,
      connected,
      login: t ? t.login || null : null,
      joined: channel,
      hasToken: !!(t && t.access),
    };
  }

  async function disconnect() {
    if (client) { try { await client.disconnect(); } catch (_) {} client = null; }
    connected = false;
  }

  async function connect(channelName) {
    if (!tmi) { log({ kind: 'error', text: 'tmi.js is not installed (run npm install)' }); return false; }
    const tokens = getTokens().twitch;
    if (!tokens || !tokens.access) { log({ kind: 'error', text: 'Twitch not connected — authorize the bot first' }); return false; }
    channel = String(channelName || '').toLowerCase().replace(/^#/, '').trim();
    if (!channel) { log({ kind: 'error', text: 'No Twitch channel set' }); return false; }

    await disconnect();
    client = new tmi.Client({
      options: { skipUpdatingEmotesets: true },
      connection: { reconnect: true, secure: true },
      identity: { username: tokens.login, password: `oauth:${tokens.access}` },
      channels: [channel],
    });

    client.on('message', (chan, tags, message, self) => {
      if (self) return;
      const isBroadcaster = !!(tags.badges && tags.badges.broadcaster === '1');
      onMessage({
        platform: 'twitch',
        user: tags['display-name'] || tags.username,
        userId: tags['user-id'],
        text: message,
        isMod: !!tags.mod || isBroadcaster,
        isBroadcaster,
        isSub: !!tags.subscriber,
      });
    });

    client.on('subscription', (chan, username) => onEvent({ platform: 'twitch', type: 'twitchSub', user: username }));
    client.on('resub', (chan, username, months, message, tags) => onEvent({
      platform: 'twitch', type: 'twitchResub', user: username,
      months: (tags && Number(tags['msg-param-cumulative-months'])) || months || 0,
    }));
    client.on('subgift', (chan, username) => onEvent({ platform: 'twitch', type: 'twitchGiftSub', user: username }));
    client.on('raided', (chan, username, viewers) => onEvent({ platform: 'twitch', type: 'twitchRaid', user: username, viewers }));
    client.on('cheer', (chan, tags, message) => onEvent({
      platform: 'twitch', type: 'twitchCheer',
      user: tags['display-name'] || tags.username, amount: tags.bits,
    }));

    client.on('connected', () => { connected = true; log({ kind: 'info', text: `Twitch connected → #${channel}` }); });
    client.on('disconnected', reason => { connected = false; log({ kind: 'error', text: `Twitch disconnected: ${reason}` }); maybeRefresh(reason); });

    try {
      await client.connect();
      return true;
    } catch (e) {
      log({ kind: 'error', text: `Twitch connect failed: ${e && e.message ? e.message : e}` });
      maybeRefresh(String(e && e.message));
      return false;
    }
  }

  // tmi can't swap the oauth password live, so on auth failure we refresh + reconnect.
  async function maybeRefresh(reason) {
    if (refreshing || !/auth|login|token/i.test(String(reason || ''))) return;
    refreshing = true;
    try {
      await refreshTwitch();
      log({ kind: 'info', text: 'Twitch token refreshed — reconnecting' });
      await connect(channel);
    } catch (e) {
      log({ kind: 'error', text: `Twitch token refresh failed: ${e && e.message}` });
    } finally {
      refreshing = false;
    }
  }

  async function say(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 480);
    if (!clean) return;
    if (dryRun()) { log({ kind: 'sent', text: `[dry·twitch] ${clean}` }); return; }
    if (!client || !connected) { log({ kind: 'error', text: 'Twitch send skipped (not connected)' }); return; }
    try {
      await client.say(channel, clean);
      log({ kind: 'sent', text: `[twitch] ${clean}` });
    } catch (e) {
      log({ kind: 'error', text: `Twitch send failed: ${e && e.message}` });
    }
  }

  return { connect, disconnect, say, status };
}

module.exports = { createTwitchAdapter };
