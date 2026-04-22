/**
 * destination-resolver.cjs — Pre-navigation destination intent verification
 *
 * Classifies the task's intent, scores the planned startUrl against that intent,
 * and returns a verdict: ok / auto_correct / ask_user.
 *
 * Flow:
 *   1. classifyTaskIntent(task) → intent string (chat | research | docs | console | settings | home)
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

// ── Intent constants ──────────────────────────────────────────────────────────
const INTENTS = {
  CHAT:     'chat',       // converse with or query an AI assistant
  RESEARCH: 'research',   // look up / search / investigate a topic via AI
  DOCS:     'docs',       // read documentation, guides, tutorials
  CONSOLE:  'console',    // API keys, developer settings, platform console
  SETTINGS: 'settings',   // account settings, profile, billing  MAIL:     'mail',       // send, compose, forward, reply to email  HOME:     'home',       // generic visit — open the site's landing page
};

// ── Task keywords → intent (first match wins) ─────────────────────────────────
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
  // SETTINGS
  {
    intent: INTENTS.SETTINGS,
    re: /\b(settings|account[\s_-]?settings|billing|subscription|profile[\s_-]?settings|preferences)\b/i,
  },
  // CHAT — explicit chat/conversation verbs
  {
    intent: INTENTS.CHAT,
    re: /\b(ask[\s_-]?it|chat|converse|have[\s_-]?a[\s_-]?conversation|talk[\s_-]?to|message[\s_-]?the[\s_-]?ai|tell[\s_-]?it|prompt[\s_-]?it)\b/i,
  },
  // RESEARCH — broad: look up, find, research, learn, "what is", "who is"
  {
    intent: INTENTS.RESEARCH,
    re: /\b(look[\s_-]?up|search|find[\s_-]?out|research|investigate|look[\s_-]?into|what[\s_-]?is|who[\s_-]?is|tell[\s_-]?me[\s_-]?about|learn[\s_-]?about|information[\s_-]?about|info[\s_-]?on|details[\s_-]?on|explore|find[\s_-]?information|gather[\s_-]?info)\b/i,
  },
  // MAIL — email actions: send, compose, forward, reply
  {
    intent: INTENTS.MAIL,
    re: /\b(send[\s_-]?email|compose[\s_-]?email|forward[\s_-]?email|reply[\s_-]?to|email[\s_-]?to|mail[\s_-]?to|write[\s_-]?email|draft[\s_-]?email|send[\s_-]?mail|compose[\s_-]?mail)\b/i,
  },
  // HOME — generic navigation
  {
    intent: INTENTS.HOME,
    re: /\b(go[\s_-]?to|open|navigate[\s_-]?to|visit)\b/i,
  },
];

/**
 * Classify the task string to a primary intent.
 * Returns one of the INTENTS values, or INTENTS.HOME as fallback.
 */
function classifyTaskIntent(task) {
  const text = String(task || '').toLowerCase();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(text)) return intent;
  }
  return INTENTS.HOME;
}

// ── URL endpoint type classifier ──────────────────────────────────────────────
// Given a URL, return the type of endpoint it most likely represents.

const URL_TYPE_PATTERNS = [
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
      /\/settings(?!\/api)/i,
      /\/account(?!\/api)/i,
      /\/profile(?!\/api)/i,
      /\/billing/i,
      /\/preferences/i,
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
  [INTENTS.CHAT]:     [INTENTS.CHAT, INTENTS.HOME],
  [INTENTS.RESEARCH]: [INTENTS.CHAT, INTENTS.HOME],
  [INTENTS.DOCS]:     [INTENTS.DOCS, INTENTS.HOME],
  [INTENTS.CONSOLE]:  [INTENTS.CONSOLE],
  [INTENTS.SETTINGS]: [INTENTS.SETTINGS, INTENTS.CONSOLE],
  [INTENTS.MAIL]:     ['mail', INTENTS.HOME],
  [INTENTS.HOME]:     [INTENTS.HOME, INTENTS.CHAT, INTENTS.DOCS, INTENTS.CONSOLE, INTENTS.SETTINGS],
};

// ── Per-service fallback chat/home URLs ───────────────────────────────────────
// Used when the resolved startUrl is a developer console but the task intent is
// chat or research. These are hard-coded as secondary fallbacks; learned corrections
// are checked first.

const SERVICE_CHAT_URLS = {
  deepseek:   'https://chat.deepseek.com/',
  perplexity: 'https://www.perplexity.ai/',
  mistral:    'https://chat.mistral.ai/',
  qwen:       'https://chat.qwenlm.ai/',
  anthropic:  'https://claude.ai/new',
  openai:     'https://chatgpt.com/',
  cohere:     'https://coral.cohere.com/',
  groq:       'https://groq.com/',
  huggingface:'https://huggingface.co/chat/',
  together:   'https://api.together.ai/playground',
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
 * Persist a successful destination correction.
 * Confidence grows with repeated hits (capped at 1.0).
 */
async function recordCorrection(serviceKey, intent, correctedUrl) {
  if (!skillDb) return;
  try {
    const existing = await skillDb.get(CORRECTION_NS, `${serviceKey}:${intent}`);
    const prevHits  = existing?.hitCount || 0;
    await skillDb.set(CORRECTION_NS, `${serviceKey}:${intent}`, {
      correctedUrl,
      confidence:  Math.min(1.0, 0.70 + prevHits * 0.05),
      updatedAt:   Date.now(),
      hitCount:    prevHits + 1,
    });
    logger.info(`[destination-resolver] Recorded: ${serviceKey}:${intent} → ${correctedUrl} (hits=${prevHits + 1})`);
  } catch (err) {
    logger.warn(`[destination-resolver] recordCorrection error: ${err.message}`);
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

  // ── Classify intent and check planned URL ─────────────────────────────────
  const intent      = classifyTaskIntent(task);
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

  // 2. Hard-coded per-service chat URL (chat/research intents against console URLs)
  if ((intent === INTENTS.CHAT || intent === INTENTS.RESEARCH) && SERVICE_CHAT_URLS[serviceKey]) {
    const correctedUrl = SERVICE_CHAT_URLS[serviceKey];
    logger.info(`[destination-resolver] Auto-correct (hard-coded): ${_id} → ${correctedUrl}`);
    return {
      action:       'auto_correct',
      correctedUrl,
      reason:       `Service defaults to developer console but task intent is "${intent}" — using chat interface`,
      intent,
    };
  }

  // 3. Mail intent for gmail/outlook — auto-use planned URL (mail.google.com is correct for send)
  if (intent === INTENTS.MAIL && isMailService) {
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

module.exports = {
  classifyTaskIntent,
  classifyUrlType,
  resolveDestination,
  recordCorrection,
  getLearnedCorrection,
  INTENTS,
};
