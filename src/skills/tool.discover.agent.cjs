'use strict';

/**
 * skill: tool.discover.agent
 *
 * Discovers external AI tools that can accomplish tasks the browser.agent
 * or cli.agent cannot do well. Prioritizes tools by friction-to-usage:
 *   Tier 1: Free, no account/auth  → instant use
 *   Tier 2: Free, account/API key  → delayed use (prompt user)
 *   Tier 3: Paid                   → ASK_USER before proceeding
 *
 * Actions:
 *   discover { task }              → web search for AI tools, classify by tier, return bestTool
 *   assess   { task, agentId? }    → self-assessment: can browser.agent do this well?
 *   recall   { task, agentId? }    → check cached discovered tools from semantic memory
 */

const http   = require('http');
const logger = require('../logger.cjs');
const { ask } = require('../skill-helpers/skill-llm.cjs');
const db     = require('../skill-helpers/skill-db.cjs');

const WEB_SEARCH_API_URL = process.env.MCP_WEB_SEARCH_API_URL;
const WEB_SEARCH_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY;

const SKILL_NAMESPACE = 'tool.discover';

// ── Known weak categories for browser.agent ──────────────────────────────────
// These are task types that browser.agent (Playwright-based) cannot do well
// and should trigger tool discovery.
const WEAK_CATEGORY_PATTERNS = [
  /\bgenerat(e|ion|ing)\b.*\b(image|comic|art|picture|illustration|photo|drawing|painting|logo|avatar|sprite|texture|3d|render)\b/i,
  /\b(image|comic|art|picture|illustration|drawing|painting|logo|avatar|sprite|texture|3d|render)\b.*\bgenerat(e|ion|ing)\b/i,
  /\b(generate|create|make|build)\b.*\b(video|animation|gif|motion|film|movie|clip)\b/i,
  /\b(transcribe|transcription|speech.to.text|convert.*audio.*text)\b/i,
  /\b(text.to.speech|tts|narrate|voice.over|read.*aloud|audio.*narration)\b/i,
  /\b(code.*execution|run.*code|execute.*script|sandbox.*code|repl)\b/i,
  /\b(data.*analysis|analyze.*dataset|statistical.*analysis|machine.*learning.*model)\b/i,
  /\b(train|fine.tune|embed|vectorize)\b.*\b(model|embedding|classifier)\b/i,
  /\b(large.*document|summarize.*pdf|extract.*pdf|parse.*document)\b.*\b(>?\d+\s*(mb|pages?))\b/i,
  /\b(translate|translation)\b.*\b(document|file|pdf)\b/i,
  /\b(music|audio|song|melody|beat|track)\b.*\b(generate|create|compose|make)\b/i,
  /\b(deepfake|face.swap|voice.clone|ai.*edit.*video)\b/i,
];

// ── Explicit user keywords requesting external tool discovery ─────────────────
const EXPLICIT_TOOL_KEYWORDS = [
  /\bfind.*(ai|online|web).*(tool|app|service|site)\b/i,
  /\buse.*(ai|online|web).*(tool|app|service|site)\b/i,
  /\bis there.*(ai|online|web).*(tool|app|service|site)\b/i,
  /\bsearch.*(ai|online|web).*(tool|app|service|site)\b/i,
  /\blook.*(up|for).*(ai|online|web).*(tool|app|service|site)\b/i,
  /\b(?:best|free|top).*(?:ai|online|web).*(?:tool|app|service|site)\b/i,
];

// ── Tier classification keywords ─────────────────────────────────────────────
const TIER2_KEYWORDS = ['sign up', 'create account', 'login', 'log in', 'register', 'sign in', 'account required'];
const TIER3_KEYWORDS = ['pricing', 'subscription', 'credits', 'per month', 'paid', 'premium', 'pro plan', 'starter plan', 'enterprise'];

// ── Web search helper (mirrors web.agent.cjs pattern) ────────────────────────

async function _searchWeb(query, maxResults = 8) {
  if (!WEB_SEARCH_API_URL) {
    logger.warn('[tool.discover] Web search not configured - MCP_WEB_SEARCH_API_URL missing');
    return { ok: false, skipped: true, error: 'Web search not configured' };
  }

  let wsHostname, wsPort;
  try {
    const _u = new URL(WEB_SEARCH_API_URL);
    wsHostname = _u.hostname;
    wsPort = parseInt(_u.port) || 3002;
  } catch (_) {
    return { ok: false, error: 'Web search URL is invalid' };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'web-search',
      requestId: `td_${Date.now()}`,
      action: 'search',
      payload: { query, maxResults },
    });
    const req = http.request({
      hostname: wsHostname,
      port: wsPort,
      path: '/web.search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${WEB_SEARCH_API_KEY || ''}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.data?.results || parsed?.results || [];
          resolve({ ok: true, results });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'web search timed out' }); });
    req.write(body);
    req.end();
  });
}

