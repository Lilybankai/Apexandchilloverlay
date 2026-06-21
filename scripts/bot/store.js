// Persistence for the chat bot: atomic JSON read/write of config + tokens.
// Mirrors the project's data/*.json convention (server.js reads standings.json),
// but adds the project's first writes — done atomically (tmp file + rename) and
// serialized per-file so rapid panel edits can't interleave.

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'bot-config.json');
const TOKENS_PATH = path.join(DATA_DIR, 'bot-tokens.json');

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function defaultConfig() {
  return {
    version: 1,
    settings: {
      twitchChannel: '',
      youtubeMode: 'auto',          // 'auto' | 'video'
      youtubeVideoId: '',
      discordInvite: '',
      defaultCooldownSec: 5,
      defaultUserCooldownSec: 15,
      twitchEnabled: true,
      youtubeEnabled: false,        // off by default — YouTube polling costs API quota
    },
    commands: [
      {
        id: uid('c'),
        trigger: '!discord',
        response: 'Join the Apex & Chill Discord: $discord',
        cooldownSec: 10,
        userCooldownSec: 30,
        modOnly: false,
        enabled: true,
        count: 0,
      },
    ],
    timers: [],
    events: {
      twitchSub: { enabled: true, template: 'Thanks for subscribing, $user! 🏁' },
      twitchResub: { enabled: true, template: '$user resubscribed for $months months! 🔥' },
      twitchGiftSub: { enabled: true, template: '$user gifted a sub! 🎁' },
      twitchRaid: { enabled: true, template: 'Welcome raiders from $user — $viewers strong! 🏎️' },
      twitchCheer: { enabled: true, template: 'Thanks for the $amount bits, $user!' },
      youtubeNewMember: { enabled: true, template: 'Welcome to the channel, member $user! 🎉' },
      youtubeMemberMilestone: { enabled: true, template: '$user has been a member for $months months! 🙌' },
    },
  };
}

// ── atomic write, serialized per file ─────────────────────────────────────────
const writeQueues = {};
function enqueueWrite(file, fn) {
  const prev = writeQueues[file] || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues[file] = next.catch(() => {});
  return next;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJsonAtomic(file, obj) {
  return enqueueWrite(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fs.rename(tmp, file);
  });
}

// Merge loaded config over defaults so new keys appear for older files.
function mergeConfig(base, loaded) {
  return {
    version: loaded.version || base.version,
    settings: { ...base.settings, ...(loaded.settings || {}) },
    commands: Array.isArray(loaded.commands) ? loaded.commands : base.commands,
    timers: Array.isArray(loaded.timers) ? loaded.timers : base.timers,
    events: { ...base.events, ...(loaded.events || {}) },
  };
}

let configCache = null;
let tokensCache = null;

async function loadConfig() {
  const loaded = await readJson(CONFIG_PATH, null);
  configCache = loaded ? mergeConfig(defaultConfig(), loaded) : defaultConfig();
  if (!loaded) await writeJsonAtomic(CONFIG_PATH, configCache);
  return configCache;
}
function getConfig() { return configCache || defaultConfig(); }
async function saveConfig(cfg) {
  configCache = cfg;
  await writeJsonAtomic(CONFIG_PATH, cfg);
  return cfg;
}

async function loadTokens() {
  tokensCache = await readJson(TOKENS_PATH, {});
  return tokensCache;
}
function getTokens() { return tokensCache || {}; }
async function saveTokens(t) {
  tokensCache = t;
  await writeJsonAtomic(TOKENS_PATH, t);
  try { await fs.chmod(TOKENS_PATH, 0o600); } catch (_) {}
  return t;
}

module.exports = {
  CONFIG_PATH, TOKENS_PATH, uid, defaultConfig,
  loadConfig, getConfig, saveConfig,
  loadTokens, getTokens, saveTokens,
};
