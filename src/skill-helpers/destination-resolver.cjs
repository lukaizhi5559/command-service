/**
 * destination-resolver.cjs — Pre-navigation destination intent verification
 *
 * Classifies the task's intent, scores the planned startUrl against that intent,
 * and returns a verdict: ok / auto_correct / ask_user.
 *
 * Flow:
 *   1. classifyTaskIntent(task) → intent string (chat | research | search | docs | console | settings | mail | social | commerce | content_create | scheduling | maps | download | support | dashboard | home)
 *   2. classifyUrlType(url)     → endpoint type the URL represents
 *   3. Compare: if the planned URL type is incompatible with the task intent → mismatch
 *   4. On mismatch:
 *        a. Check for a [Resume context:] annotation in the task — user already answered
 *        b. Check learned corrections (skill-db KV, with confidence decay)
 *        c. Check hard-coded per-service chat URLs
 *        d. Fall through to ask_user
 *
 * Correction memory: stored in skill-db KV, namespace "nav-correction",
 *   key "<serviceKey>:<intent>", value {correctedUrl, confidence, updatedAt, hitCount}.
 *   Confidence decays 0.05/week since last hit; entries below 0.40 are ignored.
 */

'use strict';

let skillDb = null;
try { skillDb = require('./skill-db.cjs'); } catch (_) {}

const logger = require('../logger.cjs');

let _skillLlm = null;
try { _skillLlm = require('./skill-llm.cjs'); } catch (_) {}

// ── LLM intent classification cache (keyed on first 100 chars of cleaned task) ─
const _intentCache = new Map();

// ── Auth-flow URL detection ───────────────────────────────────────────────────
// A URL whose path matches one of these segments is an authentication/identity
// flow page (login, magic-link, OAuth callback, signup, verify, logout, …) —
// NEVER a valid task deep-link. Promoting such a URL as the task's start page
// sends the agent to an auth error/landing page instead of the app surface
// (e.g. claude.ai/magic-link instead of claude.ai/new). Path-segment-anchored
// to avoid false positives on legit app pages that merely contain "auth".
const AUTH_FLOW_PATH_RE = /\/(?:login|signin|sign-in|sign_in|signup|sign-up|register|registration|logout|signout|sign-out|magic[-_]?link|verify|verification|oauth2?|authorize|authorise|deauthorize|auth(?:\/(?:callback|session|login|verify|new|start|finish|complete))?|session\/new|connect\/oauth|api\/auth\/callback|sso\/(?:login|callback))\b/i;

/**
 * Returns true if the URL's path is an authentication/identity-flow endpoint
 * (login, magic-link, oauth, authorize, callback, signup, verify, logout, …).
 * Such URLs must never be promoted as a task deep-link start page.
 */
function isAuthFlowUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return AUTH_FLOW_PATH_RE.test(parsed.pathname || '/');
  } catch (_) {
    return false;
  }
}

// ── Intent constants ──────────────────────────────────────────────────────────
// Derived from common web-agent benchmarks (Mind2Web, WebArena, WebVoyager).
// Intents are used to decide whether a planned start URL matches the user's task.
const INTENTS = {
  CHAT:           'chat',           // converse with or query an AI assistant
  RESEARCH:       'research',       // look up / search / investigate a topic via AI
  SEARCH:         'search',         // explicit site search / "search X for Y" / "google X"
  DOCS:           'docs',           // read documentation, guides, tutorials
  CONSOLE:        'console',        // API keys, developer settings, platform console
  SETTINGS:       'settings',       // account settings, profile, billing
  MAIL:           'mail',           // send, compose, forward, reply to email
  SOCIAL:         'social',         // post, comment, message, follow on social/forum
  COMMERCE:       'commerce',       // buy, cart, checkout, order, purchase
  CONTENT_CREATE: 'content_create', // write, compose, publish, upload content
  SCHEDULING:     'scheduling',     // book, schedule, reserve, appointment, calendar
  MAPS:           'maps',           // directions, nearby, navigate, locate
  DOWNLOAD:       'download',       // download, export, save a file
  MEDIA_PLAY:     'media_play',     // play, stream, or watch music/video/media
  SUPPORT:        'support',        // contact support, help center, ticket
  DASHBOARD:      'dashboard',      // analytics, stats, admin, overview
  HOME:           'home',           // generic visit — open the site's landing page
};

