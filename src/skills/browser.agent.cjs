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

const AGENTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');
const AGENTS_DIR     = path.join(os.homedir(), '.thinkdrop', 'agents');
const BROWSER_ACT_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);

// Lazy-loaded to avoid circular require — only pulled in when auto-connect is active
let _ensureChromeCDP = null;
function getEnsureChromeCDP() {
  if (!_ensureChromeCDP) _ensureChromeCDP = require('./agentbrowser.act.cjs').ensureChromeCDP;
  return _ensureChromeCDP;
}

// ---------------------------------------------------------------------------
// DuckDB registry (shared with cli.agent)
// ---------------------------------------------------------------------------

let _db = null;

async function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(AGENTS_DB_PATH), { recursive: true });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  try {
    const duckdbAsync = require('duckdb-async');
    _db = await duckdbAsync.Database.create(AGENTS_DB_PATH);
  } catch {
    try {
      const { Database } = require('duckdb');
      const raw = await new Promise((resolve, reject) => {
        const db = new Database(AGENTS_DB_PATH, (err) => { if (err) reject(err); else resolve(db); });
      });
      _db = {
        run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
        all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
        get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
        close: () => new Promise((res) => raw.close(() => res())),
      };
    } catch { return null; }
  }
  await _db.run(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'cli', service TEXT NOT NULL,
    cli_tool TEXT, capabilities TEXT, descriptor TEXT, last_validated TIMESTAMP,
    failure_log TEXT, status TEXT NOT NULL DEFAULT 'healthy', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await _db.run(`CREATE TABLE IF NOT EXISTS browser_meta_cache (
    service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  return _db;
}


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
  youtube:        { startUrl: 'https://studio.youtube.com',                      signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'studio.youtube.com',           isOAuth: true  },
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
  perplexity:     { startUrl: 'https://www.perplexity.ai/settings/api',          authSuccessPattern: 'perplexity.ai/',               isOAuth: false },
  fireworks:      { startUrl: 'https://fireworks.ai/account/api-keys',           authSuccessPattern: 'fireworks.ai/',                isOAuth: false },
  deepseek:       { startUrl: 'https://platform.deepseek.com/api_keys',          authSuccessPattern: 'platform.deepseek.com/',       isOAuth: false },
  // ── AI consumer apps ─────────────────────────────────────────────────────────────────────────────────
  // All anonymous-first (isOAuth: false). Only trigger waitForAuth if a login wall appears.
  // IMPORTANT: these are CONSUMER WEBSITES — NOT the developer API consoles above in // ── AI platforms ──
  // AI Chat
  chatgpt:        { startUrl: 'https://chatgpt.com/',                            authSuccessPattern: 'chatgpt.com',                  isOAuth: false },
  geminiai:       { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  gemini:         { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  googleai:       { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
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

async function resolveBrowserMeta(service) {
  const seedKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. DuckDB agent descriptor — highest priority (validate_agent writes corrections here).
  //    Extract startUrl and signInUrl from the stored descriptor frontmatter so any
  //    URL corrections validate_agent made are immediately visible to callers.
  try {
    const db = await getDb();
    if (db) {
      const rows = await db.all(
        'SELECT descriptor, capabilities FROM agents WHERE id = ?', `${seedKey}.agent`
      ).catch(() => null);
      if (rows && rows.length > 0 && rows[0].descriptor) {
        const desc = rows[0].descriptor;
        const startUrl  = extractDescriptorUrl(desc, 'start_url');
        const signInUrl = extractDescriptorUrl(desc, 'sign_in_url');
        const authSuccessPattern = extractDescriptorUrl(desc, 'auth_success_pattern');
        if (startUrl) {
          // Merge with seed map — descriptor `is_oauth: true` overrides seed map so
          // services that were initially anonymous-first but later required login
          // (detected dynamically at runtime) are permanently upgraded.
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
    }
  } catch {}

  // 2. DuckDB meta cache (LLM discovery result cached here for unknown services)
  try {
    const db = await getDb();
    if (db) {
      const rows = await db.all(
        "SELECT meta_json FROM browser_meta_cache WHERE service = ?", seedKey
      ).catch(() => null);
      if (rows && rows.length > 0) {
        try { return JSON.parse(rows[0].meta_json); } catch {}
      }
    }
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
    const db = await getDb();
    if (db) {
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
    }
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

function buildBrowserDescriptorMd({ id, service, startUrl, signInUrl, authSuccessPattern, capabilities, type = 'browser' }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `service: ${service}`,
    ...(signInUrl ? [`sign_in_url: ${signInUrl}`] : []),
    `start_url: ${startUrl}`,
    `auth_success_pattern: ${authSuccessPattern}`,
    `capabilities:`,
    capYaml,
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
    `After auth, use action:scanCurrentPage to observe the DOM before clicking or typing.`,
    `Use action:navigate to go to specific URLs within the service.`,
    `Use action:click with selector from scanCurrentPage elements.`,
    `Use action:type to fill in text fields.`,
    `Use action:evaluate to extract values from the DOM.`,
  ].join('\n');
}

async function actionBuildAgent({ service, startUrl: explicitUrl, force = false }) {
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
    const db = await getDb();
    if (db) {
      const rows = await db.all('SELECT id, type, status FROM agents WHERE id = ?', agentId);
      if (rows && rows.length > 0 && rows[0].status !== 'needs_update' && rows[0].type === agentType) {
        return { ok: true, agentId, alreadyExists: true, status: rows[0].status };
      }
    }
  }

  const descriptor = buildBrowserDescriptorMd({ id: agentId, service: serviceKey, startUrl, signInUrl, authSuccessPattern, capabilities, type: agentType });

  // Write .md to disk
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  // Upsert into DuckDB
  const db = await getDb();
  if (db) {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, 'healthy', CURRENT_TIMESTAMP)`,
      agentId,
      agentType,
      serviceKey,
      JSON.stringify(capabilities),
      descriptor
    );
  }

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

  const db = await getDb();
  if (!db) {
    const agentId = id || `${(service || '').toLowerCase().replace(/[^a-z0-9]/g, '')}.agent`;
    const mdPath  = path.join(AGENTS_DIR, `${agentId}.md`);
    if (!fs.existsSync(mdPath)) return { ok: true, found: false, agentId };
    return { ok: true, found: true, agentId, descriptor: fs.readFileSync(mdPath, 'utf8') };
  }

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
}