// ── Tier classification ──────────────────────────────────────────────────────

function _classifyTier(text) {
  const lower = (text || '').toLowerCase();
  for (const kw of TIER3_KEYWORDS) {
    if (lower.includes(kw)) return 'paid';
  }
  for (const kw of TIER2_KEYWORDS) {
    if (lower.includes(kw)) return 'free_account';
  }
  return 'free_no_account';
}

function _classifyTierCli(text) {
  const lower = (text || '').toLowerCase();
  for (const kw of TIER3_KEYWORDS) {
    if (lower.includes(kw)) return 'paid';
  }
  // CLI-specific tier 2: needs API key/token
  if (/\b(api.?key|token|secret|auth.*key|access.?key)\b/i.test(lower)) return 'free_api_key';
  return 'free_no_auth';
}

function _deriveServiceName(url, name) {
  // Prefer the URL hostname so derived agent IDs stay tied to real domains
  // (e.g., mailmeteor.com -> mailmeteor.agent) instead of garbled tool names.
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const base = host.split('.')[0];
    const derived = base.replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (derived) return derived;
  } catch (_) {}
  if (name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  }
  return 'discovered';
}

function _deriveToolType(url) {
  try {
    const host = new URL(url).hostname;
    // CLI tools typically have github.com, npm, or pip URLs
    if (/github\.com|npmjs\.com|pypi\.org|crates\.io/.test(host)) return 'cli';
    return 'browser';
  } catch (_) {
    return 'browser';
  }
}

function _isValidToolUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return false;
    if (parsed.hostname === 'localhost' || parsed.hostname.includes('localhost')) return false;
    if (!parsed.hostname.includes('.')) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// ── Action: assess ───────────────────────────────────────────────────────────

async function actionAssess({ task, agentId }) {
  if (!task) return { ok: false, error: 'task is required' };

  logger.info(`[tool.discover] assess: "${task.slice(0, 80)}"`);

  // Step 1: Check explicit user keywords
  for (const re of EXPLICIT_TOOL_KEYWORDS) {
    if (re.test(task)) {
      return {
        ok: true,
        canDoWell: false,
        reason: 'User explicitly requested finding an external AI tool',
        shouldDelegate: true,
        suggestedToolType: 'browser',
      };
    }
  }

  // Step 2: Check known weak categories
  for (const re of WEAK_CATEGORY_PATTERNS) {
    if (re.test(task)) {
      return {
        ok: true,
        canDoWell: false,
        reason: `Task matches known weak category for browser.agent`,
        shouldDelegate: true,
        suggestedToolType: 'browser',
      };
    }
  }

  // Step 3: LLM assessment (if no keyword match)
  try {
    const prompt = `You are evaluating whether a browser automation agent (Playwright-based, can navigate websites, click, type, read content) can accomplish this task well: "${task}"

Respond in JSON format only:
{"canDoWell": true/false, "reason": "brief explanation", "shouldDelegate": true/false, "suggestedToolType": "browser" or "cli"}

Guidelines:
- "canDoWell": true if the browser agent can navigate to a website and accomplish the task through UI interaction
- "shouldDelegate": true if the task requires capabilities beyond browser automation (e.g., generating images, video processing, code execution, large data analysis)
- "suggestedToolType": "browser" for web-based AI tools, "cli" for command-line tools
- If the task is something a human could do by navigating a website, canDoWell=true
- If the task requires AI generation (images, video, music) or heavy computation, canDoWell=false`;

    const response = await ask(prompt, { temperature: 0.1, responseTimeoutMs: 10000 });
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        ok: true,
        canDoWell: !!parsed.canDoWell,
        reason: parsed.reason || 'LLM assessment',
        shouldDelegate: !!parsed.shouldDelegate,
        suggestedToolType: parsed.suggestedToolType || 'browser',
      };
    }
  } catch (e) {
    logger.warn(`[tool.discover] assess LLM error: ${e.message}`);
  }

  // Default: browser.agent can probably handle it
  return {
    ok: true,
    canDoWell: true,
    reason: 'No weak category match and LLM assessment unavailable',
    shouldDelegate: false,
    suggestedToolType: 'browser',
  };
}

// ── Action: recall ───────────────────────────────────────────────────────────