// ── Task keywords → intent (first match wins) ─────────────────────────────────
// NOTE: Input is scoped to first 280 chars of stripped task before matching.
// Payload noise ([DATA FROM PRIOR STEP], body: ...) is stripped before reaching here.
const INTENT_PATTERNS = [
  // CONSOLE — developer/API work first (before research to avoid keyword overlap)
  {
    intent: INTENTS.CONSOLE,
    re: /\b(api[\s_-]?key|api[\s_-]?keys|generate[\s_-]?key|developer[\s_-]?console|create[\s_-]?token|bearer[\s_-]?token|secret[\s_-]?key|api[\s_-]?token)\b/i,
  },
  // DOCS
  {
    intent: INTENTS.DOCS,
    re: /\b(documentation|docs|tutorial|guide|reference|how[\s_-]?to[\s_-]?use|readme|manual)\b/i,
  },
  // MAIL — email actions BEFORE settings to prevent payload keywords triggering settings
  {
    intent: INTENTS.MAIL,
    re: /\b((?:send|compose|write|draft|forward|reply)(?:\s+\w+){0,3}\s+(?:email|mail)|email[\s_-]to|mail[\s_-]to|newsletter|the\s+email)\b/i,
  },
  // SETTINGS — account/profile/billing/subscription management
  {
    intent: INTENTS.SETTINGS,
    re: /\b(account[\s_-]?settings|billing[\s_-]?(info|page|settings)?|subscription[\s_-]?(management|settings)?|profile[\s_-]?settings|update\s+my\s+profile|change\s+billing|manage\s+subscription|my[\s_-]?preferences|preferences[\s_-]?page|settings[\s_-]?(panel|screen|page))\b/i,
  },
  // CHAT — explicit chat/conversation verbs
  {
    intent: INTENTS.CHAT,
    re: /\b(ask[\s_-]?(?:chatgpt|claude|grok|gemini|ai|the\s+ai|it)|chat[\s_-]?(?:with|gpt)?|converse|have[\s_-]?a[\s_-]?conversation|talk[\s_-]?to[\s_-]?(?:chatgpt|claude|grok|gemini|ai)?|message[\s_-]?the[\s_-]?ai|tell[\s_-]?it|prompt[\s_-]?it)\b/i,
  },
  // SEARCH — explicit search/query phrasing (must come before RESEARCH so "search" wins)
  {
    intent: INTENTS.SEARCH,
    re: /\b(search\s+(?:for|on|google|youtube)?|google\s+(?:for|search|maps|flights)?|site:)/i,
  },
  // CONTENT_CREATE — create and publish content (before SOCIAL so "write a post" wins)
  {
    intent: INTENTS.CONTENT_CREATE,
    re: /\b(write[\s_-].*(?:post|blog|article)|publish[\s_-].*(?:article|post|video)|upload[\s_-].*(?:video|file|image)|create[\s_-].*(?:page|post|blog|listing))\b/i,
  },
  // SOCIAL — explicit posting/messaging/following on social or forum platforms
  {
    intent: INTENTS.SOCIAL,
    re: /\b(post\s+(?:to|on)|tweet|retweet|follow\s+(?:[\w@]+\s+)?on|comment\s+on|like\s+(?:the\s+)?post|share\s+on|send\s+a\s+dm|message\s+on\s+(?:twitter|x|instagram|linkedin|facebook|reddit|discord|slack))\b/i,
  },
  // COMMERCE — explicit shopping/checkout actions
  {
    intent: INTENTS.COMMERCE,
    re: /\b(add(?:\s+\w+){0,2}\s+to\s+cart|shopping\s+cart|checkout|place\s+an?\s+order|buy\s+(?:now|this)|purchase\s+(?:this|item))\b/i,
  },
  // SCHEDULING — calendar / appointment / reservation
  {
    intent: INTENTS.SCHEDULING,
    re: /\b(book[\s_-].*(?:appointment|reservation|table|slot)|schedule[\s_-].*(?:meeting|call|appointment)|reserve[\s_-].*(?:table|room|seat)|add[\s_-].*calendar\s+event)\b/i,
  },
  // MAPS — directions / nearby / navigation
  {
    intent: INTENTS.MAPS,
    re: /\b(directions\s+(?:to|from)|navigate\s+(?:to|from)|find\s+nearby|locate\s+(?:a|the)|map\s+of|route\s+(?:to|from)|nearby\s+(?:restaurants|gas|hotels|stores))\b/i,
  },
  // DOWNLOAD — save/export a file
  {
    intent: INTENTS.DOWNLOAD,
    re: /\b(download[\s_-].*(?:file|pdf|image|video|report)|export[\s_-].*(?:data|report|list|file)|save[\s_-].*(?:file|pdf|image))\b/i,
  },
  // MEDIA_PLAY — play, stream, or watch music/video/media
  {
    intent: INTENTS.MEDIA_PLAY,
    re: /\b(play\s+(?:\w+\s+)*(?:playlist|song|track|album|music|video|movie|show|episode|first\s+result)|stream\s+(?:\w+\s+)*(?:video|movie|show|song|track|music)|watch\s+(?:\w+\s+)*(?:video|movie|show|episode|first\s+result))\b/i,
  },
  // SUPPORT — help / contact / ticket
  {
    intent: INTENTS.SUPPORT,
    re: /\b(contact\s+support|open\s+(?:a\s+)?(?:support\s+)?ticket|report\s+(?:an?\s+)?issue|help\s+center|customer\s+support)\b/i,
  },
  // DASHBOARD — analytics / admin / overview
  {
    intent: INTENTS.DASHBOARD,
    re: /\b(show\s+my\s+dashboard|open\s+(?:the\s+)?dashboard|view\s+(?:my\s+)?dashboard|view\s+(?:my\s+)?analytics|show\s+(?:my\s+)?stats|admin\s+panel|overview\s+page)\b/i,
  },
  // RESEARCH — broad: look up, find, research, learn, "what is", "who is"
  {
    intent: INTENTS.RESEARCH,
    re: /\b(look[\s_-]?up|find[\s_-]?out|research|investigate|look[\s_-]?into|what[\s_-]?is|who[\s_-]?is|tell[\s_-]?me[\s_-]?about|learn[\s_-]?about|information[\s_-]?about|info[\s_-]?on|details[\s_-]?on|explore|find[\s_-]?information|gather[\s_-]?info)\b/i,
  },
  // HOME — generic navigation
  {
    intent: INTENTS.HOME,
    re: /\b(go[\s_-]?to|open|navigate[\s_-]?to|visit)\b/i,
  },
];

// ── Valid intent enum values (for LLM response validation) ────────────────────
const VALID_INTENTS = new Set(Object.values(INTENTS));

/**
 * Strip payload noise from task string and return first N chars.
 * Removes [DATA FROM PRIOR STEP]...[/DATA], [CONTENT OF ...]..., and body: ... blocks
 * which can contain arbitrary text that would confuse intent classification.
 */
function _scopeTaskText(task, maxChars = 280) {
  let text = String(task || '');
  // Strip "(Context from prior turn: ...)" suffix (injected by preflightAgents.js)
  text = text.replace(/\n*\(Context from prior turn:[^)]*\)\s*$/i, ' ');
  // Strip [DATA FROM PRIOR STEP] ... [/DATA FROM PRIOR STEP] blocks
  text = text.replace(/\[DATA FROM PRIOR STEP\][\s\S]*?(?:\[\/DATA FROM PRIOR STEP\]|$)/gi, ' ');
  // Strip [CONTENT OF ...] blocks
  text = text.replace(/\[CONTENT OF[^\]]*\][\s\S]*?(?=\[|$)/gi, ' ');
  // Strip body: ... multiline blocks (common in email task injections)
  text = text.replace(/\bbody:\s*[\s\S]{0,3000}/gi, ' ');
  // Strip [Resume context: ...] blocks
  text = text.replace(/\[Resume context:[^\]]*\]/gi, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}

/**
 * Classify the task string to a primary intent.
 * Primary: LLM classification on first 100 chars of stripped task.
 * Fallback: hardened regex on first 280 chars of stripped task.
 * Returns one of the INTENTS values, or INTENTS.HOME as fallback.
 */