// ---------------------------------------------------------------------------
// Action: list_agents
// ---------------------------------------------------------------------------

async function actionListAgents() {
  const db = await getDb();
  if (!db) {
    if (!fs.existsSync(AGENTS_DIR)) return { ok: true, agents: [] };
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
    return { ok: true, agents: files.map(f => ({ id: f.replace('.md', ''), type: 'browser' })) };
  }
  const rows = await db.all("SELECT id, type, service, capabilities, status, last_validated FROM agents WHERE type = 'browser' ORDER BY created_at DESC");
  return {
    ok: true,
    agents: (rows || []).map(r => ({
      id: r.id,
      type: r.type,
      service: r.service,
      capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
      status: r.status,
      lastValidated: r.last_validated,
    })),
  };
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
    const db = await getDb();
    if (db) {
      await db.run(
        `UPDATE agents SET descriptor = ?, status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?`,
        patchedDescriptor, finalStatus, failureLog, id
      );
    }
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
  const db = await getDb();
  if (!db) return;
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

async function actionRun({ agentId, task, context, requiresAuth, _progressCallbackUrl, _stepIndex, _loginWallRetried = false }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task)    return { ok: false, error: 'task is required' };

  const _fs = require('fs');

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
    const MAX_TURNS = 5;
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
  const startUrl           = extractDescriptorUrl(existing.descriptor, 'start_url');
  const signInUrl          = extractDescriptorUrl(existing.descriptor, 'sign_in_url');
  const authSuccessPattern = extractDescriptorUrl(existing.descriptor, 'auth_success_pattern');
  if (!startUrl) return { ok: false, error: 'Agent descriptor missing start_url' };

  const profile   = `${agentId.replace('.agent', '')}_agent`;
  // Use the stable profile name as sessionId so browser-profiles/<sessionId>/ persists
  // cookies across all invocations. A timestamped suffix creates a fresh dir each run
  // → Chrome shows the login page every time. 'gmail_agent' ≈ 94-char socket path,
  // safely under macOS's 104-char Unix socket limit.
  const sessionId = profile;

  const _svcKey          = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const _svcInfo         = lookupBrowserService(_svcKey);

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
    let _authNeeded = false;
    try {
      logger.info(`[browser.agent] run: playwright auth-check — navigating to ${startUrl} for ${agentId}`);
      const _probeNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000);
      if (_probeNav?.ok !== false) {
        const _hrefRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({}));
        const _curHref = String(_hrefRes?.result ?? _hrefRes?.stdout ?? '').trim();
        const _onLoginPage = _curHref.length > 4 && /\/(login|signin|sign[-_]in|auth|oauth|authorize)\b/i.test(_curHref);
        if (_onLoginPage) {
          logger.info(`[browser.agent] run: auth-check: login redirect (${_curHref}) — calling waitForAuth for ${agentId}`);
          _authNeeded = true;
        } else {
          logger.info(`[browser.agent] run: auth-check: no login redirect${_curHref ? ` (${_curHref})` : ''} — skipping waitForAuth for ${agentId}`);
        }
      }
    } catch (_probeErr) {
      logger.warn(`[browser.agent] run: auth-check probe failed — falling back to waitForAuth: ${_probeErr.message}`);
      _authNeeded = true;
    }
    if (_authNeeded) {
      let authResult;
      try {
        authResult = await callBrowserAct({
          action: 'waitForAuth',
          sessionId,
          url: signInUrl || startUrl,
          authSuccessUrl: authSuccessPattern,
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
    }
  }

  // Step 2: delegate to playwright.agent or agentbrowser.agent with the authenticated session
  logger.info(`[browser.agent] run: auth ok — delegating to ${_agentSkill} for "${task}"`);
  try {
    const agentResult = await callSkill(_agentSkill, {
      goal: task,
      agentContext: existing.descriptor ? existing.descriptor.slice(0, 800) : undefined,
      url: _useAgentBrowser ? startUrl : undefined,
      authSignInUrl: _useAgentBrowser ? (signInUrl || undefined) : undefined,
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
    }, 130000);

    const agentResultText = agentResult?.result || agentResult?.stdout || '';

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
        const _patchDb = await getDb();
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
      } catch (patchErr) {
        logger.warn(`[browser.agent] login-wall patch failed for ${agentId}: ${patchErr.message}`);
      }

      // ── Auto-retry: trigger waitForAuth inline and re-run the agent once ──────
      // This avoids requiring a manual re-run after the DB patch. The _loginWallRetried
      // flag (passed via args) prevents an infinite retry loop if the second run also
      // sees a wall (e.g. waitForAuth timed out, user didn't sign in).
      if (!_loginWallRetried && !_useAgentBrowser) {
        logger.info(`[browser.agent] auto-retry: calling waitForAuth for ${agentId} then re-delegating to ${_agentSkill}`);
        try {
          const _wallAuthResult = await callBrowserAct({
            action: 'waitForAuth',
            sessionId,
            url: signInUrl || startUrl,
            authSuccessUrl: authSuccessPattern,
            timeoutMs: 2 * 60 * 1000,
            _progressCallbackUrl,
          }, 3 * 60 * 1000);

          if (_wallAuthResult?.ok) {
            logger.info(`[browser.agent] waitForAuth succeeded after login-wall upgrade for ${agentId} — retrying ${_agentSkill}`);
            // Restore status to 'healthy' now that auth is confirmed working — ensures
            // planSkills re-includes this agent in the AVAILABLE AGENTS list for future plans.
            try {
              const _healDb = await getDb();
              if (_healDb) await _healDb.run('UPDATE agents SET status=? WHERE id=? AND status=?', 'healthy', agentId, 'needs_auth').catch(() => {});
            } catch (_) {}
            const _retryResult = await callSkill(_agentSkill, {
              goal: task,
              agentContext: existing.descriptor ? existing.descriptor.slice(0, 800) : undefined,
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

      return {
        ok: false,
        agentId,
        task,
        error: `Login wall detected for ${agentId} — service requires authentication. Agent upgraded to isOAuth:true. Please sign in and re-run.`,
        loginWallDetected: true,
        oauthUpgraded: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    return {
      ok: agentResult?.ok ?? false,
      agentId,
      task,
      sessionId,
      authenticated: true,
      result: agentResultText,
      transcript: agentResult?.transcript || [],
      turns: agentResult?.turns,
      done: agentResult?.done,
      error: agentResult?.error,
    };
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
// Action: record_failure — append a runtime error to failure_log
// ---------------------------------------------------------------------------

async function actionRecordFailure({ id, failureEntry }) {
  if (!id || !failureEntry) return { ok: false, error: 'id and failureEntry are required' };
  const db = await getDb();
  if (!db) return { ok: false, error: 'DB unavailable' };
  try {
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
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// actionExplore — resolve agent URL then invoke explore.agent
// ---------------------------------------------------------------------------
async function actionExplore({ agentId, goal, url, sessionId, maxDepth, maxNavItems }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!goal)    return { ok: false, error: 'goal is required' };

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
  logger.info(`[browser.agent] explore: goal="${goal}" url=${startUrl} session=${exploreSessionId}`);

  const { exploreAgent } = require('./explore.agent.cjs');
  return await exploreAgent({
    goal,
    url: startUrl,
    agentId,
    sessionId: exploreSessionId,
    maxDepth: maxDepth || 4,
    maxNavItems: maxNavItems || 20,
  });
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

    case 'scan_page':
      return await actionScanPage(args);

    case 'record_failure':
      return await actionRecordFailure(args);

    default:
      return {
        ok: false,
        error: `Unknown action: "${action}". Valid: build_agent | query_agent | list_agents | validate_agent | run | explore | scan_page | record_failure`,
      };
  }
}

module.exports = { browserAgent, KNOWN_BROWSER_SERVICES };
module.exports._deriveAgentType = deriveAgentType;
