// Platform-agnostic bot engine: command dispatch + cooldowns, the timer
// scheduler, and event-template rendering. Adapters feed normalized messages
// and events in; the engine renders text and calls the injected say(platform, text).

const { substitute } = require('./variables');

function createEngine({ getConfig, log, getStreamInfo, saveConfigDebounced }) {
  const lastFired = new Map();         // commandId -> ts (global cooldown)
  const lastFiredByUser = new Map();   // commandId -> Map(userKey -> ts)
  let chatLines = 0;                   // running count, used by timer guards
  const timerHandles = [];
  let sayFn = async () => {};          // (platform|null, text) — null = all enabled platforms

  function setSay(fn) { sayFn = fn; }
  function noteChatLine() { chatLines += 1; }

  function privileged(msg) { return !!(msg.isMod || msg.isBroadcaster); }

  async function handleMessage(msg) {
    noteChatLine();
    const text = (msg.text || '').trim();
    if (!text.startsWith('!')) return;

    const trigger = text.split(/\s+/)[0].toLowerCase();
    const cfg = getConfig();
    const cmd = (cfg.commands || []).find(c => c.enabled && String(c.trigger).toLowerCase() === trigger);
    if (!cmd) return;
    if (cmd.modOnly && !privileged(msg)) return;

    const now = Date.now();
    const priv = privileged(msg);

    const gcd = (cmd.cooldownSec != null ? cmd.cooldownSec : cfg.settings.defaultCooldownSec) * 1000;
    if (!priv && now - (lastFired.get(cmd.id) || 0) < gcd) return;

    const ucd = (cmd.userCooldownSec != null ? cmd.userCooldownSec : cfg.settings.defaultUserCooldownSec) * 1000;
    const userKey = `${msg.platform}:${msg.userId || msg.user}`;
    let userMap = lastFiredByUser.get(cmd.id);
    if (!userMap) { userMap = new Map(); lastFiredByUser.set(cmd.id, userMap); }
    if (!priv && now - (userMap.get(userKey) || 0) < ucd) return;

    lastFired.set(cmd.id, now);
    userMap.set(userKey, now);
    cmd.count = (cmd.count || 0) + 1;
    if (saveConfigDebounced) saveConfigDebounced();

    const args = text.split(/\s+/).slice(1);
    const out = await substitute(cmd.response, {
      user: msg.user,
      touser: args[0],
      channel: cfg.settings.twitchChannel,
      count: cmd.count,
      discord: cfg.settings.discordInvite,
    }, { getStreamInfo });

    await sayFn(msg.platform, out);
    log({ kind: 'command', text: `${msg.user} → ${cmd.trigger}` });
  }

  async function handleEvent(ev) {
    const cfg = getConfig();
    const tmpl = cfg.events && cfg.events[ev.type];
    if (!tmpl || !tmpl.enabled || !tmpl.template) return;
    const out = await substitute(tmpl.template, {
      user: ev.user,
      channel: cfg.settings.twitchChannel,
      months: ev.months,
      viewers: ev.viewers,
      amount: ev.amount,
      discord: cfg.settings.discordInvite,
    }, { getStreamInfo });
    await sayFn(ev.platform, out);
    log({ kind: 'event', text: `${ev.type}${ev.user ? `: ${ev.user}` : ''}` });
  }

  function startTimers() {
    stopTimers();
    const cfg = getConfig();
    (cfg.timers || []).filter(t => t.enabled).forEach(timer => {
      let linesAtLastPost = chatLines;
      const handle = setInterval(async () => {
        if (chatLines - linesAtLastPost < (timer.minChatLines || 0)) return;
        linesAtLastPost = chatLines;
        const out = await substitute(timer.message, {
          channel: cfg.settings.twitchChannel,
          discord: cfg.settings.discordInvite,
        }, { getStreamInfo });
        await sayFn(null, out);
        log({ kind: 'info', text: `timer "${timer.name}" posted` });
      }, Math.max(5, Number(timer.intervalSec) || 600) * 1000);
      timerHandles.push(handle);
    });
  }

  function stopTimers() {
    while (timerHandles.length) clearInterval(timerHandles.pop());
  }

  return { setSay, noteChatLine, handleMessage, handleEvent, startTimers, stopTimers };
}

module.exports = { createEngine };