async function actionRecall({ task, agentId }) {
  if (!task) return { ok: false, error: 'task is required' };

  logger.info(`[tool.discover] recall: "${task.slice(0, 80)}"`);

  try {
    const memories = await db.recall(SKILL_NAMESPACE, task, 3);
    if (!memories || memories.length === 0) {
      return { ok: true, tool: null };
    }

    // Find the best matching cached tool
    for (const mem of memories) {
      try {
        const text = mem.text || mem.value || mem.content || '';
        // Parse cached tool info from memory text
        const toolMatch = text.match(/TOOL_URL:\s*(\S+)/);
        if (!toolMatch) continue;

        const url = toolMatch[1];
        const nameMatch = text.match(/TOOL_NAME:\s*(.+)/);
        const typeMatch = text.match(/TOOL_TYPE:\s*(\w+)/);
        const tierMatch = text.match(/TOOL_TIER:\s*(\w+)/);
        const usageMatch = text.match(/INSTRUCTION:\s*(.+)/);

        const name = nameMatch ? nameMatch[1].trim() : _deriveServiceName(url, null);
        const type = typeMatch ? typeMatch[1].trim() : 'browser';
        const tier = tierMatch ? tierMatch[1].trim() : 'free_no_account';
        const howToUse = usageMatch ? usageMatch[1].trim() : '';

        logger.info(`[tool.discover] recall: found cached tool ${name} (${tier})`);
        return {
          ok: true,
          tool: {
            name,
            url,
            type,
            tier,
            howToUse,
            serviceName: _deriveServiceName(url, name),
            cached: true,
          },
        };
      } catch (_) { continue; }
    }
  } catch (e) {
    logger.warn(`[tool.discover] recall error: ${e.message}`);
  }

  return { ok: true, tool: null };
}

// ── Action: discover ─────────────────────────────────────────────────────────

