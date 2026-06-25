// OAuth helpers for Twitch (chat:read chat:edit) and Google/YouTube
// (youtube.force-ssl). Pure functions over global fetch (Node 18+); the caller
// persists the returned token records via store.js.

const TWITCH_AUTH = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN = 'https://id.twitch.tv/oauth2/token';
const TWITCH_VALIDATE = 'https://id.twitch.tv/oauth2/validate';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

async function form(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── Twitch ────────────────────────────────────────────────────────────────────
function twitchAuthUrl({ clientId, redirectUri, scope, state }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    force_verify: 'true', // always show consent so the operator can pick the bot account
  });
  return `${TWITCH_AUTH}?${p}`;
}

function twitchExchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return form(TWITCH_TOKEN, {
    client_id: clientId, client_secret: clientSecret,
    code, grant_type: 'authorization_code', redirect_uri: redirectUri,
  });
}

function twitchRefresh({ clientId, clientSecret, refreshToken }) {
  return form(TWITCH_TOKEN, {
    client_id: clientId, client_secret: clientSecret,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  });
}

async function twitchValidate(accessToken) {
  const res = await fetch(TWITCH_VALIDATE, { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!res.ok) return null;
  return res.json(); // { login, user_id, scopes, expires_in }
}

// ── Google / YouTube ────────────────────────────────────────────────────────
function googleAuthUrl({ clientId, redirectUri, scope, state }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    access_type: 'offline',       // required to receive a refresh_token
    prompt: 'consent',            // force consent so refresh_token is re-issued
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH}?${p}`;
}

function googleExchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return form(GOOGLE_TOKEN, {
    client_id: clientId, client_secret: clientSecret,
    code, grant_type: 'authorization_code', redirect_uri: redirectUri,
  });
}

function googleRefresh({ clientId, clientSecret, refreshToken }) {
  return form(GOOGLE_TOKEN, {
    client_id: clientId, client_secret: clientSecret,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  });
}

module.exports = {
  twitchAuthUrl, twitchExchangeCode, twitchRefresh, twitchValidate,
  googleAuthUrl, googleExchangeCode, googleRefresh,
};
