// Bot manager — the single object server.js requires. Owns lifecycle, wires the
// engine to the two adapters, backs $uptime/$game with Twitch Helix, persists
// config/tokens via store.js, and exposes the admin surface (applyCommand) and
// the OAuth callbacks. Log lines are pushed over the app's existing broadcast().

const crypto = require('crypto');
const store = require('./store');
const oauth = require('./oauth');
const { createEngine } = require('./engine');
const { createTwitchAdapter } = require('./twitchAdapter');
const { createYoutubeAdapter } = require('./youtubeAdapter');

function createBot(opts) {
  const {
    broadcast,
    twitchClientId, twitchClientSecret,
    googleClientId, googleClientSecret,
    publicBaseUrl,
    getTwitchAppToken,   // async () => app access token (Helix, for $uptime/$game)
    dryRun,
  } = opts;

  const logBuffer = [];
  function log(line) {
    const entry = { ts: Date.now(), kind: line.kind || 'info', text: line.text || '' };
    logBuffer.push(entry);
    if (logBuffer.length > 50) logBuffer.shift();
    try { broadcast({ type: 'botLog', line: entry }); } catch (_) {}
  }

  let running = false;

  let saveTimer = null;
  function saveConfigDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { store.saveConfig(store.getConfig()).catch(() => {}); }, 1500);
  }

  // $uptime / $game — Twitch Helix stream lookup, cached ~30s.
  let streamInfoCache = { ts: 0, data: { live: false } };
  async function getStreamInfo() {
    const channel = store.getConfig().settings.twitchChannel;
    if (!channel) return { live: false };
    if (Date.now() - streamInfoCache.ts < 30000) return streamInfoCache.data;
    try {
      const token = await getTwitchAppToken();
      if (!token) return { live: false };
      const headers = { 'Client-ID': twitchClientId, Authorization: `Bearer ${token}` };
      const r = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, { headers });
      const j = r.ok ? await r.json() : { data: [] };
      const s = j.data && j.data[0];
      const data = s ? { live: true, startedAt: s.started_at, game: s.game_name } : { live: false };
      streamInfoCache = { ts: Date.now(), data };
      return data;
    } catch (_) {
      return { live: false };
    }
  }

  const engine = createEngine({ getConfig: store.getConfig, log, getStreamInfo, saveConfigDebounced });

  async function refreshTwitch() {
    const tokens = store.getTokens();
    if (!tokens.twitch || !tokens.twitch.refresh) throw new Error('no twitch refresh token');
    const r = await oauth.twitchRefresh({ clientId: twitchClientId, clientSecret: twitchClientSecret, refreshToken: tokens.twitch.refresh });
    tokens.twitch = {
      ...tokens.twitch,
      access: r.access_token,
      refresh: r.refresh_token || tokens.twitch.refresh,
      expiresAt: Date.now() + (r.expires_in || 3600) * 1000,
    };
    await store.saveTokens(tokens);
    return tokens.twitch;
  }

  async function refreshGoogle() {
    const tokens = store.getTokens();
    if (!tokens.google || !tokens.google.refresh) throw new Error('no google refresh token');
    const r = await oauth.googleRefresh({ clientId: googleClientId, clientSecret: googleClientSecret, refreshToken: tokens.google.refresh });
    tokens.google = { ...tokens.google, access: r.access_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 };
    await store.saveTokens(tokens);
    return tokens.google;
  }

  const twitch = createTwitchAdapter({
    getTokens: store.getTokens, refreshTwitch,
    onMessage: m => engine.handleMessage(m),
    onEvent: e => engine.handleEvent(e),
    log, dryRun: () => !!dryRun,
  });
  const youtube = createYoutubeAdapter({
    getTokens: store.getTokens, refreshGoogle,
    onMessage: m => engine.handleMessage(m),
    onEvent: e => engine.handleEvent(e),
    log, dryRun: () => !!dryRun,
    getSettings: () => store.getConfig().settings,
  });

  // Route engine output to enabled platforms (null = broadcast to all enabled).
  engine.setSay(async (platform, text) => {
    const s = store.getConfig().settings;
    if ((platform === 'twitch' || platform == null) && s.twitchEnabled) await twitch.say(text);
    if ((platform === 'youtube' || platform == null) && s.youtubeEnabled) await youtube.say(text);
  });

  async function init() {
    await store.loadConfig();
    await store.loadTokens();
    log({ kind: 'info', text: 'Bot initialised' });
  }

  async function start() {
    const s = store.getConfig().settings;
    running = true;
    if (s.twitchEnabled) await twitch.connect(s.twitchChannel);
    if (s.youtubeEnabled) youtube.start(); else youtube.stop();
    engine.startTimers();
    log({ kind: 'info', text: 'Bot started' });
    broadcastState();
    return true;
  }

  async function stop() {
    running = false;
    engine.stopTimers();
    await twitch.disconnect();
    youtube.stop();
    log({ kind: 'info', text: 'Bot stopped' });
    broadcastState();
    return true;
  }

  function getPublicState() {
    const cfg = store.getConfig();
    return {
      running,
      dryRun: !!dryRun,
      configured: isConfigured(),
      twitch: twitch.status(),
      youtube: youtube.status(),
      settings: cfg.settings,
      commands: cfg.commands,
      timers: cfg.timers,
      events: cfg.events,
      log: logBuffer.slice(-50),
    };
  }
  function broadcastState() {
    try { broadcast({ type: 'botState', bot: getPublicState() }); } catch (_) {}
  }

  function isConfigured() {
    return {
      twitchOAuth: !!(twitchClientId && twitchClientSecret),
      googleOAuth: !!(googleClientId && googleClientSecret),
      publicBaseUrl: !!publicBaseUrl,
    };
  }

  // ── helpers for applyCommand ────────────────────────────────────────────────
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function normalizeTrigger(t) {
    let s = String(t || '').trim();
    if (!s.startsWith('!')) s = `!${s}`;
    return s.split(/\s+/)[0];
  }
  function sanitizeSettings(a) {
    const out = {};
    if (a.twitchChannel != null) out.twitchChannel = String(a.twitchChannel).toLowerCase().replace(/^#/, '').trim();
    if (a.youtubeMode === 'auto' || a.youtubeMode === 'video') out.youtubeMode = a.youtubeMode;
    if (a.youtubeVideoId != null) out.youtubeVideoId = String(a.youtubeVideoId).trim();
    if (a.discordInvite != null) out.discordInvite = String(a.discordInvite).trim();
    if (a.defaultCooldownSec != null) out.defaultCooldownSec = num(a.defaultCooldownSec, 5);
    if (a.defaultUserCooldownSec != null) out.defaultUserCooldownSec = num(a.defaultUserCooldownSec, 15);
    if (a.twitchEnabled != null) out.twitchEnabled = !!a.twitchEnabled;
    if (a.youtubeEnabled != null) out.youtubeEnabled = !!a.youtubeEnabled;
    return out;
  }

  // ── admin command surface (POST /api/bot/command) ───────────────────────────
  async function applyCommand(cmd, args = {}) {
    const cfg = store.getConfig();
    switch (cmd) {
      case 'addCommand':
        cfg.commands.push({
          id: store.uid('c'), trigger: normalizeTrigger(args.trigger), response: args.response || '',
          cooldownSec: num(args.cooldownSec, cfg.settings.defaultCooldownSec),
          userCooldownSec: num(args.userCooldownSec, cfg.settings.defaultUserCooldownSec),
          modOnly: !!args.modOnly, enabled: args.enabled !== false, count: 0,
        });
        break;
      case 'editCommand': {
        const c = cfg.commands.find(x => x.id === args.id);
        if (c) Object.assign(c, {
          trigger: args.trigger != null ? normalizeTrigger(args.trigger) : c.trigger,
          response: args.response != null ? args.response : c.response,
          cooldownSec: args.cooldownSec != null ? num(args.cooldownSec, c.cooldownSec) : c.cooldownSec,
          userCooldownSec: args.userCooldownSec != null ? num(args.userCooldownSec, c.userCooldownSec) : c.userCooldownSec,
          modOnly: args.modOnly != null ? !!args.modOnly : c.modOnly,
          enabled: args.enabled != null ? !!args.enabled : c.enabled,
        });
        break;
      }
      case 'removeCommand':
        cfg.commands = cfg.commands.filter(x => x.id !== args.id);
        break;
      case 'addTimer':
        cfg.timers.push({
          id: store.uid('t'), name: args.name || 'Timer', message: args.message || '',
          intervalSec: num(args.intervalSec, 600), minChatLines: num(args.minChatLines, 0),
          enabled: args.enabled !== false,
        });
        break;
      case 'editTimer': {
        const t = cfg.timers.find(x => x.id === args.id);
        if (t) Object.assign(t, {
          name: args.name != null ? args.name : t.name,
          message: args.message != null ? args.message : t.message,
          intervalSec: args.intervalSec != null ? num(args.intervalSec, t.intervalSec) : t.intervalSec,
          minChatLines: args.minChatLines != null ? num(args.minChatLines, t.minChatLines) : t.minChatLines,
          enabled: args.enabled != null ? !!args.enabled : t.enabled,
        });
        break;
      }
      case 'removeTimer':
        cfg.timers = cfg.timers.filter(x => x.id !== args.id);
        break;
      case 'setEvent':
        if (cfg.events[args.key]) cfg.events[args.key] = {
          enabled: args.enabled != null ? !!args.enabled : cfg.events[args.key].enabled,
          template: args.template != null ? args.template : cfg.events[args.key].template,
        };
        break;
      case 'setSettings':
        Object.assign(cfg.settings, sanitizeSettings(args));
        break;
      case 'start':
        await store.saveConfig(cfg);
        await stop();
        await start();
        return getPublicState();
      case 'stop':
        await stop();
        return getPublicState();
      case 'testSay':
        await sayDirect(args.platform || null, args.text || '');
        return getPublicState();
      default:
        break;
    }
    await store.saveConfig(cfg);
    if (running) engine.startTimers(); // hot-apply timer changes
    broadcastState();
    return getPublicState();
  }

  async function sayDirect(platform, text) {
    const s = store.getConfig().settings;
    if ((platform === 'twitch' || platform == null) && s.twitchEnabled) await twitch.say(text);
    if ((platform === 'youtube' || platform == null) && s.youtubeEnabled) await youtube.say(text);
  }

  // ── OAuth ───────────────────────────────────────────────────────────────────
  const oauthStates = new Map(); // state -> expiry
  function newState() {
    const s = crypto.randomBytes(16).toString('hex');
    oauthStates.set(s, Date.now() + 600000);
    return s;
  }
  function checkState(s) {
    const exp = oauthStates.get(s);
    oauthStates.delete(s);
    return !!exp && Date.now() < exp;
  }

  function twitchLoginUrl() {
    return oauth.twitchAuthUrl({
      clientId: twitchClientId, redirectUri: `${publicBaseUrl}/auth/twitch/callback`,
      scope: 'chat:read chat:edit', state: newState(),
    });
  }
  async function twitchCallback(code, state) {
    if (!checkState(state)) throw new Error('invalid OAuth state');
    const r = await oauth.twitchExchangeCode({ clientId: twitchClientId, clientSecret: twitchClientSecret, code, redirectUri: `${publicBaseUrl}/auth/twitch/callback` });
    const v = await oauth.twitchValidate(r.access_token);
    const tokens = store.getTokens();
    tokens.twitch = {
      access: r.access_token, refresh: r.refresh_token,
      expiresAt: Date.now() + (r.expires_in || 3600) * 1000,
      login: v ? v.login : null, userId: v ? v.user_id : null, scopes: v ? v.scopes : [],
    };
    await store.saveTokens(tokens);
    log({ kind: 'info', text: `Twitch connected as ${tokens.twitch.login}` });
    broadcastState();
  }

  function googleLoginUrl() {
    return oauth.googleAuthUrl({
      clientId: googleClientId, redirectUri: `${publicBaseUrl}/auth/google/callback`,
      scope: 'https://www.googleapis.com/auth/youtube.force-ssl', state: newState(),
    });
  }
  async function googleCallback(code, state) {
    if (!checkState(state)) throw new Error('invalid OAuth state');
    const r = await oauth.googleExchangeCode({ clientId: googleClientId, clientSecret: googleClientSecret, code, redirectUri: `${publicBaseUrl}/auth/google/callback` });
    const tokens = store.getTokens();
    tokens.google = { access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 };
    // fetch the bot's own channel id/title (used to skip its own messages + display)
    try {
      const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${r.access_token}` } });
      if (cr.ok) {
        const cj = await cr.json();
        const it = cj.items && cj.items[0];
        if (it) { tokens.google.channelId = it.id; tokens.google.channelTitle = it.snippet && it.snippet.title; }
      }
    } catch (_) {}
    await store.saveTokens(tokens);
    log({ kind: 'info', text: `YouTube connected${tokens.google.channelTitle ? ` as ${tokens.google.channelTitle}` : ''}` });
    broadcastState();
  }

  function autoStartIfReady() {
    const s = store.getConfig().settings;
    const t = store.getTokens().twitch;
    if (s.twitchEnabled && t && t.access && s.twitchChannel) {
      log({ kind: 'info', text: 'Auto-starting bot (token present)' });
      start().catch(() => {});
    }
  }

  return {
    init, start, stop, getPublicState, applyCommand, autoStartIfReady,
    twitchLoginUrl, twitchCallback, googleLoginUrl, googleCallback,
    isConfigured,
  };
}

module.exports = createBot;
