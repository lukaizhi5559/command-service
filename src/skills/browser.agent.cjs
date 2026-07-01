'use strict';

/**
 * skill: browser.agent
 *
 * Factory skill that discovers, builds, and manages Playwright-backed narrow agents.
 * Each generated agent is stored as a structured .md descriptor in DuckDB at
 * ~/.thinkdrop/agents.db and as a .md file under ~/.thinkdrop/agents/.
 *
 * These agents are purpose-built for specific web services (slack.agent,
 * discord.agent, notion.agent, etc.) that have no CLI. They understand the
 * DOM layout and navigation patterns of their target service.
 *
 * Actions:
 *   build_agent    { service, startUrl?, force? } → generates .md descriptor,
 *                                                    stores in DuckDB
 *   query_agent    { service?, id? }              → retrieves agent descriptor
 *   list_agents    {}                             → all browser agents in registry
 *   validate_agent { id }                         → checks if service URL is reachable,
 *                                                    updates status
 *   run            { agentId, task, context? }    → executes a task using the agent's
 *                                                    descriptor as LLM context + browser.act
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const http = require('http');
const logger = require('../logger.cjs');

const SERVICE_UNAVAILABLE_PATTERNS = [
  /\bhigh\s*demand\b/i,
  /\brate\s*limit(?:ed|ing)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bat\s+capacity\b/i,
  /\bover\s+capacity\b/i,
  /\bserver\s+busy\b/i,
  /\bbusy\s+right\s+now\b/i,
  /\bmaintenance\b/i,
  /\bdown\s+for\s+maintenance\b/i,
  /\btemporarily\s+unavailable\b/i,
  /\bservice\s+unavailable\b/i,
  /\boutage\b/i,
  /\bdegraded\s+service\b/i,
  /\b(error\s+404|http\s+404|status\s+404|404\s+not\s+found|404\s+error)\b/i,
  /\b(error\s+429|http\s+429|status\s+429|429\s+too\s+many|rate\s+limited\s+429)\b/i,
  /\b(error\s+500|http\s+500|status\s+500|500\s+internal\s+server|500\s+error|internal\s+server\s+error\s+500)\b/i,
  /\b(error\s+502|http\s+502|status\s+502|502\s+bad\s+gateway|502\s+error)\b/i,
  /\b(error\s+503|http\s+503|status\s+503|503\s+service\s+unavailable|503\s+error)\b/i,
  /\bpage\s+not\s+found\b/i,
  /\binternal\s+server\s+error\b/i,
  /\bbad\s+gateway\b/i,
  /\bsomething\s+went\s+wrong\b/i,
  /\bsite\s+can(?:no)?t\s+be\s+reached\b/i,
  /\bconnection\s+refused\b/i,
  /\bname\s+not\s+resolved\b/i,
  /\bnetwork\s+error\b/i,
  /\berr_(?:connection|name|timed_out|ssl|internet)\w*\b/i,
  /\bcoming\s+soon\b/i,
  /\bunder\s+construction\b/i,
  /\bearly\s+access\b/i,
  /\baccess\s+blocked\b/i,
  /\baccess\s+denied\b/i,
  /\bnot\s+available\s+in\s+your\s+(?:region|country)\b/i,
  /\bunsupported\s+region\b/i,
  /\bupgrade\s+required\b/i,
  /\bplan\s+required\b/i,
];

// ---------------------------------------------------------------------------
// WALT: Build JavaScript extraction code for different extract types
// ---------------------------------------------------------------------------
function _buildExtractionCode(selector, extractType, extractOptions = {}) {
  const escapedSelector = selector.replace(/"/g, '\\"');
  const { dataAttr, attrName } = extractOptions;
  
  switch (extractType) {
    case 'text':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.textContent.trim();
      })()`;
    case 'href':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.href || el.getAttribute('href') || null;
      })()`;
    case 'value':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.value || el.getAttribute('value') || null;
      })()`;
    case 'html':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.outerHTML;
      })()`;
    case 'src':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.src || el.getAttribute('src') || null;
      })()`;
    case 'data':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        const dataAttr = "${dataAttr || 'id'}";
        return el.getAttribute('data-' + dataAttr) || el.dataset[dataAttr] || null;
      })()`;
    case 'attr':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        const attrName = "${attrName || 'id'}";
        return el.getAttribute(attrName) || null;
      })()`;
    case 'json':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        try {
          const text = el.textContent.trim();
          return JSON.parse(text);
        } catch (e) {
          return null;
        }
      })()`;
    case 'table':
      return `(function() {
        const table = document.querySelector("${escapedSelector}");
        if (!table) return null;
        const rows = [];
        const headers = [];
        const ths = table.querySelectorAll('th');
        ths.forEach(th => headers.push(th.textContent.trim()));
        const trs = table.querySelectorAll('tr');
        trs.forEach(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length === 0) return;
          const row = {};
          tds.forEach((td, i) => {
            const key = headers[i] || 'col' + i;
            row[key] = td.textContent.trim();
          });
          rows.push(row);
        });
        return rows;
      })()`;
    case 'list':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        const items = el.querySelectorAll('li');
        if (items.length === 0) return [el.textContent.trim()];
        return Array.from(items).map(li => li.textContent.trim());
      })()`;
    default:
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.textContent.trim();
      })()`;
  }
}

// ---------------------------------------------------------------------------
// LLM-based auth detection prompt — semantic analysis of page content
// ---------------------------------------------------------------------------
const AUTH_CHECK_PROMPT = `You are analyzing a web page to determine if user authentication is required.
Given the page TITLE and BODY TEXT, determine if this page requires the user to log in or sign up before they can access the actual service.

Reply ONLY with a JSON object:
{
  "authRequired": true|false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}

Indicate authRequired=true if the page shows:
- Login forms, sign-in buttons, or email/password fields
- Landing pages that say "Sign in to continue" or similar
- Marketing pages that require authentication to proceed
- "Workspace not found" or "Sign in to your workspace" messages
- Pages that say "Get started" or "Create account" as the primary action
- Email input fields with text like "Enter your email to sign in"

Indicate authRequired=false if:
- The user is already logged in and can see their content
- The page is a publicly accessible dashboard
- The page shows actual app content (channels, messages, files, etc.)`;

// ---------------------------------------------------------------------------
// Auth-check result cache — avoids repeated navigate+evaluate probes
// Key: agentId  Value: { ts: Date.now(), authNeeded: bool }
// TTL: 60s — re-probe if the last confirmed-ok check is older than this.
// ---------------------------------------------------------------------------
const AUTH_CHECK_CACHE_TTL_MS = 60_000;
const _authCheckCache = new Map(); // agentId → { ts, authNeeded }

function _getCachedAuthCheck(agentId) {
  const entry = _authCheckCache.get(agentId);
  if (!entry) return null;
  if (Date.now() - entry.ts > AUTH_CHECK_CACHE_TTL_MS) {
    _authCheckCache.delete(agentId);
    return null;
  }
  return entry;
}

function _setCachedAuthCheck(agentId, authNeeded) {
  _authCheckCache.set(agentId, { ts: Date.now(), authNeeded });
}

// ---------------------------------------------------------------------------
// LLM-based auth detection — semantic analysis when URL patterns fail
// ---------------------------------------------------------------------------
async function _detectAuthViaLLM(title, body, agentId) {
  try {
    const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
    const raw = await askWithMessages([
      { role: 'system', content: AUTH_CHECK_PROMPT },
      { role: 'user', content: `TITLE: ${(title || '').slice(0, 200)}\n\nBODY: ${(body || '').slice(0, 1000)}` }
    ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 10000 });

    const parsed = (() => {
      try { return JSON.parse(raw); }
      catch (_) { return null; }
    })();

    if (parsed?.authRequired && (parsed.confidence ?? 0) >= 0.7) {
      logger.info(`[browser.agent] LLM auth detection: auth required (confidence=${parsed.confidence}, reason=${parsed.reason})`);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(`[browser.agent] LLM auth detection failed (non-fatal): ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Domain Map helpers — content extraction discovery from explore.agent scan mode
// ---------------------------------------------------------------------------

const DOMAIN_MAPS_DIR = path.join(os.homedir(), '.thinkdrop', 'domain-maps');

function _loadDomainMap(hostname) {
  try {
    const p = path.join(DOMAIN_MAPS_DIR, `${hostname}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

/**
 * Get content extraction config from domain map for a hostname.
 * Returns { primary_selector, fallback_selector, content_type } or null.
 */
function getContentExtractionConfig(hostname) {
  if (!hostname) return null;
  const map = _loadDomainMap(hostname.replace(/^www\./, ''));
  return map?.content_extraction || null;
}

function detectServiceUnavailable(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const pattern of SERVICE_UNAVAILABLE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[0]) return match[0];
  }
  return null;
}
const { userAgent } = require('./user.agent.cjs');

const { resolveDestination, recordCorrection, classifyTaskIntent } = require('../skill-helpers/destination-resolver.cjs');
const { killExistingChromeForProfile, clearProfileLock, findCli, shortSessionId } = require('./browser.act.cjs');

const BROWSER_ACT_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);

// Import shared database module
const { withDb, AGENTS_DB_PATH, AGENTS_DIR } = require('@thinkdrop/agents-db');

// Lazy-loaded to avoid circular require — only pulled in when auto-connect is active
let _ensureChromeCDP = null;
function getEnsureChromeCDP() {
  if (!_ensureChromeCDP) _ensureChromeCDP = require('./agentbrowser.act.cjs').ensureChromeCDP;
  return _ensureChromeCDP;
}

// ---------------------------------------------------------------------------
// Video platforms list — services that have video content and need video.agent delegation
// ---------------------------------------------------------------------------
const VIDEO_PLATFORMS = new Set([
  'youtube', 'vimeo', 'rumble', 'tiktok', 'facebook', 'fb', 'instagram', 'ig',
  'twitch', 'kick', 'dailymotion', 'bilibili', 'youku', 'tudou', 'peertube',
  'odysee', 'lbry', 'bitchute', 'brighteon', 'bannedvideo', 'bandcamp',
  'spotify', 'soundcloud', 'mixcloud', 'anchor', 'podcast', 'applepodcasts',
  'netflix', 'hulu', 'disneyplus', 'hbomax', 'primevideo', 'appletv', 'peacock',
  'crunchyroll', 'funimation', 'vrv', 'tubi', 'pluto', 'roku', 'plex',
  'wistia', 'loom', 'vidyard', 'brightcove', 'kaltura', 'jwplayer',
  'coursera', 'udemy', 'skillshare', 'masterclass', 'edx', 'khanacademy',
  'ted', 'tedtalks', 'bigthink', 'vsauce', 'veritasium', 'kurzgesagt',
  'foodnetwork', 'allrecipes', 'seriouseats', 'natashaskitchen', 'tasty',
  'bonappetit', 'chefsteps', 'americastestkitchen', 'cookingchannel',
]);

// ---------------------------------------------------------------------------
// Known browser-only services map
// ---------------------------------------------------------------------------