async function classifyTaskIntent(task) {
  const _scopedFull = _scopeTaskText(task, 280);
  const _scopedShort = _scopedFull.slice(0, 100);
  const _cacheKey = _scopedShort;

  // Return cached result if available (handle both old string and new {intent, keywords} formats)
  if (_intentCache.has(_cacheKey)) {
    const _cached = _intentCache.get(_cacheKey);
    return typeof _cached === 'string' ? _cached : _cached.intent;
  }

  // Intra-app short-circuit
  if (_scopedFull.includes('openai') || _scopedFull.includes('chatgpt')) {
    return INTENTS.CHAT;
  }

  // ── Primary: LLM classification ───────────────────────────────────────────
  if (_skillLlm && _scopedShort.trim().length > 3) {
    try {
      const _llmPrompt = `Classify this browser task into exactly one of these categories. Return the category followed by a pipe and 3-5 keywords that characterize the task.

Definitions and examples:
- chat           : converse with an AI assistant. Examples: "ask ChatGPT", "talk to Claude", "start a conversation with Grok"
- research       : look up, summarize, or investigate a topic. Examples: "what is photosynthesis", "find information about Mars", "research vegan diets"
- search         : explicit site search. Examples: "search Google for best sushi", "google cheap flights", "search YouTube for lo-fi"
- docs           : read documentation, guides, tutorials, or reference. Examples: "show me the React docs", "how to use git rebase"
- console        : API keys, developer dashboard, bearer/secret tokens, platform console. Examples: "create an OpenAI API key", "go to the developer console"
- settings       : account settings, billing, profile, subscription management. Examples: "update my profile", "change billing info"
- mail           : send, compose, forward, or reply to email. Examples: "send an email to Bob", "reply to the last message", "compose a new email"
- social         : post, comment, message, follow, share on a social or forum platform. Examples: "post on X", "comment on Instagram", "tweet this link", "follow Elon on X"
- commerce       : buy, add to cart, checkout, order, purchase. Examples: "add headphones to cart", "checkout on Amazon", "buy this item"
- content_create : write, compose, publish, or upload content. Examples: "write a blog post on Medium", "upload a YouTube video", "publish an article"
- scheduling     : book, schedule, reserve, appointment, calendar. Examples: "book a table on OpenTable", "schedule a Zoom meeting", "reserve a room"
- maps           : directions, nearby, navigate, locate. Examples: "directions to the airport", "find nearby gas stations", "navigate to Times Square"
- download       : download, export, or save a file. Examples: "download the PDF", "export the report", "save the image"
- media_play     : play, stream, or watch media. Examples: "play my Spotify playlist", "watch a YouTube video", "play the first result on YouTube Music"
- support        : contact support, help center, ticket. Examples: "open a support ticket", "contact customer support"
- dashboard      : analytics, stats, admin, overview. Examples: "show my dashboard", "view analytics", "open admin panel"
- home           : any other generic navigation, visiting a site, opening a page, clicking elements. Examples: "go to github.com", "open Slack", "visit the homepage"

Task: ${_scopedShort}

Format: category|keyword1,keyword2,keyword3,keyword4,keyword5
Answer:`;
      const _llmRaw = await _skillLlm.ask(_llmPrompt, { temperature: 0.0, responseTimeoutMs: 8000 });
      const _parts = (_llmRaw || '').trim().split('|');
      const _llmIntent = (_parts[0] || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
      const _llmKeywords = (_parts[1] || '')
        .split(/[,;]\s*/)
        .map(k => k.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ''))
        .filter(k => k.length > 2)
        .slice(0, 8);
      if (VALID_INTENTS.has(_llmIntent)) {
        logger.debug(`[destination-resolver] LLM intent: "${_llmIntent}" keywords: [${_llmKeywords.join(', ')}] for task: "${_scopedShort.slice(0, 60)}"`);
        _intentCache.set(_cacheKey, { intent: _llmIntent, keywords: _llmKeywords });
        return _llmIntent;
      }
      logger.debug(`[destination-resolver] LLM returned non-enum "${_llmRaw?.trim()}" — falling back to regex`);
    } catch (_llmErr) {
      logger.debug(`[destination-resolver] LLM intent classification failed: ${_llmErr.message} — falling back to regex`);
    }
  }

  // ── Fallback: hardened regex on scoped text ───────────────────────────────
  const _text = _scopedFull.toLowerCase();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(_text)) {
      _intentCache.set(_cacheKey, { intent, keywords: [] });
      return intent;
    }
  }

  _intentCache.set(_cacheKey, { intent: INTENTS.HOME, keywords: [] });
  return INTENTS.HOME;
}

// ── URL endpoint type classifier ──────────────────────────────────────────────
// Given a URL, return the type of endpoint it most likely represents.

const URL_TYPE_PATTERNS = [
  {
    type: INTENTS.MAIL,
    tests: [
      /mail\.google\.com/i,
      /outlook\.live\.com/i,
      /outlook\.office\.com/i,
      /mail\.yahoo\.com/i,
      /mail\.proton\.me/i,
      /mail\.zoho\.com/i,
    ],
  },
  {
    type: INTENTS.CHAT,
    tests: [
      /^https?:\/\/chat\./i,
      /\/chat\b/i,
      /chatgpt\.com/i,
      /claude\.ai/i,
      /gemini\.google\.com/i,
      /grok\.com/i,
      /copilot\.microsoft\.com/i,
      /chat\.mistral\.ai/i,
      /chat\.qwenlm\.ai/i,
    ],
  },
  {
    type: INTENTS.SOCIAL,
    tests: [
      /\/post\b/i,
      /\/compose/i,
      /\/tweet/i,
      /\/messages/i,
      /\/feed/i,
      /\/social/i,
      /\/community/i,
      /\/forum/i,
      /\/follow/i,
      /twitter\.com\/compose/i,
      /x\.com\/compose/i,
      /linkedin\.com\/share/i,
      /reddit\.com\/submit/i,
    ],
  },
  {
    type: INTENTS.CONTENT_CREATE,
    tests: [
      /\/upload/i,
      /\/publish/i,
      /\/editor/i,
      /\/create\b/i,
      /\/write/i,
      /\/new\b/i,
      /youtube\.com\/upload/i,
      /medium\.com\/new/i,
      /notion\.so\/new/i,
    ],
  },
  {
    type: INTENTS.COMMERCE,
    tests: [
      /\/cart/i,
      /\/checkout/i,
      /\/order/i,
      /\/buy/i,
      /\/purchase/i,
      /\/shop/i,
      /\/store/i,
      /\/product/i,
      /amazon\.com\/gp\/aws\/cart/i,
      /ebay\.com\/itm/i,
    ],
  },
  {
    type: INTENTS.SCHEDULING,
    tests: [
      /\/book/i,
      /\/schedule/i,
      /\/appointment/i,
      /\/reserve/i,
      /\/calendar/i,
      /\/events/i,
      /calendly\.com/i,
      /open-table/i,
      /opentable\.com/i,
    ],
  },
  {
    type: INTENTS.MAPS,
    tests: [
      /\/maps/i,
      /\/directions/i,
      /\/nearby/i,
      /\/places/i,
      /google\.com\/maps/i,
      /maps\.google\.com/i,
    ],
  },
  {
    type: INTENTS.DOWNLOAD,
    tests: [
      /\/download/i,
      /\/export/i,
      /\.pdf$/i,
      /\.zip$/i,
      /\/file\//i,
      /drive\.google\.com\/uc/i,
    ],
  },
  {
    type: INTENTS.SUPPORT,
    tests: [
      /\/support/i,
      /\/contact/i,
      /\/help/i,
      /\/ticket/i,
      /\/help-center/i,
      /zendesk\.com/i,
    ],
  },
  {
    type: INTENTS.DASHBOARD,
    tests: [
      /\/dashboard/i,
      /\/admin/i,
      /\/analytics/i,
      /\/overview/i,
      /\/reports/i,
      /\/stats/i,
      /\/metrics/i,
    ],
  },
  {
    type: INTENTS.CONSOLE,
    tests: [
      /\/api[_-]?keys?/i,
      /\/settings\/api/i,
      /\/settings\/tokens/i,
      /\bplatform\./i,
      /\bconsole\./i,
      /\bdashboard\./i,
      /\/access[_-]?tokens?/i,
      /\/account\/api/i,
      /fireworks\.ai\/account/i,
      /together\.xyz/i,
    ],
  },
  {
    type: INTENTS.SETTINGS,
    tests: [
      /^https?:\/\/[^/]+\/settings(?!\/api)/i,
      /^https?:\/\/[^/]+\/account(?!\/api)/i,
      /^https?:\/\/[^/]+\/profile(?!\/api)/i,
      /^https?:\/\/[^/]+\/billing/i,
      /^https?:\/\/[^/]+\/preferences/i,
    ],
  },
  {
    type: INTENTS.DOCS,
    tests: [
      /\/docs\b/i,
      /\/documentation\b/i,
      /^https?:\/\/docs\./i,
    ],
  },
];

