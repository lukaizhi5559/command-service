'use strict';

// ---------------------------------------------------------------------------
// skill-helpers/page-category.cjs — shared page-category derivation.
//
// Moved out of browser.agent.cjs so the atomic-agent path (dom.act router +
// standalone wrappers) can derive the same category the legacy
// instruction.runner path always had. Resolution order:
//   1. service-key → category map (deterministic, absolute priority)
//   2. hostname(+path) → category map (covers no-agentId/direct calls)
//   3. session-cached LLM number-classification (unknown hosts only)
// Defaults to 'web_generic' on any failure — the safe category.
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');

const _PAGE_CATEGORY_MAP = new Map(); // cache: `${serviceKey}::${url}` → category

const _SERVICE_CATEGORIES = {
  gmail: 'email_compose', outlook: 'email_compose', protonmail: 'email_compose',
  yahoo: 'email_compose', mailgooglecom: 'email_compose',
  chatgpt: 'ai_chat', openai: 'ai_chat', claude: 'ai_chat', anthropic: 'ai_chat',
  gemini: 'ai_chat', googleai: 'ai_chat', grok: 'ai_chat', perplexity: 'ai_chat',
  notion: 'document_editor', googledocs: 'document_editor', googlesheets: 'spreadsheet',
  twitter: 'social_feed', x: 'social_feed', facebook: 'social_feed',
  linkedin: 'social_feed', reddit: 'social_feed',
  amazon: 'shopping', ebay: 'shopping', etsy: 'shopping',
  spotify: 'media_player', youtube: 'media_player', applemusic: 'media_player',
  googlecalendar: 'calendar', outlookcalendar: 'calendar',
  // Cloud consoles and dev tools — force web_generic to prevent appKnowledge
  // noise (e.g. "compose" in a cheatography snippet) from mis-classifying as
  // email_compose or other specialized categories.
  googlecloud: 'web_generic', googleai: 'web_generic', aistudio: 'web_generic',
  googledrive: 'web_generic', gcp: 'web_generic', aws: 'web_generic',
  azure: 'web_generic', cloudflare: 'web_generic', vercel: 'web_generic',
  github: 'web_generic', gitlab: 'web_generic', bitbucket: 'web_generic',
  stripe: 'web_generic', twilio: 'web_generic', sendgrid: 'web_generic',
  mailgun: 'web_generic', postmark: 'web_generic',
};

const _LLM_CATEGORY_NUMBERS = [
  'web_generic',    // 0
  'email_compose',  // 1
  'ai_chat',        // 2
  'document_editor',// 3
  'spreadsheet',    // 4
  'social_feed',    // 5
  'shopping',       // 6
  'media_player',   // 7
  'calendar',       // 8
];

// Hostname(+path) → category. Tested against `host` and `host+pathname` when a
// service key misses — covers direct atomic-agent calls that only know the URL.
// More specific host+path rules (docs.google.com/document) must precede their
// bare-host siblings.
const _HOST_CATEGORIES = [
  [/docs\.google\.com\/document/i, 'document_editor'],
  [/docs\.google\.com\/spreadsheets/i, 'spreadsheet'],
  [/docs\.google\.com/i, 'document_editor'],
  [/(^|\.)chatgpt\.com|(^|\.)openai\.com|(^|\.)claude\.ai|gemini\.google\.com|(^|\.)perplexity\.ai|(^|\.)grok\.com|bard\.google\.com/i, 'ai_chat'],
  [/mail\.google\.com|(^|\.)outlook\.(live|office|office365)\.com|(^|\.)outlook\.com|mail\.proton\.me|mail\.yahoo\.com/i, 'email_compose'],
  [/calendar\.google\.com|(^|\.)outlook\.(live|office)\.com\/calendar/i, 'calendar'],
  [/notion\.so|(^|\.)notion\.site/i, 'document_editor'],
  [/(^|\.)(youtube\.com|youtu\.be)|music\.youtube\.com|open\.spotify\.com|(^|\.)netflix\.com|(^|\.)twitch\.tv/i, 'media_player'],
  [/(^|\.)(x\.com|twitter\.com|linkedin\.com|facebook\.com|reddit\.com|instagram\.com|threads\.net)/i, 'social_feed'],
  [/(^|\.)(amazon\.|ebay\.|etsy\.|walmart\.|target\.|aliexpress\.|bestbuy\.|costco\.|homedepot\.|lowes\.|newegg\.)/i, 'shopping'],
  [/app\.slack\.com|(^|\.)discord\.com\/(channels|app)|(^|\.)teams\.(microsoft|live)\.com|web\.whatsapp\.com|web\.telegram\.org/i, 'messaging'],
  [/^www\.google\.com\/?$|^www\.google\.com\/search|(^|\.)bing\.com|duckduckgo\.com/i, 'search_engine'],
];