// Bootstrap seed map — cold-start anchors for first build_agent call before DuckDB has an entry.
// Three fields only: startUrl (post-login dashboard), authSuccessPattern (URL substring after auth),
// isOAuth (true = browser OAuth session required; false = API key settings page).
// After first build, DuckDB owns the descriptor and validate_agent can self-correct any entry.
// (resolveBrowserMeta priorities: DuckDB descriptor → DuckDB meta cache → this seed map → LLM+web_search)
const KNOWN_BROWSER_SERVICES = {
  // ── Core social / collaboration ─────────────────────────────────────────────────────────────────────
  gmail:          { startUrl: 'https://mail.google.com',                         signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'mail.google.com',              isOAuth: true  },
  google:         { startUrl: 'https://accounts.google.com',                     signInUrl: 'https://accounts.google.com',                       authSuccessPattern: 'myaccount.google.com',         isOAuth: true  },
  slack:          { startUrl: 'https://app.slack.com',                           signInUrl: 'https://slack.com/signin',                          authSuccessPattern: 'app.slack.com/client',         isOAuth: true  },
  discord:        { startUrl: 'https://discord.com/channels/@me',                signInUrl: 'https://discord.com/login',                         authSuccessPattern: 'discord.com/channels',         isOAuth: true  },
  notion:         { startUrl: 'https://www.notion.so',                           signInUrl: 'https://www.notion.so/login',                       authSuccessPattern: 'notion.so',                    isOAuth: true, preferAgentBrowser: true, postAuthUrl: 'https://www.notion.so', usePersistentProfile: true  },
  figma:          { startUrl: 'https://www.figma.com',                           signInUrl: 'https://www.figma.com/login',                       authSuccessPattern: 'figma.com/files',              isOAuth: true  },
  linear:         { startUrl: 'https://linear.app',                              signInUrl: 'https://linear.app/login',                          authSuccessPattern: 'linear.app/',                  isOAuth: true  },
  jira:           { startUrl: 'https://id.atlassian.com',                        signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'atlassian.net',                isOAuth: true  },
  confluence:     { startUrl: 'https://id.atlassian.com',                        signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'atlassian.net/wiki',           isOAuth: true  },
  airtable:       { startUrl: 'https://airtable.com',                            signInUrl: 'https://airtable.com/login',                        authSuccessPattern: 'airtable.com/',                isOAuth: true  },
  hubspot:        { startUrl: 'https://app.hubspot.com',                         signInUrl: 'https://app.hubspot.com/login',                     authSuccessPattern: 'app.hubspot.com/',             isOAuth: true  },
  salesforce:     { startUrl: 'https://login.salesforce.com',                    signInUrl: 'https://login.salesforce.com',                      authSuccessPattern: 'lightning.force.com',          isOAuth: true  },
  twitter:        { startUrl: 'https://twitter.com',                             signInUrl: 'https://twitter.com/i/flow/login',                  authSuccessPattern: 'twitter.com/home',             isOAuth: true  },
  facebook:       { startUrl: 'https://www.facebook.com',                        signInUrl: 'https://www.facebook.com/login',                    authSuccessPattern: 'facebook.com/',                isOAuth: true  },
  instagram:      { startUrl: 'https://www.instagram.com',                       signInUrl: 'https://www.instagram.com/accounts/login',          authSuccessPattern: 'instagram.com/',               isOAuth: true  },
  linkedin:       { startUrl: 'https://www.linkedin.com',                        signInUrl: 'https://www.linkedin.com/login',                    authSuccessPattern: 'linkedin.com/feed',            isOAuth: true  },
  // ── Email ───────────────────────────────────────────────────────────────────────────────────────────
  outlook:        { startUrl: 'https://outlook.live.com',                        signInUrl: 'https://login.live.com',                            authSuccessPattern: 'outlook.live.com/mail',        isOAuth: true  },
  yahoo:          { startUrl: 'https://mail.yahoo.com',                          signInUrl: 'https://login.yahoo.com',                           authSuccessPattern: 'mail.yahoo.com',               isOAuth: true  },
  protonmail:     { startUrl: 'https://mail.proton.me',                          signInUrl: 'https://account.proton.me/login',                   authSuccessPattern: 'mail.proton.me',               isOAuth: true  },
  fastmail:       { startUrl: 'https://www.fastmail.com',                        signInUrl: 'https://www.fastmail.com/login/',                   authSuccessPattern: 'fastmail.com',                 isOAuth: true  },
  zohomail:       { startUrl: 'https://mail.zoho.com',                           signInUrl: 'https://accounts.zoho.com/signin',                  authSuccessPattern: 'mail.zoho.com',                isOAuth: true  },
  // ── Social media ────────────────────────────────────────────────────────────────────────────────────
  tiktok:         { startUrl: 'https://www.tiktok.com',                          signInUrl: 'https://www.tiktok.com/login',                      authSuccessPattern: 'tiktok.com/foryou',            isOAuth: true  },
  pinterest:      { startUrl: 'https://www.pinterest.com',                       signInUrl: 'https://www.pinterest.com/login',                   authSuccessPattern: 'pinterest.com/',               isOAuth: true  },
  reddit:         { startUrl: 'https://www.reddit.com',                          signInUrl: 'https://www.reddit.com/login',                      authSuccessPattern: 'reddit.com/',                  isOAuth: true  },
  snapchat:       { startUrl: 'https://accounts.snapchat.com',                   signInUrl: 'https://accounts.snapchat.com',                     authSuccessPattern: 'accounts.snapchat.com',        isOAuth: true  },
  mastodon:       { startUrl: 'https://mastodon.social',                         signInUrl: 'https://mastodon.social/auth/sign_in',              authSuccessPattern: 'mastodon.social/home',         isOAuth: true  },
  bluesky:        { startUrl: 'https://bsky.app',                                signInUrl: 'https://bsky.app/login',                            authSuccessPattern: 'bsky.app',                     isOAuth: true  },
  threads:        { startUrl: 'https://www.threads.net',                         signInUrl: 'https://www.threads.net/login',                     authSuccessPattern: 'threads.net',                  isOAuth: true  },
  youtube:        { startUrl: 'https://www.youtube.com',                         signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'youtube.com',                  isOAuth: false },
  twitch:         { startUrl: 'https://www.twitch.tv',                           signInUrl: 'https://www.twitch.tv/login',                       authSuccessPattern: 'twitch.tv',                    isOAuth: true  },
  // ── Developer tools ─────────────────────────────────────────────────────────────────────────────────
  github:         { startUrl: 'https://github.com',                              signInUrl: 'https://github.com/login',                          authSuccessPattern: 'github.com/',                  isOAuth: true  },
  gitlab:         { startUrl: 'https://gitlab.com',                              signInUrl: 'https://gitlab.com/users/sign_in',                  authSuccessPattern: 'gitlab.com/',                  isOAuth: true  },
  bitbucket:      { startUrl: 'https://bitbucket.org',                           signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'bitbucket.org/',               isOAuth: true  },
  shortcut:       { startUrl: 'https://app.shortcut.com',                        signInUrl: 'https://app.shortcut.com/login',                    authSuccessPattern: 'app.shortcut.com/',            isOAuth: true  },
  azuredevops:    { startUrl: 'https://dev.azure.com',                           signInUrl: 'https://login.microsoftonline.com',                 authSuccessPattern: 'dev.azure.com/',               isOAuth: true  },
  // ── Productivity ────────────────────────────────────────────────────────────────────────────────────
  trello:         { startUrl: 'https://trello.com',                              signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'trello.com/',                  isOAuth: true  },
  asana:          { startUrl: 'https://app.asana.com',                           signInUrl: 'https://app.asana.com/-/login',                     authSuccessPattern: 'app.asana.com/',               isOAuth: true  },
  monday:         { startUrl: 'https://monday.com',                              signInUrl: 'https://auth.monday.com',                           authSuccessPattern: 'monday.com',                   isOAuth: true  },
  clickup:        { startUrl: 'https://app.clickup.com',                         signInUrl: 'https://app.clickup.com/login',                     authSuccessPattern: 'app.clickup.com/',             isOAuth: true  },
  basecamp:       { startUrl: 'https://launchpad.37signals.com',                 signInUrl: 'https://launchpad.37signals.com',                   authSuccessPattern: '37signals.com',                isOAuth: true  },
  coda:           { startUrl: 'https://coda.io',                                 signInUrl: 'https://coda.io/login',                             authSuccessPattern: 'coda.io/d/',                   isOAuth: true  },
  todoist:        { startUrl: 'https://todoist.com',                             signInUrl: 'https://todoist.com/auth/login',                    authSuccessPattern: 'todoist.com/',                 isOAuth: true  },
  canva:          { startUrl: 'https://www.canva.com',                           signInUrl: 'https://www.canva.com/login',                       authSuccessPattern: 'canva.com/',                   isOAuth: true  },
  miro:           { startUrl: 'https://miro.com',                                signInUrl: 'https://miro.com/login/',                           authSuccessPattern: 'miro.com/app/',                isOAuth: true  },
  // ── Cloud / hosting ─────────────────────────────────────────────────────────────────────────────────
  vercel:         { startUrl: 'https://vercel.com/dashboard',                    signInUrl: 'https://vercel.com/login',                          authSuccessPattern: 'vercel.com/',                  isOAuth: true  },
  netlify:        { startUrl: 'https://app.netlify.com',                         signInUrl: 'https://app.netlify.com/login',                     authSuccessPattern: 'app.netlify.com/',             isOAuth: true  },
  render:         { startUrl: 'https://dashboard.render.com',                    signInUrl: 'https://dashboard.render.com/login',                authSuccessPattern: 'dashboard.render.com/',        isOAuth: true  },
  railway:        { startUrl: 'https://railway.app/dashboard',                   signInUrl: 'https://railway.app/login',                         authSuccessPattern: 'railway.app/',                 isOAuth: true  },
  flyio:          { startUrl: 'https://fly.io/dashboard',                        signInUrl: 'https://fly.io/app/sign-in',                        authSuccessPattern: 'fly.io/',                      isOAuth: true  },
  heroku:         { startUrl: 'https://dashboard.heroku.com',                    signInUrl: 'https://id.heroku.com/login',                       authSuccessPattern: 'dashboard.heroku.com/',        isOAuth: true  },
  digitalocean:   { startUrl: 'https://cloud.digitalocean.com',                  signInUrl: 'https://cloud.digitalocean.com/login',              authSuccessPattern: 'cloud.digitalocean.com/',      isOAuth: true  },
  cloudflare:     { startUrl: 'https://dash.cloudflare.com',                     signInUrl: 'https://dash.cloudflare.com/login',                 authSuccessPattern: 'dash.cloudflare.com/',         isOAuth: true  },
  awsconsole:     { startUrl: 'https://console.aws.amazon.com',                  signInUrl: 'https://signin.aws.amazon.com/signin',              authSuccessPattern: 'console.aws.amazon.com/',      isOAuth: true  },
  gcpconsole:     { startUrl: 'https://console.cloud.google.com',                signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'console.cloud.google.com',     isOAuth: true  },
  azureportal:    { startUrl: 'https://portal.azure.com',                        signInUrl: 'https://login.microsoftonline.com',                 authSuccessPattern: 'portal.azure.com/',            isOAuth: true  },
  // ── AI platforms ────────────────────────────────────────────────────────────────────────────────────
  openai:         { startUrl: 'https://platform.openai.com/api-keys',            authSuccessPattern: 'platform.openai.com',          isOAuth: false },
  anthropic:      { startUrl: 'https://console.anthropic.com',                   authSuccessPattern: 'console.anthropic.com',        isOAuth: false },
  mistral:        { startUrl: 'https://console.mistral.ai',                      authSuccessPattern: 'console.mistral.ai',           isOAuth: false },
  cohere:         { startUrl: 'https://dashboard.cohere.com',                    authSuccessPattern: 'dashboard.cohere.com',         isOAuth: false },
  groq:           { startUrl: 'https://console.groq.com',                        authSuccessPattern: 'console.groq.com',             isOAuth: false },
  replicate:      { startUrl: 'https://replicate.com',                           signInUrl: 'https://replicate.com/signin',                      authSuccessPattern: 'replicate.com/',               isOAuth: true  },
  huggingface:    { startUrl: 'https://huggingface.co/settings/tokens',          authSuccessPattern: 'huggingface.co/',              isOAuth: false },
  together:       { startUrl: 'https://api.together.xyz',                        authSuccessPattern: 'api.together.xyz',             isOAuth: false },
  // perplexity defaults to the chat/research interface; use perplexityplatform for API keys
  perplexity:       { startUrl: 'https://www.perplexity.ai/',                      authSuccessPattern: 'perplexity.ai',                isOAuth: false },
  perplexityplatform: { startUrl: 'https://www.perplexity.ai/settings/api',        authSuccessPattern: 'perplexity.ai/',               isOAuth: false },
  fireworks:      { startUrl: 'https://fireworks.ai/account/api-keys',           authSuccessPattern: 'fireworks.ai/',                isOAuth: false },
  // deepseek defaults to the chat interface; use deepseekplatform for the API console
  deepseek:         { startUrl: 'https://chat.deepseek.com/',                      authSuccessPattern: 'chat.deepseek.com',            isOAuth: false },
  deepseekplatform: { startUrl: 'https://platform.deepseek.com/api_keys',          authSuccessPattern: 'platform.deepseek.com/',       isOAuth: false },
  // ── AI consumer apps ─────────────────────────────────────────────────────────────────────────────────
  // All anonymous-first (isOAuth: false). Only trigger waitForAuth if a login wall appears.
  // IMPORTANT: these are CONSUMER WEBSITES — NOT the developer API consoles above in // ── AI platforms ──
  // AI Chat
  chatgpt:        { startUrl: 'https://chatgpt.com/',                            authSuccessPattern: 'chatgpt.com',                  isOAuth: false },
  geminiai:       { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  gemini:         { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  googleai:       { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  // Google AI Mode — distinct from Gemini; navigate to google.com and click the AI Mode button
  googleaimode:   { startUrl: 'https://www.google.com',                           authSuccessPattern: 'google.com',                   isOAuth: false,
                    preTaskGoal: 'First locate and click the "AI Mode" tab or button near the top of the Google search page. Do NOT type anything yet — click AI Mode first, then in the AI Mode interface type the search query.' },
  claude:         { startUrl: 'https://claude.ai/new', signInUrl: 'https://claude.ai/login', postAuthUrl: 'https://claude.ai/new', authSuccessPattern: 'claude.ai',      isOAuth: true  },
  perplexitychat: { startUrl: 'https://www.perplexity.ai/',                      authSuccessPattern: 'perplexity.ai',                isOAuth: false },
  grok:           { startUrl: 'https://grok.com/',                               authSuccessPattern: 'grok.com',                     isOAuth: false },
  copilotmsft:    { startUrl: 'https://copilot.microsoft.com/',                  authSuccessPattern: 'copilot.microsoft.com',        isOAuth: false },
  deepseekchat:   { startUrl: 'https://chat.deepseek.com/',                      authSuccessPattern: 'chat.deepseek.com',            isOAuth: false },
  mistralchat:    { startUrl: 'https://chat.mistral.ai/',                        authSuccessPattern: 'chat.mistral.ai',              isOAuth: false },
  qwen:           { startUrl: 'https://chat.qwenlm.ai/',                         authSuccessPattern: 'chat.qwenlm.ai',               isOAuth: false },
  // AI Image & Art
  midjourney:     { startUrl: 'https://www.midjourney.com/',                     authSuccessPattern: 'midjourney.com',               isOAuth: false },
  ideogram:       { startUrl: 'https://ideogram.ai/',                            authSuccessPattern: 'ideogram.ai',                  isOAuth: false },
  stablechat:     { startUrl: 'https://dreamstudio.ai/generate',                 authSuccessPattern: 'dreamstudio.ai',               isOAuth: false },
  firefly:        { startUrl: 'https://firefly.adobe.com/',                      authSuccessPattern: 'firefly.adobe.com',            isOAuth: false },
  playground:     { startUrl: 'https://playground.com/',                         authSuccessPattern: 'playground.com',               isOAuth: false },
  imagenfx:       { startUrl: 'https://labs.google/fx/tools/image-fx',           authSuccessPattern: 'labs.google',                  isOAuth: false },
  craiyon:        { startUrl: 'https://www.craiyon.com/',                        authSuccessPattern: 'craiyon.com',                  isOAuth: false },
  nightcafe:      { startUrl: 'https://creator.nightcafe.studio/',               authSuccessPattern: 'nightcafe.studio',             isOAuth: false },
  leonardoai:     { startUrl: 'https://app.leonardo.ai/',                        authSuccessPattern: 'app.leonardo.ai',              isOAuth: false },
  krea:           { startUrl: 'https://krea.ai/',                                authSuccessPattern: 'krea.ai',                      isOAuth: false },
  // AI Music
  suno:           { startUrl: 'https://suno.com/',                               authSuccessPattern: 'suno.com',                     isOAuth: false },
  udio:           { startUrl: 'https://www.udio.com/',                           authSuccessPattern: 'udio.com',                     isOAuth: false },
  soundraw:       { startUrl: 'https://soundraw.io/',                            authSuccessPattern: 'soundraw.io',                  isOAuth: false },
  boomy:          { startUrl: 'https://boomy.com/',                              authSuccessPattern: 'boomy.com',                    isOAuth: false },
  mubert:         { startUrl: 'https://mubert.com/',                             authSuccessPattern: 'mubert.com',                   isOAuth: false },
  aiva:           { startUrl: 'https://www.aiva.ai/',                            authSuccessPattern: 'aiva.ai',                      isOAuth: false },
  beatoven:       { startUrl: 'https://www.beatoven.ai/',                        authSuccessPattern: 'beatoven.ai',                  isOAuth: false },
  stableaudio:    { startUrl: 'https://stableaudio.com/',                        authSuccessPattern: 'stableaudio.com',              isOAuth: false },
  // AI Video
  runwayml:       { startUrl: 'https://app.runwayml.com/',                       authSuccessPattern: 'runwayml.com',                 isOAuth: false },
  pikaai:         { startUrl: 'https://pika.art/',                               authSuccessPattern: 'pika.art',                     isOAuth: false },
  kling:          { startUrl: 'https://klingai.com/',                            authSuccessPattern: 'klingai.com',                  isOAuth: false },
  heygen:         { startUrl: 'https://app.heygen.com/',                         authSuccessPattern: 'heygen.com',                   isOAuth: false },
  synthesia:      { startUrl: 'https://app.synthesia.io/',                       authSuccessPattern: 'synthesia.io',                 isOAuth: false },
  sora:           { startUrl: 'https://sora.com/',                               authSuccessPattern: 'sora.com',                     isOAuth: false },
  lumai:          { startUrl: 'https://lumalabs.ai/dream-machine',               authSuccessPattern: 'lumalabs.ai',                  isOAuth: false },
  kaiber:         { startUrl: 'https://kaiber.ai/',                              authSuccessPattern: 'kaiber.ai',                    isOAuth: false },
  invideio:       { startUrl: 'https://invideo.io/',                             authSuccessPattern: 'invideo.io',                   isOAuth: false },
  pictory:        { startUrl: 'https://pictory.ai/',                             authSuccessPattern: 'pictory.ai',                   isOAuth: false },
  descript:       { startUrl: 'https://web.descript.com/',                       authSuccessPattern: 'descript.com',                 isOAuth: false },
  // AI Writing
  jasperai:       { startUrl: 'https://app.jasper.ai/',                          authSuccessPattern: 'app.jasper.ai',                isOAuth: false },
  copyai:         { startUrl: 'https://app.copy.ai/',                            authSuccessPattern: 'app.copy.ai',                  isOAuth: false },
  writesonic:     { startUrl: 'https://writesonic.com/',                         authSuccessPattern: 'writesonic.com',               isOAuth: false },
  rytr:           { startUrl: 'https://rytr.me/',                                authSuccessPattern: 'rytr.me',                      isOAuth: false },
  anyword:        { startUrl: 'https://app.anyword.com/',                        authSuccessPattern: 'app.anyword.com',              isOAuth: false },
  sudowrite:      { startUrl: 'https://sudowrite.com/',                          authSuccessPattern: 'sudowrite.com',                isOAuth: false },
  quillbot:       { startUrl: 'https://quillbot.com/',                           authSuccessPattern: 'quillbot.com',                 isOAuth: false },
  grammarly:      { startUrl: 'https://app.grammarly.com/',                      authSuccessPattern: 'app.grammarly.com',            isOAuth: false },
  // AI Comics & Books
  comicai:        { startUrl: 'https://comicai.com/',                            authSuccessPattern: 'comicai.com',                  isOAuth: false },
  novelai:        { startUrl: 'https://novelai.net/',                            authSuccessPattern: 'novelai.net',                  isOAuth: false },
  webtooncanvas:  { startUrl: 'https://www.webtoons.com/en/canvas',              authSuccessPattern: 'webtoons.com',                 isOAuth: false },
  pixton:         { startUrl: 'https://pixton.com/',                             authSuccessPattern: 'pixton.com',                   isOAuth: false },
  // AI Science & Research
  wolframalpha:   { startUrl: 'https://www.wolframalpha.com/',                   authSuccessPattern: 'wolframalpha.com',             isOAuth: false },
  elicit:         { startUrl: 'https://elicit.com/',                             authSuccessPattern: 'elicit.com',                   isOAuth: false },
  consensus:      { startUrl: 'https://consensus.app/',                          authSuccessPattern: 'consensus.app',                isOAuth: false },
  semanticscholar:{ startUrl: 'https://www.semanticscholar.org/',                authSuccessPattern: 'semanticscholar.org',          isOAuth: false },
  scite:          { startUrl: 'https://scite.ai/',                               authSuccessPattern: 'scite.ai',                     isOAuth: false },
  connectedpapers:{ startUrl: 'https://www.connectedpapers.com/',                authSuccessPattern: 'connectedpapers.com',          isOAuth: false },
  researchrabbit: { startUrl: 'https://www.researchrabbit.ai/',                  authSuccessPattern: 'researchrabbit.ai',            isOAuth: false },
  litmaps:        { startUrl: 'https://www.litmaps.com/',                        authSuccessPattern: 'litmaps.com',                  isOAuth: false },
  scholarcy:      { startUrl: 'https://app.scholarcy.com/',                      authSuccessPattern: 'app.scholarcy.com',            isOAuth: false },
  explainpaper:   { startUrl: 'https://www.explainpaper.com/',                   authSuccessPattern: 'explainpaper.com',             isOAuth: false },
  chatpdf:        { startUrl: 'https://www.chatpdf.com/',                        authSuccessPattern: 'chatpdf.com',                  isOAuth: false },
  humata:         { startUrl: 'https://www.humata.ai/',                          authSuccessPattern: 'humata.ai',                    isOAuth: false },
  scispace:       { startUrl: 'https://typeset.io/',                             authSuccessPattern: 'typeset.io',                   isOAuth: false },
  paperpal:       { startUrl: 'https://paperpal.com/',                           authSuccessPattern: 'paperpal.com',                 isOAuth: false },
  notebooklm:     { startUrl: 'https://notebooklm.google/',                      authSuccessPattern: 'notebooklm.google',            isOAuth: false },
  undermind:      { startUrl: 'https://www.undermind.ai/',                       authSuccessPattern: 'undermind.ai',                 isOAuth: false },
  openalex:       { startUrl: 'https://openalex.org/',                           authSuccessPattern: 'openalex.org',                 isOAuth: false },
  jenni:          { startUrl: 'https://jenni.ai/',                               authSuccessPattern: 'jenni.ai',                     isOAuth: false },
  askyourpdf:     { startUrl: 'https://askyourpdf.com/',                         authSuccessPattern: 'askyourpdf.com',               isOAuth: false },
  inciteful:      { startUrl: 'https://inciteful.xyz/',                          authSuccessPattern: 'inciteful.xyz',                isOAuth: false },
  // ── Email delivery APIs ──────────────────────────────────────────────────────────────────────────────
  sendgrid:       { startUrl: 'https://app.sendgrid.com/settings/api_keys',      authSuccessPattern: 'app.sendgrid.com',             isOAuth: false },
  mailgun:        { startUrl: 'https://app.mailgun.com/settings/api_security',   authSuccessPattern: 'app.mailgun.com',              isOAuth: false },
  postmark:       { startUrl: 'https://account.postmarkapp.com/api_tokens',      authSuccessPattern: 'postmarkapp.com',              isOAuth: false },
  resend:         { startUrl: 'https://resend.com/api-keys',                     authSuccessPattern: 'resend.com/',                  isOAuth: false },
  mailchimp:      { startUrl: 'https://login.mailchimp.com',                     signInUrl: 'https://login.mailchimp.com',                       authSuccessPattern: 'mailchimp.com/',               isOAuth: true  },
  brevo:          { startUrl: 'https://app.brevo.com',                           authSuccessPattern: 'app.brevo.com/',               isOAuth: false },
  sparkpost:      { startUrl: 'https://app.sparkpost.com/account/api-keys',      authSuccessPattern: 'app.sparkpost.com/',           isOAuth: false },
  convertkit:     { startUrl: 'https://app.convertkit.com/account_settings/advanced', authSuccessPattern: 'app.convertkit.com/',     isOAuth: false },
  klaviyo:        { startUrl: 'https://www.klaviyo.com/account#api-keys-tab',    authSuccessPattern: 'klaviyo.com/',                 isOAuth: false },
  // ── Payments / finance ───────────────────────────────────────────────────────────────────────────────
  stripe:         { startUrl: 'https://dashboard.stripe.com/apikeys',            authSuccessPattern: 'dashboard.stripe.com/',        isOAuth: false },
  paypal:         { startUrl: 'https://developer.paypal.com/dashboard',          signInUrl: 'https://www.paypal.com/signin',                     authSuccessPattern: 'developer.paypal.com/',        isOAuth: true  },
  square:         { startUrl: 'https://developer.squareup.com/apps',             signInUrl: 'https://squareup.com/login',                        authSuccessPattern: 'developer.squareup.com/',      isOAuth: true  },
  braintree:      { startUrl: 'https://sandbox.braintreegateway.com',            authSuccessPattern: 'braintreegateway.com/',        isOAuth: false },
  plaid:          { startUrl: 'https://dashboard.plaid.com',                     signInUrl: 'https://dashboard.plaid.com/signin',                authSuccessPattern: 'dashboard.plaid.com/',         isOAuth: true  },
  quickbooks:     { startUrl: 'https://app.qbo.intuit.com',                      signInUrl: 'https://accounts.intuit.com/app/sign-in',           authSuccessPattern: 'app.qbo.intuit.com/',          isOAuth: true  },
  xero:           { startUrl: 'https://go.xero.com/app/dashboard',               signInUrl: 'https://login.xero.com',                            authSuccessPattern: 'go.xero.com/',                 isOAuth: true  },
  // ── CRM / support ────────────────────────────────────────────────────────────────────────────────────
  zohocrm:        { startUrl: 'https://crm.zoho.com',                            signInUrl: 'https://accounts.zoho.com/signin',                  authSuccessPattern: 'crm.zoho.com/',                isOAuth: true  },
  pipedrive:      { startUrl: 'https://app.pipedrive.com',                       signInUrl: 'https://app.pipedrive.com/auth/login',              authSuccessPattern: 'app.pipedrive.com/',           isOAuth: true  },
  activecampaign: { startUrl: 'https://www.activecampaign.com',                  authSuccessPattern: 'activecampaign.com/',          isOAuth: false },
  freshdesk:      { startUrl: 'https://freshdesk.com',                           authSuccessPattern: 'freshdesk.com/',               isOAuth: false },
  helpscout:      { startUrl: 'https://secure.helpscout.net',                    authSuccessPattern: 'secure.helpscout.net/',        isOAuth: false },
  // ── Analytics ───────────────────────────────────────────────────────────────────────────────────────
  mixpanel:       { startUrl: 'https://mixpanel.com',                            authSuccessPattern: 'mixpanel.com/',                isOAuth: false },
  amplitude:      { startUrl: 'https://analytics.amplitude.com',                 authSuccessPattern: 'analytics.amplitude.com',      isOAuth: false },
  posthog:        { startUrl: 'https://app.posthog.com',                         authSuccessPattern: 'app.posthog.com/',             isOAuth: false },
  segment:        { startUrl: 'https://app.segment.com',                         signInUrl: 'https://app.segment.com/login',                     authSuccessPattern: 'app.segment.com/',             isOAuth: true  },
  plausible:      { startUrl: 'https://plausible.io',                            authSuccessPattern: 'plausible.io/',                isOAuth: false },
  // ── Monitoring / observability ───────────────────────────────────────────────────────────────────────
  datadog:        { startUrl: 'https://app.datadoghq.com',                       authSuccessPattern: 'app.datadoghq.com/',           isOAuth: false },
  newrelic:       { startUrl: 'https://login.newrelic.com',                      authSuccessPattern: 'one.newrelic.com/',            isOAuth: false },
  grafana:        { startUrl: 'https://grafana.com/auth/sign-in',                signInUrl: 'https://grafana.com/auth/sign-in',                  authSuccessPattern: 'grafana.com/',                 isOAuth: true  },
  sentry:         { startUrl: 'https://sentry.io',                               authSuccessPattern: 'sentry.io/',                   isOAuth: false },
  pagerduty:      { startUrl: 'https://app.pagerduty.com',                       signInUrl: 'https://app.pagerduty.com/sign_in',                authSuccessPattern: 'app.pagerduty.com/',           isOAuth: true  },
  // ── Databases / data ─────────────────────────────────────────────────────────────────────────────────
  supabase:       { startUrl: 'https://app.supabase.com',                        signInUrl: 'https://supabase.com/dashboard/sign-in',            authSuccessPattern: 'app.supabase.com/',            isOAuth: true  },
  neon:           { startUrl: 'https://console.neon.tech',                       signInUrl: 'https://console.neon.tech/login',                   authSuccessPattern: 'console.neon.tech/',           isOAuth: true  },
  mongoatlas:     { startUrl: 'https://cloud.mongodb.com',                       signInUrl: 'https://account.mongodb.com/account/login',         authSuccessPattern: 'cloud.mongodb.com/',           isOAuth: true  },
  firebase:       { startUrl: 'https://console.firebase.google.com',             signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'console.firebase.google.com',  isOAuth: true  },
  snowflake:      { startUrl: 'https://app.snowflake.com',                       signInUrl: 'https://app.snowflake.com',                         authSuccessPattern: 'app.snowflake.com/',           isOAuth: true  },
  // ── Communications ───────────────────────────────────────────────────────────────────────────────────
  twilio:         { startUrl: 'https://console.twilio.com',                      authSuccessPattern: 'console.twilio.com/',          isOAuth: false },
  vonage:         { startUrl: 'https://dashboard.nexmo.com',                     authSuccessPattern: 'dashboard.nexmo.com/',         isOAuth: false },
  pusher:         { startUrl: 'https://dashboard.pusher.com',                    authSuccessPattern: 'dashboard.pusher.com/',        isOAuth: false },
  zoom:           { startUrl: 'https://zoom.us/signin',                          signInUrl: 'https://zoom.us/signin',                            authSuccessPattern: 'zoom.us/',                     isOAuth: true  },
  loom:           { startUrl: 'https://www.loom.com/looms/videos',               signInUrl: 'https://www.loom.com/login',                        authSuccessPattern: 'loom.com/',                    isOAuth: true  },
  // ── Identity / auth platforms ────────────────────────────────────────────────────────────────────────
  auth0:          { startUrl: 'https://manage.auth0.com',                        authSuccessPattern: 'manage.auth0.com/',            isOAuth: false },
  okta:           { startUrl: 'https://developer.okta.com',                      authSuccessPattern: 'developer.okta.com/',          isOAuth: false },
  clerk:          { startUrl: 'https://dashboard.clerk.com',                     authSuccessPattern: 'dashboard.clerk.com/',         isOAuth: false },
  // ── Storage ──────────────────────────────────────────────────────────────────────────────────────────
  dropbox:        { startUrl: 'https://www.dropbox.com/home',                    signInUrl: 'https://www.dropbox.com/login',                     authSuccessPattern: 'dropbox.com/',                 isOAuth: true  },
  box:            { startUrl: 'https://app.box.com',                             signInUrl: 'https://account.box.com/login',                     authSuccessPattern: 'app.box.com/',                 isOAuth: true  },
  // ── CMS / e-commerce ─────────────────────────────────────────────────────────────────────────────────
  shopify:        { startUrl: 'https://partners.shopify.com',                    signInUrl: 'https://accounts.shopify.com/lookup',               authSuccessPattern: 'partners.shopify.com/',        isOAuth: true  },
  contentful:     { startUrl: 'https://app.contentful.com',                      authSuccessPattern: 'app.contentful.com/',          isOAuth: false },
  sanity:         { startUrl: 'https://www.sanity.io/manage',                    signInUrl: 'https://www.sanity.io/login',                       authSuccessPattern: 'sanity.io/manage/',            isOAuth: true  },
  webflow:        { startUrl: 'https://webflow.com/dashboard',                   signInUrl: 'https://webflow.com/dashboard/login',               authSuccessPattern: 'webflow.com/',                 isOAuth: true  },
  ghost:          { startUrl: 'https://ghost.org/dashboard',                     signInUrl: 'https://ghost.org/dashboard/signin',                authSuccessPattern: 'ghost.org/',                   isOAuth: true  },
  // ── Social media management ──────────────────────────────────────────────────────────────────────────
  buffer:         { startUrl: 'https://app.buffer.com',                          signInUrl: 'https://app.buffer.com/login',                      authSuccessPattern: 'app.buffer.com/',              isOAuth: true  },
  hootsuite:      { startUrl: 'https://hootsuite.com/dashboard',                 signInUrl: 'https://hootsuite.com/login',                       authSuccessPattern: 'hootsuite.com/',               isOAuth: true  },
  // ── IoT / Smart Home ─────────────────────────────────────────────────────────────────────────────────
  ifttt:          { startUrl: 'https://ifttt.com/home',                          signInUrl: 'https://ifttt.com/login',                           authSuccessPattern: 'ifttt.com/',                   isOAuth: true  },
  homeassistant:  { startUrl: 'https://my.home-assistant.io',                    signInUrl: 'https://my.home-assistant.io',                      authSuccessPattern: 'home-assistant.io/',           isOAuth: true  },
  smartthings:    { startUrl: 'https://account.smartthings.com',                 signInUrl: 'https://account.smartthings.com',                   authSuccessPattern: 'account.smartthings.com/',     isOAuth: true  },
  nest:           { startUrl: 'https://home.nest.com',                           signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'home.nest.com/',               isOAuth: true  },
  ring:           { startUrl: 'https://account.ring.com',                        signInUrl: 'https://account.ring.com/sign-in',                  authSuccessPattern: 'account.ring.com/',            isOAuth: true  },
  wyze:           { startUrl: 'https://app.wyzecam.com',                         signInUrl: 'https://app.wyzecam.com',                           authSuccessPattern: 'wyzecam.com/',                 isOAuth: true  },
  tuya:           { startUrl: 'https://iot.tuya.com',                            signInUrl: 'https://iot.tuya.com',                              authSuccessPattern: 'iot.tuya.com/',                isOAuth: true  },
  particle:       { startUrl: 'https://console.particle.io',                     signInUrl: 'https://login.particle.io',                         authSuccessPattern: 'console.particle.io/',         isOAuth: true  },
  blynk:          { startUrl: 'https://blynk.cloud',                             authSuccessPattern: 'blynk.cloud/',                 isOAuth: false },
  adafruitio:     { startUrl: 'https://io.adafruit.com',                         authSuccessPattern: 'io.adafruit.com/',             isOAuth: false },
  arduino:        { startUrl: 'https://app.arduino.cc',                          signInUrl: 'https://login.arduino.cc',                          authSuccessPattern: 'app.arduino.cc/',              isOAuth: true  },
  balena:         { startUrl: 'https://dashboard.balena-cloud.com',              signInUrl: 'https://dashboard.balena-cloud.com/login',          authSuccessPattern: 'dashboard.balena-cloud.com/',  isOAuth: true  },
  ubidots:        { startUrl: 'https://industrial.ubidots.com',                  authSuccessPattern: 'industrial.ubidots.com/',      isOAuth: false },
  thingsboard:    { startUrl: 'https://thingsboard.cloud/home',                  authSuccessPattern: 'thingsboard.cloud/',           isOAuth: false },
  philipshue:     { startUrl: 'https://account.meethue.com',                     signInUrl: 'https://account.meethue.com/login',                 authSuccessPattern: 'meethue.com/',                 isOAuth: true  },
  ecobee:         { startUrl: 'https://www.ecobee.com/home',                     signInUrl: 'https://www.ecobee.com/home/authorizationForm.jsp', authSuccessPattern: 'ecobee.com/',                  isOAuth: true  },
  honeywell:      { startUrl: 'https://www.resideo.com',                         authSuccessPattern: 'resideo.com/',                 isOAuth: false },
  switchbot:      { startUrl: 'https://account.switch-bot.com',                  signInUrl: 'https://account.switch-bot.com/login',              authSuccessPattern: 'switch-bot.com/',              isOAuth: true  },
  govee:          { startUrl: 'https://developer.govee.com',                     authSuccessPattern: 'developer.govee.com/',         isOAuth: false },
  lifx:           { startUrl: 'https://cloud.lifx.com',                          signInUrl: 'https://cloud.lifx.com/sign_in',                    authSuccessPattern: 'cloud.lifx.com/',              isOAuth: true  },
  shelly:         { startUrl: 'https://my.shelly.cloud',                         authSuccessPattern: 'my.shelly.cloud/',             isOAuth: false },
  meross:         { startUrl: 'https://www.meross.com/web/profile',              authSuccessPattern: 'meross.com/',                  isOAuth: false },
  nanoleaf:       { startUrl: 'https://my.nanoleaf.me',                          signInUrl: 'https://my.nanoleaf.me/login',                      authSuccessPattern: 'nanoleaf.me/',                 isOAuth: true  },
  wemo:           { startUrl: 'https://www.wemo.com/setup',                      authSuccessPattern: 'wemo.com/',                    isOAuth: false },
  lutron:         { startUrl: 'https://www.casetawireless.com',                  signInUrl: 'https://www.casetawireless.com',                    authSuccessPattern: 'casetawireless.com/',          isOAuth: true  },
  // ── Automotive / car connectivity ────────────────────────────────────────────────────────────────────
  tesla:          { startUrl: 'https://auth.tesla.com/oauth2/v3/authorize',      signInUrl: 'https://auth.tesla.com/oauth2/v3/authorize',        authSuccessPattern: 'tesla.com/',                   isOAuth: true  },
  smartcar:       { startUrl: 'https://dashboard.smartcar.com',                  signInUrl: 'https://dashboard.smartcar.com/login',              authSuccessPattern: 'dashboard.smartcar.com/',      isOAuth: true  },
  ford:           { startUrl: 'https://fordpass.ford.com',                       signInUrl: 'https://fordpass.ford.com',                         authSuccessPattern: 'ford.com/',                    isOAuth: true  },
  bmw:            { startUrl: 'https://www.bmwconnecteddrive.com',               signInUrl: 'https://www.bmwconnecteddrive.com',                 authSuccessPattern: 'bmwconnecteddrive.com/',        isOAuth: true  },
  rivian:         { startUrl: 'https://rivian.com/account',                      signInUrl: 'https://rivian.com/account/sign-in',                authSuccessPattern: 'rivian.com/',                  isOAuth: true  },
  onstar:         { startUrl: 'https://my.onstar.com',                           signInUrl: 'https://my.onstar.com/account/login',               authSuccessPattern: 'my.onstar.com/',               isOAuth: true  },
  // ── Drone / aerial ──────────────────────────────────────────────────────────────────────────────────
  dji:            { startUrl: 'https://developer.dji.com',                       signInUrl: 'https://account.dji.com/login',                     authSuccessPattern: 'developer.dji.com/',           isOAuth: true  },
  dronedeploy:    { startUrl: 'https://www.dronedeploy.com/app2/',               signInUrl: 'https://www.dronedeploy.com/app2/login',            authSuccessPattern: 'dronedeploy.com/',             isOAuth: true  },
  skydio:         { startUrl: 'https://www.skydio.com/login',                    signInUrl: 'https://www.skydio.com/login',                      authSuccessPattern: 'skydio.com/',                  isOAuth: true  },
  autel:          { startUrl: 'https://passport.autelrobotics.com',              signInUrl: 'https://passport.autelrobotics.com',                authSuccessPattern: 'autelrobotics.com/',           isOAuth: true  },
  airmap:         { startUrl: 'https://app.airmap.com',                          signInUrl: 'https://app.airmap.com/login',                      authSuccessPattern: 'app.airmap.com/',              isOAuth: true  },
  dronelogbook:   { startUrl: 'https://dronelogbook.com',                        signInUrl: 'https://dronelogbook.com/login',                    authSuccessPattern: 'dronelogbook.com/',            isOAuth: true  },
  // ── Public reference / search / e-commerce (no auth required) ─────────────────────────────────────
  stackoverflow:  { startUrl: 'https://stackoverflow.com',                      authSuccessPattern: 'stackoverflow.com',            isOAuth: false },
  stackexchange:  { startUrl: 'https://stackexchange.com',                      authSuccessPattern: 'stackexchange.com',            isOAuth: false },
  wikipedia:      { startUrl: 'https://en.wikipedia.org',                       authSuccessPattern: 'wikipedia.org',                isOAuth: false },
  amazon:         { startUrl: 'https://www.amazon.com',                         authSuccessPattern: 'amazon.com',                   isOAuth: false },
  ebay:           { startUrl: 'https://www.ebay.com',                           authSuccessPattern: 'ebay.com',                     isOAuth: false },
  imdb:           { startUrl: 'https://www.imdb.com',                           authSuccessPattern: 'imdb.com',                     isOAuth: false },
  yelp:           { startUrl: 'https://www.yelp.com',                           authSuccessPattern: 'yelp.com',                     isOAuth: false },
  tripadvisor:    { startUrl: 'https://www.tripadvisor.com',                    authSuccessPattern: 'tripadvisor.com',              isOAuth: false },
  biblegateway:   { startUrl: 'https://www.biblegateway.com',                   authSuccessPattern: 'biblegateway.com',             isOAuth: false },
  duckduckgo:     { startUrl: 'https://duckduckgo.com',                         authSuccessPattern: 'duckduckgo.com',               isOAuth: false },
  bing:           { startUrl: 'https://www.bing.com',                           authSuccessPattern: 'bing.com',                     isOAuth: false },
  medium:         { startUrl: 'https://medium.com',                             authSuccessPattern: 'medium.com',                   isOAuth: false },
  quora:          { startUrl: 'https://www.quora.com',                          authSuccessPattern: 'quora.com',                    isOAuth: false },
  hackernews:     { startUrl: 'https://news.ycombinator.com',                   authSuccessPattern: 'news.ycombinator.com',         isOAuth: false },
  arxiv:          { startUrl: 'https://arxiv.org',                              authSuccessPattern: 'arxiv.org',                    isOAuth: false },
  npm:            { startUrl: 'https://www.npmjs.com',                          authSuccessPattern: 'npmjs.com',                    isOAuth: false },
  pypi:           { startUrl: 'https://pypi.org',                               authSuccessPattern: 'pypi.org',                     isOAuth: false },
  craigslist:     { startUrl: 'https://www.craigslist.org',                     authSuccessPattern: 'craigslist.org',               isOAuth: false },
  zillow:         { startUrl: 'https://www.zillow.com',                         authSuccessPattern: 'zillow.com',                   isOAuth: false },
  weather:        { startUrl: 'https://weather.com',                            authSuccessPattern: 'weather.com',                  isOAuth: false },
  googlemaps:     { startUrl: 'https://www.google.com/maps',                    authSuccessPattern: 'google.com/maps',              isOAuth: false },
};

function lookupBrowserService(service) {
  const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const entry = KNOWN_BROWSER_SERVICES[key];
  if (!entry) return null;
  // All seed-map entries are browser-navigable services — inject default capabilities so that
  // deriveAgentType() returns 'browser' for any isOAuth:false entry without an explicit type.
  if (!entry.capabilities) return { ...entry, capabilities: ['navigate', 'interact'] };
  return entry;
}

// ---------------------------------------------------------------------------
// LLM-driven browser service meta resolution — for services not in seed map.
// Result cached in DuckDB so LLM is called at most once per service.
// ---------------------------------------------------------------------------

const BROWSER_DISCOVERY_SYSTEM_PROMPT = `You are a web service knowledge base. Given a service/product name, return structured JSON with exactly four fields.

Output ONLY valid JSON:
{
  "signInUrl": "<URL of the actual login/sign-in form — the page where the user types credentials or clicks OAuth. Set to null for isOAuth=false services.>",
  "startUrl": "<URL of the post-login dashboard or API key settings page>",
  "authSuccessPattern": "<URL substring that reliably appears AFTER successful login>",
  "isOAuth": true | false
}

CRITICAL rules:
- isOAuth=true means the service requires an OAuth browser session (social login, SSO, consent screen). isOAuth=false means the service uses an API key / token from a settings page.
- signInUrl MUST be the actual login form URL, NOT the dashboard. Example: Dropbox signInUrl=https://www.dropbox.com/login (NOT www.dropbox.com). If the service redirects to a separate identity provider (Google, Microsoft, Okta), use that IdP's login URL.
- For isOAuth=false services, set signInUrl to null.
- startUrl is where the agent navigates AFTER login (dashboard, API keys page, etc.).
- Getting isOAuth or signInUrl wrong causes auth flow failures — the agent will navigate to the wrong page and loop forever.`;

// ---------------------------------------------------------------------------
// PLAYBOOK_SEED_MAP — battle-tested task playbooks for known services.
// Keys match the serviceKey (lowercase, alphanumeric only).
// Values are markdown strings using ONLY real playwright-cli action names.
// Available actions (full vocabulary):
//   INPUT:       fill (inputs), type (contenteditable), select (dropdowns),
//                check, uncheck, upload
//   INTERACTION: click, dblclick, hover, drag
//   KEYBOARD:    press, keydown, keyup
//   NAVIGATION:  navigate, go-back, reload, tab-new, tab-select, tab-close
//   OBSERVATION: snapshot (after every DOM change), screenshot, eval
//   EXTRACTION:  run-code (full page.evaluate)
//   DIALOGS:     dialog-accept, dialog-dismiss
//   SCROLL:      mousewheel (dx, dy)
//   RESULT:      return
// Each ### section header contains task keywords used by _resolvePlaybook() for matching.
// ---------------------------------------------------------------------------
const PLAYBOOK_SEED_MAP = {
  gmail: `### Compose & Send Email (compose, send, email, draft, write, message)
1. Click the Compose button: { "action": "click", "selector": "div[gh='cm']" }
2. Wait for compose window: { "action": "snapshot" }
3. Fill recipient — CHIP CONFIRMATION REQUIRED:
   { "action": "fill", "selector": "input[name='to'],textarea[name='to']", "text": "<recipient email>" }
   { "action": "press", "key": "Enter" }
   { "action": "snapshot" }
   RULE: After fill+Enter on To field, always snapshot. If the address is still in the input field (not converted to a chip/token), press Enter again and snapshot again before continuing to Subject.
4. Fill subject: { "action": "fill", "selector": "input[name='subjectbox']", "text": "<subject>" }
5. Click body to focus: { "action": "click", "selector": "div[aria-label='Message Body']" }
6. Type body text: { "action": "type", "text": "<body>" }
7. Safety snapshot before sending: { "action": "snapshot" }
8. Click Send with verification: { "action": "sendEmailWithVerification", "selector": "div[data-tooltip*='Send'],div[aria-label*='Send']" }

### Read Inbox (read, inbox, emails, messages, check, list, unread)
Extract up to 15 inbox rows using page.evaluate with Gmail's stable CSS selectors:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const rows=Array.from(document.querySelectorAll('tr.zA')).slice(0,5); if(!rows.length) return 'No emails found'; return rows.map((r,i)=>{ const s=r.querySelector('.yX span,.zF')?.innerText||''; const sub=r.querySelector('.bog,.bqe')?.innerText||''; const snip=r.querySelector('.y2')?.innerText||''; const t=r.querySelector('.xW span')?.innerText||''; return 'Email '+(i+1)+': From='+s+' | Subject='+sub+' | Preview='+snip+' | Time='+t; }).join('\\n'); }); }" }

### Search Emails (search, find, look for, from, subject, filter)
1. Click search box: { "action": "click", "selector": "input[aria-label*='Search']" }
2. Type query: { "action": "type", "text": "<search query>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Wait for results: { "action": "snapshot" }
5. Extract results (same selectors as Read Inbox above)`,

  outlook: `### Compose & Send Email (compose, send, email, draft, write, message)
1. Click New mail: { "action": "click", "selector": "button[aria-label='New mail'],span[data-icon-name='ComposeRegular']" }
2. Wait for compose: { "action": "snapshot" }
3. Fill recipient — press Enter to confirm chip:
   { "action": "fill", "selector": "div[aria-label='To']", "text": "<recipient>" }
   { "action": "press", "key": "Enter" }
   { "action": "snapshot" }
4. Fill subject: { "action": "fill", "selector": "input[aria-label='Subject']", "text": "<subject>" }
5. Click body: { "action": "click", "selector": "div[aria-label*='Message body']" }
6. Type body: { "action": "type", "text": "<body>" }
7. Click Send: { "action": "click", "selector": "button[aria-label='Send']" }

### Read Inbox (read, inbox, emails, check, list, unread)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const rows=Array.from(document.querySelectorAll('div[role=listitem]')).slice(0,5); return rows.map((r,i)=>{ const s=r.querySelector('.luvU6')?.innerText||''; const sub=r.querySelector('.nDYNg')?.innerText||''; const snip=r.querySelector('.SibTc')?.innerText||''; return 'Email '+(i+1)+': From='+s+' | Subject='+sub+' | Preview='+snip; }).join('\\n'); }); }" }`,

  notion: `### Create New Page (create, new page, add page, write)
1. Click new page in sidebar: { "action": "click", "selector": "div[data-testid='sidebar-new-page'],a[aria-label='Add a page']" }
2. Snapshot to confirm page opened: { "action": "snapshot" }
3. Type page title: { "action": "type", "text": "<page title>" }
4. Press Enter to start body: { "action": "press", "key": "Enter" }
5. Type body content: { "action": "type", "text": "<content>" }

### Search Workspace (search, find, look for, page)
1. Click search: { "action": "click", "selector": "div[aria-label='Search'],button[data-testid='search-button']" }
2. Fill search: { "action": "fill", "selector": "input[placeholder*='Search']", "text": "<query>" }
3. Snapshot results: { "action": "snapshot" }`,

  slack: `### Send Message to Channel (send, message, post, write, channel, dm, direct)
1. Navigate to channel (or use sidebar): { "action": "click", "selector": "a[data-qa*='channel_sidebar_name']" }
2. Click message composer: { "action": "click", "selector": "div[data-qa='message_input']" }
3. Type message: { "action": "type", "text": "<message>" }
4. Press Enter to send: { "action": "press", "key": "Enter" }

### Read Channel Messages (read, messages, check, latest, history)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('.c-message__body')).slice(-5); return msgs.map((m,i)=>'Msg '+(i+1)+': '+m.innerText).join('\\n'); }); }" }`,

  github: `### Navigate to Repository (navigate, open, go to, repo, repository)
1. Navigate directly: { "action": "navigate", "url": "https://github.com/<owner>/<repo>" }
2. Snapshot: { "action": "snapshot" }

### Create Issue (create, issue, bug, report, ticket, open issue)
1. Navigate to new issue: { "action": "navigate", "url": "https://github.com/<owner>/<repo>/issues/new" }
2. Fill title: { "action": "fill", "selector": "input#issue_title", "text": "<title>" }
3. Click body area: { "action": "click", "selector": "div.CodeMirror,textarea#issue_body" }
4. Type body: { "action": "type", "text": "<body>" }
5. Submit: { "action": "click", "selector": "button[data-disable-with*='Submitting']" }
NOTE: Prefer gh CLI for most GitHub operations — use browser only when CLI is unavailable.`,

  reddit: `### Submit Text Post (submit, post, create, write, share)
1. Navigate to submit: { "action": "navigate", "url": "https://www.reddit.com/r/<subreddit>/submit" }
2. Click Text tab: { "action": "click", "selector": "button[id*='post-type-link-text'],button[aria-label='Text']" }
3. Fill title: { "action": "fill", "selector": "textarea[placeholder='Title']", "text": "<title>" }
4. Click body editor: { "action": "click", "selector": "div.public-DraftEditor-content,div[contenteditable=true]" }
5. Type body: { "action": "type", "text": "<body>" }
6. Submit: { "action": "click", "selector": "button[data-testid='submit-button'],button:has-text('Post')" }

### Read Feed / Posts (read, feed, posts, subreddit, list, browse)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const posts=Array.from(document.querySelectorAll('article,shreddit-post')).slice(0,5); return posts.map((p,i)=>{ const t=p.querySelector('a[slot=full-post-link],[data-testid=post-title]')?.innerText||''; return 'Post '+(i+1)+': '+t; }).join('\\n'); }); }" }`,

  todoist: `### Add Task (add, create, task, todo, reminder, new task)
1. Click add task: { "action": "click", "selector": "button[data-testid='add-task-button'],button[aria-label*='Add task']" }
2. Snapshot: { "action": "snapshot" }
3. Fill task name: { "action": "fill", "selector": "div[aria-label='Task name'],input[data-testid='task-editor-field']", "text": "<task name>" }
4. Press Enter to save: { "action": "press", "key": "Enter" }

### List Tasks (list, tasks, show, view, today)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { return Array.from(document.querySelectorAll('.task_content,[data-testid=task-content]')).map((t,i)=>'Task '+(i+1)+': '+t.innerText).join('\\n'); }); }" }`,

  twitter: `### Compose Tweet (tweet, post, write, share, compose)
1. Click new tweet button: { "action": "click", "selector": "a[data-testid='SideNav_NewTweet_Button'],button[data-testid='tweetButtonInline']" }
2. Snapshot: { "action": "snapshot" }
3. Click tweet textarea: { "action": "click", "selector": "div[data-testid='tweetTextarea_0']" }
4. Type tweet: { "action": "type", "text": "<tweet text>" }
5. Submit: { "action": "click", "selector": "button[data-testid='tweetButton'],button[data-testid='tweetButtonInline']" }

### Read Timeline / Feed (read, timeline, feed, tweets, posts)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const tweets=Array.from(document.querySelectorAll('article[data-testid=tweet]')).slice(0,5); return tweets.map((t,i)=>{ const u=t.querySelector('div[data-testid=User-Name]')?.innerText||''; const body=t.querySelector('div[data-testid=tweetText]')?.innerText||''; return 'Tweet '+(i+1)+': '+u+' → '+body; }).join('\\n'); }); }" }`,

  chatgpt: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate, write, help)
1. Click prompt input: { "action": "click", "selector": "div#prompt-textarea,div[contenteditable][data-id]" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter to submit: { "action": "press", "key": "Enter" }
4. Snapshot to wait for response to begin: { "action": "snapshot" }
5. Extract last assistant response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('[data-message-author-role=assistant]')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  claude: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate, write, help)
1. Click input area: { "action": "click", "selector": "div.ProseMirror[contenteditable=true],div[data-testid='chat-input']" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Snapshot: { "action": "snapshot" }
5. Extract response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('[data-testid=assistant-message],[data-is-streaming=false]')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  grok: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate)
1. Click input: { "action": "click", "selector": "textarea[placeholder*='Ask'],div[contenteditable=true]" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Snapshot: { "action": "snapshot" }
5. Extract response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('.response-content,.message-content,[data-message-role=assistant]')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  gemini: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate)
1. Click input: { "action": "click", "selector": "div[contenteditable=true][aria-label*='Enter'],div.ql-editor" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Snapshot: { "action": "snapshot" }
5. Extract response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('model-response,message-content')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  youtube: `### Search Videos (search, find, lookup, video, sourdough, tutorial, how to)
1. Navigate directly to search results: { "action": "navigate", "url": "https://www.youtube.com/results?search_query=<encoded_query>" }
2. Wait for results to load: { "action": "waitForStableText" }
3. Read search results: { "action": "getPageText" }
4. Extract video links: { "action": "getPageLinks" }
NOTE: Use /results?search_query= URL directly — it is more reliable than click+fill+Enter (avoids autocomplete dropdown timing issues). Encode spaces as + in the query.

### Watch Video (watch, play, view, open, specific video)
1. Navigate to video URL: { "action": "navigate", "url": "<video_url>" }
2. Wait for page to load: { "action": "waitForStableText" }
3. Read video page content: { "action": "getPageText" }
4. Extract video metadata and links: { "action": "getPageLinks" }

### Extract Video Content (watch and tell me about it, tell me about, tell me what, describe it, describe the video, explain it, give me a summary, watch and summarize, extract, steps, transcript, tutorial, learn, summarize, content, analyze)
DELEGATE_TO: video.agent
PLATFORM: youtube
INSTRUCTION: Use video.agent to find and watch tutorial videos, extracting actionable steps and content via page metadata + audio transcription.

### Browse Feed / Subscriptions (subscriptions, feed, home, browse, latest)
1. Navigate to YouTube feed: { "action": "navigate", "url": "https://www.youtube.com/feed/subscriptions" }
2. Wait for feed to load: { "action": "waitForStableText" }
3. Read feed content: { "action": "getPageText" }`,
};

// ---------------------------------------------------------------------------
// PLAYBOOK_BUILD_PROMPT — LLM prompt for generating playbooks for unknown
// services at build time. Fires once, cached in DuckDB. ~600 tokens output.
// ---------------------------------------------------------------------------
const PLAYBOOK_BUILD_PROMPT = `You are a browser automation expert. Generate step-by-step playbooks for automating a web service using playwright-cli.

You MUST use ONLY these action names in your steps (no others):

INPUT
  fill        — { "action": "fill", "selector": "...", "text": "..." }           — standard <input> / <textarea>
  type        — { "action": "type", "text": "..." }                              — contenteditable / rich-text (no selector)
  select      — { "action": "select", "selector": "...", "value": "..." }        — <select> dropdowns
  check       — { "action": "check", "selector": "..." }                         — checkboxes / radio buttons
  uncheck     — { "action": "uncheck", "selector": "..." }                       — uncheck a checkbox
  upload      — { "action": "upload", "selector": "...", "files": ["/abs/path"] } — attach file(s): clicks selector to open the chooser, then uses playwright-cli upload command for each file. selector = attach button ref from snapshot; files = absolute local file paths array.

DOM INTERACTION
  click       — { "action": "click", "selector": "..." }
  dblclick    — { "action": "dblclick", "selector": "..." }                      — double-click (inline edit, expand)
  hover       — { "action": "hover", "selector": "..." }                         — reveal hover menus / tooltips
  drag        — { "action": "drag", "startSelector": "...", "endSelector": "..." } — drag-and-drop

KEYBOARD
  press       — { "action": "press", "key": "Enter" }                            — Enter, Escape, Tab, ArrowDown, etc.
  keydown     — { "action": "keydown", "key": "Shift" }                          — hold modifier before click
  keyup       — { "action": "keyup", "key": "Shift" }                            — release modifier

NAVIGATION
  navigate    — { "action": "navigate", "url": "..." }
  go-back     — { "action": "go-back" }                                          — browser back
  reload      — { "action": "reload" }                                           — reload current page
  tab-new     — { "action": "tab-new", "url": "..." }                            — open new tab
  tab-select  — { "action": "tab-select", "index": 0 }                           — switch tab
  tab-close   — { "action": "tab-close", "index": 0 }                            — close tab

OBSERVATION  (ALWAYS snapshot after any DOM change before the next action)
  snapshot          — { "action": "snapshot" }                                         — re-reads live DOM / ARIA tree
  screenshot        — { "action": "screenshot" }                                       — capture visual screenshot
  eval              — { "action": "eval", "expression": "document.title" }             — lightweight JS (no page.evaluate wrapper)
  waitForStableText — { "action": "waitForStableText" }                                — wait until page text stops changing (use after navigate on dynamic/JS-rendered pages, after search, after pressing Enter)
  getPageText       — { "action": "getPageText" }                                      — read all visible page text as plain string (use after waitForStableText to capture search results, listings, or content)

DATA EXTRACTION
  run-code    — { "action": "run-code", "code": "async page => { return await page.evaluate(() => ...) }" }

CONTENT EXTRACTION RULE: For any playbook that navigates to a search results page or a dynamic content page, ALWAYS end with { "action": "waitForStableText" } followed by { "action": "getPageText" } so the results are captured and returned to the user. Without getPageText, the task result will be empty.

DIALOGS
  dialog-accept  — { "action": "dialog-accept" }                                 — confirm / OK dialogs
  dialog-dismiss — { "action": "dialog-dismiss" }                                — cancel / dismiss dialogs

SCROLL
  mousewheel  — { "action": "mousewheel", "dx": 0, "dy": 500 }                  — scroll down (positive dy); up (negative dy)

RESULT
  return      — { "action": "return", "data": "..." }                            — emit final result

Generate 2-4 playbooks covering the most common tasks for this service.
Format each playbook as a ### section with task keywords in parentheses in the header.

Example format:
### Send Message (send, message, post, write)
1. Click compose button: { "action": "click", "selector": "button[aria-label='Compose']" }
2. Wait for modal: { "action": "snapshot" }
3. Fill recipient: { "action": "fill", "selector": "input[placeholder='To']", "text": "<recipient>" }
4. Type body: { "action": "type", "text": "<message>" }
5. Click Send: { "action": "click", "selector": "button:has-text('Send')" }

### Read Messages (read, messages, inbox, check)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { return Array.from(document.querySelectorAll('.message')).slice(0,5).map(m=>m.innerText).join('\\n'); }); }" }

IMPORTANT:
- Use CSS attribute selectors and ARIA labels — they are more stable than class names
- For form fields that create chips/tokens (like email To fields), always fill + press Enter + snapshot before continuing
- For contenteditable rich-text areas use type, not fill
- After hover/dblclick/click that opens a menu or modal, always snapshot before the next action
- Keep selectors as generic/semantic as possible since you don't have a live DOM
- Output ONLY the ### playbook sections — no preamble, no explanation`;

// ---------------------------------------------------------------------------
// PLAYBOOK_RUNTIME_COT_PROMPT — LLM prompt for generating a single playbook
// for a novel goal at runtime (Chain-of-Thought with few-shot examples).
// Output is one ### section; appended to descriptor for future reuse.
// ---------------------------------------------------------------------------
const PLAYBOOK_RUNTIME_COT_PROMPT = `You are a browser automation expert. A user wants to accomplish a specific goal on a web service.

You will receive:
- SERVICE: the service name
- START_URL: the service's base URL
- GOAL: what the user wants to accomplish
- EXISTING_PLAYBOOKS: 1-2 example playbooks for OTHER tasks on this service (use these as FORMAT REFERENCES only)
- EXECUTION_RESULT (optional): what the agent actually observed/did when it ran this goal successfully.
  If present, use it to ground your selectors and steps — it reflects the real DOM.

Your job: generate ONE new playbook for the GOAL using the exact same format and action vocabulary as the examples.

You MUST use ONLY these action names (full playwright-cli vocabulary):
  INPUT:       fill (inputs), type (contenteditable), select (dropdowns), check, uncheck, upload
  INTERACTION: click, dblclick, hover, drag
  KEYBOARD:    press, keydown, keyup
  NAVIGATION:  navigate, go-back, reload, tab-new, tab-select, tab-close
  OBSERVATION: snapshot (after EVERY DOM change), screenshot, eval
  EXTRACTION:  run-code (async page => { return await page.evaluate(() => ...) })
  DIALOGS:     dialog-accept, dialog-dismiss
  SCROLL:      mousewheel (dx, dy)
  RESULT:      return

Chain-of-thought approach:
1. What page/view does this goal start from?
2. What is the first action (click, navigate, hover to reveal a menu)?
3. Does the DOM change after that action? If yes → snapshot.
4. What fields need filling? Use fill for <input>/<textarea>, type for contenteditable.
5. Are there chip/token confirmation steps? Fill + press Enter + snapshot + verify chip exists.
6. Does the task involve drag, scroll-to-load, multi-select, or dialog confirmation?
7. What is the final action (submit, press Enter, click Save)?
8. Does the goal require reading data back? If yes → run-code with page.evaluate.

Format your response as a single ### section:
### <Task Name> (<keyword1>, <keyword2>, <keyword3>)
<numbered steps or single run-code block>

IMPORTANT:
- The ### header keywords are used for future matching — make them comprehensive and relevant
- Do NOT repeat steps from the existing playbooks — generate only what GOAL requires
- Output ONLY the ### section — no preamble, no explanation`;

// ---------------------------------------------------------------------------
// _resolvePlaybook — 3-tier goal-aware playbook selection.
// Returns: { tier, section, subsections }
//   tier 1: keyword match found     — section = matched ### block
//   tier 3: no match                — section = null, subsections = all ### blocks (for COT)
// ---------------------------------------------------------------------------
function _resolvePlaybook(descriptor, task, agentId) {
  if (!descriptor || !task) return { tier: 3, section: null, subsections: [] };

  // No `m` flag — `$` must match end-of-string to capture the full Playbooks block
  const playbookMatch = descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
  if (!playbookMatch) return { tier: 3, section: null, subsections: [] };

  const playbookBody = playbookMatch[1].trim();
  // Split into ### subsections, keeping the header with each block
  const subsections = playbookBody.split(/(?=### )/).map(s => s.trim()).filter(Boolean);
  if (subsections.length === 0) return { tier: 3, section: null, subsections: [] };

  const taskLower = task.toLowerCase();
  const matched = [];
  for (const sub of subsections) {
    const headerLine = sub.split('\n')[0]; // e.g. "### Compose & Send Email (compose, send, email, ...)"
    // Extract keywords from parentheses in header, plus individual words from the header title
    const parenMatch = headerLine.match(/\(([^)]+)\)/);
    const keywords   = parenMatch
      ? parenMatch[1].split(',').map(k => k.trim().toLowerCase())
      : headerLine.replace(/^###\s*/, '').toLowerCase().split(/\W+/).filter(k => k.length > 3);

    if (keywords.some(kw => kw && taskLower.includes(kw))) {
      matched.push(sub);
    }
  }

  if (matched.length > 0) {
    // Join all matching sections — compound tasks (e.g. "find and delete") get both playbooks
    return { tier: 1, section: matched.join('\n\n'), subsections };
  }

  return { tier: 3, section: null, subsections };
}

// ---------------------------------------------------------------------------
// _isPureSearchTask — true when the task is just a search/lookup and does not
// ask to watch, play, summarize, extract, or otherwise consume a video.
// ---------------------------------------------------------------------------
function _isPureSearchTask(task) {
  if (!task) return false;
  const t = task.toLowerCase();
  // Must be a search/lookup request
  const hasSearchVerb = /\b(search|find|look up|lookup)\b/.test(t);
  if (!hasSearchVerb) return false;
  // Must NOT ask for video consumption/extraction/analysis
  const videoExtraction = /\b(watch|play|view|open|summarize|summarise|extract|describe|explain|analyze|analyse|learn from|transcript|steps|content)\b/.test(t);
  if (videoExtraction) return false;
  return true;
}

// ---------------------------------------------------------------------------
// _cosineSim — dot-product cosine similarity between two equal-length vectors.
// ---------------------------------------------------------------------------
function _cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// _resolvePlaybookSemantic — semantic embedding-based playbook selection.
// Calls /memory.embed on the user-memory service (port 3001) to get vectors
// for the task + all playbook headers, computes cosine similarity in-process,
// and returns the best-matching section(s).
// Falls back to keyword-based _resolvePlaybook() if the embedding service is
// unreachable or returns no results.
// ---------------------------------------------------------------------------
const _MEMORY_EMBED_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const _MEMORY_EMBED_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const _MEMORY_EMBED_KEY  = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

async function _resolvePlaybookSemantic(agentId, descriptor, task) {
  if (!descriptor || !task) return _resolvePlaybook(descriptor, task, agentId);

  // Sanitize: strip DELEGATE_TO: video.agent playbook blocks from non-video agents.
  // This cleans up descriptors that were polluted by old LLM prompts without a DB migration.
  const _serviceKey = (agentId || '').replace('.agent', '').toLowerCase();
  if (!VIDEO_PLATFORMS.has(_serviceKey) && descriptor.includes('DELEGATE_TO: video.agent')) {
    descriptor = descriptor
      .split(/(?=\n### )/)
      .filter(block => !block.includes('DELEGATE_TO: video.agent'))
      .join('');
    logger.debug(`[browser.agent] _resolvePlaybookSemantic: stripped video.agent DELEGATE_TO from non-video descriptor for ${agentId}`);
  }

  const playbookMatch = descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
  if (!playbookMatch) return _resolvePlaybook(descriptor, task, agentId);

  const subsections = playbookMatch[1].trim()
    .split(/(?=### )/).map(s => s.trim()).filter(Boolean);
  if (subsections.length === 0) return _resolvePlaybook(descriptor, task, agentId);

  const headers = subsections.map(s => s.split('\n')[0]);

  try {
    const body = JSON.stringify({
      version: 'mcp.v1',
      requestId: `embed_${Date.now()}`,
      action: 'memory.embed',
      payload: { texts: [task, ...headers] },
    });

    const embedResult = await new Promise((resolve) => {
      const req = http.request({
        hostname: _MEMORY_EMBED_HOST,
        port: _MEMORY_EMBED_PORT,
        path: '/memory.embed',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${_MEMORY_EMBED_KEY}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

    const vectors = embedResult?.result?.embeddings || embedResult?.embeddings;
    if (!Array.isArray(vectors) || vectors.length < 2) {
      return _resolvePlaybook(descriptor, task, agentId);
    }

    const [taskVec, ...headerVecs] = vectors;

    const scored = headers.map((h, i) => ({
      score:         _cosineSim(taskVec, headerVecs[i] || []),
      section:       subsections[i],
      hasDelegation: subsections[i].includes('DELEGATE_TO:'),
    })).sort((a, b) => b.score - a.score);

    logger.info(`[browser.agent] _resolvePlaybookSemantic: top scores for ${agentId} — ${scored.slice(0, 3).map(s => `"${s.section.split('\n')[0].slice(0, 50)}" (${s.score.toFixed(3)})`).join(', ')}`);

    // Delegate only if the best-scoring DELEGATE_TO playbook is for a video platform
    const delegateMatch = scored.find(s => s.hasDelegation && s.score >= 0.30);
    if (delegateMatch) {
      const _delegatePlatform = (delegateMatch.section.match(/PLATFORM:\s*(\S+)/) || [])[1] || '';
      const _serviceKey = (agentId || '').replace('.agent', '').toLowerCase();
      if (VIDEO_PLATFORMS.has(_delegatePlatform.toLowerCase()) || VIDEO_PLATFORMS.has(_serviceKey)) {
        logger.info(`[browser.agent] _resolvePlaybookSemantic: delegation match → "${delegateMatch.section.split('\n')[0]}" (score=${delegateMatch.score.toFixed(3)})`);
        return { tier: 1, section: delegateMatch.section, subsections };
      }
      logger.info(`[browser.agent] _resolvePlaybookSemantic: ignored DELEGATE_TO for non-video agent ${agentId} (score=${delegateMatch.score.toFixed(3)})`);
    }

    // Collect all sections above threshold (compound tasks get multiple sections)
    const matched = scored.filter(s => s.score >= 0.35).map(s => s.section);
    if (matched.length > 0) {
      return { tier: 1, section: matched.join('\n\n'), subsections };
    }

    return { tier: 3, section: null, subsections };

  } catch (_semErr) {
    logger.warn(`[browser.agent] _resolvePlaybookSemantic: embedding call failed (${_semErr.message}) — falling back to keyword scan`);
    return _resolvePlaybook(descriptor, task, agentId);
  }
}

// ---------------------------------------------------------------------------
// _generateAndCachePlaybook — COT runtime playbook generation.
// Generates one ### section for a novel goal, appends to descriptor in DuckDB + disk.
// Non-blocking write-back; returns the generated section (or null on failure).
// ---------------------------------------------------------------------------
async function _generateAndCachePlaybook(agentId, descriptor, task, subsections, executionResult) {
  try {
    // Pick up to 2 shortest subsections as few-shot examples
    const examples = [...subsections]
      .sort((a, b) => a.length - b.length)
      .slice(0, 2)
      .join('\n\n');

    // Extract startUrl from descriptor frontmatter
    const urlLine  = (descriptor || '').split('\n').find(l => l.startsWith('start_url:'));
    const startUrl = urlLine ? urlLine.replace('start_url:', '').trim() : '';
    const serviceLine = (descriptor || '').split('\n').find(l => l.startsWith('service:'));
    const service  = serviceLine ? serviceLine.replace('service:', '').trim() : agentId;

    // If we have a real execution result (post-execution write-back path), include it as
    // grounding context. The LLM can generate selectors from what the agent actually observed.
    const resultCtx = executionResult
      ? `\n\nEXECUTION_RESULT (what the agent observed/did successfully):\n${String(executionResult).slice(0, 800)}`
      : '';

    const userQuery = `SERVICE: ${service}\nSTART_URL: ${startUrl}\nGOAL: ${task}\n\nEXISTING_PLAYBOOKS:\n${examples}${resultCtx}`;
    const raw = await callLLM(PLAYBOOK_RUNTIME_COT_PROMPT, userQuery, { temperature: 0.2, maxTokens: 500 });
    if (!raw || !raw.includes('###')) return null;

    // Extract the ### block
    const sectionMatch = raw.match(/(###[\s\S]+)/);
    if (!sectionMatch) return null;
    const newSection = sectionMatch[1].trim();

    // Append to descriptor — fire-and-forget write-back (non-blocking for caller)
    setImmediate(async () => {
      try {
        let updatedDescriptor;
        if (descriptor.includes('\n## Playbooks\n')) {
          updatedDescriptor = descriptor.trimEnd() + '\n\n' + newSection;
        } else {
          updatedDescriptor = descriptor.trimEnd() + '\n\n## Playbooks\n' + newSection;
        }
        const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
        fs.writeFileSync(mdPath, updatedDescriptor, 'utf8');
        await withDb(async (db) => {
          await db.run('UPDATE agents SET descriptor = ? WHERE id = ?', updatedDescriptor, agentId);
        });
        logger.info(`[browser.agent] _generateAndCachePlaybook: cached new playbook for ${agentId} — goal="${task}"`);
      } catch (writeErr) {
        logger.warn(`[browser.agent] _generateAndCachePlaybook: write-back failed for ${agentId}: ${writeErr.message}`);
      }
    });

    return newSection;
  } catch (err) {
    logger.warn(`[browser.agent] _generateAndCachePlaybook: LLM error for ${agentId}: ${err.message}`);
    return null;
  }
}

async function resolveBrowserMeta(service) {
  const seedKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. DuckDB agent descriptor — highest priority (validate_agent writes corrections here).
  //    Extract startUrl and signInUrl from the stored descriptor frontmatter so any
  //    URL corrections validate_agent made are immediately visible to callers.
  try {
    const agentResult = await withDb(async (db) => {
      const rows = await db.all(
        'SELECT descriptor, capabilities FROM agents WHERE id = ?', `${seedKey}.agent`
      ).catch(() => null);
      if (rows && rows.length > 0 && rows[0].descriptor) {
        const desc = rows[0].descriptor;
        const startUrl  = extractDescriptorUrl(desc, 'start_url');
        const signInUrl = extractDescriptorUrl(desc, 'sign_in_url');
        const authSuccessPattern = extractDescriptorUrl(desc, 'auth_success_pattern');
        if (startUrl) {
          const seed = KNOWN_BROWSER_SERVICES[seedKey] || {};
          const isOAuthFromDesc = /^is_oauth:\s*true/m.test(desc);
          return {
            ...seed,
            startUrl,
            ...(signInUrl ? { signInUrl } : {}),
            authSuccessPattern: authSuccessPattern || seed.authSuccessPattern || seedKey,
            ...(isOAuthFromDesc ? { isOAuth: true } : {}),
          };
        }
      }
      return null;
    });
    if (agentResult) return agentResult;
  } catch {}

  // 2. DuckDB meta cache (LLM discovery result cached here for unknown services)
  try {
    const cachedMeta = await withDb(async (db) => {
      const rows = await db.all(
        "SELECT meta_json FROM browser_meta_cache WHERE service = ?", seedKey
      ).catch(() => null);
      if (rows && rows.length > 0) {
        try { return JSON.parse(rows[0].meta_json); } catch {}
      }
      return null;
    });
    if (cachedMeta) return cachedMeta;
  } catch {}

  // 3. Seed map — bootstrap fallback only (cold-start before any agent has been built)
  const fromSeed = KNOWN_BROWSER_SERVICES[seedKey];
  if (fromSeed) return fromSeed;

  // 4. LLM discovery with web_search grounding
  logger.info(`[browser.agent] resolveBrowserMeta: LLM lookup for "${service}"`);

  // 4a. web_search grounding (non-blocking, 5s cap) — gives LLM real signal about auth type
  let searchSnippets = '';
  try {
    searchSnippets = await Promise.race([
      agentWebSearch(`${service} authentication type OAuth API key login URL`),
      new Promise(r => setTimeout(() => r(''), 5000))
    ]);
  } catch {}

  // 4b. Keyword heuristic vote — OAuth vs API key based on search snippet text
  const snippetLower = (searchSnippets || '').toLowerCase();
  const oauthKeywords  = ['oauth', 'sign in with', 'sso', 'openid connect', 'social login'];
  const apikeyKeywords = ['api key', 'api token', 'bearer token', '/settings/api', 'access token', 'secret key'];
  const votesOAuth   = oauthKeywords.filter(kw => snippetLower.includes(kw)).length;
  const votesApiKey  = apikeyKeywords.filter(kw => snippetLower.includes(kw)).length;

  // 4c. Grounded LLM call — search snippets injected as context when available
  const groundedQuery = searchSnippets
    ? `Web search results:\n${searchSnippets.slice(0, 800)}\n\nService: ${service}`
    : `Service: ${service}`;
  const raw = await callLLM(
    BROWSER_DISCOVERY_SYSTEM_PROMPT,
    groundedQuery,
    { temperature: 0.1, maxTokens: 300 }
  );

  let meta = null;
  if (raw) {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) meta = JSON.parse(match[0]);
    } catch {}
  }

  // 4d. Cross-validate isOAuth: trust keyword heuristic over LLM when they conflict
  if (meta && searchSnippets && (votesOAuth > 0 || votesApiKey > 0)) {
    const heuristicSaysApiKey = votesApiKey > votesOAuth;
    const heuristicSaysOAuth  = votesOAuth  > votesApiKey;
    if (heuristicSaysApiKey && meta.isOAuth === true) {
      meta.isOAuth = false;
      logger.warn(`[browser.agent] isOAuth conflict for "${service}": LLM=true but search suggests api_key → correcting to false`);
    } else if (heuristicSaysOAuth && meta.isOAuth === false) {
      meta.isOAuth = true;
      logger.warn(`[browser.agent] isOAuth conflict for "${service}": LLM=false but search suggests OAuth → correcting to true`);
    }
  }

  if (!meta || !meta.startUrl) {
    meta = {
      startUrl: `https://${seedKey}.com`,
      authSuccessPattern: `${seedKey}.com`,
      capabilities: ['navigate', 'interact'],
      isOAuth: false,
    };
  }

  // 5. cache in DuckDB
  try {
    await withDb(async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS browser_meta_cache (
          service     TEXT PRIMARY KEY,
          meta_json   TEXT NOT NULL,
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).catch(() => {});
      await db.run(
        "INSERT OR REPLACE INTO browser_meta_cache (service, meta_json, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        seedKey, JSON.stringify(meta)
      );
    });
  } catch {}

  return meta;
}

// ---------------------------------------------------------------------------
// browser.act HTTP helper (calls the same command-service, avoids circular dep
// by using HTTP since we are already inside command-service process)
// ---------------------------------------------------------------------------

function callBrowserAct(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'browser.act', args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('browser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('browser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// agentbrowser.act HTTP helper — same transport, different skill name
function callAgentbrowserAct(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'agentbrowser.act', args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('agentbrowser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('agentbrowser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


// ---------------------------------------------------------------------------
// Agent type derivation — pure function, priority order:
//   1. meta.type           (explicit override from descriptor or seed map)
//   2. isOAuth: true        (OAuth-gated session services — always need browser)
//   3. navigate/interact caps (browser UI signal — any web app that is navigated)
//   4. default: 'api_key'  (safe fallback for pure REST endpoints with no browser UI)
// NOTE: isOAuth:false alone does NOT imply api_key — it only controls _skipInitialAuth.
// ---------------------------------------------------------------------------
function deriveAgentType(meta) {
  if (meta?.type) return meta.type;
  if (meta?.isOAuth === true) return 'browser';
  const caps = Array.isArray(meta?.capabilities) ? meta.capabilities : [];
  if (caps.some(c => c === 'navigate' || c === 'interact')) return 'browser';
  return 'api_key';
}

// ---------------------------------------------------------------------------
// Action: build_agent
// ---------------------------------------------------------------------------

function buildBrowserDescriptorMd({ id, service, startUrl, signInUrl, authSuccessPattern, capabilities, type = 'browser', playbooks = null, goals = null }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  const goalsYaml = goals && goals.length > 0
    ? goals.map(g => `  - "${g.replace(/"/g, '\\"')}"`).join('\n')
    : '  - "General task automation"';
  const parts = [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `service: ${service}`,
    ...(signInUrl ? [`sign_in_url: ${signInUrl}`] : []),
    `start_url: ${startUrl}`,
    `auth_success_pattern: ${authSuccessPattern}`,
    `capabilities:`,
    capYaml,
    `user_goals:`,
    goalsYaml,
    `learned_states: []`,
    `trained_skills: []`,
    '---',
    `# start_url is the service home/dashboard (used as auth entry point and post-auth navigation target).`,
    '',
    `## Instructions`,
    `Use Playwright via browser.act skill for all ${service} operations.`,
    `Session is persistent — use profile: "${service}_agent" so the user logs in once.`,
    `Always start navigation from: ${startUrl}`,
    '',
    `## Auth`,
    `Use action:waitForAuth with url="${signInUrl || startUrl}" and authSuccessUrl="${authSuccessPattern}".`,
    `Once authenticated, the session is stored at ~/.thinkdrop/browser-sessions/${service}_agent/`,
    '',
    `## Navigation Patterns`,
    `Use { "action": "snapshot" } to read the current DOM state before interacting.`,
    `Use { "action": "navigate", "url": "..." } to go to specific URLs.`,
    `Use { "action": "click", "selector": "..." } with ref from snapshot.`,
    `Use { "action": "fill", "selector": "...", "text": "..." } for standard text inputs and form fields.`,
    `Use { "action": "type", "text": "..." } for contenteditable areas (email body, chat prompts, rich-text editors).`,
    `Use { "action": "press", "key": "..." } for keyboard actions (Enter=confirm/submit, Escape=close, Tab=autocomplete).`,
    `Use { "action": "run-code", "code": "async page => { return await page.evaluate(() => ...) }" } to extract DOM data.`,
  ];
  if (playbooks) {
    parts.push('', '## Playbooks', playbooks);
  }
  return parts.join('\n');
}

async function actionBuildAgent({ service, startUrl: explicitUrl, force = false, goals = null }) {
  if (!service) return { ok: false, error: 'service is required' };

  const serviceKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');
  const agentId    = `${serviceKey}.agent`;

  // Resolve via LLM if not in seed map — never hard-fail on unknown service
  const meta = await resolveBrowserMeta(service);

  const startUrl           = explicitUrl || meta?.startUrl;
  const signInUrl          = meta?.signInUrl || null;
  const authSuccessPattern = meta?.authSuccessPattern || serviceKey;
  const capabilities       = meta?.capabilities || ['navigate', 'interact'];
  // Derive agent type using priority-ordered signals. isOAuth:false alone no longer implies
  // api_key — consumer web apps (chatgpt, gemini, etc.) are always type=browser regardless.
  const agentType = deriveAgentType({ ...meta, capabilities });

  if (!startUrl) {
    return {
      ok: false,
      error: `Could not determine start URL for service "${service}". Pass startUrl: explicitly.`,
    };
  }

  // Check registry — skip rebuild unless forced.
  // Always rebuild if the stored type differs from the computed agentType so stale descriptors
  // (e.g. Mailgun previously stored as type=browser) are corrected on the next build_agent call.
  if (!force) {
    const existsResult = await withDb(async (db) => {
      const rows = await db.all('SELECT id, type, status FROM agents WHERE id = ?', agentId);
      if (rows && rows.length > 0 && rows[0].status !== 'needs_update' && rows[0].type === agentType) {
        return { alreadyExists: true, status: rows[0].status };
      }
      return null;
    });
    if (existsResult) {
      return { ok: true, agentId, ...existsResult };
    }
  }

  // Resolve playbooks: seed map first, then LLM generation for unknown services.
  // LLM-generated playbooks are marked with a comment so validate_agent can refine them later.
  let playbooks = PLAYBOOK_SEED_MAP[serviceKey] || null;
  let playbooksSource = playbooks ? 'seeded' : null;
  if (!playbooks) {
    try {
      const capList = capabilities.join(', ');
      const buildQuery = `SERVICE: ${serviceKey}\nSTART_URL: ${startUrl}${signInUrl ? '\nSIGN_IN_URL: ' + signInUrl : ''}\nCAPS: ${capList}`;
      const rawPlaybooks = await callLLM(PLAYBOOK_BUILD_PROMPT, buildQuery, { temperature: 0.2, maxTokens: 700 });
      if (rawPlaybooks && rawPlaybooks.includes('###')) {
        // Extract only the ### sections
        const sectionsMatch = rawPlaybooks.match(/(###[\s\S]+)/);
        playbooks = sectionsMatch ? sectionsMatch[1].trim() : null;
        playbooksSource = 'generated';
      }
    } catch (pbErr) {
      logger.warn(`[browser.agent] build_agent: playbook LLM generation failed for ${serviceKey}: ${pbErr.message}`);
    }
  }
  logger.info(`[browser.agent] build_agent: playbooks for ${agentId} — source=${playbooksSource || 'none'}`);

  // Inject video extraction playbook for video-capable platforms (fallback for LLM not generating it)
  if (VIDEO_PLATFORMS.has(serviceKey) && !playbooks?.includes('DELEGATE_TO: video.agent')) {
    const videoPlaybook = `\n\n### Extract Video Content (watch and tell me about it, tell me about, tell me what, describe it, describe the video, explain it, give me a summary, watch and summarize, extract, steps, transcript, tutorial, learn, summarize, content, analyze)\nDELEGATE_TO: video.agent\nPLATFORM: ${serviceKey}\nINSTRUCTION: Use video.agent to find and watch tutorial videos, extracting actionable steps and content via page metadata + audio transcription.`;
    playbooks = (playbooks || '') + videoPlaybook;
    logger.info(`[browser.agent] build_agent: injected video extraction playbook for ${agentId}`);
  }

  // Agent status: LLM-generated playbooks are unverified — mark needs_validation so the first
  // successful run can upgrade to 'healthy'. Seeded playbooks are battle-tested — healthy directly.
  const initialStatus = playbooksSource === 'generated' ? 'needs_validation' : 'healthy';

  const descriptor = buildBrowserDescriptorMd({ id: agentId, service: serviceKey, startUrl, signInUrl, authSuccessPattern, capabilities, type: agentType, playbooks, goals });

  // Write .md to disk
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  // Upsert into DuckDB
  await withDb(async (db) => {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
      agentId,
      agentType,
      serviceKey,
      JSON.stringify(capabilities),
      descriptor,
      initialStatus
    );
  });

  logger.info(`[browser.agent] built agent: ${agentId}`, { capabilities });
  return {
    ok: true,
    agentId,
    alreadyExists: false,
    service: serviceKey,
    startUrl,
    capabilities,
    mdPath,
    descriptor,
  };
}


// ---------------------------------------------------------------------------
// Action: query_agent
// ---------------------------------------------------------------------------

async function actionQueryAgent({ service, id }) {
  if (!service && !id) return { ok: false, error: 'service or id is required' };

  return await withDb(async (db) => {
    let rows;
    if (id) {
      rows = await db.all("SELECT * FROM agents WHERE id = ?", id);
    } else {
      const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      rows = await db.all("SELECT * FROM agents WHERE service = ? AND type = 'browser'", serviceKey);
    }

    if (!rows || rows.length === 0) return { ok: true, found: false };

    const row = rows[0];
    return {
      ok: true,
      found: true,
      agentId: row.id,
      service: row.service,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      status: row.status,
      lastValidated: row.last_validated,
      descriptor: row.descriptor,
    };
  });
}

// ---------------------------------------------------------------------------
// Action: list_agents
// ---------------------------------------------------------------------------

async function actionListAgents() {
  let dbAgents = [];
  try {
    await withDb(async (db) => {
      // One-time migration: delete legacy bare-id rows (e.g. 'youtube') when a canonical
      // 'youtube.agent' counterpart exists. Safe to run every call — no-op once clean.
      await db.run(`
        DELETE FROM agents
        WHERE id NOT LIKE '%.agent'
          AND id || '.agent' IN (SELECT id FROM agents WHERE id LIKE '%.agent')
      `).catch(() => {});

      const rows = await db.all("SELECT id, type, service, capabilities, status, last_validated FROM agents WHERE type = 'browser' ORDER BY created_at DESC");
      dbAgents = (rows || []).map(r => ({
        id: r.id,
        type: r.type,
        service: r.service,
        capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
        status: r.status,
        lastValidated: r.last_validated,
      }));
    });
  } catch (_) {}
  // Merge .md file agents not yet in DB (e.g. gmail.agent created by explore.agent before DB registration)
  if (fs.existsSync(AGENTS_DIR)) {
    try {
      const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
      const dbIds = new Set(dbAgents.map(a => a.id));
      for (const f of files) {
        const id = f.replace('.md', '');
        if (dbIds.has(id)) continue;
        try {
          const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
          const statusMatch  = content.match(/^status:\s*(\S+)/m);
          const typeMatch    = content.match(/^type:\s*(\S+)/m);
          const serviceMatch = content.match(/^service:\s*(\S+)/m);
          const rawStatus = statusMatch?.[1] || 'healthy';
          // Normalize non-standard statuses to 'healthy' so planSkills includes them
          const HEALTHY_STATUSES = new Set(['healthy', 'learned', 'degraded', 'needs_auth', 'needs_validation']);
          const normalStatus = HEALTHY_STATUSES.has(rawStatus) ? 'healthy' : rawStatus;
          const type    = typeMatch?.[1]    || 'browser';
          const service = serviceMatch?.[1] || id.replace('.agent', '');
          dbAgents.push({ id, type, service, capabilities: [], status: normalStatus });
          logger.info(`[browser.agent] list_agents: merged .md-only agent ${id} (status=${normalStatus})`);
        } catch (_) {}
      }
    } catch (_) {}
  }
  return { ok: true, agents: dbAgents };
}

// ---------------------------------------------------------------------------
// Shared: lightweight LLM caller via the VSCode WebSocket backend (port 4000)
// ---------------------------------------------------------------------------

const LLM_WS_URL = process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
const LLM_API_KEY = process.env.VSCODE_API_KEY || '';

async function callLLM(systemPrompt, userQuery, { temperature = 0.2, maxTokens = 1400 } = {}) {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return null; }

  const url = new URL(LLM_WS_URL);
  if (LLM_API_KEY) url.searchParams.set('apiKey', LLM_API_KEY);
  url.searchParams.set('userId', 'browser_agent_validator');
  url.searchParams.set('clientId', `browser_agent_${Date.now()}`);

  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url.toString()); } catch { return resolve(null); }

    let accumulated = '';
    const connTimeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve(null); }, 8000);
    const respTimeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve(accumulated || null); }, 60000);

    ws.on('open', () => {
      clearTimeout(connTimeout);
      ws.send(JSON.stringify({
        id: `val_${Date.now()}`,
        type: 'llm_request',
        payload: {
          prompt: userQuery,
          provider: 'openai',
          options: { temperature, stream: true, taskType: 'ask' },
          context: { systemInstructions: systemPrompt, recentContext: [], sessionFacts: [], memories: [] },
        },
        timestamp: Date.now(),
        metadata: { source: 'browser_agent_validator' },
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'llm_stream_chunk') { accumulated += (msg.payload?.text || msg.payload?.chunk || ''); }
        else if (msg.type === 'llm_stream_end') { clearTimeout(respTimeout); ws.close(); resolve(accumulated); }
        else if (msg.type === 'error') { clearTimeout(respTimeout); ws.close(); resolve(accumulated || null); }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
    ws.on('close', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
  });
}

// ---------------------------------------------------------------------------
// Action: validate_agent — LLM-powered DOM/flow change detection + auto-fix
// ---------------------------------------------------------------------------

// Phase 1: DOM health check — are selectors + auth flow still valid?
const BROWSER_VALIDATOR_SYSTEM_PROMPT = `You are ThinkDrop's Browser Agent Validator. Your job is to assess whether a browser agent descriptor is still accurate given the current live state of the page it navigates.

You will receive:
1. The agent's current descriptor (.md with navigation patterns, selectors, capabilities, auth flow)
2. An accessibility snapshot of the current live page (title, URL, visible interactive elements)
3. Any HTTP status / reachability info

Your analysis must cover:
- Do the documented navigation patterns still work on the current page?
- Are any critical buttons, forms, or nav items missing or renamed?
- Did the page structure change significantly (e.g. redesign, new auth flow, modal dialogs)?
- Are there new navigation paths or features visible that should be added to the descriptor?
- Are timing issues likely? (e.g. heavy SPAs, lazy-loaded elements that may need a wait step)
- Did the auth flow or login URL change?

Output ONLY valid JSON:
{
  "verdict": "healthy" | "degraded" | "needs_update",
  "missingSelectors": ["<element from descriptor that is no longer on page>"],
  "changedSelectors": [{ "old": "<old selector>", "new": "<new selector or description of change>" }],
  "newElements": ["<new important element found not in descriptor>"],
  "authFlowChanged": true | false,
  "timingRisk": true | false,
  "timingAdvice": "<specific wait hint or null>",
  "fixes": ["<precise fix — exact new selector, updated navigation step, or updated auth URL>"],
  "updatedInstructionsPatch": "<updated ## Navigation Patterns section text, or null if no change>",
  "summary": "<one sentence overall assessment>"
}

IMPORTANT: Be conservative — only flag elements as missing if they are clearly gone from the snapshot. An element not visible in a partial snapshot may just not be on this specific page. Focus on login pages, main nav, and primary action elements.`;

// Phase 2: pipeline review — is the descriptor complete and correct for every node that consumes it?
const BROWSER_PIPELINE_REVIEW_PROMPT = `You are ThinkDrop's Pipeline Review Agent. You perform a deep review of a browser agent descriptor — not just checking if selectors work, but whether the descriptor is COMPLETE and CORRECT for all the real-world cases the autonomous pipeline will encounter.

The ThinkDrop pipeline works like this:
- planSkills reads agent descriptors to decide if credentials/auth are already resolved
- buildSkill injects agent descriptors so generated skill code uses proven navigation patterns
- installSkill calls browser.agent to handle OAuth flows before prompting the user
- browser.agent routes services based on: isOAuth (needs OAuth flow) vs direct API key

You must reason as a senior engineer reviewing this descriptor. Ask yourself:

1. ROUTING CORRECTNESS
   - Is this service correctly handled by browser.agent, or does a CLI tool exist that would be better?
   - Example: if himalaya CLI exists for Gmail, browser.agent may be redundant for credential extraction
   - Is the auth flow described correctly (OAuth2 vs API key vs session cookie vs SSO)?

2. CAPABILITY COMPLETENESS
   - Do the listed capabilities match what skills will actually need?
   - Are common operations missing for this service?
   - Are capabilities listed that browser automation cannot reliably perform?

3. AUTH FLOW ACCURACY
   - Is the startUrl the correct entry point for auth?
   - Is authSuccessPattern reliable? (some SPAs never change URL after login)
   - Is session persistence documented? (does the session survive app restarts?)
   - Are there MFA/2FA flows not documented that will block automation?

4. SKILL CODE QUALITY RISK
   - If a skill is built using this descriptor, will the generated automation code be correct?
   - Are the navigation patterns precise enough? (exact element identifiers, wait conditions, timing)
   - Are error states documented (rate limits, session expiry, CAPTCHA, consent dialogs)?

5. PIPELINE GAPS
   - Is there anything installSkill will need to do that the descriptor doesn't explain?
   - Are there one-time setup steps (app registration, OAuth consent screen, permission grants)?
   - Are there platform-specific requirements (macOS only, requires specific browser profile)?

Output ONLY valid JSON:
{
  "routingCorrect": true | false,
  "routingIssues": ["<precise description and fix>"],
  "betterAlternative": { "type": "cli", "name": "<cli name>", "reason": "<why it is better>" } | null,
  "missingCapabilities": ["<capability missing>"],
  "incorrectCapabilities": ["<capability that cannot reliably be done via browser>"],
  "authFlowIssues": ["<problem with auth flow>"],
  "skillCodeRisks": ["<thing that will cause generated automation code to be wrong>"],
  "pipelineGaps": ["<gap the pipeline will hit but descriptor doesn't cover>"],
  "setupStepsRequired": ["<one-time setup step the user must complete>"],
  "correctedUrls": {
    "sign_in_url": "<corrected actual login form URL, or null if current is correct>",
    "start_url": "<corrected post-login dashboard URL, or null if current is correct>"
  } | null,
  "descriptorPatch": "<updated ## Auth or ## Navigation Patterns or ## Instructions section, or null>",
  "verdict": "complete" | "has_gaps" | "needs_rebuild",
  "summary": "<2-3 sentence assessment written like a senior engineer code review comment>"
}

CRITICAL: If the start_url in the descriptor is a marketing/landing page instead of the actual login form, set correctedUrls.sign_in_url to the real login URL. Example: Gmail descriptor start_url=https://mail.google.com is the dashboard, so sign_in_url should be https://accounts.google.com/signin/v2/identifier. Always correct this — scan_page and waitForAuth depend on sign_in_url being the actual form.`;

async function actionValidateAgent({ id, sessionId: explicitSession }) {
  if (!id) return { ok: false, error: 'id is required' };

  const existing = await actionQueryAgent({ id });
  if (!existing.found) return { ok: false, error: `Agent not found: ${id}` };

  const lines    = (existing.descriptor || '').split('\n');
  const urlLine  = lines.find(l => l.startsWith('start_url:'));
  const startUrl = urlLine ? urlLine.replace('start_url:', '').trim() : null;

  if (!startUrl) {
    await _updateStatus(id, 'needs_update', 'No start_url found in descriptor');
    return { ok: true, agentId: id, healthy: false, issue: 'missing_start_url' };
  }

  // Step 1: quick reachability probe (HEAD request)
  const reachable = await new Promise(resolve => {
    try {
      const parsed = new URL(startUrl);
      const mod    = parsed.protocol === 'https:' ? require('https') : http;
      const req    = mod.request(
        { hostname: parsed.hostname, path: parsed.pathname || '/', method: 'HEAD', timeout: 8000 },
        res => resolve(res.statusCode < 500)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });

  if (!reachable) {
    const note = `Service URL not reachable: ${startUrl}`;
    await _updateStatus(id, 'needs_update', note);
    return { ok: true, agentId: id, healthy: false, verdict: 'needs_update', issue: 'url_unreachable', startUrl, summary: note };
  }

  // Step 2: use browser.act scanCurrentPage to get live DOM snapshot
  const profile   = `${id.replace('.agent', '')}_validator`;
  const sessionId = explicitSession || `${id}_validate_${Date.now()}`;
  let domSnapshot = null;

  try {
    const scanResult = await callBrowserAct({
      action: 'scanCurrentPage',
      sessionId,
      profile,
      url: startUrl,
      timeoutMs: 20000,
    }, 30000);

    if (scanResult?.ok !== false) {
      domSnapshot = {
        title:    scanResult?.title || '',
        url:      scanResult?.url || startUrl,
        elements: (scanResult?.elements || []).slice(0, 80),
      };
    }
  } catch (err) {
    logger.warn(`[browser.agent] validate_agent scanCurrentPage failed for ${id}: ${err.message}`);
  }

  // Step 3: build LLM query — descriptor + live DOM snapshot
  const elementsSummary = domSnapshot
    ? domSnapshot.elements.map(el =>
        `[${el.tag}${el.type ? ' type=' + el.type : ''}] label="${el.label || ''}" selector="${el.selector || ''}"${el.href ? ' href=' + el.href : ''}`
      ).join('\n')
    : '(DOM snapshot unavailable — only reachability was checked)';

  const userQuery = [
    `## Agent: ${id}`,
    `## Service start_url: ${startUrl}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 3000),
    '```',
    ``,
    `## Live DOM Snapshot`,
    `Page title: ${domSnapshot?.title || 'unknown'}`,
    `Current URL: ${domSnapshot?.url || startUrl}`,
    ``,
    `### Visible Elements (up to 80):`,
    elementsSummary,
  ].join('\n');

  // ── Phase 1: DOM health check — are selectors + auth flow still valid? ──────
  let healthDiagnosis = null;
  const healthRaw = await callLLM(BROWSER_VALIDATOR_SYSTEM_PROMPT, userQuery, { temperature: 0.1, maxTokens: 1400 });
  if (healthRaw) {
    try {
      const m = healthRaw.match(/\{[\s\S]*\}/);
      if (m) healthDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[browser.agent] validate_agent health parse failed for ${id}`);
    }
  }

  // Fallback if LLM unavailable
  if (!healthDiagnosis) {
    healthDiagnosis = {
      verdict: 'healthy', missingSelectors: [], changedSelectors: [],
      newElements: [], authFlowChanged: false, timingRisk: false,
      timingAdvice: null, fixes: [], updatedInstructionsPatch: null,
      summary: 'Service reachable (LLM validation unavailable)',
    };
  }

  // ── Phase 2: pipeline review — is the descriptor complete for the full pipeline? ─
  // Senior-engineer pass: routing correctness, missing capabilities, auth flow accuracy,
  // skill code risks, setup steps installSkill must surface to the user.
  let reviewDiagnosis = null;
  const reviewQuery = [
    `## Agent: ${id}  (service: ${existing.service || id.replace('.agent', '')})`,
    `## Type: browser`,
    `## start_url: ${startUrl}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 4000),
    '```',
    ``,
    `## Live page title: ${domSnapshot?.title || 'unknown'}`,
    `## Live page URL: ${domSnapshot?.url || startUrl}`,
  ].join('\n');

  const reviewRaw = await callLLM(BROWSER_PIPELINE_REVIEW_PROMPT, reviewQuery, { temperature: 0.15, maxTokens: 1600 });
  if (reviewRaw) {
    try {
      const m = reviewRaw.match(/\{[\s\S]*\}/);
      if (m) reviewDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[browser.agent] validate_agent review parse failed for ${id}`);
    }
  }

  // ── Combine verdicts (worst-case wins) ────────────────────────────────────
  const HEALTH_RANK = { healthy: 0, degraded: 1, needs_update: 2 };
  const REVIEW_MAP  = { complete: 'healthy', has_gaps: 'degraded', needs_rebuild: 'needs_update' };
  const healthVerdict = healthDiagnosis.verdict || 'healthy';
  const reviewVerdict = reviewDiagnosis?.verdict || 'complete';
  const reviewStatus  = REVIEW_MAP[reviewVerdict] || 'healthy';
  const finalStatus   = (HEALTH_RANK[healthVerdict] >= HEALTH_RANK[reviewStatus]) ? healthVerdict : reviewStatus;

  const failureParts = [];
  if (healthVerdict !== 'healthy') failureParts.push(`Health: ${healthDiagnosis.summary}`);
  if (reviewVerdict !== 'complete' && reviewDiagnosis?.summary) failureParts.push(`Review: ${reviewDiagnosis.summary}`);
  if (reviewDiagnosis?.pipelineGaps?.length) failureParts.push(`Gaps: ${reviewDiagnosis.pipelineGaps.join(' | ')}`);
  if (reviewDiagnosis?.betterAlternative)
    failureParts.push(`Alternative: ${reviewDiagnosis.betterAlternative.name} (${reviewDiagnosis.betterAlternative.reason})`);
  const failureLog = failureParts.length > 0 ? failureParts.join('\n') : null;

  // ── Auto-patch descriptor from both phases ────────────────────────────────
  let patchedDescriptor = existing.descriptor;
  let descriptorPatched = false;

  // Phase 2: correct frontmatter URLs if validate_agent found them wrong.
  // This is the primary self-healing path — no human needed.
  if (reviewDiagnosis?.correctedUrls) {
    const { sign_in_url: newSignIn, start_url: newStart } = reviewDiagnosis.correctedUrls;
    if (newSignIn || newStart) {
      patchedDescriptor = rewriteDescriptorFrontmatter(patchedDescriptor, {
        ...(newSignIn ? { sign_in_url: newSignIn } : {}),
        ...(newStart  ? { start_url:   newStart  } : {}),
      });
      descriptorPatched = true;
      logger.info(`[browser.agent] validate_agent: corrected URLs for ${id} — sign_in_url=${newSignIn || '(unchanged)'} start_url=${newStart || '(unchanged)'}`);
    }
  }

  if (healthVerdict === 'needs_update' && healthDiagnosis.updatedInstructionsPatch) {
    patchedDescriptor = patchBrowserDescriptor(patchedDescriptor, {
      patch:        healthDiagnosis.updatedInstructionsPatch,
      timingAdvice: healthDiagnosis.timingAdvice,
    });
    descriptorPatched = true;
  }
  if (reviewDiagnosis?.descriptorPatch) {
    patchedDescriptor = patchBrowserDescriptor(patchedDescriptor, {
      patch:        reviewDiagnosis.descriptorPatch,
      timingAdvice: null,
    });
    descriptorPatched = true;
  }

  if (descriptorPatched) {
    const mdPath = path.join(AGENTS_DIR, `${id}.md`);
    fs.writeFileSync(mdPath, patchedDescriptor, 'utf8');
    await withDb(async (db) => {
      await db.run(
        `UPDATE agents SET descriptor = ?, status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?`,
        patchedDescriptor, finalStatus, failureLog, id
      );
    });
    logger.info(`[browser.agent] validate_agent auto-patched descriptor for ${id}`);
  } else {
    await _updateStatus(id, finalStatus, failureLog);
  }

  logger.info(`[browser.agent] validate_agent ${id} → health:${healthVerdict} review:${reviewVerdict} final:${finalStatus}`);

  return {
    ok: true,
    agentId: id,
    healthy: finalStatus === 'healthy',
    verdict: finalStatus,
    startUrl,
    domSnapshot: !!domSnapshot,
    // Phase 1
    missingSelectors:  healthDiagnosis.missingSelectors  || [],
    changedSelectors:  healthDiagnosis.changedSelectors  || [],
    newElements:       healthDiagnosis.newElements       || [],
    authFlowChanged:   healthDiagnosis.authFlowChanged   || false,
    timingRisk:        healthDiagnosis.timingRisk        || false,
    timingAdvice:      healthDiagnosis.timingAdvice      || null,
    fixes:             healthDiagnosis.fixes             || [],
    healthSummary:     healthDiagnosis.summary,
    // Phase 2
    reviewVerdict,
    routingCorrect:      reviewDiagnosis?.routingCorrect ?? true,
    routingIssues:       reviewDiagnosis?.routingIssues || [],
    betterAlternative:   reviewDiagnosis?.betterAlternative || null,
    missingCapabilities: reviewDiagnosis?.missingCapabilities || [],
    pipelineGaps:        reviewDiagnosis?.pipelineGaps || [],
    setupStepsRequired:  reviewDiagnosis?.setupStepsRequired || [],
    skillCodeRisks:      reviewDiagnosis?.skillCodeRisks || [],
    reviewSummary:       reviewDiagnosis?.summary,
    // Meta
    descriptorPatched,
  };
}


// Rewrite specific frontmatter key: value lines in-place.
// fieldMap = { sign_in_url: 'https://...', start_url: 'https://...' }
function rewriteDescriptorFrontmatter(descriptor, fieldMap) {
  const lines = descriptor.split('\n');
  const rewritten = lines.map(line => {
    for (const [field, value] of Object.entries(fieldMap)) {
      if (line.startsWith(`${field}:`)) {
        return `${field}: ${value}`;
      }
    }
    return line;
  });
  // If a field wasn't present in frontmatter at all, insert it after the last known field
  for (const [field, value] of Object.entries(fieldMap)) {
    if (!rewritten.some(l => l.startsWith(`${field}:`))) {
      const insertAfter = rewritten.findIndex(l => l.startsWith('start_url:') || l.startsWith('service:'));
      if (insertAfter >= 0) {
        rewritten.splice(insertAfter + 1, 0, `${field}: ${value}`);
      }
    }
  }
  return rewritten.join('\n');
}

function patchBrowserDescriptor(descriptor, { patch, timingAdvice }) {
  const lines = descriptor.split('\n');

  // Append patch notes at the end
  const patchLines = [
    ``,
    `## Validator Notes (${new Date().toISOString().slice(0, 10)})`,
    patch,
  ];

  if (timingAdvice) {
    patchLines.push(``, `### Timing Notes`, timingAdvice);
  }

  return lines.join('\n') + '\n' + patchLines.join('\n');
}

async function _updateStatus(id, status, failureNote) {
  await withDb(async (db) => {
    if (failureNote) {
      await db.run(
        'UPDATE agents SET status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
        status, failureNote, id
      );
    } else {
      await db.run(
        'UPDATE agents SET status = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
        status, id
      );
    }
  });
}


// ---------------------------------------------------------------------------
// Agentic loop helpers (api_key path) — mirrors cli.agent pattern
// ---------------------------------------------------------------------------

async function agentWebSearch(query) {
  const { URL } = require('url');
  const wsUrl = new URL(process.env.MCCP_WEB_SEARCH_API_URL || 'http://127.0.0.1:3002');
  const wsApiKey = process.env.MCP_WEB_SEARCH_API_KEY || '';
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'web-search',
      requestId: `ws_${Date.now()}`, action: 'search',
      payload: { query, maxResults: 3 },
    });
    const req = http.request({
      hostname: wsUrl.hostname, port: parseInt(wsUrl.port) || 3002,
      path: '/web.search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${wsApiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.data?.results || parsed?.results || [];
          if (results.length === 0) { resolve(`web_search returned no results for: "${query}" — try web_fetch with a direct docs URL instead`); return; }
          resolve(results.slice(0, 3).map(r => `${r.title}\n${r.description}`).join('\n---\n'));
        } catch { resolve(data.slice(0, 600) || `web_search returned no results for: "${query}" — try web_fetch with a direct docs URL instead`); }
      });
    });
    req.on('error', (e) => resolve(`web_search failed: ${e.message || 'connection error'} — try web_fetch with a direct docs URL instead`));
    req.setTimeout(5000, () => { req.destroy(); resolve(`web_search timed out for: "${query}" — try web_fetch with a direct docs URL instead`); });
    req.write(body);
    req.end();
  });
}

async function agentWebFetch(url) {
  const WEB_FETCH_CHARS = 2000;
  const { execFile: _execFileWF } = require('child_process');
  const pcResult = await new Promise(resolve => {
    _execFileWF('/opt/homebrew/bin/playwright-cli', ['fetch', url], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve({ ok: !err, stdout: out || '' });
    });
  });
  if (pcResult.ok && pcResult.stdout.trim()) return pcResult.stdout.slice(0, WEB_FETCH_CHARS);
  const curlResult = await new Promise(resolve => {
    _execFileWF('curl', ['-sL', '--max-time', '10', url], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve({ stdout: out || '' });
    });
  });
  if (curlResult.stdout) return curlResult.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, WEB_FETCH_CHARS);
  return '';
}

// ---------------------------------------------------------------------------
// Recipe Doctor — diagnoseAndPatchRecipe()
//
// Called when a recipe-driven task fails goal verification.
// Automatically:
//   1. Probes the last recipe step's target element via page.evaluate()
//   2. Detects known JS frameworks (CodeMirror, Monaco, ACE, Quill, etc.)
//   3. If framework unknown, calls web search MCP for interaction hints
//   4. LLM generates a patched waypoint (e.g. evaluate instead of focus)
//   5. Writes the patched recipe JSON to disk
//
// Returns { patched: true, summary, patchedWaypoint } on success
// or      { patched: false, reason } on any failure (always non-fatal)
// ---------------------------------------------------------------------------

async function diagnoseAndPatchRecipe({ agentId, recipeName, recipe, failureReason, sessionId }) {
  const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

  try {
    if (!recipe || !recipe.waypoints || !Array.isArray(recipe.waypoints)) {
      return { patched: false, reason: 'No recipe waypoints to inspect' };
    }

    // Identify the last substantive waypoint (the handoff step — usually focus/fill/click on the editor)
    const _interactionTypes = ['focus', 'fill', 'click', 'evaluate', 'keycombo', 'paste'];
    const lastWp = [...recipe.waypoints].reverse().find(wp => _interactionTypes.includes(wp.type));
    if (!lastWp) {
      return { patched: false, reason: 'No interaction waypoint found to diagnose' };
    }

    // Skip re-patching if waypoint is already an evaluate with a setValue call.
    // In that case the recipe step itself is correct — the failure is that playwright.agent
    // ignored the targetDescription and used type instead of run-code+editor.setValue().
    // Re-patching the same evaluate step again just thrashes the recipe file with no benefit.
    if (lastWp.type === 'evaluate' && lastWp.code && /setValue/i.test(lastWp.code)) {
      logger.info(`[browser.agent] recipe-doctor: step ${lastWp.step} already has evaluate+setValue — recipe is correct, skipping re-patch (failure is in LLM plan, not recipe)`);
      return { patched: false, reason: 'Recipe step already correct (evaluate+setValue) — LLM plan generation issue, not recipe issue' };
    }

    logger.info(`[browser.agent] recipe-doctor: diagnosing step ${lastWp.step} (${lastWp.type} on "${lastWp.selector || 'no selector'}")`);

    // ── Step 1: DOM probe ──────────────────────────────────────────────────
    let elementProfile = null;
    if (lastWp.selector) {
      const probeCode = `(function() {
        const sel = ${JSON.stringify(lastWp.selector)};
        const el = document.querySelector(sel);
        if (!el) return JSON.stringify({ found: false, selector: sel });
        const style = window.getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        const framework =
          (window.editor && typeof window.editor.setValue === 'function') ? 'codemirror' :
          (window.monaco) ? 'monaco' :
          (window.ace && typeof window.ace.edit === 'function') ? 'ace' :
          (window.Quill) ? 'quill' :
          (window.CodeMirror) ? 'codemirror' :
          null;
        const globalApi =
          framework === 'codemirror' ? 'editor.setValue(content)' :
          framework === 'monaco' ? 'monaco.editor.getModels()[0].setValue(content)' :
          framework === 'ace' ? 'ace.edit(el).setValue(content)' :
          framework === 'quill' ? 'new Quill(el).setText(content)' :
          null;
        const editableChild = el.querySelector('[contenteditable="true"], textarea:not([style*="display:none"])');
        return JSON.stringify({
          found: true,
          selector: sel,
          tagName: el.tagName.toLowerCase(),
          visible,
          contenteditable: el.contentEditable,
          role: el.getAttribute('role'),
          framework,
          globalApi,
          editableChildTag: editableChild ? editableChild.tagName.toLowerCase() : null,
          classes: el.className.slice(0, 100),
        });
      })()`;

      const probeRes = await callBrowserAct({ action: 'evaluate', text: probeCode, sessionId }).catch(() => null);
      if (probeRes) {
        // browser.act wraps eval output in "### Result\n<value>" markdown.
        // For complex JSON strings the outer-quote strip in the evaluate handler
        // can mangle content — extract directly from stdout as the reliable path.
        let raw = '';
        if (probeRes.stdout) {
          const _m = probeRes.stdout.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
          raw = _m ? _m[1].trim() : probeRes.stdout.trim();
          if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\"/g, '"');
        } else {
          raw = String(probeRes?.result || '').replace(/^"|"$/g, '');
        }
        try { elementProfile = JSON.parse(raw); } catch (_) { /* non-fatal */ }
      }
      logger.info(`[browser.agent] recipe-doctor: element profile: ${JSON.stringify(elementProfile)}`);
    }

    // ── Step 2: Web search for unknown elements ────────────────────────────
    let webHints = '';
    if (elementProfile && elementProfile.found && !elementProfile.framework) {
      // Unknown element type — search for how to interact with it
      try {
        let hostname = 'unknown';
        try { hostname = new URL(recipe.targetUrl || '').hostname; } catch (_) {}
        const searchQuery = `how to programmatically set content in ${elementProfile.tagName} ${elementProfile.classes.split(' ')[0]} editor on ${hostname}`;
        logger.info(`[browser.agent] recipe-doctor: web search for unknown element: "${searchQuery.slice(0, 80)}"`);
        webHints = await agentWebSearch(searchQuery);
        logger.info(`[browser.agent] recipe-doctor: web hints: ${webHints.slice(0, 200)}`);
      } catch (_) { /* non-fatal */ }
    }

    // ── Step 3: LLM generates a patch ─────────────────────────────────────
    const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

    const patchPrompt = `A recipe step failed. Your job is to generate a REPLACEMENT waypoint that correctly interacts with the target element.

FAILED WAYPOINT:
${JSON.stringify(lastWp, null, 2)}

FAILURE REASON: ${failureReason}

ELEMENT PROFILE (from live DOM inspection):
${elementProfile ? JSON.stringify(elementProfile, null, 2) : 'Could not probe element'}

${webHints ? `WEB SEARCH HINTS (advisory — use only if directly relevant):\n${webHints.slice(0, 400)}` : ''}

RULES:
- If framework is "codemirror" and globalApi is "editor.setValue(content)": use type "evaluate" with code that calls editor.setValue('') to CLEAR the editor. The playwright.agent will then use run-code to SET the content.
- If framework is "monaco": use type "evaluate" with code calling monaco.editor.getModels()[0].setValue('').
- If element tagName is "div" and not visible or contenteditable is "false": the selector is wrong — suggest using ".CodeMirror-code" or the editableChild instead.
- If no framework detected: use type "keycombo" with key "Meta+a" then type "evaluate" with document.execCommand('delete') OR suggest a "fill" on the editableChild.
- The patched waypoint should be a SINGLE JSON object (one step).
- Use type "evaluate" for JS API calls. The "code" field is raw JS expression (not async).
- Keep the same step number as the failed waypoint.

Respond with ONLY a valid JSON object — no markdown, no explanation:
{
  "step": <number>,
  "type": "evaluate" | "fill" | "keycombo" | "focus",
  "code": "<JS expression if type=evaluate>",
  "selector": "<CSS selector if needed>",
  "description": "<what this step does>",
  "patchReason": "<one sentence explaining why the original step failed>"
}`;

    const patchRaw = await askWithMessages([
      { role: 'system', content: 'You are a browser automation expert. Respond with JSON only. No markdown fences.' },
      { role: 'user', content: patchPrompt },
    ], { temperature: 0.0, maxTokens: 400, responseTimeoutMs: 20000 });

    let patchedWaypoint = null;
    try {
      const cleaned = (patchRaw || '').trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
      patchedWaypoint = JSON.parse(cleaned);
    } catch (_) {
      logger.warn(`[browser.agent] recipe-doctor: LLM returned unparseable patch — aborting`);
      return { patched: false, reason: 'LLM patch parse failed' };
    }

    if (!patchedWaypoint || !patchedWaypoint.type) {
      return { patched: false, reason: 'LLM patch missing required fields' };
    }

    logger.info(`[browser.agent] recipe-doctor: patch generated: ${JSON.stringify(patchedWaypoint)}`);

    // ── Step 4: Apply patch + update targetDescription ────────────────────
    const patchedWaypoints = recipe.waypoints.map(wp =>
      wp.step === lastWp.step ? { ...patchedWaypoint } : wp
    );

    // Derive improved targetDescription if we found a framework
    let patchedTargetDescription = recipe.targetDescription || '';
    if (elementProfile?.framework === 'codemirror' && elementProfile?.globalApi) {
      patchedTargetDescription = `${patchedTargetDescription.split('.')[0]}. IMPORTANT: Editor uses CodeMirror. To write content use run-code: page.evaluate(() => editor.setValue(htmlString)). The editor has been cleared by the recipe — do NOT use type or fill on the editor directly.`;
    } else if (elementProfile?.framework && elementProfile?.globalApi) {
      patchedTargetDescription = `${patchedTargetDescription.split('.')[0]}. IMPORTANT: Editor uses ${elementProfile.framework}. To write content use run-code: page.evaluate(() => ${elementProfile.globalApi.replace('content', 'newContent')}). Do NOT use raw type or fill.`;
    } else if (patchedWaypoint.patchReason) {
      patchedTargetDescription = `${patchedTargetDescription} [Auto-patched: ${patchedWaypoint.patchReason}]`;
    }

    const patchedRecipe = {
      ...recipe,
      waypoints: patchedWaypoints,
      targetDescription: patchedTargetDescription,
      _autoPatchedAt: new Date().toISOString(),
      _autoPatchReason: patchedWaypoint.patchReason || failureReason,
    };

    // ── Step 5: Write patched recipe to disk ──────────────────────────────
    const _skillDirId = (id) => id.replace(/\.agent$/, '').replace(/[^a-z0-9_]/gi, '_');
    const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
    const recipePath = path.join(skillDir, `${recipeName}.recipe.json`);

    if (!fs.existsSync(skillDir)) {
      logger.warn(`[browser.agent] recipe-doctor: skill dir not found: ${skillDir}`);
      return { patched: false, reason: 'Skill directory not found' };
    }

    fs.writeFileSync(recipePath, JSON.stringify(patchedRecipe, null, 2), 'utf8');
    logger.info(`[browser.agent] recipe-doctor: patched recipe written to ${recipePath}`);

    const summary = `Auto-patched step ${lastWp.step}: changed "${lastWp.type}" → "${patchedWaypoint.type}"${elementProfile?.framework ? ` (detected ${elementProfile.framework})` : ''}. ${patchedWaypoint.patchReason || ''}`;
    logger.info(`[browser.agent] recipe-doctor: ${summary}`);

    return { patched: true, summary, patchedWaypoint, recipePath };

  } catch (err) {
    logger.warn(`[browser.agent] recipe-doctor: diagnosis failed (non-fatal): ${err.message}`);
    return { patched: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Action: run — executes a task using the agent's descriptor as context.
// Supports two paths based on agent type:
//   api_key / bearer: multi-turn agentic loop (run_curl/web_search/web_fetch/done/ask_user)
//   browser / oauth:  waitForAuth → playwright.agent agentic loop
// ---------------------------------------------------------------------------

const BROWSER_RUN_CURL_PROMPT = `You are a REST API command inference engine. Given an agent descriptor and a task, output the curl command to accomplish that task.

Use EXACTLY these shell variable names for credentials (they will be substituted before execution):
  $CRED_PRIMARY    — the API key, auth token, or password
  $CRED_USERNAME   — the username or account SID (for Basic auth)
  $CRED_DOMAIN     — the domain or secondary identifier (if required, e.g. Mailgun sending domain)

Output ONLY valid JSON:
{
  "curlArgs": ["-s", "-f", "-X", "POST", "<url>", ...],
  "credVars": ["PRIMARY"],
  "reasoning": "<one sentence>"
}

curlArgs must NOT include the word "curl" itself. Always use -s flag. Use -f to fail on HTTP errors.
credVars = which of ["PRIMARY", "USERNAME", "DOMAIN"] are actually referenced in curlArgs.`;

const BROWSER_AGENTIC_LOOP_PROMPT = `You are an expert REST API automation agent executing a user task step-by-step.
You have access to the API service described in the Agent Descriptor below.
Each turn you output exactly ONE JSON action object from this palette:

  run_curl   – execute API call:           { "action": "run_curl", "curlArgs": [...], "credVars": [...] }
  web_search – search for API docs:        { "action": "web_search", "query": "..." }
  web_fetch  – read an API docs/ref URL:   { "action": "web_fetch", "url": "..." }
  done       – task complete:              { "action": "done", "summary": "..." }
  ask_user   – need user clarification:    { "action": "ask_user", "question": "...", "options": [] }

Rules:
- curlArgs must NOT include the word "curl" itself. Always use -s flag. Do NOT use -f (you need to read error bodies on failure).
- credVars lists which of ["PRIMARY", "USERNAME", "DOMAIN"] are referenced in curlArgs as $CRED_PRIMARY / $CRED_USERNAME / $CRED_DOMAIN.
- On HTTP 4xx or 5xx: read the response body carefully for error details, then retry with corrected parameters or endpoint.
- Use web_search or web_fetch to find the correct endpoint, required headers, or request body format when uncertain.
- Use done immediately when HTTP 2xx is received and the task is confirmed complete.
- On HTTP 4xx/5xx, diagnose before retrying:
  401/403 → auth issue: verify credential format matches descriptor (Bearer vs Basic vs header name), retry with corrected auth header
  404     → bad endpoint: use web_fetch to find correct URL path from API docs, then retry
  400/422 → bad request body: use web_fetch to check required fields and format, then retry
  5xx     → server error: retry once; if persists, use ask_user
  Never use ask_user for 4xx without first attempting one web_fetch diagnostic probe.
- Use ask_user only when genuinely blocked by missing information that cannot be resolved with the tools above.
- Output JSON only. No prose. No markdown fences.`;

// Resolve a named credential: env var → keytar → null
async function resolveCredential(agentId, credName) {
  const serviceKey = agentId.replace('.agent', '');

  // 1. Try env var patterns (CLICKSEND_API_KEY, CLICKSEND_USERNAME, etc.)
  const candidates = [
    `${serviceKey.toUpperCase()}_${credName}`,
    `${serviceKey.toUpperCase()}_API_KEY`,
    `${serviceKey.toUpperCase()}_TOKEN`,
  ];
  for (const envVar of candidates) {
    if (process.env[envVar]) return process.env[envVar];
  }

  // 2. Try keytar (macOS Keychain)
  try {
    const { execFile } = require('child_process');
    const accounts = [
      `browser_agent:${agentId}:${credName}`,
      `skill:${agentId}:${credName}`,
      `browser_agent:${serviceKey}:${credName}`,
    ];
    for (const account of accounts) {
      const val = await new Promise(resolve => {
        execFile('security', ['find-generic-password', '-s', 'thinkdrop', '-a', account, '-w'], (err, stdout) => {
          resolve(err ? null : stdout.trim());
        });
      });
      if (val) return val;
    }
  } catch {}

  return null;
}

// HTTP helper to call another skill in this command-service process
function callSkill(skillName, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: skillName, args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error(`skill(${skillName}) parse error: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`skill(${skillName}) timeout`)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function actionRun({ agentId: _agentIdArg, task, url, context, requiresAuth, skipAuth, _progressCallbackUrl, _stepIndex, _loginWallRetried = false, _emitThinking = null }) {
  // Derive agentId from url hostname when caller omits it (LLM sometimes emits only url)
  let agentId = _agentIdArg;
  if (!agentId && url) {
    try {
      const _host = new URL(url).hostname.replace(/^www\./, '');
      const _svc  = _host.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      agentId = `${_svc}.agent`;
      logger.info(`[browser.agent] run: derived agentId="${agentId}" from url="${url}"`);
    } catch (_) { /* malformed url — fall through to error below */ }
  }
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task)    return { ok: false, error: 'task is required' };

  const _fs = require('fs');

  // ── AGENT THINKING PHASE ─────────────────────────────────────────────────
  // Emit thinking event to provide user insight into agent's reasoning process
  const thinkingContext = {
    agentId,
    task: task.slice(0, 200),
    hasUrl: !!url,
    requiresAuth: !!requiresAuth,
    timestamp: Date.now()
  };

  // Generate agent's initial reasoning about the task
  const thinking = _generateAgentThinking('browser.agent', thinkingContext);

  // Emit thinking event via callback if provided
  if (typeof _emitThinking === 'function') {
    _emitThinking({
      type: 'agent:thinking',
      agent: 'browser.agent',
      agentId,
      phase: 'preparation',
      thought: thinking,
      context: thinkingContext
    });
  }

  // If the caller passed a full-content buffer file from a prior pipeline step, append it to the task
  const _dataFile = context?._dataFile;
  if (_dataFile) {
    try {
      const fileContent = _fs.readFileSync(_dataFile, 'utf8');
      task = `${task}\n\n[DATA FROM PRIOR STEP]:\n${fileContent.slice(0, 8000)}`;
    } catch (_) { /* non-fatal — file may not exist */ }
  }

  // Scan the task string for absolute file paths mentioned inline (e.g. "content of /tmp/foo.txt").
  // Pre-read each file and replace the path reference with the actual content so the LLM never
  // needs to generate run-code that tries require('fs') or fs.readFile inside playwright.
  const FILE_PATH_RE = /(\/(?:tmp|var|home|Users|root|etc)[^\s"'`,;)]+)/g;
  const mentionedPaths = [...new Set((task.match(FILE_PATH_RE) || []))];
  for (const filePath of mentionedPaths) {
    try {
      const fileContent = _fs.readFileSync(filePath, 'utf8');
      logger.info(`[browser.agent] pre-injecting file content from ${filePath} (${fileContent.length} chars)`);
      task = task.replace(filePath, `[CONTENT OF ${filePath}]`) +
             `\n\n[CONTENT OF ${filePath}]:\n${fileContent.slice(0, 8000)}`;
    } catch (_) { /* file may not exist — leave path in task as-is */ }
  }

  let existing = await actionQueryAgent({ id: agentId });
  if (!existing.found) {
    // Auto-build the agent transparently — no plan step required for known services.
    // actionBuildAgent already resolves service metadata from KNOWN_BROWSER_SERVICES so
    // gemini / googleai / geminiai aliases all work without any extra config.
    const serviceKey = agentId.replace(/\.agent$/, '');
    logger.info(`[browser.agent] run: agent "${agentId}" not found — attempting auto-build for service "${serviceKey}"`);
    try {
      const buildResult = await actionBuildAgent({ service: serviceKey });
      if (buildResult.ok) {
        logger.info(`[browser.agent] run: auto-built "${agentId}" (alreadyExists=${buildResult.alreadyExists}) — re-querying`);
        existing = await actionQueryAgent({ id: agentId });
      } else {
        logger.warn(`[browser.agent] run: auto-build failed for "${agentId}": ${buildResult.error}`);
      }
    } catch (buildErr) {
      logger.warn(`[browser.agent] run: auto-build threw for "${agentId}": ${buildErr.message}`);
    }
    // If still not found after auto-build attempt, return the original error with needsBuild:true
    // so recoverSkill.js fast-path can REPLAN instead of falling through to ASK_USER.
    if (!existing.found) {
      return { ok: false, error: `Agent not found: ${agentId}. Build it first with action:build_agent.`, needsBuild: true };
    }
  }

  // Self-heal: .md file was deleted (e.g. to force a playbook refresh) but DuckDB entry still
  // has the old descriptor. When the service has a PLAYBOOK_SEED_MAP entry, force-rebuild so
  // the new seed playbook replaces the stale DB record.
  if (existing.found) {
    const _mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
    const _serviceKey = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    const _hasSeed = Object.prototype.hasOwnProperty.call(PLAYBOOK_SEED_MAP, _serviceKey);
    if (!_fs.existsSync(_mdPath) && _hasSeed) {
      logger.info(`[browser.agent] run: "${agentId}" .md missing but has seed — force-rebuilding from PLAYBOOK_SEED_MAP`);
      try {
        const _seedRebuild = await actionBuildAgent({ service: _serviceKey, force: true });
        if (_seedRebuild.ok) {
          existing = await actionQueryAgent({ id: agentId });
          logger.info(`[browser.agent] run: seed-rebuild complete for "${agentId}"`);
        } else {
          logger.warn(`[browser.agent] run: seed-rebuild failed for "${agentId}": ${_seedRebuild.error}`);
        }
      } catch (_seedErr) {
        logger.warn(`[browser.agent] run: seed-rebuild threw for "${agentId}": ${_seedErr.message}`);
      }
    }
  }

  // Self-heal stale wrong-type entries (e.g. gemini.agent previously built as api_key).
  // Happens when auto-build ran in a prior session before deriveAgentType() was introduced.
  // Only triggers when stored type=api_key but the seed map says this is a browser UI service.
  if (existing.found && (existing.type === 'api_key' || (existing.descriptor || '').match(/^type:\s*api_key/m))) {
    const _selfHealKey = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    const _seedMeta    = lookupBrowserService(_selfHealKey);
    if (_seedMeta !== null && deriveAgentType(_seedMeta) === 'browser') {
      logger.info(`[browser.agent] run: type mismatch "${agentId}" stored=api_key expected=browser — force-rebuilding`);
      try {
        const _rebuildResult = await actionBuildAgent({ service: _selfHealKey, force: true });
        if (_rebuildResult.ok) {
          existing = await actionQueryAgent({ id: agentId });
          logger.info(`[browser.agent] run: self-healed "${agentId}" — new type=${_rebuildResult.descriptor?.match(/^type:\s*(\S+)/m)?.[1] || 'browser'}`);
        }
      } catch (_rebuildErr) {
        logger.warn(`[browser.agent] run: self-heal rebuild threw for "${agentId}": ${_rebuildErr.message}`);
      }
    }
  }

  const agentType = (() => {
    const m = (existing.descriptor || '').match(/^type:\s*(\S+)/m);
    return m ? m[1].toLowerCase() : existing.type || 'browser';
  })();

  logger.info(`[browser.agent] run agentId=${agentId} type=${agentType} task="${task}"`);

  // ── REST API path (api_key, bearer, basic) — multi-turn agentic loop ──
  if (agentType === 'api_key' || agentType === 'bearer' || agentType === 'basic') {
    const MAX_TURNS = 8;
    const OBSERVATION_CHARS = 600;
    const loopHistory = [];

    // Resolve credentials once before the loop starts
    const creds = {
      PRIMARY:  await resolveCredential(agentId, 'PRIMARY')  || await resolveCredential(agentId, 'API_KEY')  || '',
      USERNAME: await resolveCredential(agentId, 'USERNAME') || await resolveCredential(agentId, 'USER')     || '',
      DOMAIN:   await resolveCredential(agentId, 'DOMAIN')   || '',
    };

    // Build system prompt with descriptor embedded (descriptor stays in system, not per-turn)
    const DESCRIPTOR_LIMIT = 3000;
    const trimmedDescriptor = (existing.descriptor || '(none)').slice(0, DESCRIPTOR_LIMIT);
    const loopSystemPrompt = `${BROWSER_AGENTIC_LOOP_PROMPT}\n\n## Agent Descriptor\n${trimmedDescriptor}`;

    // Helper: substitute credential placeholders and run curl
    const { execFile: _execFileCurl } = require('child_process');
    const execCurlWithCreds = (curlArgs) => {
      const resolvedArgs = curlArgs.map(a =>
        a.replace(/\$CRED_PRIMARY/g,  creds.PRIMARY)
         .replace(/\$CRED_USERNAME/g, creds.USERNAME)
         .replace(/\$CRED_DOMAIN/g,   creds.DOMAIN)
      );
      logger.info(`[browser.agent] api_key loop: curl ${resolvedArgs.filter(a => !creds.PRIMARY || !a.includes(creds.PRIMARY)).slice(0, 5).join(' ')} ...`);
      return new Promise(resolve => {
        _execFileCurl('curl', resolvedArgs, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) => {
          resolve({ ok: !err || err.code === 0, stdout: out || '', stderr: errOut || '', exitCode: err?.code ?? 0, error: err?.message });
        });
      });
    };

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      // Build per-turn user prompt
      const histLines = loopHistory.length === 0
        ? '(none — this is turn 1)'
        : loopHistory.map(h => {
            const parts = Object.entries(h)
              .filter(([k]) => k !== 'turn' && k !== 'observation')
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
            return `  Turn ${h.turn}: ${parts}\n    Observation: ${h.observation}`;
          }).join('\n\n');
      const turnUser = `## Task\n${task}\n\n## Turn History\n${histLines}\n\n## Next Action\nOutput a single JSON action object.`;

      const llmRaw = await callLLM(loopSystemPrompt, turnUser, { temperature: 0.1, maxTokens: 400 });

      let action = null;
      if (llmRaw) {
        try {
          const m = llmRaw.match(/\{[\s\S]*\}/);
          if (m) action = JSON.parse(m[0]);
        } catch {}
      }

      if (!action || !action.action) {
        loopHistory.push({ turn, action: 'parse_error', observation: `LLM output unparseable: ${(llmRaw || '').slice(0, 200)}` });
        continue;
      }

      logger.info(`[browser.agent] api_key loop turn ${turn}/${MAX_TURNS}: action=${action.action}`);

      if (action.action === 'done') {
        return { ok: true, agentId, task, stdout: action.summary || '', agentTurns: turn, loopHistory };
      }

      if (action.action === 'ask_user') {
        return { ok: false, agentId, task, askUser: true, question: action.question, options: action.options || [], agentTurns: turn, loopHistory };
      }

      let observation = '';

      if (action.action === 'run_curl') {
        const curlArgs = Array.isArray(action.curlArgs) ? action.curlArgs : [];
        const credVars = Array.isArray(action.credVars) ? action.credVars : [];
        if (credVars.includes('PRIMARY') && !creds.PRIMARY) {
          return {
            ok: false, agentId, task,
            error: `Missing credential for ${agentId}. Store API key in Keychain: security add-generic-password -s thinkdrop -a "browser_agent:${agentId}:PRIMARY" -w "<your-key>"`,
            needsCredentials: true,
          };
        }
        if (curlArgs.length === 0) {
          observation = 'run_curl: no curlArgs provided';
        } else {
          const result = await execCurlWithCreds(curlArgs);
          observation = (result.stdout || result.stderr || result.error || '').slice(0, OBSERVATION_CHARS);
          // Auto-done on HTTP success (exitCode 0 = 2xx when -f is omitted)
          if (result.ok && result.exitCode === 0) {
            return {
              ok: true, agentId, task,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              agentTurns: turn,
              loopHistory,
            };
          }
        }
      } else if (action.action === 'web_search') {
        const snippets = await agentWebSearch(action.query || '');
        observation = snippets.slice(0, OBSERVATION_CHARS);
      } else if (action.action === 'web_fetch') {
        const page = await agentWebFetch(action.url || '');
        observation = page.slice(0, OBSERVATION_CHARS);
      } else {
        observation = `Unknown action: ${action.action}`;
      }

      loopHistory.push({ turn, ...action, observation });
    }

    return { ok: false, agentId, task, error: `Agentic loop reached MAX_TURNS (${MAX_TURNS}) without completing`, loopHistory };
  }

  // ── Browser / OAuth path ───────────────────────────────────────────────
  let startUrl             = extractDescriptorUrl(existing.descriptor, 'start_url');
  const signInUrl          = extractDescriptorUrl(existing.descriptor, 'sign_in_url');
  const authSuccessPattern = extractDescriptorUrl(existing.descriptor, 'auth_success_pattern');
  if (!startUrl) return { ok: false, error: 'Agent descriptor missing start_url' };

  // Strip any path from the stored descriptor start_url — always navigate to the
  // landing page (scheme + hostname only). This is a data-quality rule on static
  // defaults; resolveDestination corrections below are intentionally NOT stripped
  // because they are dynamic, intent-aware overrides that may need a deep path.
  try { const _u = new URL(startUrl); startUrl = `${_u.protocol}//${_u.hostname}`; } catch (_) {}

  const profile   = `${agentId.replace('.agent', '')}_agent`;
  // Use the stable profile name as sessionId so browser-profiles/<sessionId>/ persists
  // cookies across all invocations. A timestamped suffix creates a fresh dir each run
  // → Chrome shows the login page every time. 'gmail_agent' ≈ 94-char socket path,
  // safely under macOS's 104-char Unix socket limit.
  const sessionId = profile;

  const _svcKey          = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const _svcInfo         = lookupBrowserService(_svcKey);

  // ── Destination intent mismatch correction ────────────────────────────────────
  // Pre-navigation: detect when the configured startUrl (e.g. developer API console)
  // does not match the task's intent (e.g. research/chat). Correct silently on high
  // confidence; ask the user when ambiguous. Entirely non-blocking on error.
  try {
    const _destResult = await resolveDestination(_svcKey, task, startUrl, agentId);
    if (_destResult.action === 'auto_correct') {
      logger.info(`[browser.agent] run: destination auto-correct for "${agentId}": "${startUrl}" → "${_destResult.correctedUrl}" (${_destResult.reason})`);
      startUrl = _destResult.correctedUrl;
      // Record the correction so future runs use it without re-checking,
      // but only when this isn't already a resume (avoid echoing learned corrections).
      if (!_destResult.fromResumeContext) {
        setImmediate(() => {
          recordCorrection(_svcKey, _destResult.intent, _destResult.correctedUrl).catch(() => {});
        });
      }
    } else if (_destResult.action === 'ask_user') {
      logger.info(`[browser.agent] run: destination ambiguous for "${agentId}" — surfacing ASK_USER`);
      return {
        ok:               false,
        agentId,
        task,
        askUser:          true,
        wrongDestination: true,
        question:         _destResult.question,
        options:          _destResult.options || [],
      };
    }
    // action === 'ok': no change needed
  } catch (_destErr) {
    logger.warn(`[browser.agent] run: destination-resolver error (non-fatal): ${_destErr.message}`);
  }

  // Route to agentbrowser.agent when preferAgentBrowser is set on the service entry
  // or when THINKDROP_CLI_DRIVER=agentbrowser is set globally.
  const _useAgentBrowser = _svcInfo?.preferAgentBrowser === true || process.env.THINKDROP_CLI_DRIVER === 'agentbrowser';
  const _agentSkill = _useAgentBrowser ? 'agentbrowser.agent' : 'playwright.agent';
  if (_useAgentBrowser) {
    logger.info(`[browser.agent] run: routing ${agentId} through agentbrowser.agent (preferAgentBrowser=${_svcInfo?.preferAgentBrowser}, env=${process.env.THINKDROP_CLI_DRIVER})`);
  }

  // When auto-connect is enabled, agentbrowser attaches to the user's already-running
  // Chrome via CDP. No playwright waitForAuth / state-bridging needed — Chrome already
  // has all auth cookies. Activate per service (useAutoConnect) or globally via env var.
  const _useAutoConnect = _useAgentBrowser && (
    _svcInfo?.useAutoConnect === true ||
    process.env.THINKDROP_AUTO_CONNECT === 'true'
  );
  if (_useAutoConnect) {
    logger.info(`[browser.agent] run: auto-connect mode for ${agentId} — skipping playwright auth, attaching to running Chrome`);
  }

  // Persistent-profile mode: agent-browser opens Chrome with a persistent profile dir so
  // cookies survive between runs. User logs in once (headed), then auth is automatic.
  const AGENT_BROWSER_PROFILE = path.join(os.homedir(), '.thinkdrop', 'agent-profile');
  const _usePersistentProfile = _useAgentBrowser && (_svcInfo?.usePersistentProfile === true);
  if (_usePersistentProfile) {
    logger.info(`[browser.agent] run: persistent-profile mode for ${agentId} — profile=${AGENT_BROWSER_PROFILE}`);
  }

  // ── Step 1: Auth — lazy navigate-first ────────────────────────────────────
  // Rule: go to the site first; only call waitForAuth if the site itself redirects
  // to a login/auth page. Never navigate to sign-in upfront.
  //
  // agentbrowser path: fully independent — agentbrowser.agent handles its own lazy
  //   auth gate; playwright-cli is never involved for this stack.
  // playwright path: navigate to startUrl, probe current URL, call waitForAuth only
  //   if redirected to a login path. Applies uniformly to all services.

  // Helper: detect a sign-in wall URL. Covers path-based patterns (/login, /signin,
  // /auth, /oauth, /authorize) AND Google's accounts.google.com hostname which uses
  // URL structures like /v3/signin/identifier that don't match path patterns.
  const _isSigninWall = (href) =>
    href.length > 4 && (
      /\/(login|signin|sign[-_]in|auth|oauth|authorize)\b/i.test(href) ||
      /\baccounts\.google\.com\b/i.test(href)
    );

  let _effectiveAutoConnect = _useAutoConnect && !_usePersistentProfile;

  if (_useAgentBrowser) {
    // agentbrowser.agent handles its own auth lazily — no playwright-cli involvement.
    if (_usePersistentProfile) {
      // Daemon restart forces --profile/--headed flags on next launch.
      await callAgentbrowserAct({ action: 'close-all' }, 8000).catch(() => {});
      logger.info(`[browser.agent] persistent-profile: cleared sessions for ${agentId} — profile=${AGENT_BROWSER_PROFILE}`);
    } else if (_useAutoConnect) {
      try {
        const cdpResult = await getEnsureChromeCDP()();
        if (cdpResult.launched) {
          logger.info(`[browser.agent] Chrome CDP launched for ${agentId} auto-connect ✓`);
        } else if (!cdpResult.ok) {
          logger.warn(`[browser.agent] CDP unavailable: ${cdpResult.error} — falling back to --profile Default for ${agentId}`);
          _effectiveAutoConnect = false;
        } else {
          logger.info(`[browser.agent] Chrome CDP already available for ${agentId}`);
        }
      } catch (cdpErr) {
        logger.warn(`[browser.agent] ensureChromeCDP threw (non-fatal) — falling back to --profile Default: ${cdpErr.message}`);
        _effectiveAutoConnect = false;
      }
    }
    // agentbrowser.agent navigates to startUrl + lazy-checks auth itself.
    logger.info(`[browser.agent] run: agentbrowser path — auth delegated to agentbrowser.agent for ${agentId}`);
  } else {
    // playwright path: navigate to startUrl first, probe URL, call waitForAuth only if
    // the site redirects to a login path. Applies to ALL services uniformly.
    // skipAuth: true bypasses all auth checks (used for "Try without logging in" in parallel groups).
    if (skipAuth) {
      logger.info(`[browser.agent] run: skipAuth=true for ${agentId} — bypassing waitForAuth`);
    }
    let _authNeeded = false;
    let _skipNavigate = false;

    // ── Auth state persistence strategy ──────────────────────────────────────
    // Persistent-profile sessions (*_agent) use Chrome's own cookie store at
    // ~/.thinkdrop/browser-profiles/<sessionId>/. This preserves HttpOnly,
    // SameSite=Strict, and cross-domain cookies (e.g. Google's accounts.google.com
    // session tokens) that cannot be captured by playwright's JSON storageState.
    //
    // JSON state-load (browser-sessions/<sessionId>.json) is kept ONLY for
    // non-persistent sessions where no profile dir exists — it works fine for
    // simple sites but fails consistently for Google/Slack/Notion.
    const _hasPersistentProfile = sessionId.includes('agent');
    const _stateFile = path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
    if (_hasPersistentProfile) {
      // ── Auth-check cache hit — skip navigate+evaluate if recently confirmed ──
      const _cachedAuth = _getCachedAuthCheck(agentId);
      if (_cachedAuth && !_cachedAuth.authNeeded) {
        logger.info(`[browser.agent] run: auth-check cache hit for ${agentId} (${Math.round((Date.now() - _cachedAuth.ts) / 1000)}s ago) — skipping auth probe`);
        _skipNavigate = true;
      } else {
        logger.info(`[browser.agent] run: persistent-profile session — skipping JSON state-load, Chrome cookie store handles auth for ${agentId}`);
      }
    } else if (fs.existsSync(_stateFile)) {
      logger.info(`[browser.agent] run: state file found for ${agentId} — loading persisted auth state`);
      const _loadRes = await callBrowserAct({ action: 'state-load', sessionId, timeoutMs: 10000 }, 12000).catch(() => ({ ok: false }));
      if (_loadRes?.ok !== false) {
        // Navigate after injecting cookies — probe whether the session is still valid
        const _stateNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000).catch(() => ({ ok: false }));
        const _stateHrefRes = _stateNav?.ok !== false
          ? await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch((err) => {
              logger.error(`[browser.agent] auth-check eval failed (state persistence): ${err.message}`);
              return { ok: false, error: err.message };
            })
          : { ok: false, error: 'navigation failed' };
        let _stateCurHref = _stateHrefRes?.ok === false ? '' : String(_stateHrefRes?.result ?? _stateHrefRes?.stdout ?? '').trim();
        let _stateOnLogin = _isSigninWall(_stateCurHref);
        _skipNavigate = true; // already navigated above — skip the auth-check navigate below

        if (_stateOnLogin) {
          logger.info(`[browser.agent] run: state-load: initial redirect to signin for ${agentId} — waiting 3s and re-checking`);
          await new Promise(r => setTimeout(r, 3000));
          const _recheckRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
          const _recheckHref = _recheckRes?.ok === false ? '' : String(_recheckRes?.result ?? _recheckRes?.stdout ?? '').trim();
          if (!_isSigninWall(_recheckHref)) {
            logger.info(`[browser.agent] run: state-load: grace-period recheck cleared auth for ${agentId} (${_recheckHref})`);
            _stateCurHref = _recheckHref;
            _stateOnLogin = false;
          }
        }

        if (!_stateOnLogin) {
          logger.info(`[browser.agent] run: state-load: auth cleared for ${agentId} (${_stateCurHref}) — skipping waitForAuth`);
        } else {
          logger.warn(`[browser.agent] run: state-load: auth wall still present for ${agentId} after grace period — deleting stale state, re-authenticating`);
          try { fs.unlinkSync(_stateFile); } catch (_) {}
          _authNeeded = true;
        }
      } else {
        logger.warn(`[browser.agent] run: state-load failed for ${agentId} — falling back to fresh auth check`);
      }
    }

    // ── Domain continuity check: skip restart if already on target ─────────
    // Query user-memory to check if we're already on the target domain/page.
    // If so, skip daemon restart, auth checks, and recipe waypoints entirely.
    let _domainContinuitySkip = false;
    let _currentBrowserUrl = null;
    try {
      const memHost = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
      const memBody = JSON.stringify({
        version: 'mcp.v1',
        service: 'user-memory',
        action: 'memory.getRecentOcr',
        payload: { maxAgeSeconds: 15 },
        context: { userId: 'local_user' }
      });
      const memRes = await new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({ hostname: memHost, port: memPort, path: '/memory.getRecentOcr', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(memBody) }, timeout: 3000 }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } }); });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(memBody);
        req.end();
      });
      // MCP response format: { data: { available: true, capture: { url, appName, ... } } }
      logger.debug(`[browser.agent] domain-continuity: raw memRes keys=${Object.keys(memRes || {}).join(',')}`);
      const captureData = memRes?.data?.capture || memRes?.result?.capture;
      const isAvailable = memRes?.data?.available || memRes?.result?.available;
      logger.debug(`[browser.agent] domain-continuity: captureData=${!!captureData}, isAvailable=${isAvailable}`);
      if (isAvailable && captureData?.url) {
        _currentBrowserUrl = captureData.url;
        const currentHostname = new URL(_currentBrowserUrl).hostname;
        const startHostname = new URL(startUrl).hostname;
        // Extract base domain (e.g., w3schools.com from www.w3schools.com or my-learning.w3schools.com)
        const currentBaseDomain = currentHostname.split('.').slice(-2).join('.');
        const startBaseDomain = startHostname.split('.').slice(-2).join('.');
        logger.info(`[browser.agent] domain-continuity check: current=${currentHostname} (base: ${currentBaseDomain}) vs start=${startHostname} (base: ${startBaseDomain})`);
        // If already on same base domain, skip restart
        if (currentBaseDomain === startBaseDomain) {
          _domainContinuitySkip = true;
          logger.info(`[browser.agent] domain-continuity: MATCH - skipping browser restart`);
        } else {
          logger.info(`[browser.agent] domain-continuity: NO MATCH - will restart browser`);
        }
      } else {
        logger.info(`[browser.agent] domain-continuity: no current browser URL available (available=${isAvailable}, hasUrl=${!!captureData?.url})`);
      }
    } catch (_memErr) {
      logger.info(`[browser.agent] domain-continuity: user-memory query failed: ${_memErr.message}`);
    }

    // ── Skip browser restart if domain continuity detected ────────────────
    if (!_domainContinuitySkip) {
      // ── Close any existing playwright-cli daemon for this session ──────────
      const _shortSid = shortSessionId(sessionId);
      try {
        const { spawnSync } = require('child_process');
        const _closeRes = spawnSync(findCli(), ['-s=' + _shortSid, 'close'], { timeout: 5000, encoding: 'utf8' });
        if (_closeRes.status === 0) logger.info(`[browser.agent] closed existing playwright-cli daemon for session=${sessionId} (sid=${_shortSid})`);
      } catch (_) {}

      // ── Kill existing Chrome for this profile — prevents .sock EINVAL ──────
      try {
        const _killed = killExistingChromeForProfile(sessionId);
        if (_killed) logger.info(`[browser.agent] killed existing Chrome for session=${sessionId}`);
      } catch (_killErr) {
        logger.warn(`[browser.agent] killExistingChromeForProfile error (non-fatal): ${_killErr.message}`);
      }

      // ── Clear profile lock + crash markers so fresh launch succeeds ───────
      try { clearProfileLock(sessionId); } catch (_) {}

      // ── Stale .sock cleanup — prevents EINVAL on first navigate ──────────
      try {
        const _sockDir = path.join(os.tmpdir(), 'playwright-cli');
        if (fs.existsSync(_sockDir)) {
          const _sockFiles = fs.readdirSync(_sockDir, { recursive: true }).filter(f => String(f).endsWith('.sock') && (String(f).includes(sessionId) || String(f).includes(_shortSid)));
          for (const sf of _sockFiles) {
            try { fs.unlinkSync(path.join(_sockDir, String(sf))); logger.info(`[browser.agent] cleaned stale .sock: ${sf}`); } catch (_) {}
          }
        }
      } catch (_) {}

      // ── Helper: detect Chrome session conflict errors ─────────────────────
      const _isChromeSessionConflict = (result) => {
        const errStr = String(result?.error || result?.stderr || result?.stdout || '');
        return /Opening in existing browser session/i.test(errStr) ||
               /Failed to launch the browser process/i.test(errStr) ||
               /EINVAL.*\.sock/i.test(errStr);
      };

      if (!_skipNavigate) try {
        logger.info(`[browser.agent] run: playwright auth-check — navigating to ${startUrl} for ${agentId}`);
        const _probeNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000);

        // ── Chrome session conflict detection — fail fast ──────────────────
        if (_isChromeSessionConflict(_probeNav)) {
          logger.error(`[browser.agent] run: Chrome session conflict detected for ${agentId} — aborting (no retry)`);
          return { ok: false, agentId, task, error: 'Browser session conflict: Chrome is already running with this profile. Close existing Chrome windows for this agent or restart the app.' };
        }

        if (_probeNav?.ok !== false) {
          const _hrefRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch((err) => {
            logger.error(`[browser.agent] auth-check eval failed (fresh check): ${err.message}`);
            return { ok: false, error: err.message };
          });

          // ── Session health check: if eval also fails, browser is not running ──
          if (_hrefRes?.ok === false || _isChromeSessionConflict(_hrefRes)) {
            logger.error(`[browser.agent] run: browser session crashed for ${agentId} — flagging for retry`);
            return {
              ok: false,
              chromeCrash: true,
              agentId,
              task,
              error: 'Browser session crashed, will retry once',
              result: null,
              stdout: null,
            };
          }

          const _curHref = String(_hrefRes?.result ?? _hrefRes?.stdout ?? '').trim();
          const _onLoginPage = _isSigninWall(_curHref);
          // Also detect domain mismatch — e.g. redirect to workspace.google.com instead of mail.google.com
          let _wrongDomain = false;
          let _curHost = '';
          try {
            const _startHost = new URL(startUrl).hostname;
            _curHost   = new URL(_curHref.match(/https?:\/\//) ? _curHref : `https://${_curHref}`).hostname;
            // Same base domain (e.g. pathfinder.w3schools.com vs profile.w3schools.com) is NOT a mismatch
            const _startBase = _startHost.split('.').slice(-2).join('.');
            const _curBase   = _curHost.split('.').slice(-2).join('.');
            _wrongDomain = !!_startHost && !!_curHost && _curBase !== _startBase;
          } catch (_) {}

          // ── Parking/squatter detection via live page content ───────────────────
          // Checks page title + body text for broker/parking language. This is
          // content-based (not a hostname list) so it catches any parking provider.
          let _isParkingPage = false;
          try {
            const _pageInfoRes = await callBrowserAct({
              action: 'evaluate',
              text: `(() => {
                const title = document.title || '';
                const body   = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 800) : '';
                const links  = document.querySelectorAll('a').length;
                return JSON.stringify({ title, body, links });
              })()`,
              sessionId,
              timeoutMs: 5000,
            }, 8000).catch(() => null);
            if (_pageInfoRes?.ok !== false) {
              const _pageInfo = (() => { try { return JSON.parse(_pageInfoRes?.result ?? '{}'); } catch (_) { return {}; } })();
              const _pageText = `${_pageInfo.title || ''} ${_pageInfo.body || ''}`.toLowerCase();
              const _PARKING_RE = /\bdomain\s+(for\s+sale|is\s+for\s+sale|available\s+for\s+sale)\b|\bbuy\s+this\s+domain\b|\bmake\s+an?\s+offer\b|\bparked\s+(by|domain|page)\b|\binquire\s+about\s+this\s+domain\b|\bthis\s+domain\s+(may\s+be|is)\s+(for\s+sale|available)\b/;
              if (_PARKING_RE.test(_pageText) || (Number(_pageInfo.links) < 10 && /for\s+sale|buy|offer|domain/i.test(_pageText))) {
                _isParkingPage = true;
                logger.warn(`[browser.agent] run: parking/squatter content detected on ${_curHost} for ${agentId}`);
              }

              // ── LLM-based auth detection — catches landing pages not detected by URL patterns ──
              // If URL check passed but page content shows auth indicators (landing page, "sign in to continue", etc.)
              // use LLM semantic analysis to confirm before skipping auth.
              if (!_onLoginPage) {
                // Quick keyword pre-filter to avoid unnecessary LLM calls
                const _authIndicators = /sign\s*in|log\s*in|enter\s*your\s*email|workspace\s*not\s+found|where\s+should\s+we\s+begin|get\s+started|create\s+workspace|sign\s*in\s*to\s*continue/i;
                if (_authIndicators.test(_pageText)) {
                  logger.info(`[browser.agent] Auth indicators found in page content, confirming with LLM...`);
                  const _llmDetected = await _detectAuthViaLLM(_pageInfo.title || '', _pageInfo.body || '', agentId);
                  if (_llmDetected) {
                    _onLoginPage = true;
                    logger.info(`[browser.agent] LLM confirmed auth required — treating as login page`);
                  }
                }
              }
            }
          } catch (_pageErr) {
            logger.warn(`[browser.agent] run: parking content check failed (non-fatal): ${_pageErr.message}`);
          }

          // ── Internal web.agent self-heal ───────────────────────────────────────
          // Trigger on: (a) domain mismatch OR (b) parking content detected on any domain.
          // For domain mismatch that is NOT a parking page (e.g. workspace.google.com for mail.google.com),
          // web.agent is tried first but if it finds nothing we fall through to waitForAuth — no regression.
          const _needsHeal = _wrongDomain || _isParkingPage;
          if (_needsHeal && !_onLoginPage) {
            const _svcName = existing?.service || agentId.replace('.agent', '');
            const _healReason = _isParkingPage ? `parking content on ${_curHost}` : `domain mismatch (expected ${(() => { try { return new URL(startUrl).hostname; } catch(_){return startUrl;} })()}, got ${_curHost})`;
            logger.warn(`[browser.agent] run: ${_healReason} — attempting web.agent self-heal for ${agentId}`);
            let _healedUrl = null;
            try {
              const _webResult = await callSkill('web.agent', {
                action: 'search_and_navigate',
                query: `${_svcName} official website`,
                preferDomain: _svcName,
              }, 10000);
              if (_webResult?.ok && _webResult?.bestUrl) {
                _healedUrl = _webResult.bestUrl;
                logger.info(`[browser.agent] self-heal: web.agent found ${_healedUrl} for ${agentId}`);
              }
            } catch (_healErr) {
              logger.warn(`[browser.agent] self-heal: web.agent call failed: ${_healErr.message}`);
            }

            if (_healedUrl) {
              // Update startUrl and invalidate DuckDB meta cache so next run uses the correct URL
              startUrl = _healedUrl;
              try {
                await withDb(async (_db) => {
                  const _seedKey = _svcName.toLowerCase().replace(/[^a-z0-9]/g, '');
                  await _db.run('DELETE FROM browser_meta_cache WHERE service = ?', _seedKey).catch(() => {});
                });
              } catch (_) {}
              logger.info(`[browser.agent] self-heal: retrying with corrected startUrl=${startUrl}`);
              const _retryNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000).catch(() => ({ ok: false }));
              if (_retryNav?.ok !== false) {
                logger.info(`[browser.agent] self-heal: navigate to corrected URL succeeded — skipping waitForAuth`);
                _setCachedAuthCheck(agentId, false);
              } else {
                logger.warn(`[browser.agent] self-heal: corrected URL navigate failed — failing fast`);
                return { ok: false, agentId, task, wrongDomain: true, landedUrl: _curHref, expectedService: agentId, error: `Navigated to corrected URL ${startUrl} but browser failed to load it.` };
              }
            } else if (_isParkingPage) {
              // Parking page + web.agent found nothing → fail fast, recoverSkill handles it
              logger.warn(`[browser.agent] self-heal: parking page detected but no corrected URL found — returning wrongDomain error`);
              return { ok: false, agentId, task, wrongDomain: true, landedUrl: _curHref, expectedService: agentId, error: `${agentId} loaded a domain parking/squatter page at ${_curHref}. Could not automatically resolve the correct URL for "${_svcName}".` };
            } else {
              // Domain mismatch but web.agent found nothing better → this may be a valid redirect (e.g. workspace.google.com)
              // Fall through to waitForAuth as before
              logger.info(`[browser.agent] self-heal: no better URL found for domain mismatch — falling back to waitForAuth`);
              _authNeeded = true;
            }
          } else if (_onLoginPage || _wrongDomain) {
            const _reason = _onLoginPage ? 'login redirect' : `domain mismatch (expected ${(() => { try { return new URL(startUrl).hostname; } catch(_){return startUrl;} })()}, got ${_curHost || _curHref})`;
            logger.info(`[browser.agent] run: auth-check: ${_reason} — calling waitForAuth for ${agentId}`);
            _authNeeded = true;
          } else {
            logger.info(`[browser.agent] run: auth-check: no login redirect${_curHref ? ` (${_curHref})` : ''} — skipping waitForAuth for ${agentId}`);
            _setCachedAuthCheck(agentId, false);
          }
        }
      } catch (_probeErr) {
        // Check if the thrown error is a Chrome conflict — fail fast instead of falling to waitForAuth
        if (/Opening in existing browser session/i.test(_probeErr.message) || /Failed to launch/i.test(_probeErr.message)) {
          logger.error(`[browser.agent] run: Chrome session conflict (thrown) for ${agentId} — aborting`);
          return { ok: false, agentId, task, error: 'Browser session conflict: Chrome is already running with this profile. Close existing Chrome windows for this agent or restart the app.' };
        }
        logger.warn(`[browser.agent] run: auth-check probe failed — falling back to waitForAuth: ${_probeErr.message}`);
        _authNeeded = true;
      }
    } else {
      // Domain continuity: skip auth checks and proceed directly to task
      logger.info(`[browser.agent] domain-continuity: skipping auth checks, proceeding directly to task execution`);
    }
    if (_authNeeded && skipAuth) {
      logger.info(`[browser.agent] run: login wall detected but skipAuth=true for ${agentId} — proceeding as guest`);
      _authNeeded = false;
    }
    if (_authNeeded) {
      // ── Resolve stored credentials via user.agent before opening auth form ──────
      // user.agent calls profile.get which transparently decrypts SAFE: blobs so
      // waitForAuth receives plaintext email + password for form auto-fill.
      let _credentials = {};
      try {
        const credResult = await userAgent({ action: 'resolve_credentials', agentId });
        if (credResult?.ok && credResult.resolved) {
          _credentials = credResult.resolved;
          const emailOk = !!_credentials.email;
          const passOk  = !!_credentials.password;
          logger.info(`[browser.agent] resolved credentials for ${agentId} (email ${emailOk ? '✓' : '✗'}, password ${passOk ? '✓' : '✗'})`);
        }
      } catch (_credErr) {
        logger.warn(`[browser.agent] user.agent resolve_credentials failed (non-fatal): ${_credErr.message}`);
      }

      // ── Credential gate: prompt user if no email stored ─────────────────────
      // Fires the existing ask_user short-circuit in executeCommand.js which
      // surfaces the credential gather card and stores email/password securely.
      // The user can type "skip" to proceed with manual login instead.
      if (!_credentials.email) {
        const _credNorm = agentId.toLowerCase().replace(/\.agent$/, '');
        return {
          ok:              false,
          agentId,
          task,
          askUser:         true,
          question:        `What email or username do you use for ${agentId}? (It will be stored securely for future logins. Type "skip" to log in manually.)`,
          options:         [],
          needsCredentials: true,
          credentialKey:   `credential:${_credNorm}.agent:email`,
        };
      }

      let authResult;
      try {
        authResult = await callBrowserAct({
          action: 'waitForAuth',
          sessionId,
          url: signInUrl || startUrl,
          authSuccessUrl: authSuccessPattern,
          credentials: _credentials,
          timeoutMs: 2 * 60 * 1000,
          _progressCallbackUrl,
        }, 3 * 60 * 1000);
      } catch (err) {
        const failureNote = `[${new Date().toISOString()}] waitForAuth threw: ${err.message} | url=${startUrl} | task=${task}`;
        logger.warn(`[browser.agent] run: waitForAuth threw — triggering self-heal for ${agentId}`);
        (async () => {
          try {
            await actionRecordFailure({ id: agentId, failureEntry: failureNote });
            const healResult = await actionValidateAgent({ id: agentId });
            logger.info(`[browser.agent] self-heal (throw): validate_agent verdict=${healResult?.verdict} for ${agentId}`);
          } catch (healErr) {
            logger.warn(`[browser.agent] self-heal error: ${healErr.message}`);
          }
        })();
        return { ok: false, error: `waitForAuth failed: ${err.message}` };
      }
      if (!authResult?.ok) {
        const failureNote = `[${new Date().toISOString()}] waitForAuth failed: ${authResult?.error || 'timeout'} | url=${startUrl} | task=${task}`;
        logger.warn(`[browser.agent] run: auth failed — recording failure + triggering self-heal for ${agentId}`);
        (async () => {
          try {
            await actionRecordFailure({ id: agentId, failureEntry: failureNote });
            const healResult = await actionValidateAgent({ id: agentId });
            logger.info(`[browser.agent] self-heal: validate_agent verdict=${healResult?.verdict} for ${agentId}`);
          } catch (healErr) {
            logger.warn(`[browser.agent] self-heal error: ${healErr.message}`);
          }
        })();
        return { ok: false, error: `Auth failed for ${agentId}: ${authResult?.error}` };
      }
      // Persistent-profile sessions: the Chrome profile dir already persists cookies/IndexedDB.
      // JSON state-save is redundant for *_agent sessions and creates stale files that
      // interfere on next run (Google rejects injected JSON cookies). Skip it.
      _setCachedAuthCheck(agentId, false);
      if (!_hasPersistentProfile) {
        logger.info(`[browser.agent] run: auth succeeded — saving browser state for ${agentId}`);
        await callBrowserAct({ action: 'state-save', sessionId, timeoutMs: 10000 }, 12000).catch(e => {
          logger.warn(`[browser.agent] run: state-save failed (non-fatal): ${e.message}`);
        });
      } else {
        logger.info(`[browser.agent] run: auth succeeded for ${agentId} — profile dir persists auth (skipping JSON state-save)`);
      }
    }
  }

  // Step 2: delegate to playwright.agent or agentbrowser.agent with the authenticated session
  logger.info(`[browser.agent] run: auth ok — delegating to ${_agentSkill} for "${task}"`);

  // ── preTaskGoal injection + startUrl recovery anchor ────────────────────────
  // Some services (e.g. googleaimode) require a UI interaction BEFORE the main task.
  // All services get a recovery anchor so playwright.agent knows where to return if
  // the session goes blank (about:blank) — it must navigate back to startUrl, NOT
  // invent its own fallback destination (e.g. google.com search).
  const _recoveryAnchor = startUrl
    ? `IMPORTANT: You are working on ${startUrl} (browser session: ${sessionId}). If the page ever shows about:blank, a blank page, or you lose the site, navigate back to ${startUrl} immediately — do NOT navigate to any other website as a fallback.`
    : null;
  const _effectiveTask = _svcInfo?.preTaskGoal
    ? `${_svcInfo.preTaskGoal}\n\nTask: ${task}`
    : _recoveryAnchor
      ? `${_recoveryAnchor}\n\nTask: ${task}`
      : task;

  // ── Goal-aware playbook injection ────────────────────────────────────────────
  // Tier 1: semantic embedding match → best ### section(s) injected directly.
  //         Uses /memory.embed (user-memory service) + local cosine similarity.
  //         Falls back to keyword scan if embedding service is unavailable.
  //         Compound tasks get all sections above the similarity threshold.
  // Tier 2: no match → inject 2 seeded sections as FORMAT EXAMPLES + a NOVEL TASK
  //         comment so playwright.agent reasons from the live snapshot. 0 LLM calls,
  //         0 added latency. Async COT write-back fires after success to cache for next run.
  // Tier 3: no playbook sections exist yet → inject core descriptor only (bare agent).
  let _agentContext   = undefined;
  let _playbookTier   = 3;        // tracked for post-execution write-back decision
  if (existing.descriptor) {
    const _coreDescriptor = existing.descriptor.replace(/\n## Playbooks[\s\S]*/m, '').trim();
    const _playbook = await _resolvePlaybookSemantic(agentId, existing.descriptor, task);
    let _matchedPlaybook = null;

    if (_playbook.tier === 1) {
      // Tier 1: direct match (possibly multiple sections for compound tasks)
      _matchedPlaybook = _playbook.section;
      _playbookTier    = 1;
      const headers = _playbook.section.match(/^### .+/gm) || [];
      logger.info(`[browser.agent] playbook: tier-1 match (${headers.length} section(s)) for ${agentId} — ${headers.map(h => `"${h}"`).join(', ')}`);

      // Check for DELEGATE_TO directive — special playbooks that delegate to other skills
      const delegateMatch = _matchedPlaybook.match(/DELEGATE_TO:\s*(\S+)/);
      if (delegateMatch) {
        const delegateSkill = delegateMatch[1];
        const platformMatch = _matchedPlaybook.match(/PLATFORM:\s*(\S+)/);
        const platform = platformMatch ? platformMatch[1] : serviceKey;

        // Pure search/lookup tasks should stay in browser.agent instead of being handed to video.agent.
        // e.g. "search YouTube for sourdough bread tutorials" should use the Search Videos playbook.
        if (delegateSkill === 'video.agent' && _isPureSearchTask(task)) {
          logger.info(`[browser.agent] run: pure search task detected for ${agentId} — keeping in browser.agent, skipping video.agent delegation`);
          _matchedPlaybook = _matchedPlaybook
            .split(/(?=\n### )/)
            .filter(block => !block.includes('DELEGATE_TO: video.agent'))
            .join('');
        } else if (delegateSkill === 'video.agent') {
          // Strip instruction noise before passing to video.agent.
          // Task like "watch X, extract the key steps, then summarize" → "X"
          // Only the video identity part (title/creator) should reach the search.
          const _videoQuery = task
            .replace(/,.*$/s, '')                                   // drop everything after first comma
            .replace(/;\s*.*/s, '')                                  // drop everything after semicolon
            .replace(/^(?:watch|find|play|open|show|get|look up|navigate to|go to)\s+/i, '') // leading verb
            .replace(/\s+(?:and|then)\s+.*$/i, '')                  // trailing "and/then ..."
            .trim() || task;
          logger.info(`[browser.agent] run: delegating to video.agent for ${agentId} — query="${_videoQuery.slice(0, 80)}"`);
          try {
            const videoResult = await callSkill('video.agent', {
              action: 'find_and_watch_tutorial',
              platform: platform,
              query: _videoQuery,
              goal: task,
            }, 120000);

            if (videoResult?.ok) {
              logger.info(`[browser.agent] run: video.agent completed successfully`);
              return {
                ok: true,
                agentId,
                task,
                result: videoResult.result || videoResult.data || videoResult,
                delegated: 'video.agent',
              };
            } else {
              logger.warn(`[browser.agent] run: video.agent failed — ${videoResult?.error || 'unknown error'}`);
              return {
                ok: false,
                agentId,
                task,
                error: videoResult?.error || 'video.agent delegation failed',
                delegated: 'video.agent',
              };
            }
          } catch (videoErr) {
            logger.error(`[browser.agent] run: video.agent error — ${videoErr.message}`);
            return {
              ok: false,
              agentId,
              task,
              error: `video.agent error: ${videoErr.message}`,
              delegated: 'video.agent',
            };
          }
        }
      }

    } else if (_playbook.subsections.length > 0) {
      // Tier 2: no keyword match but we have seed sections to use as format references.
      // Inject the 2 shortest (most focused) sections as few-shot examples so playwright.agent
      // understands action vocabulary and output format — then let it reason from the live snapshot.
      const formatExamples = [..._playbook.subsections]
        .sort((a, b) => a.length - b.length)
        .slice(0, 2)
        .join('\n\n');
      _matchedPlaybook = `<!-- NOVEL TASK: no direct playbook match for this goal.\n` +
        `Take a snapshot first, then reason from the live DOM to accomplish the goal.\n` +
        `The sections below are FORMAT EXAMPLES ONLY — do not follow their steps literally.\n` +
        `Available actions: click, dblclick, hover, drag, fill, type, select, check, uncheck, upload,\n` +
        `press, keydown, keyup, navigate, go-back, reload, tab-new, tab-select, tab-close,\n` +
        `snapshot (after every DOM change), screenshot, eval, run-code, dialog-accept, dialog-dismiss,\n` +
        `mousewheel (scroll), return -->\n\n` +
        formatExamples;
      _playbookTier = 2;
      logger.info(`[browser.agent] playbook: tier-2 format-reference for ${agentId} — novel goal="${task.slice(0, 60)}"`);

    } else {
      // Tier 3: no playbook sections at all — bare core descriptor
      _playbookTier = 3;
      logger.info(`[browser.agent] playbook: tier-3 core-only for ${agentId} — no playbook sections exist yet`);
    }

    // ── Substitute playbook placeholders (e.g., <encoded_query>) ─────────────
    // Extract query from task and substitute into playbook templates
    if (_matchedPlaybook && task) {
      // Extract query from patterns like "search youtube for X", "find X videos", etc.
      const queryMatch = task.match(/(?:search|find|lookup)\s+(?:youtube|videos?\s+(?:about|for|on))\s+for\s+(.+)$/i) ||
                         task.match(/(?:search|find|lookup)\s+(?:youtube|videos?\s+(?:about|for|on))\s+(.+)$/i) ||
                         task.match(/(?:search|find)\s+for\s+(.+?)\s+(?:on\s+youtube|videos)/i) ||
                         task.match(/(?:watch|find)\s+(.+?)\s+(?:video|tutorial)/i) ||
                         task.match(/(?:how\s+to|what\s+is)\s+(.+)$/i);
      
      if (queryMatch) {
        const rawQuery = queryMatch[1].trim();
        // Remove trailing punctuation and common suffixes
        const cleanQuery = rawQuery
          .replace(/\s+(?:video|videos|tutorial|tutorials)\s*$/i, '')
          .replace(/[?.!]+$/, '')
          .trim();
        
        if (cleanQuery) {
          const encodedQuery = encodeURIComponent(cleanQuery).replace(/%20/g, '+');
          const originalPlaybook = _matchedPlaybook;
          _matchedPlaybook = _matchedPlaybook.replace(/<encoded_query>/g, encodedQuery);
          
          if (_matchedPlaybook !== originalPlaybook) {
            logger.info(`[browser.agent] playbook: substituted <encoded_query> with "${cleanQuery.slice(0, 40)}"`);
          }
        }
      }
    }

    _agentContext = (_coreDescriptor + (_matchedPlaybook ? '\n\n## Playbooks\n' + _matchedPlaybook : '')).slice(0, 3000);
  }

  // ── Inject installed domain skills into _agentContext ───────────────────────
  // Load atomic skills for this agent's service domain and surface them to playwright.agent
  // so it can plan external_skill steps alongside browser.act steps.
  const _domainForSkills = existing?.service || agentId.replace('.agent', '');
  try {
    const SKILLS_BASE = path.join(os.homedir(), '.thinkdrop', 'skills');
    if (fs.existsSync(SKILLS_BASE)) {
      const skillDirs = fs.readdirSync(SKILLS_BASE).filter(d =>
        fs.existsSync(path.join(SKILLS_BASE, d, 'skill.json'))
      );
      const domainSkills = [];
      for (const d of skillDirs) {
        try {
          const sj = JSON.parse(fs.readFileSync(path.join(SKILLS_BASE, d, 'skill.json'), 'utf8'));
          const skillDomain = sj.source_domain || sj.agent_id?.replace('.agent', '') || '';
          if (!skillDomain) continue;
          // Match if skill's domain contains the agent service name or vice-versa
          if (skillDomain.includes(_domainForSkills) || _domainForSkills.includes(skillDomain)) {
            if (!sj.goal_tied) continue; // only surface goal_tied atomics as building blocks
            domainSkills.push({ name: d, description: sj.description || sj.source_action || d, sourceAction: sj.source_action || '' });
          }
        } catch (_) {}
      }
      if (domainSkills.length > 0) {
        const skillsNote = `\n\n## Available Atomic Skills (use external_skill action for these exact sub-tasks)\n` +
          domainSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
        _agentContext = (_agentContext + skillsNote).slice(0, 3500);
        logger.info(`[browser.agent] run: injected ${domainSkills.length} domain skill(s) for ${_domainForSkills} into context`);
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Trained recipe injection (guided agentic mode) ──────────────────────────
  // If the user's task matches a trained skill recipe (fuzzy: dots/spaces/underscores),
  // inject the waypoint recipe as navigation guidance for playwright.agent.
  // The recipe provides ordered waypoints so the agent knows WHERE to navigate,
  // then the user's actual task tells it WHAT to do once there.
  let _trainedRecipeInjected = false;
  try {
    const trainerAgent = require('./trainer.agent.cjs');
    const _agentIdClean = agentId.replace('.agent', '');
    // Try fuzzy match on task text first, then fall back to single-recipe auto-inject
    let recipe = trainerAgent.findMatchingRecipe(_agentIdClean, task);
    if (!recipe) {
      // Fallback: if this agent has exactly 1 trained recipe, auto-inject it
      const allSkills = trainerAgent.actionListSkills({ agentId: _agentIdClean });
      if (allSkills.ok && allSkills.skills && allSkills.skills.length === 1) {
        recipe = trainerAgent.loadRecipe(_agentIdClean, allSkills.skills[0].name);
        if (recipe) logger.info(`[browser.agent] run: auto-injecting sole trained recipe "${recipe.name}" for ${agentId}`);
      }
    }
    if (recipe && recipe.waypoints && recipe.waypoints.length > 0) {
      const waypointSteps = recipe.waypoints.map(wp => {
        if (wp.type === 'navigate') return `  ${wp.step}. NAVIGATE to ${wp.url} (checkpoint: ${wp.checkpoint || wp.pageTitle || ''})`;
        if (wp.type === 'click') return `  ${wp.step}. CLICK "${wp.elementText || ''}" selector: ${wp.selector}${wp.altSelectors?.length ? ` (alt: ${wp.altSelectors[0]})` : ''}`;
        if (wp.type === 'check') return `  ${wp.step}. CHECK "${wp.label || ''}" selector: ${wp.selector} → ${wp.checked ? 'on' : 'off'}`;
        if (wp.type === 'drag') return `  ${wp.step}. DRAG from ${wp.fromSelector} by (${(wp.toX || 0) - (wp.fromX || 0)}, ${(wp.toY || 0) - (wp.fromY || 0)})px`;
        if (wp.type === 'scroll') return `  ${wp.step}. SCROLL ${wp.deltaY > 0 ? 'down' : 'up'} ${Math.abs(wp.deltaY || 0)}px to reveal content`;
        return `  ${wp.step}. ${wp.type.toUpperCase()} ${wp.selector || wp.url || ''}`;
      }).join('\n');

      const recipeBlock = `\n\n## Trained Navigation Recipe: ${recipe.name}\n` +
        `TARGET: ${recipe.targetUrl || ''}\n` +
        (recipe.targetDescription ? `EDITOR/PAGE RULES: ${recipe.targetDescription}\n` : '') +
        `Follow these waypoints IN ORDER to reach the target page. After reaching the target, execute the user's task.\n` +
        `WAYPOINTS:\n${waypointSteps}\n\n` +
        `RULES:\n` +
        `- Follow waypoints sequentially — verify each checkpoint before advancing\n` +
        `- If a waypoint selector fails, try altSelectors or reason from the live snapshot\n` +
        `- Once at the TARGET page, stop navigating and execute the user's actual task\n` +
        `- The recipe is GUIDANCE — if the site layout changed, adapt using the snapshot`;

      _agentContext = (_agentContext + recipeBlock).slice(0, 5000);
      _trainedRecipeInjected = true;
      logger.info(`[browser.agent] run: injected trained recipe "${recipe.name}" (${recipe.waypoints.length} waypoints) for ${agentId}`);
    }
  } catch (_recipeErr) {
    logger.warn(`[browser.agent] trained recipe lookup failed (non-fatal): ${_recipeErr.message}`);
  }

  // ── Query current browser state from user-memory monitor ──────────────────
  // Use the background screen monitor (running every 5s) to check if we're already
  // on the target domain. This enables "do it" / "now look up X" style follow-ups
  // without re-navigating from scratch.
  let _currentBrowserState = null;
  let _skipNavigation = false;
  try {
    const memHost = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
    const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
    const memBody = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'memory.getRecentOcr',
      payload: { maxAgeSeconds: 15 },
      context: { userId: 'local_user' }
    });
    const memRes = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: memHost, port: memPort, path: '/memory.getRecentOcr', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(memBody) }, timeout: 3000 }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } }); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(memBody);
      req.end();
    });
    // MCP response format: { data: { available: true, capture: { url, appName, ... } } }
    const captureData = memRes?.data?.capture || memRes?.result?.capture;
    const isAvailable = memRes?.data?.available || memRes?.result?.available;
    if (isAvailable && captureData) {
      _currentBrowserState = { appName: captureData.appName, windowTitle: captureData.windowTitle, url: captureData.url, text: captureData.text };
      logger.info(`[browser.agent] current browser state: ${captureData.windowTitle} @ ${captureData.url}`);
    }
  } catch (_memErr) {
    // Non-fatal, proceed without current state
    logger.debug(`[browser.agent] could not fetch current browser state: ${_memErr.message}`);
  }

  // ── Deterministic recipe execution ─────────────────────────────────────────
  // Instead of relying on the LLM to interpret recipe waypoints from prompt text,
  // execute them programmatically using browser.act. Once at the target page,
  // playwright.agent only needs to handle the user's actual creative task.
  let _recipeExecutedOk = false;
  let _activeRecipe = null;   // hoisted so recipe-doctor can access it at askUser time
  let _activeAgentIdClean = agentId.replace('.agent', '');
  let _extractedData = null; // WALT: stores extraction waypoint results
  if (_trainedRecipeInjected) {
    try {
      const trainerAgent = require('./trainer.agent.cjs');
      const _agentIdClean = _activeAgentIdClean;
      const _execRecipe = trainerAgent.findMatchingRecipe(_agentIdClean, task)
        || (() => { const ls = trainerAgent.actionListSkills({ agentId: _agentIdClean }); return (ls.ok && ls.skills?.length === 1) ? trainerAgent.loadRecipe(_agentIdClean, ls.skills[0].name) : null; })();

      if (_execRecipe && _execRecipe.waypoints && _execRecipe.waypoints.length > 0) {
        _activeRecipe = _execRecipe; // hoist for recipe-doctor access at askUser time
        // ── Domain continuity check ─────────────────────────────────────────
        // Check if we're already on the target domain (trained recipe target)
        if (_currentBrowserState?.url && _execRecipe.targetUrl) {
          try {
            const currentHostname = new URL(_currentBrowserState.url).hostname;
            const targetHostname = new URL(_execRecipe.targetUrl).hostname;
            // Extract base domain (e.g., w3schools.com from www.w3schools.com or my-learning.w3schools.com)
            const currentBaseDomain = currentHostname.split('.').slice(-2).join('.');
            const targetBaseDomain = targetHostname.split('.').slice(-2).join('.');
            const targetPath = new URL(_execRecipe.targetUrl).pathname;
            // If same base domain AND current URL contains the target path → skip navigation
            if (currentBaseDomain === targetBaseDomain && _currentBrowserState.url.includes(targetPath.replace(/\/$/, ''))) {
              _skipNavigation = true;
              _recipeExecutedOk = true;
              logger.info(`[browser.agent] domain-continuity: already at target (${_currentBrowserState.url}), skipping recipe navigation`);
            }
          } catch {}
        }

        if (!_skipNavigation) {
          logger.info(`[browser.agent] recipe-exec: executing ${_execRecipe.waypoints.length} waypoints deterministically for "${_execRecipe.name}"`);
          let _wpFailed = false;

          for (const wp of _execRecipe.waypoints) {
            if (_wpFailed) break;
            try {
              if (wp.type === 'navigate') {
                const navRes = await callBrowserAct({ action: 'navigate', url: wp.url, sessionId });
                if (!navRes?.ok && navRes?.error) { logger.warn(`[browser.agent] recipe-exec: navigate failed — ${navRes.error}`); _wpFailed = true; }
                else { logger.info(`[browser.agent] recipe-exec: step ${wp.step} navigate → ${wp.url} ✓`); }
              } else if (wp.type === 'click') {
                // Build selector fallback chain with priorities
                let selectors = [];
                
                // Priority 1: Combined href + text (most specific from new CDP recorder)
                if (wp.altSelectors) {
                  const combined = wp.altSelectors.find(s => s.includes('[href*="') && s.includes(':has-text('));
                  if (combined) selectors.push(combined);
                }
                
                // Priority 2: href-based selector (most reliable for links)
                if (wp.href) {
                  try {
                    const hrefPath = new URL(wp.href).pathname;
                    selectors.push(`a[href="${wp.href}"]`);
                    selectors.push(`a[href*="${hrefPath}"]`);
                    // Also try just the filename
                    const filename = hrefPath.split('/').pop();
                    if (filename) selectors.push(`a[href*="${filename}"]`);
                  } catch {}
                }
                
                // Priority 3: primary selector
                if (wp.selector) selectors.push(wp.selector);
                
                // Priority 4: alt selectors from new CDP format (href-exact, href-partial, text, class+text)
                if (wp.altSelectors) {
                  // href-exact
                  const hrefExact = wp.altSelectors.find(s => s.match(/\[href="[^"]+"\]$/));
                  if (hrefExact && !selectors.includes(hrefExact)) selectors.push(hrefExact);
                  // href-partial
                  const hrefPartial = wp.altSelectors.find(s => s.includes('[href*="') && !s.includes(':has-text('));
                  if (hrefPartial && !selectors.includes(hrefPartial)) selectors.push(hrefPartial);
                  // class+text
                  const classText = wp.altSelectors.find(s => s.match(/\.[a-z][a-z0-9_-]*.*:has-text/));
                  if (classText && !selectors.includes(classText)) selectors.push(classText);
                  // has-text
                  const hasText = wp.altSelectors.find(s => s.includes(':has-text('));
                  if (hasText && !selectors.includes(hasText)) selectors.push(hasText);
                  // text-is (exact match)
                  const textIs = wp.altSelectors.find(s => s.includes(':text-is('));
                  if (textIs && !selectors.includes(textIs)) selectors.push(textIs);
                }
                
                // Priority 5: text-based fallback (last resort)
                if (wp.elementText) {
                  selectors.push(`text="${wp.elementText.substring(0, 40)}"`);
                }
                
                // Priority 6: ARIA-based from altSelectors
                if (wp.altSelectors) {
                  const ariaSel = wp.altSelectors.find(s => s.includes('[aria-label=') || s.includes('[aria-labelledby='));
                  if (ariaSel && !selectors.includes(ariaSel)) selectors.push(ariaSel);
                }

                let clicked = false;
                let lastError = '';
                let successSelector = '';
                for (const sel of selectors) {
                  const clickRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  // Use exitCode for consistent success checking
                  if (clickRes?.exitCode === 0 || clickRes?.ok === true) {
                    clicked = true;
                    successSelector = sel;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} click "${wp.elementText || sel}" ✓ (selector: ${sel.substring(0, 50)})`);
                    break;
                  } else {
                    lastError = clickRes?.stderr || clickRes?.error || 'unknown';
                    logger.debug(`[browser.agent] recipe-exec: step ${wp.step} click failed with selector "${sel.substring(0, 40)}" — ${lastError}`);
                  }
                }
                if (!clicked) {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} click failed for all selectors (last error: ${lastError})`);
                  _wpFailed = true;
                } else {
                  // After successful click, check if the target URL was reached.
                  // Links that open in a new tab will leave the current tab unchanged —
                  // detect this and navigate directly to wp.href to stay on track.
                  if (wp.href) {
                    try {
                      await new Promise(r => setTimeout(r, 800)); // Brief wait for any navigation to start
                      const urlCheck = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId });
                      const currentUrl = (urlCheck?.result || urlCheck?.data || '').replace(/"/g, '').replace(/^"|"$/g, '');
                      
                      // Determine expected destination: wp.href itself or the recipe targetUrl
                      const _destUrl  = wp.href;
                      const _destPath = new URL(_destUrl).pathname.split('?')[0];
                      if (currentUrl && !currentUrl.includes(_destPath)) {
                        logger.info(`[browser.agent] recipe-exec: step ${wp.step} click opened new tab or didn't navigate — navigating directly to ${_destUrl}`);
                        const navRes = await callBrowserAct({ action: 'navigate', url: _destUrl, sessionId });
                        if (navRes?.exitCode === 0 || navRes?.ok === true) {
                          logger.info(`[browser.agent] recipe-exec: direct navigation to ${_destUrl} ✓`);
                          _currentBrowserState = { ..._currentBrowserState, url: _destUrl };
                        } else {
                          logger.warn(`[browser.agent] recipe-exec: direct navigation failed — ${navRes?.error || 'unknown'}`);
                        }
                      }
                    } catch (navErr) {
                      logger.debug(`[browser.agent] recipe-exec: post-click navigation check failed (non-fatal): ${navErr.message}`);
                    }
                  }
                }
              } else if (wp.type === 'check') {
                // Try primary selector, then alt selectors
                let checkSelectors = [wp.selector];
                if (wp.altSelectors) {
                  checkSelectors.push(...wp.altSelectors.filter(s => !s.startsWith('text=')));
                }
                
                let checked = false;
                for (const sel of checkSelectors) {
                  const checkRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  if (checkRes?.exitCode === 0) {
                    checked = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} check "${wp.label}" ✓`);
                    break;
                  }
                }
                if (!checked) { 
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} check failed for all selectors`);
                  _wpFailed = true; 
                }
              } else if (wp.type === 'extract') {
                // Data extraction waypoint - WALT tool returns
                try {
                  const extractOptions = { dataAttr: wp.dataAttr, attrName: wp.attrName };
                  const extractCode = _buildExtractionCode(wp.selector, wp.extractType || 'text', extractOptions);
                  const extractRes = await callBrowserAct({ action: 'evaluate', text: extractCode, sessionId });
                  
                  if (extractRes?.exitCode === 0) {
                    const extractedValue = (extractRes?.result || extractRes?.data || '').replace(/^["']|["']$/g, '');
                    
                    // Store in agent context for LLM to use
                    if (!_extractedData) _extractedData = {};
                    _extractedData[wp.extractName] = extractedValue;
                    
                    // Also add to _agentContext so LLM sees it
                    const extractInfo = `\n[EXTRACTION] ${wp.extractName}: "${extractedValue.substring(0, 200)}${extractedValue.length > 200 ? '...' : ''}"`;
                    _agentContext = (_agentContext + extractInfo).slice(0, 5000);
                    
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} extract "${wp.extractName}" ✓ (${extractedValue.length} chars)`);
                  } else {
                    logger.warn(`[browser.agent] recipe-exec: step ${wp.step} extract failed — ${extractRes?.stderr || 'unknown error'}`);
                    // Don't fail the recipe for extraction errors, just log
                  }
                } catch (extractErr) {
                  logger.debug(`[browser.agent] recipe-exec: extract error (non-fatal): ${extractErr.message}`);
                }

              } else if (wp.type === 'scroll') {
                // Scroll the page — non-fatal
                const scrollCode = `window.scrollBy(0, ${wp.deltaY || 0})`;
                await callBrowserAct({ action: 'evaluate', text: scrollCode, sessionId });
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} scroll ${wp.deltaY || 0}px ✓`);

              } else if (wp.type === 'focus') {
                // Focus an element (e.g. textarea, input) — non-fatal
                const focusSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let focused = false;
                for (const sel of focusSelectors) {
                  const focusCode = `(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.focus(); return true; } return false; })()`;
                  const focusRes = await callBrowserAct({ action: 'evaluate', text: focusCode, sessionId });
                  const result = String(focusRes?.result || focusRes?.data || '').replace(/^"|"$/g, '');
                  if (result === 'true' || focusRes?.exitCode === 0) {
                    focused = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} focus "${sel}" ✓`);
                    break;
                  }
                }
                if (!focused) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} focus — element not found (non-fatal)`);

              } else if (wp.type === 'evaluate') {
                // Run arbitrary JS on the page — non-fatal
                // Used by patched recipes to call JS APIs (e.g. editor.setValue('') for CodeMirror)
                if (wp.code) {
                  const evalRes = await callBrowserAct({ action: 'evaluate', text: wp.code, sessionId });
                  const evalResult = String(evalRes?.result || evalRes?.data || '').replace(/^"|"$/g, '');
                  logger.info(`[browser.agent] recipe-exec: step ${wp.step} evaluate → ${evalResult.slice(0, 80) || 'ok'}`);
                } else {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} evaluate — no code provided (skipped)`);
                }

              } else if (wp.type === 'fill') {
                // Fill an input/textarea — fatal if all selectors fail
                const fillSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let filled = false;
                for (const sel of fillSelectors) {
                  const fillRes = await callBrowserAct({ action: 'type', selector: sel, text: wp.value || '', sessionId });
                  if (fillRes?.exitCode === 0 || fillRes?.ok === true) {
                    filled = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} fill "${sel}" ✓`);
                    break;
                  }
                }
                if (!filled) {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} fill failed for all selectors`);
                  _wpFailed = true;
                }

              } else if (wp.type === 'keycombo') {
                // Press a key combination (e.g. Enter, Ctrl+A) — non-fatal
                const key = [wp.ctrl ? 'Control' : '', wp.shift ? 'Shift' : '', wp.alt ? 'Alt' : '', wp.key].filter(Boolean).join('+') || wp.key || 'Enter';
                const keySel = wp.selector;
                const keyRes = keySel
                  ? await callBrowserAct({ action: 'press-key', selector: keySel, key, sessionId })
                  : await callBrowserAct({ action: 'press-key', key, sessionId });
                if (keyRes?.exitCode === 0 || keyRes?.ok === true) {
                  logger.info(`[browser.agent] recipe-exec: step ${wp.step} keycombo ${key} ✓`);
                } else {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} keycombo ${key} failed (non-fatal)`);
                }

              } else if (wp.type === 'select') {
                // Select a dropdown option — non-fatal
                const selectSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let selected = false;
                for (const sel of selectSelectors) {
                  const selectRes = await callBrowserAct({ action: 'select', selector: sel, value: wp.value || '', sessionId });
                  if (selectRes?.exitCode === 0 || selectRes?.ok === true) {
                    selected = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} select "${wp.value}" on "${sel}" ✓`);
                    break;
                  }
                }
                if (!selected) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} select failed (non-fatal)`);

              } else if (wp.type === 'dblclick') {
                // Double-click an element — non-fatal
                const dblSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let dblClicked = false;
                for (const sel of dblSelectors) {
                  const dblRes = await callBrowserAct({ action: 'dblclick', selector: sel, sessionId });
                  if (dblRes?.exitCode === 0 || dblRes?.ok === true) {
                    dblClicked = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} dblclick "${sel}" ✓`);
                    break;
                  }
                }
                if (!dblClicked) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} dblclick failed (non-fatal)`);

              } else if (wp.type === 'submit') {
                // Form submit — treat as click on the submit button selector — non-fatal
                const submitSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let submitted = false;
                for (const sel of submitSelectors) {
                  const submitRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  if (submitRes?.exitCode === 0 || submitRes?.ok === true) {
                    submitted = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} submit "${sel}" ✓`);
                    break;
                  }
                }
                if (!submitted) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} submit failed (non-fatal)`);

              } else if (wp.type === 'paste') {
                // Paste text into an element — non-fatal
                const pasteSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                const pasteText = wp.text || wp.value || '';
                let pasted = false;
                for (const sel of pasteSelectors) {
                  const pasteCode = `(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); document.execCommand('insertText', false, ${JSON.stringify(pasteText)}); return true; })()`;
                  const pasteRes = await callBrowserAct({ action: 'evaluate', text: pasteCode, sessionId });
                  const result = String(pasteRes?.result || pasteRes?.data || '').replace(/^"|"$/g, '');
                  if (result === 'true' || pasteRes?.exitCode === 0) {
                    pasted = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} paste into "${sel}" ✓`);
                    break;
                  }
                }
                if (!pasted) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} paste failed (non-fatal)`);

              } else if (wp.type === 'drag') {
                // Drag-and-drop — non-fatal
                if (wp.fromSelector && (wp.toX !== undefined || wp.toSelector)) {
                  const dragArgs = wp.toSelector
                    ? { action: 'drag', fromSelector: wp.fromSelector, toSelector: wp.toSelector, sessionId }
                    : { action: 'drag', fromSelector: wp.fromSelector, toX: wp.toX, toY: wp.toY, sessionId };
                  const dragRes = await callBrowserAct(dragArgs);
                  if (dragRes?.exitCode === 0 || dragRes?.ok === true) {
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} drag ✓`);
                  } else {
                    logger.warn(`[browser.agent] recipe-exec: step ${wp.step} drag failed (non-fatal): ${dragRes?.stderr || 'unknown'}`);
                  }
                } else {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} drag skipped — missing fromSelector/toX`);
                }

              } else if (wp.type === 'hover') {
                // Hover over an element (menu reveals, tooltips) — non-fatal
                const hoverSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                for (const sel of hoverSelectors) {
                  const hoverRes = await callBrowserAct({ action: 'hover', selector: sel, sessionId });
                  if (hoverRes?.exitCode === 0 || hoverRes?.ok === true) {
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} hover "${sel}" ✓`);
                    break;
                  }
                }

              } else if (wp.type === 'back') {
                // Browser back navigation — non-fatal
                await callBrowserAct({ action: 'evaluate', text: 'window.history.back()', sessionId });
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} back ✓`);
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});

              } else if (wp.type === 'forward') {
                // Browser forward navigation — non-fatal
                await callBrowserAct({ action: 'evaluate', text: 'window.history.forward()', sessionId });
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} forward ✓`);
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});

              } else if (wp.type === 'rightclick' || wp.type === 'tab-new') {
                // rightclick: context menus can't be replayed deterministically — skip gracefully
                // tab-new: tab management is handled by post-click URL check — skip gracefully
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} ${wp.type} — skipped gracefully (not replayable)`);
              }

              // ── Smart per-type wait after each waypoint ───────────────────────────────
              // navigate/click-with-href: waitForStableText confirms rendered content
              // submit/dblclick with potential navigation: short waitForStableText
              // back/forward: already waited above
              // fill/select/keycombo/paste/drag/hover/scroll/focus/rightclick/tab-new: short fixed pause
              if (wp.type === 'navigate') {
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});
              } else if (wp.type === 'click' && wp.href) {
                // Post-click URL resolution already ran above; wait for content to stabilise
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});
              } else if (wp.type === 'submit' || wp.type === 'dblclick') {
                // May trigger navigation — short waitForStableText
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 5000 }).catch(() => {});
              } else if (wp.type === 'back' || wp.type === 'forward') {
                // Already waited in handler above — no extra wait needed
              } else if (wp.type === 'fill' || wp.type === 'keycombo' || wp.type === 'select') {
                await new Promise(r => setTimeout(r, 500));
              } else {
                // scroll, focus, evaluate, hover, drag, paste, check, extract, rightclick, tab-new
                await new Promise(r => setTimeout(r, 300));
              }
            } catch (wpErr) {
              logger.warn(`[browser.agent] recipe-exec: step ${wp.step} error — ${wpErr.message}`);
              _wpFailed = true;
            }
          }

          if (!_wpFailed) {
            // Verify we reached the target by checking current URL
            try {
              const urlCheck = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId });
              const currentUrl = (urlCheck?.result || urlCheck?.data || '').replace(/"/g, '');
              if (_execRecipe.targetUrl && currentUrl.includes(new URL(_execRecipe.targetUrl).pathname.split('?')[0])) {
                _recipeExecutedOk = true;
                logger.info(`[browser.agent] recipe-exec: target reached ✓ — ${currentUrl}`);
              } else if (_execRecipe.targetUrl) {
                logger.warn(`[browser.agent] recipe-exec: target URL mismatch — got "${currentUrl}", expected path from "${_execRecipe.targetUrl}"`);
                // Target mismatch - don't strip recipe context so LLM can recover
                _recipeExecutedOk = false;
                _wpFailed = true;
              } else {
                // No targetUrl specified in recipe, assume success
                _recipeExecutedOk = true;
              }
            } catch { 
              // Verification failed, but waypoints completed - be optimistic
              _recipeExecutedOk = true; 
            }
          } else {
            logger.warn(`[browser.agent] recipe-exec: waypoint failed — falling back to LLM-guided recipe`);
          }
        }

        // If execution succeeded (or skipped due to continuity), strip recipe nav steps from context
        // but PRESERVE targetDescription as a standalone Editor Context block so playwright.agent
        // still sees critical editor rules (e.g. CRITICAL RULE: use run-code+editor.setValue()) even
        // after the navigation waypoints are gone.
        if (_recipeExecutedOk) {
          _agentContext = _agentContext.replace(/\n\n## Trained Navigation Recipe:[\s\S]*?— if the site layout changed, adapt using the snapshot/, '');
          if (_activeRecipe?.targetDescription) {
            _agentContext = (_agentContext + `\n\n## Editor Context (from trained recipe)\n${_activeRecipe.targetDescription}`).slice(0, 5500);
          }
          logger.info(`[browser.agent] recipe-exec: stripped recipe from context — playwright.agent will only handle the user task`);
        }
      }
    } catch (_execErr) {
      logger.warn(`[browser.agent] recipe-exec: deterministic execution failed (non-fatal): ${_execErr.message}`);
    }
  }

  // ── Step 1c: Tier 2/3 nav context enrichment via web.agent / video.agent ──
  // When playwright.agent has no keyword-matched playbook (Tier 2 or 3), it reasons
  // purely from the live DOM. Inject web-researched navigation hints to guide it.
  // Skip if a trained recipe was already injected (recipe provides the navigation path).
  if (_playbookTier >= 2 && !_trainedRecipeInjected) {
    try {
      const _navSvcName = existing?.service || agentId.replace('.agent', '');
      const _navQuery   = `how to navigate to ${task} on ${_navSvcName}`;
      logger.info(`[browser.agent] tier-${_playbookTier}: fetching web.agent nav hints for "${_navQuery.slice(0, 80)}"`);
      const _navHints = await callSkill('web.agent', {
        action: 'research_domain',
        domain: _navSvcName,
        query: _navQuery,
        maxResults: 3,
      }, 8000).catch(() => null);

      if (_navHints?.ok && _navHints?.insightsText) {
        _agentContext = (_agentContext + `\n\n## Web-Researched Navigation Hints\n${_navHints.insightsText.slice(0, 600)}`).slice(0, 4000);
        logger.info(`[browser.agent] tier-${_playbookTier}: injected web.agent nav hints (confidence=${_navHints.confidence}) for ${agentId}`);

        // Escalate to video.agent only for Tier 3 (no playbook at all) with low web.agent confidence
        if (_playbookTier === 3 && (_navHints.confidence || 0) < 0.5) {
          logger.info(`[browser.agent] tier-3: web.agent confidence low (${_navHints.confidence}) — escalating to video.agent`);
          const _videoHints = await callSkill('video.agent', {
            action: 'find_and_watch_tutorial',
            platform: 'youtube',
            query: `${_navSvcName} ${task} tutorial`,
            goal: task,
          }, 30000).catch(() => null);

          if (_videoHints?.ok && Array.isArray(_videoHints?.steps) && _videoHints.steps.length > 0) {
            const _videoSteps = _videoHints.steps.map(s => `${s.step}. ${s.text}`).join('\n');
            _agentContext = (_agentContext + `\n\n## Video Tutorial Steps\n${_videoSteps}`).slice(0, 4500);
            logger.info(`[browser.agent] tier-3: injected video.agent tutorial steps (${_videoHints.steps.length} steps) for ${agentId}`);
          }
        }
      } else {
        logger.info(`[browser.agent] tier-${_playbookTier}: web.agent nav hints unavailable or empty — proceeding without`);
      }
    } catch (_navErr) {
      logger.warn(`[browser.agent] tier-${_playbookTier}: nav enrichment failed (non-fatal): ${_navErr.message}`);
    }
  }

  // ── Inject domain map content extraction hints if available ───────────────
  // explore.agent scan mode discovers optimal CSS selectors for content extraction.
  // These hints help playwright.agent extract substantive content instead of UI chrome.
  const _hostname = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  const _contentExtraction = _hostname ? getContentExtractionConfig(_hostname) : null;
  if (_contentExtraction?.primary_selector) {
    const extractionHint = `
\n## Content Extraction (discovered via scan mode)
When extracting page content with run-code, prioritize these selectors over generic document.body:
- Primary:   ${_contentExtraction.primary_selector}${_contentExtraction.fallback_selector ? `\n- Fallback:  ${_contentExtraction.fallback_selector}` : ''}
- Type:      ${_contentExtraction.content_type}
- Confidence: ${Math.round((_contentExtraction.confidence || 0) * 100)}%
`;
    _agentContext = (_agentContext + extractionHint).slice(0, 3200);
    logger.info(`[browser.agent] run: injected content extraction hints for ${_hostname} (${_contentExtraction.primary_selector})`);
  }

  try {
    // If recipe was successfully executed, we're already on the target page - don't navigate
    const _playwrightUrl = _recipeExecutedOk ? undefined : (url || (_useAgentBrowser ? startUrl : undefined));
    if (_recipeExecutedOk && url) {
      logger.info(`[browser.agent] run: recipe executed successfully - NOT passing URL to playwright.agent to stay on target page`);
    }
    const agentResult = await callSkill(_agentSkill, {
      goal: _effectiveTask,
      agentContext: _agentContext,
      url: _playwrightUrl,
      authSignInUrl: _useAgentBrowser ? (signInUrl || undefined) : undefined,
      sessionId,
      agentId,
      autoConnect: _effectiveAutoConnect,
      chromeProfile: _usePersistentProfile ? AGENT_BROWSER_PROFILE
        : (!_effectiveAutoConnect && _useAutoConnect ? 'Default' : undefined),
      headed: _usePersistentProfile ? true : undefined,
      maxTurns: 15,
      timeoutMs: 120000,
      recipeWasUsed: _recipeExecutedOk,
      _progressCallbackUrl,
      _stepIndex,
    }, 130000);

    const agentResultText = agentResult?.result || agentResult?.stdout || '';

    // ── Bubble up askUser from playwright.agent ────────────────────────────────
    // If playwright.agent surfaced an ask_user (goal not achieved after recipe
    // or after exhausting replanning), propagate it directly to the caller
    // so recoverSkill / executeCommand can surface the choice to the user.
    if (agentResult?.askUser === true) {
      logger.info(`[browser.agent] propagating askUser from playwright.agent: "${agentResult.question}"`);

      // ── Recipe Doctor: auto-diagnose and patch the recipe before asking user ──
      // When a recipe-driven task fails, attempt to auto-diagnose why the last
      // recipe step didn't work and patch it — so the next run just works.
      let _doctorSummary = null;
      if (_recipeExecutedOk && _activeRecipe && sessionId) {
        logger.info(`[browser.agent] recipe-doctor: goal not achieved after recipe — running diagnosis`);
        try {
          const _doctorResult = await diagnoseAndPatchRecipe({
            agentId,
            recipeName: _activeRecipe.name,
            recipe: _activeRecipe,
            failureReason: agentResult.question || 'Task goal not achieved',
            sessionId,
          });
          if (_doctorResult.patched) {
            _doctorSummary = _doctorResult.summary;
            logger.info(`[browser.agent] recipe-doctor: patch applied — "${_doctorSummary}"`);
          } else {
            logger.info(`[browser.agent] recipe-doctor: no patch applied — ${_doctorResult.reason}`);
          }
        } catch (_docErr) {
          logger.warn(`[browser.agent] recipe-doctor: non-fatal error: ${_docErr.message}`);
        }
      }

      const _questionText = _doctorSummary
        ? `${agentResult.question}\n\n✅ Recipe auto-fixed: ${_doctorSummary}\n\nTry again to use the patched recipe.`
        : agentResult.question;
      const _options = _doctorSummary
        ? ['Try again with patched recipe', ...( agentResult.options || []).filter(o => !/try again/i.test(o))]
        : (agentResult.options || []);

      return {
        ok: false,
        agentId,
        task,
        askUser: true,
        question: _questionText,
        options: _options,
        recipeWasUsed: _recipeExecutedOk,
        recipePatched: !!_doctorSummary,
      };
    }

    // ── Tier-2 post-execution write-back ──────────────────────────────────────
    // When a novel-goal task (tier-2 format-reference) succeeds, fire an async COT
    // call to generate a grounded ### playbook section from the actual execution
    // result. On the next identical task, _resolvePlaybook will hit tier-1 directly.
    if (_playbookTier === 2 && agentResult?.ok === true && existing.descriptor) {
      // Parse only the ## Playbooks section — avoid matching ### headers in other sections
      const _pbMatch = existing.descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
      const _existingSubsections = _pbMatch
        ? _pbMatch[1].trim().split(/(?=### )/).map(s => s.trim()).filter(Boolean)
        : [];
      setImmediate(() => {
        _generateAndCachePlaybook(
          agentId,
          existing.descriptor,
          task,
          _existingSubsections,
          agentResultText.slice(0, 1200),
        ).catch(() => {/* silent — write-back is best-effort */});
      });
      logger.info(`[browser.agent] playbook: tier-2 success — async COT write-back queued for ${agentId}`);
    }

    // ── Dynamic login-wall detector ───────────────────────────────────────────
    // If playwright.agent returned content that looks like a login/auth wall,
    // the service has changed from anonymous-first to requiring login. Auto-patch
    // the agent descriptor (DuckDB + disk) so future runs call waitForAuth and
    // properly prompt the user to authenticate once.
    //
    // Two signal tiers:
    //   Strong: OAuth provider button text ("Continue with Google", etc.) — single
    //           match is definitive; these only appear on login walls.
    //   Weak:   Generic auth phrases ("Sign in", "Log in", etc.) — require >= 2
    //           matches AND sparse page (< 50 lines) to avoid false positives on
    //           pages that merely show a nav-bar "Sign in" link alongside real content.
    const _LOGIN_WALL_RE = /\b(sign[\s-]+in|log[\s-]+in|log[\s-]+into|create[\s-]+account|sign[\s-]+up|please[\s-]+log|welcome[\s-]+back|get[\s-]+started[\s-]+free)\b/gi;
    const _OAUTH_PROVIDERS_RE = /\b(continue[\s-]+with[\s-]+(google|microsoft|apple|github|facebook|linkedin|twitter|x\.com|slack)|sign[\s-]+in[\s-]+with[\s-]+(google|microsoft|apple|github|facebook|linkedin|twitter)|google[\s-]+login)\b/i;
    const _loginWallMatches = (agentResultText.match(_LOGIN_WALL_RE) || []).length;
    const _hasOAuthProvider  = _OAUTH_PROVIDERS_RE.test(agentResultText);
    const _isLoginWall       = _loginWallMatches >= 2 && agentResultText.trim().split(/\n+/).length < 50;

    if (_isLoginWall || _hasOAuthProvider || agentResult?.loginWallDetected) {
      logger.warn(`[browser.agent] Login wall detected for ${agentId} (signals=${_loginWallMatches}, oauthProvider=${_hasOAuthProvider}, explicitFlag=${!!agentResult?.loginWallDetected}) — auto-upgrading to isOAuth:true`);
      try {
        await withDb(async (_patchDb) => {
          const _existingRows = _patchDb
            ? await _patchDb.all('SELECT descriptor FROM agents WHERE id = ?', agentId).catch(() => null)
            : null;
          const _existingDesc = _existingRows?.[0]?.descriptor || '';
          if (_existingDesc) {
            // Patch descriptor frontmatter: mark is_oauth:true so lookupBrowserService
            // picks it up on the next run and routes through waitForAuth.
            // Also ensure sign_in_url is set — fall back to startUrl if not already present.
            const _patchedDesc = rewriteDescriptorFrontmatter(_existingDesc, {
              is_oauth: 'true',
              ...(signInUrl ? {} : { sign_in_url: startUrl }),
            });
            const _mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
            fs.writeFileSync(_mdPath, _patchedDesc, 'utf8');
            if (_patchDb) {
              await _patchDb.run(
                'UPDATE agents SET descriptor = ?, status = ? WHERE id = ?',
                _patchedDesc, 'needs_auth', agentId
              );
            }
            logger.info(`[browser.agent] ${agentId} patched: is_oauth=true${_hasOAuthProvider ? ' (OAuth provider buttons detected)' : ''} — attempting auto-retry with waitForAuth`);
          }
        })
      } catch (patchErr) {
        logger.warn(`[browser.agent] login-wall patch failed for ${agentId}: ${patchErr.message}`);
      }

      // ── Auto-retry: trigger waitForAuth inline and re-run the agent once ──────
      // This avoids requiring a manual re-run after the DB patch. The _loginWallRetried
      // flag (passed via args) prevents an infinite retry loop if the second run also
      // sees a wall (e.g. waitForAuth timed out, user didn't sign in).
      if (!_loginWallRetried && !_useAgentBrowser) {
        logger.info(`[browser.agent] auto-retry: calling waitForAuth for ${agentId} then re-delegating to ${_agentSkill}`);

        // ── Emit task:auth_required so the UI shows the full auth overlay ────
        const _svcDisplay = agentId.replace('.agent', '').replace(/_/g, ' ');
        if (_progressCallbackUrl) {
          try {
            const http = require('http');
            const _authPayload = JSON.stringify({
              type: 'task:auth_required',
              agentId,
              serviceDisplay: _svcDisplay,
              loginUrl: signInUrl || startUrl,
              sessionId,
              stepIndex: _stepIndex ?? 0,
              message: `Sign in to ${_svcDisplay} in the browser window that just opened.`,
            });
            const _authReq = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_authPayload) }, timeout: 3000 });
            _authReq.on('error', () => {});
            _authReq.write(_authPayload);
            _authReq.end();
          } catch (_notifyErr) { /* fire-and-forget */ }
        }

        try {
          const _wallAuthResult = await callBrowserAct({
            action: 'waitForAuth',
            sessionId,
            url: signInUrl || startUrl,
            authSuccessUrl: authSuccessPattern,
            timeoutMs: 5 * 60 * 1000,
            _progressCallbackUrl,
          }, 6 * 60 * 1000);

          if (_wallAuthResult?.ok) {
            logger.info(`[browser.agent] waitForAuth succeeded after login-wall upgrade for ${agentId} — retrying ${_agentSkill}`);
            // ── Emit task:auth_resolved so the UI dismisses the auth overlay ──
            if (_progressCallbackUrl) {
              try {
                const http = require('http');
                const _resolvedPayload = JSON.stringify({ type: 'task:auth_resolved', agentId, sessionId, stepIndex: _stepIndex ?? 0 });
                const _resolvedReq = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_resolvedPayload) }, timeout: 3000 });
                _resolvedReq.on('error', () => {});
                _resolvedReq.write(_resolvedPayload);
                _resolvedReq.end();
              } catch (_) { /* fire-and-forget */ }
            }
            // Restore status to 'healthy' now that auth is confirmed working — ensures
            // planSkills re-includes this agent in the AVAILABLE AGENTS list for future plans.
            try {
              await withDb(async (_healDb) => {
                await _healDb.run('UPDATE agents SET status=? WHERE id=? AND status=?', 'healthy', agentId, 'needs_auth').catch(() => {});
              });
            } catch (_) {}
            const _retryResult = await callSkill(_agentSkill, {
              goal: _effectiveTask,
              agentContext: _agentContext,
              url: startUrl,
              sessionId,
              agentId,
              autoConnect: _effectiveAutoConnect,
              chromeProfile: _usePersistentProfile ? AGENT_BROWSER_PROFILE
                : (!_effectiveAutoConnect && _useAutoConnect ? 'Default' : undefined),
              headed: _usePersistentProfile ? true : undefined,
              maxTurns: 15,
              timeoutMs: 120000,
              _progressCallbackUrl,
              _stepIndex,
              _loginWallRetried: true,  // prevent recursive retry
            }, 130000);
            return {
              ok: _retryResult?.ok ?? false,
              agentId,
              task,
              sessionId,
              authenticated: true,
              result: _retryResult?.result || _retryResult?.stdout || '',
              transcript: _retryResult?.transcript || [],
              turns: _retryResult?.turns,
              done: _retryResult?.done,
              error: _retryResult?.error,
              autoRetriedAfterLoginWall: true,
            };
          } else {
            logger.warn(`[browser.agent] waitForAuth did not complete for ${agentId} (user may not have signed in) — surfacing ASK_USER`);
          }
        } catch (retryErr) {
          logger.warn(`[browser.agent] auto-retry after login-wall threw: ${retryErr.message}`);
        }
      }

      const _svcDisplayFinal = agentId.replace('.agent', '').replace(/_/g, ' ');
      return {
        ok: false,
        agentId,
        task,
        askUser: true,
        question: `${_svcDisplayFinal} requires sign-in. A browser window has been opened — please sign in there to continue.`,
        options: [],
        error: `Login wall detected for ${agentId} — service requires authentication.`,
        loginWallDetected: true,
        oauthUpgraded: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // When the run succeeded and startUrl was auto-corrected by the destination resolver,
    // reinforce the correction memory so future runs auto-correct with full confidence.
    if (agentResult?.ok === true) {
      try {
        const _confirmedIntent = await classifyTaskIntent(task);
        const _origUrl = extractDescriptorUrl(existing.descriptor, 'start_url');
        if (_origUrl && startUrl !== _origUrl) {
          setImmediate(() => {
            recordCorrection(_svcKey, _confirmedIntent, startUrl).catch(() => {});
          });
        }
      } catch (_) {}
    }

    // ── Research content quality gate ─────────────────────────────────────────
    // Catches pages that passed the login-wall detector above (e.g. Qwen welcome
    // screen, Perplexity nav-only result) but returned no substantive research
    // content.  Criteria for "empty research":
    //   • task intent is research or chat
    //   • result is sparse (< 40 lines)
    //   • no keyword overlap with the task topic (< 2 words from task in result)
    //   • result does NOT contain multi-sentence prose (< 3 sentences)
    // When detected, return a structured failure so executeCommand / recoverSkill
    // can surface ASK_USER with alternative source options instead of silently
    // passing an empty result to the synthesize step.
    if (agentResult?.ok === true) {
      const _researchIntents = /\b(research|find|look\s+up|search|get\s+info|learn\s+about|tell\s+me\s+about|summarize|what\s+is|who\s+is|how\s+does|explain)\b/i;
      const _taskIsResearch = _researchIntents.test(task);
      if (_taskIsResearch) {
        const _httpStatus = Number.isInteger(agentResult?.httpStatus) ? agentResult.httpStatus : null;
        if (_httpStatus !== null && _httpStatus >= 400) {
          logger.warn(`[browser.agent] Research quality gate: http error for ${agentId} (status=${_httpStatus}) — marking serviceUnavailable`);
          return {
            ok: false,
            agentId,
            task,
            error: `${agentId} could not fulfill the research step because the service returned HTTP ${_httpStatus}.`,
            researchContentEmpty: true,
            serviceUnavailable: true,
            unavailableReason: `HTTP ${_httpStatus}`,
            httpStatus: _httpStatus,
          };
        }
        const _unavailableReason = detectServiceUnavailable(agentResultText);
        if (_unavailableReason) {
          logger.warn(`[browser.agent] Research quality gate: unusable service state for ${agentId} (${_unavailableReason}) — marking serviceUnavailable`);
          return {
            ok: false,
            agentId,
            task,
            error: `${agentId} could not fulfill the research step because the service showed an unavailable or blocked page (${_unavailableReason}).`,
            researchContentEmpty: true,
            serviceUnavailable: true,
            unavailableReason: _unavailableReason,
            httpStatus: _httpStatus,
          };
        }
        const _lines = agentResultText.trim().split(/\n+/).filter(l => l.trim().length > 2);
        // Content density scoring — nav/welcome pages have few long sentences;
        // research pages have many lines with >6 words. Avoids fragile topic-word
        // matching which causes false positives on synonyms / paraphrased results.
        const _longLines = _lines.filter(l => l.trim().split(/\s+/).length > 6).length;
        const _totalWords = agentResultText.trim().split(/\s+/).filter(Boolean).length;
        const _isSparse = _longLines < 3 && _totalWords < 60;
        // Navigation/action tasks (goto, click, open, navigate to, go to history, etc.)
        // produce sparse output by design — the task is complete when the page loads.
        // Only apply the quality gate to research/lookup tasks.
        const _taskLower = (task || '').toLowerCase();
        const _isNavTask = /\b(goto|go to|navigate|click|open|visit|go back|return to|scroll|history|previous|close|dismiss)\b/.test(_taskLower);
        const _isResearchTask = /\b(search|find|look up|lookup|research|what is|summarize|compare|list|show me|tell me|fetch|get me)\b/.test(_taskLower);
        const _skipQualityGate = _isNavTask && !_isResearchTask;
        // Check if we have video links or comprehensive content extracted - if so, don't fail on sparse content
        const _hasVideoLinks = agentResult?.transcript?.some(step => 
          step.action === 'getPageLinks' && step.result && step.result.length > 0
        );
        const _hasExtractedContent = agentResult?.transcript?.some(step =>
          step.action === 'extractContent' && step.result && 
          (step.result.text || step.result.links) && 
          ((step.result.text?.length || 0) > 100 || (step.result.links?.length || 0) > 0)
        );
        if (_isSparse && !_skipQualityGate && !_hasVideoLinks && !_hasExtractedContent) {
          logger.warn(`[browser.agent] Research quality gate: sparse content for ${agentId} (longLines=${_longLines}, totalWords=${_totalWords}) — marking researchContentEmpty`);
          return {
            ok: false,
            agentId,
            task,
            error: `${agentId} returned navigation/welcome content instead of research data (${_longLines} content lines, ${_totalWords} total words). The service may require login or the URL landed on the wrong page.`,
            researchContentEmpty: true,
          };
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const _runResult = {
      ok: agentResult?.ok ?? false,
      agentId,
      task,
      sessionId,
      authenticated: true,
      result: agentResultText,
      transcript: agentResult?.transcript || [],
      turns: agentResult?.turns,
      done: agentResult?.done,
      httpStatus: Number.isInteger(agentResult?.httpStatus) ? agentResult.httpStatus : undefined,
      error: agentResult?.error,
    };

    // ── Post-run background rescan ────────────────────────────────────────────
    // After a successful run, enqueue a background scan to rebuild domain maps
    // and navigate_history skills with fresh data. This ensures the history index
    // stays current without blocking the current task.
    if (_runResult.ok === true) {
      try {
        const { enqueueScan } = require('./explore.agent.cjs');
        enqueueScan({ url: startUrl, agentId }, 'post_automation');
      } catch (_enqueuErr) {
        // Non-fatal — scan will be triggered on next periodic heartbeat
      }
    }

    // ── Minimize browser window after successful completion ───────────────────
    if (_runResult.ok === true && _usePersistentProfile) {
      try {
        await browserAct({ action: 'minimize', sessionId, headed: true });
      } catch (minimizeErr) {
        logger.debug(`[browser.agent] minimize failed (non-critical): ${minimizeErr.message}`);
      }
    }

    return _runResult;
  } catch (err) {
    return { ok: false, agentId, task, error: `playwright.agent delegation failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: scan_page — headless DOM scan of login/setup page
// Returns structured field list so the UI card can render actual inputs.
// ---------------------------------------------------------------------------

const SCAN_PAGE_SYSTEM_PROMPT = `You are a web page analyzer. Given a DOM snapshot of a login or credential setup page, extract all the input fields the user needs to fill in to authenticate or get an API key.

Output ONLY valid JSON:
{
  "pageType": "login" | "api_key" | "oauth_setup" | "unknown",
  "fields": [
    {
      "name": "<machine-readable key name, e.g. GMAIL_EMAIL>",
      "label": "<human-readable label from page, e.g. Email or phone>",
      "type": "email" | "password" | "text" | "url",
      "placeholder": "<placeholder text if any>",
      "required": true | false
    }
  ],
  "submitLabel": "<text on the submit button, e.g. Next or Sign in>",
  "pageTitle": "<title of the page>",
  "notes": "<one sentence about what this page is asking for>"
}

Rules:
- For Google/Gmail login pages: fields = [{name:"GMAIL_EMAIL", label:"Email or phone", type:"email", required:true}]
- For password step: fields = [{name:"GMAIL_PASSWORD", label:"Password", type:"password", required:true}]
- For API key pages: fields = [{name:"API_KEY", label:"API Key", type:"text", required:true}]
- For OAuth setup (Client ID + Secret): fields = [{name:"CLIENT_ID", label:"Client ID", type:"text"}, {name:"CLIENT_SECRET", label:"Client Secret", type:"password"}]
- Map field names to SCREAMING_SNAKE_CASE with service prefix where appropriate
- Only include fields actually visible in the DOM, not hidden/disabled ones`;

// Extract sign_in_url: or start_url: from a descriptor frontmatter string
function extractDescriptorUrl(descriptor, field) {
  if (!descriptor) return null;
  const line = descriptor.split('\n').find(l => l.startsWith(`${field}:`));
  return line ? line.replace(`${field}:`, '').trim() : null;
}

async function actionScanPage({ service, url: explicitUrl, secretKey }) {
  const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  let scanUrl = explicitUrl;
  if (!scanUrl && serviceKey) {
    // Priority 1: DuckDB descriptor sign_in_url: (written/corrected by validate_agent)
    const agentId = `${serviceKey}.agent`;
    const stored = await actionQueryAgent({ id: agentId }).catch(() => null);
    const storedSignIn = stored?.found ? extractDescriptorUrl(stored.descriptor, 'sign_in_url') : null;
    if (storedSignIn) {
      scanUrl = storedSignIn;
      logger.info(`[browser.agent] scan_page: using DuckDB sign_in_url for ${service}: ${scanUrl}`);
    } else {
      // Priority 2: seed map startUrl (bootstrap fallback only)
      const meta = await resolveBrowserMeta(service).catch(() => null);
      scanUrl = meta?.startUrl || `https://${serviceKey}.com`;
      logger.info(`[browser.agent] scan_page: no stored sign_in_url — using seed startUrl: ${scanUrl}`);
    }
  }
  if (!scanUrl) return { ok: false, error: 'url or service is required for scan_page' };

  logger.info(`[browser.agent] scan_page: scanning ${scanUrl} for service="${service}"`);

  // Use headless browser.act scanCurrentPage (isolated, no cookies)
  let domSnapshot = '';
  try {
    const scanResult = await callBrowserAct({
      action: 'scanCurrentPage',
      url: scanUrl,
      sessionId: `scan_${serviceKey}_${Date.now()}`,
      isolated: true,
      timeoutMs: 20000,
    }, 30000);
    if (scanResult?.elements) {
      // Flatten elements to a readable text snapshot for the LLM
      domSnapshot = (scanResult.elements || [])
        .slice(0, 60)
        .map(el => `[${el.tag}] label="${el.label || ''}" placeholder="${el.placeholder || ''}" type="${el.type || ''}" id="${el.id || ''}" name="${el.name || ''}"`)
        .join('\n');
    } else if (scanResult?.html) {
      domSnapshot = scanResult.html.slice(0, 4000);
    } else if (typeof scanResult === 'string') {
      domSnapshot = scanResult.slice(0, 4000);
    }
  } catch (err) {
    logger.warn(`[browser.agent] scan_page: DOM scan failed (${err.message}), using LLM knowledge only`);
  }

  // Ask LLM to interpret what fields this page needs
  const userQuery = [
    `Service: ${service}`,
    `URL: ${scanUrl}`,
    secretKey ? `We need to collect: ${secretKey}` : '',
    domSnapshot ? `\nDOM snapshot:\n${domSnapshot}` : '\n(DOM scan unavailable — use your knowledge of this service\'s login page)',
  ].filter(Boolean).join('\n');

  let parsed = null;
  try {
    const raw = await callLLM(SCAN_PAGE_SYSTEM_PROMPT, userQuery, { temperature: 0.1, maxTokens: 600 });
    if (raw) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
  } catch (err) {
    logger.warn(`[browser.agent] scan_page: LLM parse failed: ${err.message}`);
  }

  // Hard fallback: return sensible defaults based on secretKey naming
  if (!parsed || !parsed.fields || parsed.fields.length === 0) {
    const key = (secretKey || '').toUpperCase();
    const isPassword = key.includes('PASSWORD') || key.includes('SECRET');
    const isEmail    = key.includes('EMAIL') || key.includes('USER');
    parsed = {
      pageType: 'unknown',
      fields: [{
        name: secretKey || `${serviceKey.toUpperCase()}_KEY`,
        label: (secretKey || 'API Key').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        type: isPassword ? 'password' : isEmail ? 'email' : 'text',
        placeholder: '',
        required: true,
      }],
      pageTitle: service,
      notes: `Credential required for ${service}`,
    };
  }

  logger.info(`[browser.agent] scan_page: found ${parsed.fields.length} field(s) for ${service} (${parsed.pageType})`);
  return {
    ok: true,
    service,
    url: scanUrl,
    pageType: parsed.pageType,
    fields: parsed.fields,
    submitLabel: parsed.submitLabel || 'Submit',
    pageTitle: parsed.pageTitle || service,
    notes: parsed.notes || '',
  };
}

// ---------------------------------------------------------------------------
// Action: delete_agent — remove all artifacts tied to an agent
// ---------------------------------------------------------------------------

async function actionDeleteAgent({ id }) {
  if (!id) return { ok: false, error: 'id is required' };

  const deleted = [];
  const errors  = [];

  logger.info(`[browser.agent] delete_agent: starting delete for ${id}`);
  logger.info(`[browser.agent] delete_agent: AGENTS_DIR = ${AGENTS_DIR}`);
  logger.info(`[browser.agent] delete_agent: AGENTS_DB_PATH = ${AGENTS_DB_PATH}`);

  // ── 1. Read descriptor before deleting (need hostname for domain-map) ──────
  let hostname = null;
  
  // Try multiple file naming patterns
  const possiblePaths = [
    path.join(AGENTS_DIR, `${id}.agent.md`),  // w3schools.agent.md
    path.join(AGENTS_DIR, `${id}.md`),         // w3schools.agent.md (if id already has .agent)
    path.join(AGENTS_DIR, `${id.replace(/\.agent$/, '')}.agent.md`), // w3schools.agent.md
  ];
  
  logger.info(`[browser.agent] delete_agent: checking paths: ${JSON.stringify(possiblePaths)}`);

  // Debug: list actual files in AGENTS_DIR
  try {
    const files = fs.readdirSync(AGENTS_DIR);
    logger.info(`[browser.agent] delete_agent: files in AGENTS_DIR: ${JSON.stringify(files)}`);
  } catch (e) {
    logger.error(`[browser.agent] delete_agent: cannot read AGENTS_DIR: ${e.message}`);
  }

  let agentMdPath = null;
  for (const tryPath of possiblePaths) {
    const exists = fs.existsSync(tryPath);
    logger.info(`[browser.agent] delete_agent: checking ${tryPath}: ${exists}`);
    if (exists) {
      agentMdPath = tryPath;
      break;
    }
  }

  // Fuzzy fallback: normalize both the requested id and each filename to find closest match.
  // Handles mismatches where UI sends display id (e.g. 'w3schoolsagent') but file is
  // stored as 'w3schools.agent.md' (canonical id 'w3schools.agent').
  if (!agentMdPath) {
    try {
      const _norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const _idNorm = _norm(id);
      const _allFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
      const _match = _allFiles.find(f => {
        const base = f.replace(/\.agent\.md$/, '');
        return _norm(base) === _idNorm || _norm(f.replace(/\.md$/, '')) === _idNorm;
      });
      if (_match) {
        agentMdPath = path.join(AGENTS_DIR, _match);
        logger.info(`[browser.agent] delete_agent: fuzzy match found: ${_match} for id=${id}`);
      } else {
        logger.warn(`[browser.agent] delete_agent: no .md file found for ${id} (fuzzy scan also failed)`);
      }
    } catch (_fuzzyErr) {
      logger.warn(`[browser.agent] delete_agent: no .md file found for ${id}`);
    }
  }

  if (agentMdPath) {
    try {
      const desc = fs.readFileSync(agentMdPath, 'utf8');
      const urlMatch = desc.match(/^start_url:\s*(.+)$/m);
      if (urlMatch) {
        try { hostname = new URL(urlMatch[1].trim()).hostname.replace(/^www\./, ''); } catch (_) {}
      }
    } catch (_) {}
    try { fs.rmSync(agentMdPath, { force: true }); deleted.push(agentMdPath); logger.info(`[browser.agent] delete_agent: removed file ${agentMdPath}`); } catch (e) { errors.push(e.message); }
  }

  // ── 2. DuckDB: agents table + browser_meta_cache ────────────────────────────
  try {
    await withDb(async (db) => {
      const service = id.replace(/\.agent$/, '');
      logger.info(`[browser.agent] delete_agent: looking for service = ${service}`);
      
      // Check if agent exists before delete
      const beforeRows = await db.all('SELECT id FROM agents WHERE id = ?', id).catch((e) => {
        logger.error(`[browser.agent] delete_agent: SELECT error: ${e.message}`);
        return [];
      });
      logger.info(`[browser.agent] delete_agent: found ${beforeRows.length} rows for id = ${id}`);
      if (beforeRows.length > 0) {
        await db.run('DELETE FROM agents WHERE id = ?', id);
        deleted.push(`DuckDB agents row: ${id}`);
        logger.info(`[browser.agent] delete_agent: removed ${id} from DuckDB agents table`);
      } else {
        // Fuzzy fallback: match by normalized service name so 'w3schoolsagent' finds 'w3schools.agent'
        const _norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const _idNorm = _norm(id);
        const allAgents = await db.all('SELECT id, service FROM agents').catch(() => []);
        const _fuzzyRow = allAgents.find(r =>
          _norm(r.id) === _idNorm ||
          _norm(r.service || '') === _idNorm ||
          _norm(r.id.replace(/\.agent$/, '')) === _idNorm
        );
        if (_fuzzyRow) {
          await db.run('DELETE FROM agents WHERE id = ?', _fuzzyRow.id);
          deleted.push(`DuckDB agents row: ${_fuzzyRow.id}`);
          logger.info(`[browser.agent] delete_agent: fuzzy-removed ${_fuzzyRow.id} from DuckDB (matched id=${id})`);
        } else {
          logger.warn(`[browser.agent] delete_agent: agent ${id} not found in DuckDB. Available: ${JSON.stringify(allAgents.map(r => r.id))}`);
        }
      }
      
      // Delete from meta cache
      const metaRows = await db.all('SELECT service FROM browser_meta_cache WHERE service = ?', service).catch(() => []);
      if (metaRows.length > 0) {
        await db.run('DELETE FROM browser_meta_cache WHERE service = ?', service);
        deleted.push(`DuckDB meta_cache row: ${service}`);
      }
      
      // Note: withDb closes connection automatically, no need for CHECKPOINT
    });
  } catch (e) { 
    logger.error(`[browser.agent] delete_agent: DuckDB error: ${e.message}`);
    errors.push(`DuckDB: ${e.message}`); 
  }

  // ── 3. Domain map JSON ───────────────────────────────────────────────────────
  if (hostname) {
    const domainMapPath = path.join(os.homedir(), '.thinkdrop', 'domain-maps', `${hostname}.json`);
    if (fs.existsSync(domainMapPath)) {
      try { fs.rmSync(domainMapPath, { force: true }); deleted.push(domainMapPath); } catch (e) { errors.push(e.message); }
    }
  }

  // ── 4. Browser profile dir (persistent Chrome cookies) ──────────────────────
  const service = id.replace(/\.agent$/, '');
  const profileName = `${service}_agent`;
  const profileDir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles', profileName);
  if (fs.existsSync(profileDir)) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); deleted.push(profileDir); } catch (e) { errors.push(e.message); }
  }

  // ── 5. AB-sessions auth JSON ─────────────────────────────────────────────────
  const abSessionFile = path.join(os.homedir(), '.thinkdrop', 'ab-sessions', `${profileName}.json`);
  if (fs.existsSync(abSessionFile)) {
    try { fs.rmSync(abSessionFile, { force: true }); deleted.push(abSessionFile); } catch (e) { errors.push(e.message); }
  }

  // ── 6. agent-profile sessions JSON ──────────────────────────────────────────
  const agentProfileFile = path.join(os.homedir(), '.thinkdrop', 'agent-profile', `${profileName}.json`);
  if (fs.existsSync(agentProfileFile)) {
    try { fs.rmSync(agentProfileFile, { force: true }); deleted.push(agentProfileFile); } catch (e) { errors.push(e.message); }
  }

  // ── 7. Temp validate/scan dirs in ab-sessions ────────────────────────────────
  const abDir = path.join(os.homedir(), '.thinkdrop', 'ab-sessions');
  if (fs.existsSync(abDir)) {
    try {
      const entries = fs.readdirSync(abDir);
      for (const entry of entries) {
        if (entry.startsWith(`${id}_`) || entry.startsWith(`${service}.agent_`) || entry.startsWith(`${profileName}_`)) {
          const fullPath = path.join(abDir, entry);
          try { fs.rmSync(fullPath, { recursive: true, force: true }); deleted.push(fullPath); } catch (e) { errors.push(e.message); }
        }
      }
    } catch (_) {}
  }

  // ── 8. scan-state.json — remove from lastRunAgents ───────────────────────────
  const scanStatePath = path.join(os.homedir(), '.thinkdrop', 'scan-state.json');
  if (fs.existsSync(scanStatePath)) {
    try {
      const scanState = JSON.parse(fs.readFileSync(scanStatePath, 'utf8'));
      if (Array.isArray(scanState.lastRunAgents)) {
        const before = scanState.lastRunAgents.length;
        scanState.lastRunAgents = scanState.lastRunAgents.filter(a => a !== id && a !== `${service}.agent`);
        if (scanState.lastRunAgents.length !== before) {
          fs.writeFileSync(scanStatePath, JSON.stringify(scanState, null, 2), 'utf8');
          deleted.push(`scan-state.json entry: ${id}`);
        }
      }
    } catch (e) { errors.push(`scan-state.json: ${e.message}`); }
  }

  // ── 9. Skills directory (trained recipes and atomic skills) ────────────────────
  const skillsDir = path.join(os.homedir(), '.thinkdrop', 'skills', service);
  if (fs.existsSync(skillsDir)) {
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); deleted.push(skillsDir); } catch (e) { errors.push(e.message); }
  }
  // Also try id-based directory name (some skills use full agent id)
  const skillsDirById = path.join(os.homedir(), '.thinkdrop', 'skills', id.replace(/\./g, '_'));
  if (fs.existsSync(skillsDirById) && skillsDirById !== skillsDir) {
    try { fs.rmSync(skillsDirById, { recursive: true, force: true }); deleted.push(skillsDirById); } catch (e) { errors.push(e.message); }
  }

  logger.info(`[browser.agent] delete_agent: removed ${deleted.length} artifacts for ${id}`, { deleted, errors });
  return { ok: true, deleted, errors };
}