/**
 * Given a URL string, return the endpoint type it represents.
 */
function classifyUrlType(url) {
  if (!url) return INTENTS.HOME;
  for (const { type, tests } of URL_TYPE_PATTERNS) {
    if (tests.some(re => re.test(url))) return type;
  }
  return INTENTS.HOME;
}

// ── Intent → acceptable URL endpoint types ────────────────────────────────────
// Maps a task intent to the set of URL types considered compatible.

const INTENT_ACCEPTED_URL_TYPES = {
  [INTENTS.CHAT]:           [INTENTS.CHAT, INTENTS.HOME],
  [INTENTS.RESEARCH]:       [INTENTS.CHAT, INTENTS.HOME],
  [INTENTS.SEARCH]:         [INTENTS.HOME, INTENTS.CHAT, INTENTS.DOCS, INTENTS.RESEARCH, INTENTS.MAIL, INTENTS.CONSOLE, INTENTS.SETTINGS, INTENTS.SOCIAL, INTENTS.COMMERCE, INTENTS.CONTENT_CREATE, INTENTS.SCHEDULING, INTENTS.MAPS, INTENTS.DOWNLOAD, INTENTS.SUPPORT, INTENTS.DASHBOARD],
  [INTENTS.DOCS]:           [INTENTS.DOCS, INTENTS.HOME],
  [INTENTS.CONSOLE]:        [INTENTS.CONSOLE],
  [INTENTS.SETTINGS]:       [INTENTS.SETTINGS, INTENTS.CONSOLE],
  [INTENTS.MAIL]:           ['mail', INTENTS.HOME],
  [INTENTS.SOCIAL]:         [INTENTS.SOCIAL, INTENTS.HOME, INTENTS.CONTENT_CREATE],
  [INTENTS.COMMERCE]:       [INTENTS.COMMERCE, INTENTS.HOME],
  [INTENTS.CONTENT_CREATE]: [INTENTS.CONTENT_CREATE, INTENTS.HOME, INTENTS.SOCIAL],
  [INTENTS.SCHEDULING]:     [INTENTS.SCHEDULING, INTENTS.HOME],
  [INTENTS.MAPS]:           [INTENTS.MAPS, INTENTS.HOME],
  [INTENTS.DOWNLOAD]:       [INTENTS.DOWNLOAD, INTENTS.HOME, INTENTS.DOCS],
  [INTENTS.MEDIA_PLAY]:     [INTENTS.MEDIA_PLAY, INTENTS.HOME, INTENTS.SEARCH],
  [INTENTS.SUPPORT]:        [INTENTS.SUPPORT, INTENTS.HOME],
  [INTENTS.DASHBOARD]:      [INTENTS.DASHBOARD, INTENTS.HOME, INTENTS.CONSOLE, INTENTS.SETTINGS],
  [INTENTS.HOME]:           [INTENTS.HOME, INTENTS.CHAT, INTENTS.DOCS, INTENTS.CONSOLE, INTENTS.SETTINGS, INTENTS.SOCIAL, INTENTS.COMMERCE, INTENTS.CONTENT_CREATE, INTENTS.SCHEDULING, INTENTS.MAPS, INTENTS.DOWNLOAD, INTENTS.MEDIA_PLAY, INTENTS.SUPPORT, INTENTS.DASHBOARD],
};

// ── Per-service fallback chat/home URLs ───────────────────────────────────────
// Used when the resolved startUrl is a developer console but the task intent is
// chat or research. These are hard-coded as secondary fallbacks; learned corrections
// are checked first.

const SERVICE_CHAT_URLS = {
  // API console keys (used by resolveDestination for console→chat correction)
  deepseek:   'https://chat.deepseek.com/',
  perplexity: 'https://www.perplexity.ai/',
  mistral:    'https://chat.mistral.ai/',
  qwen:       'https://chat.qwenlm.ai/',
  anthropic:  'https://claude.ai/new',
  openai:     'https://platform.openai.com',
  chatgpt:    'https://chatgpt.com/',
  cohere:     'https://coral.cohere.com/',
  groq:       'https://groq.com/',
  huggingface:'https://huggingface.co/chat/',
  together:   'https://api.together.ai/playground',
  // Consumer chat app keys (matching KNOWN_BROWSER_SERVICES in browser.agent.cjs)
  claude:           'https://claude.ai/new',
  perplexitychat:   'https://www.perplexity.ai/',
  grok:             'https://grok.com/',
  deepseekchat:     'https://chat.deepseek.com/',
  mistralchat:      'https://chat.mistral.ai/',
  copilotmsft:      'https://copilot.microsoft.com/',
  geminiai:         'https://gemini.google.com',
  gemini:           'https://gemini.google.com',
  googleai:         'https://gemini.google.com',
};

// ── Correction memory ─────────────────────────────────────────────────────────

const CORRECTION_NS = 'nav-correction';
const CONFIDENCE_DECAY_PER_WEEK = 0.05;
const STALE_THRESHOLD = 0.40;

/**
 * Load a previously recorded destination correction with time-based confidence decay.
 * Returns null if none exists or confidence has decayed below STALE_THRESHOLD.
 */
async function getLearnedCorrection(serviceKey, intent) {
  if (!skillDb) return null;
  try {
    const entry = await skillDb.get(CORRECTION_NS, `${serviceKey}:${intent}`);
    if (!entry || typeof entry !== 'object') return null;
    const { correctedUrl, confidence = 1.0, updatedAt = Date.now(), hitCount = 1 } = entry;
    const weeksElapsed = (Date.now() - updatedAt) / (7 * 24 * 60 * 60 * 1000);
    const decayedConf  = Math.max(0, confidence - weeksElapsed * CONFIDENCE_DECAY_PER_WEEK);
    if (decayedConf < STALE_THRESHOLD) {
      logger.debug(`[destination-resolver] Stale correction for ${serviceKey}:${intent} (conf=${decayedConf.toFixed(2)}) — ignoring`);
      return null;
    }
    return { correctedUrl, confidence: decayedConf, hitCount };
  } catch (err) {
    logger.warn(`[destination-resolver] getLearnedCorrection error: ${err.message}`);
    return null;
  }
}

/**
 * Delete a learned correction from persistent storage.
 * Returns true if the deletion succeeded (or no helper is available), false otherwise.
 */
async function deleteLearnedCorrection(serviceKey, intent) {
  if (!skillDb) return false;
  const key = `${serviceKey}:${intent}`;
  try {
    const ok = await skillDb.del(CORRECTION_NS, key);
    if (ok) {
      logger.info(`[destination-resolver] Deleted correction: ${key}`);
    } else {
      logger.warn(`[destination-resolver] deleteLearnedCorrection returned false for ${key}`);
    }
    return ok;
  } catch (err) {
    logger.warn(`[destination-resolver] deleteLearnedCorrection error for ${key}: ${err.message}`);
    return false;
  }
}