function _normSvc(k) { return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// 'chatgpt.agent' → 'chatgpt'; also accepts bare 'chatgpt'.
function serviceKeyForAgentId(agentId) {
  return _normSvc(String(agentId || '').replace(/\.agent$/i, ''));
}

function hostCategory(url) {
  let host = '', hostPath = '';
  try {
    const u = new URL(String(url || ''));
    host = u.hostname.toLowerCase();
    hostPath = (u.hostname + u.pathname).toLowerCase();
  } catch (_) { return null; }
  for (const [re, cat] of _HOST_CATEGORIES) {
    if (re.test(hostPath) || re.test(host)) return cat;
  }
  return null;
}

async function _classifyPageCategoryLLM(serviceKey, url, task, appKnowledgeEntries) {
  const { askWithMessages } = require('./skill-llm.cjs');
  const _svc = _normSvc(serviceKey);
  const _url = (url || '').toLowerCase();
  const _task = (task || '').toLowerCase();

  // Build compact appKnowledge summary (max 500 chars)
  const _akSummary = (appKnowledgeEntries || [])
    .map(e => `${e.type}: ${e.summary || ''}`.toLowerCase())
    .join(' | ')
    .slice(0, 500);

  const systemPrompt = `You classify a web page into a category based on the service, URL, task, and app knowledge.
Return ONLY a single number — nothing else:
  0 = web_generic (dashboards, consoles, admin panels, cloud platforms, unknown sites)
  1 = email_compose (composing/sending email — Gmail, Outlook, ProtonMail)
  2 = ai_chat (chatting with an AI — ChatGPT, Claude, Gemini chat)
  3 = document_editor (editing a document — Notion, Google Docs)
  4 = spreadsheet (cell-based grid editing — Google Sheets)
  5 = social_feed (posting/sharing to a feed — Twitter, LinkedIn, Facebook)
  6 = shopping (product pages, checkout — Amazon, eBay)
  7 = media_player (playing media — Spotify, YouTube)
  8 = calendar (event scheduling — Google Calendar)

Rules:
- Cloud consoles (Google Cloud, AWS, Azure) → 0 (web_generic), NOT email even if "compose" appears
- "compose" in a cloud/dev context means "compose a query", not email → 0
- When in doubt → 0 (web_generic is the safe default)`;

  const userPrompt = `Service: ${_svc}
URL: ${_url}
Task: ${_task}
App knowledge: ${_akSummary || '(none)'}

Which category number?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, taskType: 'classification', responseTimeoutMs: 8000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num >= 0 && num < _LLM_CATEGORY_NUMBERS.length) {
      const category = _LLM_CATEGORY_NUMBERS[num];
      logger.info(`[page-category] _classifyPageCategoryLLM: service=${_svc} url=${_url.slice(0, 60)} → ${category} (num=${num})`);
      return category;
    }
    logger.info(`[page-category] _classifyPageCategoryLLM: invalid response "${(raw || '').trim()}" — defaulting to web_generic`);
    return 'web_generic';
  } catch (e) {
    logger.warn(`[page-category] _classifyPageCategoryLLM failed: ${e.message} — defaulting to web_generic`);
    return 'web_generic';
  }
}

// Legacy signature kept — browser.agent call sites use (serviceKey, url, task, ak).
async function _inferPageCategory(serviceKey, url, task, appKnowledgeEntries = []) {
  const _svc = _normSvc(serviceKey);
  const _url = (url || '').toLowerCase();

  // 1. Direct service → category mapping (deterministic, absolute priority)
  if (_SERVICE_CATEGORIES[_svc]) return _SERVICE_CATEGORIES[_svc];

  // 1.5. Hostname → category mapping (deterministic — covers direct atomic
  // calls that only know the URL, before paying for the LLM fallback).
  const _hostCat = hostCategory(url);
  if (_hostCat) return _hostCat;

  // Check session cache
  const _cacheKey = `${_svc}::${_url}`;
  if (_PAGE_CATEGORY_MAP.has(_cacheKey)) {
    return _PAGE_CATEGORY_MAP.get(_cacheKey);
  }

  // 2. LLM number-classification
  const _category = await _classifyPageCategoryLLM(serviceKey, url, task, appKnowledgeEntries);

  // Cache for the session
  _PAGE_CATEGORY_MAP.set(_cacheKey, _category);
  return _category;
}

// Atomic-path entry point: inferPageCategory({agentId, serviceKey, url, task|goal, appKnowledgeEntries})
async function inferPageCategory({ agentId, serviceKey, url, task, goal, appKnowledgeEntries } = {}) {
  return _inferPageCategory(serviceKey || serviceKeyForAgentId(agentId), url, task || goal, appKnowledgeEntries);
}

module.exports = {
  inferPageCategory,
  _inferPageCategory,
  _classifyPageCategoryLLM,
  serviceKeyForAgentId,
  hostCategory,
  _SERVICE_CATEGORIES,
  _HOST_CATEGORIES,
  _PAGE_CATEGORY_MAP,
};