async function actionDiscover({ task }) {
  if (!task) return { ok: false, error: 'task is required' };

  logger.info(`[tool.discover] discover: "${task.slice(0, 80)}"`);

  // Step 1: Web search with free-biased queries
  const queries = [
    `free AI tool to ${task} no signup`,
    `best free AI tool for ${task} 2025`,
    `online AI tool ${task} free no account`,
  ];

  let allResults = [];
  for (const q of queries) {
    const searchRes = await _searchWeb(q, 5);
    if (searchRes.ok && searchRes.results) {
      allResults.push(...searchRes.results);
    }
    if (allResults.length >= 10) break;
  }

  if (allResults.length === 0) {
    logger.warn('[tool.discover] No web search results found');
    return { ok: false, error: 'No AI tools found via web search' };
  }

  // Step 2: Deduplicate by URL
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Step 3: Score and classify results
  const scored = unique.map(r => {
    const text = `${r.title || ''} ${r.snippet || ''}`;
    const type = _deriveToolType(r.url);
    const tier = type === 'cli' ? _classifyTierCli(text) : _classifyTier(text);

    // Relevance scoring
    let score = 50;
    const taskLower = task.toLowerCase();
    const textLower = text.toLowerCase();

    // Boost for task keyword matches
    const taskWords = taskLower.split(/\s+/).filter(w => w.length > 3);
    for (const w of taskWords) {
      if (textLower.includes(w)) score += 5;
    }

    // Boost for "free" in title/snippet
    if (/\bfree\b/i.test(text)) score += 15;
    if (/\bno.*(signup|account|register|login)\b/i.test(text)) score += 10;

    // Tier penalty (lower tier = higher priority)
    if (tier === 'free_no_account' || tier === 'free_no_auth') score += 30;
    else if (tier === 'free_account' || tier === 'free_api_key') score += 10;
    else if (tier === 'paid') score -= 20;

    // Penalize non-tool results (news, blog posts about AI in general)
    if (/\b(news|blog|opinion|review|comparison|best.*of|top.*\d+)\b/i.test(text)) score -= 15;

    return { ...r, _score: score, _tier: tier, _type: type };
  }).sort((a, b) => b._score - a._score);

  // Step 4: Take top 5 for LLM evaluation
  const topCandidates = scored.slice(0, 5);

  // Step 5: LLM evaluation to pick best tool and extract usage hints
  let bestTool = null;
  let allTools = [];

  try {
    const candidateText = topCandidates.map((r, i) => 
      `${i + 1}. Title: ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}\n   Pre-classified tier: ${r._tier} (${r._type})`
    ).join('\n\n');

    const prompt = `You are evaluating AI tools for this task: "${task}"

Here are ${topCandidates.length} candidate tools from web search:

${candidateText}

Evaluate each tool and pick the BEST one for the task. Respond in JSON format only:
{
  "tools": [
    {"name": "Tool Name", "url": "https://...", "type": "browser" or "cli", "tier": "free_no_account" or "free_account" or "free_no_auth" or "free_api_key" or "paid", "description": "brief", "howToUse": "brief instructions on how to use this tool for the task"}
  ],
  "bestToolIndex": 0
}

Tier classification rules:
- "free_no_account": Free, no signup, public web app — instant use
- "free_account": Free but requires account/login — delayed use
- "free_no_auth": Free CLI, no token/key needed — instant use
- "free_api_key": Free but needs API key/token — delayed use
- "paid": Paid service, subscription, credits — requires user approval

Pick the tool with the LOWEST friction (free + no account/auth is best).
If ALL tools are paid, set bestToolIndex to -1 and include all options with pricing info.`;

    const response = await ask(prompt, { temperature: 0.1, responseTimeoutMs: 15000 });
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      allTools = (parsed.tools || [])
        .filter(t => _isValidToolUrl(t.url))
        .map((t, i) => ({
          ...t,
          serviceName: _deriveServiceName(t.url, t.name),
          iconUrl: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(_safeHostname(t.url))}&sz=128`,
        }));

      if (parsed.bestToolIndex >= 0 && parsed.bestToolIndex < allTools.length) {
        bestTool = allTools[parsed.bestToolIndex];
      }
    }
  } catch (e) {
    logger.warn(`[tool.discover] discover LLM error: ${e.message}`);
  }

  // Step 6: Fallback — use top scored result if LLM failed
  if (!bestTool && topCandidates.length > 0) {
    const top = topCandidates.find(t => _isValidToolUrl(t.url)) || topCandidates[0];
    if (_isValidToolUrl(top.url)) {
      bestTool = {
        name: top.title?.slice(0, 60) || 'Discovered Tool',
        url: top.url,
        type: top._type,
        tier: top._tier,
        description: top.snippet?.slice(0, 200) || '',
        howToUse: 'Navigate to the tool and interact with it for the task.',
        serviceName: _deriveServiceName(top.url, null),
        iconUrl: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(_safeHostname(top.url))}&sz=128`,
      };
      allTools = [bestTool];
    } else {
      logger.warn(`[tool.discover] Fallback top result has invalid URL: ${top.url}`);
    }
  }

  if (!bestTool) {
    return { ok: false, error: 'No suitable AI tool found' };
  }

  // Step 7: Check if only paid tools found
  const allPaid = allTools.length > 0 && allTools.every(t => t.tier === 'paid');
  if (allPaid) {
    logger.info('[tool.discover] Only paid tools found — returning askUser');
    return {
      ok: true,
      askUser: true,
      tools: allTools,
      bestTool: null,
      message: 'Only paid AI tools found — user approval needed',
    };
  }

  // Step 8: Cache the discovered tool in semantic memory
  try {
    const memText = `TOOL_NAME: ${bestTool.name}\nTOOL_URL: ${bestTool.url}\nTOOL_TYPE: ${bestTool.type}\nTOOL_TIER: ${bestTool.tier}\nINSTRUCTION: ${bestTool.howToUse || 'Navigate to this tool and use it for the task.'}\nTASK: ${task}`;
    await db.remember(SKILL_NAMESPACE, memText, { task, url: bestTool.url, tier: bestTool.tier });
    logger.info(`[tool.discover] Cached tool ${bestTool.name} in semantic memory`);
  } catch (e) {
    logger.warn(`[tool.discover] Cache write error: ${e.message}`);
  }

  logger.info(`[tool.discover] Best tool: ${bestTool.name} (${bestTool.tier}) at ${bestTool.url}`);

  return {
    ok: true,
    tools: allTools,
    bestTool,
  };
}

// ── Helper ───────────────────────────────────────────────────────────────────

function _safeHostname(url) {
  try { return new URL(url).hostname; } catch (_) { return 'example.com'; }
}

// ── Main export ──────────────────────────────────────────────────────────────

module.exports = async function toolDiscoverAgent(args) {
  const { action, ...params } = args || {};

  switch (action) {
    case 'discover':
      return await actionDiscover(params);
    case 'assess':
      return await actionAssess(params);
    case 'recall':
      return await actionRecall(params);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
};

module.exports.actionAssess   = actionAssess;
module.exports.actionDiscover = actionDiscover;
module.exports.actionRecall   = actionRecall;