/**
 * Persist a successful destination correction.
 * Confidence grows with repeated hits (capped at 1.0).
 * Returns true when the underlying write succeeds, false otherwise.
 */
async function recordCorrection(serviceKey, intent, correctedUrl) {
  if (!skillDb) return false;
  // Defense-in-depth: never persist an auth-flow URL (login, magic-link, oauth,
  // callback, signup, verify, logout, …) as a task destination correction.
  // Such URLs are auth/identity flow pages, not app surfaces — caching them
  // poisons future runs (e.g. claude.ai/magic-link instead of claude.ai/new).
  if (isAuthFlowUrl(correctedUrl)) {
    logger.warn(`[destination-resolver] Refusing to record auth-flow URL as correction for ${serviceKey}:${intent}: ${correctedUrl}`);
    return false;
  }
  try {
    const existing = await skillDb.get(CORRECTION_NS, `${serviceKey}:${intent}`);
    const prevHits  = existing?.hitCount || 0;
    const ok = await skillDb.set(CORRECTION_NS, `${serviceKey}:${intent}`, {
      correctedUrl,
      confidence:  Math.min(1.0, 0.70 + prevHits * 0.05),
      updatedAt:   Date.now(),
      hitCount:    prevHits + 1,
    });
    if (ok) {
      logger.info(`[destination-resolver] Recorded: ${serviceKey}:${intent} → ${correctedUrl} (hits=${prevHits + 1})`);
    } else {
      logger.warn(`[destination-resolver] Failed to record ${serviceKey}:${intent} → ${correctedUrl}`);
    }
    return ok;
  } catch (err) {
    logger.warn(`[destination-resolver] recordCorrection error: ${err.message}`);
    return false;
  }
}

// ── Resume context parser ─────────────────────────────────────────────────────
// When browser.agent re-runs after an ask_user destination question, main.js injects
// "[Resume context: You previously asked "...". The user answered: "...".]" into the task.
// This function extracts the user's answer so we can honor it without prompting again.

const RESUME_RE = /\[Resume context:[^\]]*The user answered:\s*"([^"]+)"/i;