// ---------------------------------------------------------------------------
// Action: record_failure — append a runtime error to failure_log
// ---------------------------------------------------------------------------

async function actionRecordFailure({ id, failureEntry }) {
  if (!id || !failureEntry) return { ok: false, error: 'id and failureEntry are required' };
  return await withDb(async (db) => {
    const row = await db.get('SELECT failure_log FROM agents WHERE id = ?', id);
    if (!row) return { ok: false, error: `Agent not found: ${id}` };
    const existing = row.failure_log || '';
    const entries = existing ? existing.split('\n---\n') : [];
    entries.unshift(failureEntry);
    const trimmed = entries.slice(0, 5).join('\n---\n');
    await db.run(
      'UPDATE agents SET failure_log = ?, status = CASE WHEN status = \'healthy\' THEN \'degraded\' ELSE status END WHERE id = ?',
      trimmed, id
    );
    logger.info(`[browser.agent] record_failure: appended runtime error for ${id}`);
    return { ok: true, agentId: id };
  });
}

// ---------------------------------------------------------------------------
// actionExplore — resolve agent URL then invoke explore.agent
// ---------------------------------------------------------------------------
async function actionExplore({ agentId, goal, url, sessionId, maxDepth, maxNavItems, mode, _progressCallbackUrl }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };

  // scan mode does not require a goal
  const resolvedMode = mode || 'execute';
  if (resolvedMode === 'execute' && !goal) return { ok: false, error: 'goal is required' };

  // Resolve start URL from agent descriptor (same pattern as actionRun)
  let existing = await actionQueryAgent({ id: agentId });
  if (!existing.found) {
    const serviceKey = agentId.replace(/\.agent$/, '');
    logger.info(`[browser.agent] explore: agent "${agentId}" not found — attempting auto-build for "${serviceKey}"`);
    try {
      const buildResult = await actionBuildAgent({ service: serviceKey });
      if (buildResult.ok) existing = await actionQueryAgent({ id: agentId });
    } catch (_) {}
    if (!existing.found) {
      return { ok: false, error: `Agent not found: ${agentId}. Build it first with action:build_agent.`, needsBuild: true };
    }
  }

  const startUrl = url || existing.startUrl || existing.descriptor?.match(/start_url:\s*(.+)/)?.[1]?.trim();
  if (!startUrl) return { ok: false, error: `No start URL for agent ${agentId}` };

  const exploreSessionId = sessionId || `${agentId}_explore`;

  // scan mode — route directly to scanDomain (no goal needed)
  if (resolvedMode === 'scan') {
    logger.info(`[browser.agent] explore: scan mode — probing ${startUrl}`);
    const { scanDomain } = require('./explore.agent.cjs');
    return await scanDomain({ url: startUrl, agentId, sessionId: exploreSessionId, _progressCallbackUrl });
  }

  logger.info(`[browser.agent] explore: goal="${goal}" url=${startUrl} session=${exploreSessionId}`);

  const { exploreAgent, enqueueScan } = require('./explore.agent.cjs');
  const result = await exploreAgent({
    goal,
    url: startUrl,
    agentId,
    sessionId: exploreSessionId,
    maxDepth: maxDepth || 4,
    maxNavItems: maxNavItems || 20,
    mode: resolvedMode,
    _progressCallbackUrl,
  });

  // After a successful execute run, enqueue a background post-automation scan
  // Only if the run succeeded and the map hasn't been updated in the last 24h
  if (result?.ok && result?.done) {
    try {
      enqueueScan({ url: startUrl, agentId, _progressCallbackUrl }, 'post_automation');
    } catch (_) { /* non-fatal */ }
  }

  return result;
}

