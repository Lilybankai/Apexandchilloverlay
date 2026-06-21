// Shared $variable substitution for commands, timers, and event templates.
// $uptime / $game require live stream info, fetched via the injected
// helpers.getStreamInfo() (the bot manager backs this with Twitch Helix, cached).

function fmtUptime(startedAtIso) {
  if (!startedAtIso) return 'offline';
  const ms = Date.now() - new Date(startedAtIso).getTime();
  if (!(ms > 0)) return 'just now';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function substitute(template, ctx = {}, helpers = {}) {
  if (!template) return '';
  const needsStream = /\$uptime|\$game/.test(template);
  let streamInfo = null;
  if (needsStream && typeof helpers.getStreamInfo === 'function') {
    try { streamInfo = await helpers.getStreamInfo(); } catch (_) { streamInfo = null; }
  }

  const map = {
    user: ctx.user || 'friend',
    touser: ctx.touser || ctx.user || 'friend',
    channel: ctx.channel || '',
    count: ctx.count != null ? String(ctx.count) : '0',
    months: ctx.months != null ? String(ctx.months) : '',
    viewers: ctx.viewers != null ? String(ctx.viewers) : '',
    amount: ctx.amount != null ? String(ctx.amount) : '',
    discord: ctx.discord || '',
    uptime: streamInfo && streamInfo.live ? fmtUptime(streamInfo.startedAt) : 'offline',
    game: streamInfo && streamInfo.live && streamInfo.game ? streamInfo.game : 'unknown',
  };

  return template.replace(/\$(\w+)/g, (m, key) => (key in map ? map[key] : m));
}

module.exports = { substitute, fmtUptime };