function parseResumeContext(task) {
  const m = RESUME_RE.exec(String(task || ''));
  return m ? m[1].trim() : null;
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the correct navigation destination for a given browser.agent task.
 *
 * @param {string} serviceKey  Lowercase alphanumeric key (e.g. "deepseek")
 * @param {string} task        Natural-language task string from the plan step
 * @param {string} plannedUrl  The URL in the agent descriptor (start_url)
 * @param {string} [agentId]   Full agent ID for log messages
 *
 * @returns {Promise<{
 *   action: 'ok' | 'auto_correct' | 'ask_user',
 *   correctedUrl?: string,
 *   reason?: string,
 *   intent: string,
 *   fromResumeContext?: boolean,
 * }>}
 */
async function resolveDestination(serviceKey, task, plannedUrl, agentId) {
  const _id = agentId || serviceKey;

  // ── Short-circuit: home-type agents never need destination correction ────
  // The resolver's sole purpose is to detect when an agent's start_url is a
  // developer/API console but the task intent is chat/research — and redirect
  // to the correct consumer interface. For any agent whose start_url is a plain
  // home page (perplexity.ai, claude.ai, chatgpt.com, etc.) there is nothing to
  // correct: the landing page is always the right destination regardless of the
  // task phrasing. Skipping here eliminates all false-positive ASK_USER dialogs
  // caused by the intent classifier misreading task text (e.g. "account" → settings).
  const _plannedUrlType = classifyUrlType(plannedUrl);
  if (_plannedUrlType !== INTENTS.CONSOLE && _plannedUrlType !== INTENTS.SETTINGS) {
    logger.debug(`[destination-resolver] Short-circuit: home-type start_url for "${_id}" — skip destination check`);
    return { action: 'ok', intent: INTENTS.HOME, reason: 'Home-type agent — destination check not applicable' };
  }

  // ── Short-circuit: known mail service navigating to its mail host ─────────
  // Gmail/Outlook send tasks always land on their mail host — skip all mismatch
  // logic entirely to prevent false-positive ask_user dialogs.
  const _isMailService = /gmail|outlook|mail/i.test(serviceKey);
  const _isMailHost = URL_TYPE_PATTERNS[0].tests.some(re => re.test(plannedUrl));
  if (_isMailService && _isMailHost) {
    logger.debug(`[destination-resolver] Short-circuit: mail service on mail host → ok`);
    return { action: 'ok', intent: INTENTS.MAIL };
  }

  // ── Short-circuit: tutorial / editor services ─────────────────────────────
  // These services use a profile/hub subdomain as their dashboard but are never
  // developer-console or settings destinations. Destination correction does not
  // apply — always ok regardless of task intent.
  const _isTutorialService = /w3schools/i.test(serviceKey);
  if (_isTutorialService) {
    logger.debug(`[destination-resolver] Short-circuit: tutorial/editor service "${_id}" — skip destination check`);
    return { action: 'ok', intent: INTENTS.HOME, reason: 'Tutorial/editor service — destination check not applicable' };
  }

  // ── Resume context: user already answered a destination question ──────────
  // Honor their choice without prompting again.
  const resumeAnswer = parseResumeContext(task);
  if (resumeAnswer) {
    const wantsChat = /chat[\s_-]?interface|chat[\s_-]?app|research|open.*chat|use.*chat/i.test(resumeAnswer);
    const wantsConsole = /developer[\s_-]?console|api[\s_-]?key|platform|console/i.test(resumeAnswer);
    if (wantsChat && SERVICE_CHAT_URLS[serviceKey]) {
      logger.info(`[destination-resolver] Resume context: user chose chat → ${SERVICE_CHAT_URLS[serviceKey]}`);
      return {
        action:           'auto_correct',
        correctedUrl:     SERVICE_CHAT_URLS[serviceKey],
        reason:           'User chose chat interface in prior interaction',
        intent:           INTENTS.CHAT,
        fromResumeContext: true,
      };
    }
    if (wantsConsole) {
      logger.info(`[destination-resolver] Resume context: user chose developer console → ok`);
      return { action: 'ok', intent: INTENTS.CONSOLE, reason: 'User chose developer console' };
    }
    // No clear direction from resume context — skip destination check to avoid loop
    logger.debug(`[destination-resolver] Resume context present but no clear direction — skipping check`);
    return { action: 'ok', intent: INTENTS.HOME, reason: 'Resume context present' };
  }

  // ── Short-circuit: intra-app / in-session navigation tasks ─────────────────
  // Tasks that navigate *within* an already-open page (history, clicking elements,
  // scrolling, going back) do not need destination validation — the start_url is
  // irrelevant because the session is already established.  Letting the resolver
  // run on these tasks causes false-positive ask_user dialogs (e.g. classifying
  // "navigate to history section" as console intent).
  const _taskForCheck = _scopeTaskText(task, 280).toLowerCase();
  const _isIntraApp = /\b(history|go[\s_-]?back|previous[\s_-]?searches?|navigate[\s_-]?to[\s_-]?section|within|inside|scroll[\s_-]?to|click[\s_-]?on|open[\s_-]?the[\s_-]?(menu|sidebar|panel|tab|section|dropdown))\b/i.test(_taskForCheck);
  if (_isIntraApp) {
    logger.debug(`[destination-resolver] Short-circuit: intra-app navigation task — skipping destination check`);
    return { action: 'ok', intent: INTENTS.HOME, reason: 'Intra-app navigation — skipping destination check' };
  }

  // ── Classify intent and check planned URL ─────────────────────────────────
  const intent      = await classifyTaskIntent(task);
  const plannedType = classifyUrlType(plannedUrl);
  const accepted    = INTENT_ACCEPTED_URL_TYPES[intent]
    || [INTENTS.HOME, INTENTS.CHAT, INTENTS.DOCS, INTENTS.CONSOLE, INTENTS.SETTINGS];

  logger.debug(`[destination-resolver] ${_id}: intent="${intent}" plannedType="${plannedType}" url="${plannedUrl}"`);

  if (accepted.includes(plannedType)) {
    return { action: 'ok', intent };
  }

  // ── Mismatch ──────────────────────────────────────────────────────────────
  logger.info(`[destination-resolver] Mismatch for ${_id}: intent="${intent}" but planned URL is type="${plannedType}" (${plannedUrl})`);

  // 1. Learned correction (highest priority — user or system confirmed it works)
  // Lower confidence threshold for mail services (fewer URL variations than AI research tools)
  const isMailService = /gmail|outlook|mail/i.test(serviceKey);
  const confidenceThreshold = isMailService ? 0.60 : 0.75;
  const learned = await getLearnedCorrection(serviceKey, intent);
  if (learned && learned.confidence >= confidenceThreshold) {
    logger.info(`[destination-resolver] Auto-correct (learned, conf=${learned.confidence.toFixed(2)}): ${_id} → ${learned.correctedUrl}`);
    return {
      action:       'auto_correct',
      correctedUrl: learned.correctedUrl,
      reason:       `Learned correction (${(learned.confidence * 100).toFixed(0)}% confidence, ${learned.hitCount} uses)`,
      intent,
    };
  }

  // 2. Hard-coded per-service chat URL (chat/research/search intents against console URLs)
  if ((intent === INTENTS.CHAT || intent === INTENTS.RESEARCH || intent === INTENTS.SEARCH) && SERVICE_CHAT_URLS[serviceKey]) {
    const correctedUrl = SERVICE_CHAT_URLS[serviceKey];
    logger.info(`[destination-resolver] Auto-correct (hard-coded): ${_id} → ${correctedUrl}`);
    return {
      action:       'auto_correct',
      correctedUrl,
      reason:       `Service defaults to developer console but task intent is "${intent}" — using chat interface`,
      intent,
    };
  }

  // 3. Mail intent with mail-host URL — always ok
  if (intent === INTENTS.MAIL && (isMailService || classifyUrlType(plannedUrl) === INTENTS.MAIL)) {
    logger.info(`[destination-resolver] Auto-correct (mail service): ${_id} → ${plannedUrl}`);
    return {
      action:       'auto_correct',
      correctedUrl: plannedUrl,
      reason:       `Mail services use home URL for send/compose actions`,
      intent,
    };
  }

  // 4. Ambiguous — not enough signal to auto-correct confidently
  const serviceName = _id.replace(/\.agent$/, '');
  const chatUrl     = SERVICE_CHAT_URLS[serviceKey];
  return {
    action:   'ask_user',
    reason:   `Planned URL (${plannedUrl}) does not match task intent "${intent}"`,
    intent,
    question: `I was going to open **${serviceName}**'s ${plannedType} page, but your task looks like a **${intent}** request that usually needs a different endpoint.\n\nWhich should I open?`,
    options: [
      ...(chatUrl ? [`Open ${serviceName} chat interface`] : []),
      `Open ${serviceName} at ${plannedUrl}`,
      'Cancel',
    ],
    chatUrl: chatUrl || null,
  };
}

// ── LLM-suggested task URL ────────────────────────────────────────────────────
// For a given service + task, ask the LLM for the most direct deep-link URL.
// The suggestion is validated by the caller (browser.agent uses verifyDeepLinkUrl).
// This scales to any service without hardcoding URLs.

/**
 * Ask the LLM for the single most direct URL to start accomplishing `task`
 * on service `serviceKey` with base URL `startUrl`. Returns the suggested URL
 * only if the response parses cleanly and stays on the expected host domain.
 */
async function suggestTaskUrl(serviceKey, startUrl, intent, task) {
  if (!_skillLlm) {
    return { ok: false, error: 'skill-llm not available' };
  }

  const cleanStartUrl = String(startUrl || '').trim();
  if (!cleanStartUrl) {
    return { ok: false, error: 'startUrl is required' };
  }

  const baseHost = (() => {
    try { return new URL(cleanStartUrl).hostname.replace(/^www\./, ''); }
    catch (_) { return ''; }
  })();
  if (!baseHost) {
    return { ok: false, error: 'could not parse startUrl hostname' };
  }

  const _taskPreview = _scopeTaskText(task, 200);

  // Detect if this is a search/filter task that needs a search URL
  const _isSearchTask = /\b(search|find|look\s*up|filter|unread|from:|subject:|label:|starred|is:unread|check.*for|show.*from|list.*from)\b/i.test(_taskPreview);

  const _searchHint = _isSearchTask
    ? `\nIMPORTANT: This task requires searching or filtering. If the service supports URL-based search (e.g., #search/query, ?q=query, ?filter=query, /search?q=query), provide the search URL with the query embedded. For email services, use the service's search operators (e.g., is:unread from:sender). If the service does not support URL-based search, return: none`
    : '';

  const prompt = `You are a browser automation assistant. Given:
- service: ${serviceKey}
- base URL: ${cleanStartUrl}
- task intent: ${intent}
- task: ${_taskPreview}${_searchHint}

What is the single most direct URL to open in a browser to begin this task? Also provide 3-5 keywords that characterize this task type.

Format: URL|keyword1,keyword2,keyword3,keyword4,keyword5
If you cannot determine a direct URL, return exactly: none
Do not include any explanation, markdown, or trailing punctuation.`;

  try {
    const raw = await _skillLlm.ask(prompt, { temperature: 0.0, responseTimeoutMs: 6000 });
    const _parts = String(raw || '').trim().split('|');
    let candidate = _parts[0].replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```$/i, '').trim();
    const _suggestKeywords = (_parts[1] || '')
      .split(/[,;]\s*/)
      .map(k => k.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ''))
      .filter(k => k.length > 2)
      .slice(0, 8);

    if (!candidate || candidate.toLowerCase() === 'none') {
      return { ok: false, error: 'LLM returned no URL' };
    }

    // Resolve relative URLs against startUrl
    let resolved;
    try {
      resolved = new URL(candidate, cleanStartUrl).href;
    } catch (_) {
      return { ok: false, error: `LLM returned unparseable URL: ${candidate}` };
    }

    // Security: must stay on the expected service domain or a subdomain
    const resolvedHost = (() => {
      try { return new URL(resolved).hostname.replace(/^www\./, ''); }
      catch (_) { return ''; }
    })();
    if (!resolvedHost || (resolvedHost !== baseHost && !resolvedHost.endsWith('.' + baseHost))) {
      // Don't reject — return with flag so caller can verify via navigation.
      // Shortcut domains (e.g. notion.new → app.notion.com) redirect to the canonical service.
      logger.info(`[destination-resolver] suggestTaskUrl: off-domain candidate for ${serviceKey}:${intent} → ${resolved} (needsVerification)`);
      return { ok: true, url: resolved, needsVerification: true, keywords: _suggestKeywords };
    }

    logger.info(`[destination-resolver] suggestTaskUrl: ${serviceKey}:${intent} → ${resolved}`);
    return { ok: true, url: resolved, keywords: _suggestKeywords };
  } catch (err) {
    logger.warn(`[destination-resolver] suggestTaskUrl failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Keyword-indexed deep-link cache ──────────────────────────────────────────
// Stores multiple URLs per service, indexed by keyword overlap matching.
// Separate namespace from nav-correction (which is for console→chat redirects).

const DEEPLINK_NS = 'nav-deeplink';
const KEYWORD_MATCH_THRESHOLD = 0.5; // raised from 0.4 — 40% overlap was too loose
const MAX_ROUTE_KEYWORDS = 8; // cap per-route keyword accumulation (LRU) — prevents keyword sponge

/**
 * Validate a deep-link URL before caching it.
 * Rejects malformed URLs with duplicated leading labels (docs.docs., mail.mail., www.www.),
 * unparseable URLs, and other obvious corruption.
 */
function _isValidDeepLinkUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  const host = parsed.hostname.replace(/^www\./, '');
  // Reject duplicated leading labels (e.g., docs.docs.google.com, mail.mail.google.com)
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (labels[i] === labels[i + 1] && labels[i].length > 0) {
      logger.warn(`[destination-resolver] rejecting deep-link with duplicated label: ${url} (host=${host})`);
      return false;
    }
  }
  // Reject chrome-extension URLs
  if (/^chrome-extension:/i.test(url)) return false;
  // Reject about:blank and other non-http(s) URLs
  if (!/^https?:/i.test(url)) return false;
  // Reject auth-flow URLs (login, magic-link, oauth, authorize, callback, signup,
  // verify, logout, …). These are identity-flow pages, never valid task deep-links.
  if (isAuthFlowUrl(url)) {
    logger.warn(`[destination-resolver] rejecting auth-flow deep-link URL: ${url}`);
    return false;
  }
  return true;
}

/**
 * Detect generic/landing URLs that should never be cached as deep-links.
 * These are the service's default destinations (inbox, dashboard, home) —
 * caching them adds no value (they're already the startUrl fallback) and
 * pollutes the keyword index because every task that lands there gets its
 * task keywords absorbed onto the generic URL.
 *
 * Returns true if the URL is a generic landing page with no meaningful
 * action-specific path/hash/query.
 */
function _isGenericLandingUrl(url, serviceKey = '') {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, ''); // strip trailing slashes
  const hash = parsed.hash || '';
  const hasQuery = parsed.search.length > 0;

  // ── Service-specific generic patterns ──
  // Gmail: bare inbox / mail root — generic. #search/, #compose, #inbox/<id> are specific.
  if (svc === 'gmail' || host === 'mail.google.com') {
    // /mail/u/0/ or /mail/u/0/#inbox → generic
    if (/^\/mail\/u\/\d+\/?$/.test(path) && (!hash || /^#(inbox|home)?$/i.test(hash)) && !hasQuery) return true;
    return false;
  }
  // Outlook: root or /mail/ → generic
  if (svc === 'outlook' || /outlook\.(live|office)\.com/.test(host)) {
    if ((!path || path === '/mail' || path === '/mail/') && !hash && !hasQuery) return true;
    return false;
  }
  // LinkedIn: bare feed root → generic (feed?shareActive=true etc. are specific)
  if (svc === 'linkedin' || host === 'linkedin.com') {
    if ((!path || path === '/feed' || path === '/feed/') && !hasQuery && (!hash || hash === '#')) return true;
    return false;
  }

  // ── Generic rule: no path (or just "/"), no hash (or #inbox/#home), no query ──
  if (!path && (!hash || /^#(inbox|home)?$/i.test(hash)) && !hasQuery) return true;
  return false;
}

/**
 * Clean up existing cache entries that fail validation or contain generic-landing URLs.
 * Called lazily on first cache access after module load.
 */
let _deepLinkCleanupDone = false;
async function _cleanupDeepLinkCache() {
  if (_deepLinkCleanupDone || !skillDb) return;
  _deepLinkCleanupDone = true;
  try {
    // We can't enumerate all keys in skillDb easily, so this is a no-op for now.
    // Individual entries are cleaned up when they're accessed in getCachedDeepLink
    // (which filters out invalid + generic-landing routes on every read).
    // The validation in recordDeepLinkCache prevents new bad entries from being stored.
  } catch (_) {}
}

/**
 * Retrieve keywords extracted by classifyTaskIntent for a given task.
 * Returns [] if classifyTaskIntent hasn't been called or no keywords were extracted.
 */
function getTaskKeywords(task) {
  const _scopedShort = _scopeTaskText(task, 100);
  const _cached = _intentCache.get(_scopedShort);
  if (_cached && typeof _cached === 'object' && Array.isArray(_cached.keywords)) {
    return _cached.keywords;
  }
  return [];
}

async function _persistDeepLinkCache(serviceKey, entry) {
  if (!skillDb) return false;
  return skillDb.set(DEEPLINK_NS, serviceKey, entry);
}

/**
 * Check the keyword-indexed deep-link cache for a matching URL.
 * Returns { url, source, score } if a match is found, null otherwise.
 */
async function getCachedDeepLink(serviceKey, keywords) {
  if (!skillDb || !keywords || keywords.length === 0) return null;
  // Lazy cleanup on first access
  if (!_deepLinkCleanupDone) setImmediate(() => _cleanupDeepLinkCache().catch(() => {}));
  try {
    const entry = await skillDb.get(DEEPLINK_NS, serviceKey);
    if (!entry || !Array.isArray(entry.routes)) return null;

    // Clean up invalid routes AND generic-landing routes from existing cache entries.
    // Generic-landing URLs (bare inbox/dashboard) are the startUrl fallback — caching
    // them pollutes the keyword index because every task that lands there gets its
    // task keywords absorbed onto the generic URL. Filter them out on read and persist
    // the cleaned entry so the pollution doesn't recur.
    const _validRoutes = entry.routes.filter(r => _isValidDeepLinkUrl(r.url) && !_isGenericLandingUrl(r.url, serviceKey));
    if (_validRoutes.length < entry.routes.length) {
      const _removed = entry.routes.length - _validRoutes.length;
      logger.info(`[destination-resolver] cleaning ${_removed} invalid/generic cached route(s) for ${serviceKey}`);
      entry.routes = _validRoutes;
      setImmediate(() => _persistDeepLinkCache(serviceKey, entry).catch(() => {}));
    }

    let bestMatch = null;
    let bestScore = 0;

    for (const route of _validRoutes) {
      const overlap = route.keywords.filter(k => keywords.includes(k));
      const score = overlap.length / Math.max(route.keywords.length, keywords.length);
      if (score > bestScore && score >= KEYWORD_MATCH_THRESHOLD) {
        bestScore = score;
        bestMatch = route;
      }
    }

    if (bestMatch) {
      bestMatch.hitCount = (bestMatch.hitCount || 0) + 1;
      bestMatch.updatedAt = Date.now();
      setImmediate(() => _persistDeepLinkCache(serviceKey, entry));
      logger.info(`[destination-resolver] Deep-link cache hit: ${serviceKey} → ${bestMatch.url} (score=${bestScore.toFixed(2)})`);
      return { url: bestMatch.url, source: 'keyword-cache', score: bestScore };
    }

    logger.debug(`[destination-resolver] Deep-link cache miss: ${serviceKey} (best score=${bestScore.toFixed(2)})`);
    return null;
  } catch (err) {
    logger.warn(`[destination-resolver] getCachedDeepLink error: ${err.message}`);
    return null;
  }
}

/**
 * Record a discovered deep-link URL with associated keywords for future cache matching.
 * Validates the URL before storing to prevent cache pollution.
 */
async function recordDeepLinkCache(serviceKey, url, keywords, intent) {
  if (!skillDb || !keywords || keywords.length === 0) return false;
  // Validate URL before storing — prevents cache pollution from malformed URLs
  if (!_isValidDeepLinkUrl(url)) {
    logger.warn(`[destination-resolver] recordDeepLinkCache: rejecting invalid URL for ${serviceKey}: ${url}`);
    return false;
  }
  // Layer 1: Don't cache generic/landing URLs (bare inbox, dashboard, home).
  // These are the service's startUrl fallback — caching them adds no value and
  // pollutes the keyword index because every task that lands there gets its
  // task keywords absorbed onto the generic URL.
  if (_isGenericLandingUrl(url, serviceKey)) {
    logger.info(`[destination-resolver] recordDeepLinkCache: skipping generic-landing URL for ${serviceKey}: ${url}`);
    return false;
  }
  try {
    let entry = await skillDb.get(DEEPLINK_NS, serviceKey);
    if (!entry || !Array.isArray(entry.routes)) {
      entry = { routes: [] };
    }

    const existing = entry.routes.find(r => r.url === url);
    if (existing) {
      // Layer 3: Cap keyword accumulation per route at MAX_ROUTE_KEYWORDS (8) with LRU.
      // Without this, a URL hit N times absorbs N tasks' worth of keywords, making the
      // keyword overlap score meaningless (matches on coincidental task vocabulary).
      // New keywords first (most recently used), then existing, sliced to the cap.
      const _merged = [...new Set([...keywords, ...existing.keywords])].slice(0, MAX_ROUTE_KEYWORDS);
      existing.keywords = _merged;
      existing.hitCount = (existing.hitCount || 0) + 1;
      existing.updatedAt = Date.now();
    } else {
      entry.routes.push({
        url,
        keywords: keywords.slice(0, MAX_ROUTE_KEYWORDS),
        intent,
        hitCount: 1,
        confidence: 0.70,
        updatedAt: Date.now(),
      });
    }

    return await _persistDeepLinkCache(serviceKey, entry);
  } catch (err) {
    logger.warn(`[destination-resolver] recordDeepLinkCache error: ${err.message}`);
    return false;
  }
}

// ── Search URL pattern cache ─────────────────────────────────────────────────
// Separate from the keyword-indexed deep-link cache. This caches the *search URL
// pattern* per service (e.g., "https://example.com/search?q={query}"), keyed by
// serviceKey — NOT by task keywords. This avoids the keyword-sponge problem and
// lets any future criteria task on the same service reuse the discovered pattern
// without re-running the full discovery pipeline.
//
// The pattern is discovered by the form-extraction / web.agent / web.crawl steps
// in _resolveTaskDeepLink, then cached here for future use.

const SEARCH_PATTERN_NS = 'search-pattern';
const SEARCH_PATTERN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days — search URL patterns rarely change

/**
 * Retrieve the best (highest hitCount, non-expired) search URL pattern for a service.
 * Returns { urlTemplate, inputName, source, hitCount, updatedAt } or null.
 */
async function getSearchUrlPattern(serviceKey) {
  if (!skillDb || !serviceKey) return null;
  try {
    const entry = await skillDb.get(SEARCH_PATTERN_NS, serviceKey);
    if (!entry || !Array.isArray(entry.patterns)) return null;
    const _now = Date.now();
    const _valid = entry.patterns.filter(p => _now - (p.updatedAt || 0) < SEARCH_PATTERN_TTL);
    if (_valid.length === 0) return null;
    // Sort by hitCount descending — most-used pattern first
    _valid.sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0));
    return _valid[0];
  } catch (err) {
    logger.warn(`[destination-resolver] getSearchUrlPattern error: ${err.message}`);
    return null;
  }
}

/**
 * Record a discovered search URL pattern for a service.
 * The urlTemplate should contain a {query} placeholder where the task's search
 * criteria will be substituted (e.g., "https://example.com/search?q={query}").
 */
async function recordSearchUrlPattern(serviceKey, urlTemplate, inputName, source) {
  if (!skillDb || !serviceKey || !urlTemplate) return false;
  if (!urlTemplate.includes('{query}')) {
    logger.warn(`[destination-resolver] recordSearchUrlPattern: urlTemplate missing {query} placeholder: ${urlTemplate}`);
    return false;
  }
  try {
    let entry = await skillDb.get(SEARCH_PATTERN_NS, serviceKey);
    if (!entry || !Array.isArray(entry.patterns)) entry = { patterns: [] };
    const existing = entry.patterns.find(p => p.urlTemplate === urlTemplate);
    if (existing) {
      existing.hitCount = (existing.hitCount || 0) + 1;
      existing.updatedAt = Date.now();
    } else {
      entry.patterns.push({
        urlTemplate,
        inputName: inputName || null,
        source: source || 'discovery',
        hitCount: 1,
        updatedAt: Date.now(),
      });
    }
    return await skillDb.set(SEARCH_PATTERN_NS, serviceKey, entry);
  } catch (err) {
    logger.warn(`[destination-resolver] recordSearchUrlPattern error: ${err.message}`);
    return false;
  }
}

module.exports = {
  classifyTaskIntent,
  classifyUrlType,
  resolveDestination,
  recordCorrection,
  getLearnedCorrection,
  deleteLearnedCorrection,
  suggestTaskUrl,
  getTaskKeywords,
  getCachedDeepLink,
  recordDeepLinkCache,
  getSearchUrlPattern,
  recordSearchUrlPattern,
  INTENTS,
  SERVICE_CHAT_URLS,
  isAuthFlowUrl,
  AUTH_FLOW_PATH_RE,
};
