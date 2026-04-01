'use strict';

/**
 * oauth-refresh.cjs
 *
 * Refreshes an expired OAuth access_token using the stored refresh_token.
 * Handles providers that issue short-lived access tokens (Google: 1 hr, Microsoft: 1 hr).
 * Providers with non-expiring tokens (GitHub, Slack) are passed through unchanged.
 *
 * Usage:
 *   const { refreshTokenIfNeeded } = require('./oauth-refresh.cjs');
 *   const token = await refreshTokenIfNeeded(keytar, 'google', 'my.skill.name');
 *   // Returns up-to-date token blob or null if no token stored
 */

const https = require('https');
const logger = require('./logger.cjs');

// Minutes before expiry to proactively refresh (avoids races on slow networks)
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Provider token endpoints that support refresh_token grant
const TOKEN_URLS = {
  google:     'https://oauth2.googleapis.com/token',
  microsoft:  'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  salesforce: 'https://login.salesforce.com/services/oauth2/token',
  atlassian:  'https://auth.atlassian.com/oauth/token',
  zoom:       'https://zoom.us/oauth/token',
  dropbox:    'https://api.dropboxapi.com/oauth2/token',
  spotify:    'https://accounts.spotify.com/api/token',
  hubspot:    'https://api.hubapi.com/oauth/v1/token',
};

/**
 * Post to a token URL and return parsed JSON response.
 * @param {string} tokenUrl
 * @param {string} body - URL-encoded form body
 * @param {string|null} basicAuth - base64 "client_id:client_secret" for providers using Basic auth
 */
function postTokenRequest(tokenUrl, body, basicAuth) {
  return new Promise((resolve, reject) => {
    const url = new URL(tokenUrl);
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    };
    if (basicAuth) headers['Authorization'] = `Basic ${basicAuth}`;

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('token refresh request timed out')); });
    req.write(body);
    req.end();
  });
}

/**
 * Attempt to refresh an OAuth token for a given provider + skill.
 *
 * Key lookup order (mirrors buildSkillContext):
 *   1. oauth:<provider>:<skillName>   (per-skill token)
 *   2. oauth:<provider>               (global Connections token)
 *
 * If the token has no expires_at or is still valid, returns the existing blob unchanged.
 * If refresh fails (bad token, network error), returns the existing blob so the skill
 * can still attempt the call and get a normal auth error rather than a null context.
 *
 * @param {object} keytar
 * @param {string} provider  e.g. 'google'
 * @param {string} skillName e.g. 'gmail.daily'
 * @returns {object|null} token blob or null if no token stored
 */
async function refreshTokenIfNeeded(keytar, provider, skillName) {
  // Providers that don't issue expiring tokens — skip refresh entirely
  const NON_EXPIRING = new Set(['github', 'slack', 'notion', 'discord', 'twitter', 'linkedin', 'facebook']);
  if (NON_EXPIRING.has(provider)) return null; // caller will load via keytar directly

  const tokenUrl = TOKEN_URLS[provider];
  if (!tokenUrl) return null; // unknown provider — no refresh support

  // Load blob from keytar (skill-specific → global fallback)
  let usedKey = null;
  let blob = null;
  for (const key of [`oauth:${provider}:${skillName}`, `oauth:${provider}`]) {
    try {
      const raw = await keytar.getPassword('thinkdrop', key);
      if (raw) {
        blob = JSON.parse(raw);
        usedKey = key;
        break;
      }
    } catch (_) {}
  }
  if (!blob) return null;

  // Check if a real token is present (not just seeded client credentials)
  if (!blob.access_token && !blob.refresh_token) return null;

  // Check if refresh is needed
  const expiresAt = blob.expires_at ? Number(blob.expires_at) : 0;
  const needsRefresh = expiresAt > 0 && (Date.now() >= expiresAt - REFRESH_BUFFER_MS);
  if (!needsRefresh) return blob;
  if (!blob.refresh_token) {
    logger.warn(`[oauth-refresh] ${provider}: token expired but no refresh_token stored — cannot refresh`);
    return blob; // return expired blob; skill will get a 401 and surface it properly
  }

  logger.info(`[oauth-refresh] Refreshing ${provider} token for skill "${skillName}"...`);

  // Resolve client credentials: stored blob → .env fallback
  const prefix = provider.toUpperCase();
  const clientId     = blob.client_id     || process.env[`${prefix}_CLIENT_ID`]     || '';
  const clientSecret = blob.client_secret || process.env[`${prefix}_CLIENT_SECRET`] || '';
  if (!clientId || !clientSecret) {
    logger.warn(`[oauth-refresh] ${provider}: missing client_id/client_secret — cannot refresh`);
    return blob;
  }

  try {
    const formBody = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: blob.refresh_token,
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString();

    const { status, body: tokenResponse } = await postTokenRequest(tokenUrl, formBody, null);

    if (status !== 200 || !tokenResponse.access_token) {
      logger.warn(`[oauth-refresh] ${provider}: refresh failed (HTTP ${status}): ${JSON.stringify(tokenResponse).slice(0, 200)}`);
      return blob; // return stale blob
    }

    // Merge new token fields into existing blob
    const updatedBlob = {
      ...blob,
      access_token: tokenResponse.access_token,
      // Some providers rotate refresh tokens — update if provided
      ...(tokenResponse.refresh_token ? { refresh_token: tokenResponse.refresh_token } : {}),
      // expires_in is seconds from now
      ...(tokenResponse.expires_in ? { expires_at: Date.now() + tokenResponse.expires_in * 1000 } : {}),
    };

    // Persist updated blob back to keytar (same keys that had the old blob)
    try {
      await keytar.setPassword('thinkdrop', usedKey, JSON.stringify(updatedBlob));
      // Keep skill-specific ACCESS_TOKEN entry in sync for shell scripts
      if (usedKey === `oauth:${provider}`) {
        const skillKey = `oauth:${provider}:${skillName}`;
        await keytar.setPassword('thinkdrop', skillKey, JSON.stringify(updatedBlob));
      }
      await keytar.setPassword('thinkdrop', `skill:${skillName}:ACCESS_TOKEN`, updatedBlob.access_token);
      logger.info(`[oauth-refresh] ${provider}: token refreshed and stored ✓`);
    } catch (storeErr) {
      logger.warn(`[oauth-refresh] ${provider}: keytar store failed after refresh: ${storeErr.message}`);
    }

    return updatedBlob;
  } catch (err) {
    logger.warn(`[oauth-refresh] ${provider}: refresh request failed: ${err.message}`);
    return blob; // stale blob — skill will surface 401 naturally
  }
}

module.exports = { refreshTokenIfNeeded };