// ---------------------------------------------------------------------------

async function browserAgent(args) {
  const { action } = args || {};

  logger.info('[browser.agent] invoked', { action });

  switch (action) {
    case 'build_agent':
      return await actionBuildAgent(args);

    case 'query_agent':
      return await actionQueryAgent(args);

    case 'list_agents':
      return await actionListAgents();

    case 'validate_agent':
      return await actionValidateAgent(args);

    case 'run':
      return await actionRun(args);

    case 'explore':
      return await actionExplore(args);

    case 'scan_domain':
      // Shortcut for mode:scan — background probe without a goal
      return await actionExplore({ ...args, mode: 'scan' });

    case 'scan_page':
      return await actionScanPage(args);

    case 'delete_agent':
      return await actionDeleteAgent(args);

    case 'record_failure':
      return await actionRecordFailure(args);

    default:
      return {
        ok: false,
        error: `Unknown action: "${action}". Valid: build_agent | query_agent | list_agents | validate_agent | run | explore | scan_domain | scan_page | delete_agent | record_failure`,
      };
  }
}

// ---------------------------------------------------------------------------
// Agent Thinking Helper — generates reasoning text for UI display
// ---------------------------------------------------------------------------

/**
 * Generate agent thinking/reasoning text for user insight.
 * This provides transparency into what the agent is about to do.
 */
function _generateAgentThinking(agentType, context) {
  const { agentId, task, hasUrl, requiresAuth } = context;

  const thoughts = [];

  // Opening statement based on agent type
  thoughts.push(`I'm ${agentType} preparing to execute a task.`);

  // Task analysis
  if (task) {
    const taskSummary = task.length > 100 ? task.slice(0, 100) + '...' : task;
    thoughts.push(`Task: "${taskSummary}"`);
  }

  // URL context
  if (hasUrl) {
    thoughts.push(`I'll navigate to the specified URL.`);
  } else if (agentId) {
    thoughts.push(`I'll work with the ${agentId} agent configuration.`);
  }

  // Auth consideration
  if (requiresAuth) {
    thoughts.push(`Authentication may be required — I'll check for login pages.`);
  }

  // Plan statement
  thoughts.push(`My approach: analyze the page, identify elements, and execute the task step by step.`);

  return thoughts.join(' ');
}

module.exports = { browserAgent, KNOWN_BROWSER_SERVICES, actionDeleteAgent, _generateAgentThinking };
module.exports._deriveAgentType = deriveAgentType;
