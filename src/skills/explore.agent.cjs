'use strict';
// ---------------------------------------------------------------------------
// explore.agent.cjs — Unified navigate + explore loop agent
//
// Accepts a goal + seed URL and autonomously:
//   Phase 0   : Navigate to the URL (fast-path auth hint via KNOWN_BROWSER_SERVICES)
//   Phase 0.5 : Detect + resolve login walls (waitForAuth → full Phase 0 restart)
//   Phase 1   : Validate (and optionally evict) learned context_rules
//   Phase 2   : Immediate goal-check on the landing page
//   Phase 3   : Explore loop — score nav items, LLM picks click/search/goal_met/none
//               Fast-path: if domain map has verified selectors, use_cached skips LLM scoring
//
// Mode A (execute) — goal-driven, uses cached domain map selectors when available
// Mode B (scan)    — no goal, background probing, builds domain map for a site
//
// Scan triggers:
//   1. Post-automation (lazy, fired by browser.agent after successful run)
//   2. Maintenance Scan — idle-triggered (30min idle + 24h cooldown) or user/scheduled
//   3. Self-heal on failure (_resolveLocator all-fallbacks-fail)
//
// Domain maps stored at: ~/.thinkdrop/domain-maps/<hostname>.json
// Called from browser.agent.cjs `actionExplore()`.
// ---------------------------------------------------------------------------

const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const skillDb = require('../skill-helpers/skill-db.cjs');

const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const logger             = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BROWSER_ACT_PORT      = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
const SCREEN_SERVICE_PORT   = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const DOMAIN_MAPS_DIR       = path.join(os.homedir(), '.thinkdrop', 'domain-maps');
const AGENTS_DIR            = path.join(os.homedir(), '.thinkdrop', 'agents');

// Absolute path to browser.act.cjs — baked into generated skill code so skills
// can require() it regardless of where they are stored on disk (e.g. ~/.thinkdrop/skills/).
const BROWSER_ACT_PATH      = path.join(__dirname, 'browser.act.cjs');

const MAP_STALE_MS          = 7 * 24 * 60 * 60 * 1000;  // 7 days
const MAP_LAZY_RESCAN_MS    = 24 * 60 * 60 * 1000;       // 24 hours (post-automation gate)
const OVERLAY_PORT          = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);

// Known browser services map — isOAuth=true means skip dynamic login detection and
// go straight to waitForAuth. Shared reference with browser.agent.cjs.
const KNOWN_BROWSER_SERVICES = (() => {
  try { return require('./browser.agent.cjs').KNOWN_BROWSER_SERVICES || {}; }
  catch (_) { return {}; }
})();

// ---------------------------------------------------------------------------
// Configurable Filter Configuration — Site-agnostic rules with per-site overrides
// Stored in domain map or agent descriptor, not hardcoded
// ---------------------------------------------------------------------------
const DEFAULT_FILTER_CONFIG = {
  // URL patterns that indicate historical content (regex strings)
  historicalUrlPatterns: [
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', // UUIDs
    '/c/[a-zA-Z0-9-]+',        // Chat threads (ChatGPT)
    '/chat/',                  // Chat paths
    '/search/[a-z0-9-]+',      // Search results
    '/thread/',                // Forum threads
    '/message/',               // Messages
    '#inbox/',                 // Email
  ],
  
  // Text patterns that indicate user queries
  queryTextPatterns: [
    '^(what|how|why|when|where|who|can|is|are|do|does)\\s',
    '^(find|get|show|tell|explain)\\s',
  ],
  
  // Container indicators for history lists
  historyContainerIndicators: [
    'history',
    'recent',
    'past',
    'previous',
    'chat',
    'conversation',
    'thread',
    'archive'
  ],
  
  // Always-keep patterns (primary controls) - must match FULL words/phrases
  primaryControlPatterns: [
    '^(new|create|add|compose|start)$',           // Exact match only
    '^(search|ask)$',                              // Exact match only (NOT "find" - that's too broad)
    '^(send|submit|save)$',                        // Exact match only
    '^(settings|profile|menu|help)$',            // Exact match only
    '\\bnew\\s+(chat|conversation|message)',     // "New chat", "New conversation"
    '\\bsearch\\b',                              // Word boundary for "search"
    '^\\$',                                      // Dollar amount (pricing/billing)
    '^upgrade', '^plan',                          // Pricing/plan controls
  ],
  
  // Scoring thresholds
  minHistoryScore: 3,
  minPrimaryControlScore: 1
};

// ---------------------------------------------------------------------------
// Interaction Type Schemas — Complete metadata for all 10+ interaction types
// ---------------------------------------------------------------------------
const INTERACTION_SCHEMAS = {
  click: {
    params: [],
    description: "Click element",
    paramTypes: {},
    successCriteria: { expected_url_change: true }
  },
  dblclick: {
    params: [],
    description: "Double-click element (for file managers, grids)",
    paramTypes: {},
    successCriteria: { expected_url_change: true }
  },
  fill: {
    params: ['text'],
    description: "Fill input field with text",
    paramTypes: { text: { type: 'string', required: true } },
    followUp: ['press Enter for search inputs'],
    successCriteria: { expected_url_change: false }
  },
  type: {
    params: ['text'],
    description: "Type into contenteditable rich text editor",
    paramTypes: { text: { type: 'string', required: true } },
    followUp: ['press Enter for search inputs'],
    successCriteria: { expected_url_change: false }
  },
  select: {
    params: ['value'],
    description: "Select option from dropdown",
    paramTypes: { value: { type: 'string', required: true, options: 'array' } },
    successCriteria: { expected_url_change: false }
  },
  check: {
    params: [],
    description: "Check checkbox",
    paramTypes: {},
    successCriteria: { expected_url_change: false }
  },
  uncheck: {
    params: [],
    description: "Uncheck checkbox",
    paramTypes: {},
    successCriteria: { expected_url_change: false }
  },
  scroll: {
    params: ['direction', 'distance'],
    description: "Scroll container or page",
    paramTypes: {
      direction: { type: 'string', required: true, options: ['up', 'down', 'left', 'right'] },
      distance: { type: 'number', required: true, default: 500 }
    },
    defaults: { direction: 'down', distance: 500 },
    successCriteria: { expected_url_change: false }
  },
  drag: {
    params: ['targetSelector'],
    description: "Drag element to target",
    paramTypes: { targetSelector: { type: 'string', required: true } },
    successCriteria: { expected_url_change: false }
  },
  hover: {
    params: [],
    description: "Hover to reveal dropdown/menu",
    paramTypes: {},
    reveals: 'dropdown',
    successCriteria: { expected_url_change: false }
  },
  upload: {
    params: ['files'],
    description: "Upload file(s)",
    paramTypes: { files: { type: 'array', items: 'string', required: true } },
    successCriteria: { expected_url_change: false }
  }
};

// Per-site overrides loaded from agent descriptors or domain maps
function _getFilterConfigForSite(hostname, domainMap = null) {
  // Check if domain map has custom filter config
  if (domainMap?._filterConfig) {
    return { ...DEFAULT_FILTER_CONFIG, ...domainMap._filterConfig };
  }
  
  // Check for agent descriptor with filter config
  const agentPath = path.join(AGENTS_DIR, `${hostname.replace(/\./g, '_')}.md`);
  if (fs.existsSync(agentPath)) {
    try {
      const content = fs.readFileSync(agentPath, 'utf8');
      const configMatch = content.match(/^filter_config:\s*([\s\S]*?)(?:\n\n|\n[A-Za-z]|$)/m);
      if (configMatch) {
        const parsed = JSON.parse(configMatch[1].trim());
        return { ...DEFAULT_FILTER_CONFIG, ...parsed };
      }
    } catch (_) {
      // Fall back to defaults
    }
  }
  
  return DEFAULT_FILTER_CONFIG;
}

// ---------------------------------------------------------------------------
// LLM System Prompts
// ---------------------------------------------------------------------------

const GOAL_CHECK_PROMPT = `You are a browser automation agent checking whether the current page already satisfies a user goal.
Given the GOAL and the SNAPSHOT (YAML accessibility tree), reply ONLY with a JSON object:
{
  "satisfied": true|false,
  "result": "<extracted answer or empty string>",
  "confidence": 0.0-1.0
}
Rules:
- satisfied=true only when the page clearly contains the answer or the requested content.
- result should contain the extracted answer (≤500 chars).
- confidence should reflect how certain you are.
- If unsure, return satisfied=false with confidence<0.5.
Reply with ONLY valid JSON, no preamble.`;

const EXPLORE_PICK_PROMPT = `You are a browser navigation expert. Given a GOAL, a list of scored navigation items (label + score), the current URL, a VISITED set, and optionally a CACHED_ACTIONS map, pick the SINGLE best action to take.
Reply ONLY with a valid JSON object:
{
  "decision": "click"|"search"|"goal_met"|"none"|"need_login"|"use_cached",
  "ref": "@eN or null",
  "label": "<chosen item label or empty>",
  "cachedActionKey": "<key from CACHED_ACTIONS — only when decision=use_cached>",
  "searchQuery": "<query string — only when decision=search>",
  "rationale": "<one line why>"
}
Decision rules:
- "use_cached"  → CACHED_ACTIONS has a pre-mapped action that directly matches the goal step (fastest path).
- "click"       → follow a nav item that likely leads toward the goal.
- "search"      → a search box is the best route (fill it + press Enter).
- "goal_met"    → the current page already appears to satisfy the goal.
- "need_login"  → a login wall or auth gate is blocking access.
- "none"        → goal cannot be reached from current page; go back to anchor.
NEVER revisit a URL already in VISITED. Prefer use_cached when a matching cached action exists.
Reply with ONLY valid JSON, no preamble.`;

const RULE_VALIDATE_PROMPT = `You are a browser automation verifier. A learned path rule describes steps previously used to reach a goal from a specific starting page.
Given the RULE TEXT and the CURRENT PAGE SNAPSHOT, decide whether the current page looks like the expected starting checkpoint described in the rule.
Reply ONLY with a valid JSON object:
{
  "valid": true|false,
  "reason": "<one line explanation>"
}
valid=true  → the page layout matches what the rule expects (safe to follow the rule).
valid=false → the page has changed significantly since the rule was recorded (rule is stale, discard it).
Reply with ONLY valid JSON, no preamble.`;

const STABLE_SELECTOR_PROMPT = `You are a Lead Automation Engineer. Given a DOM element's attributes extracted from a live page, produce a "Resilient Identity Profile" — a set of stable selectors that will survive minor website redesigns.

Selector priority rules:
  Rank 1 (User Intent): ARIA labels, roles, visible text — e.g. button:has-text("Log in"), [aria-label="Search"]
  Rank 2 (Developer Intent): data-testid, data-qa, id attributes — e.g. [data-testid="login-button"]
  Rank 3 (Structural): Simple CSS — avoid fragile chains. e.g. header .login-btn (not div>div>span>button)

Reply ONLY with a valid JSON object:
{
  "locators": {
    "primary": "<most stable selector — prefer Rank 1>",
    "fallback_1": "<second selector using different attribute>",
    "fallback_2": "<text-based or role-based selector>"
  },
  "fingerprint": {
    "tag": "<tagName>",
    "text": "<visible text, ≤60 chars or null>",
    "aria_label": "<aria-label or null>",
    "data_testid": "<data-testid or null>"
  },
  "success_criteria": {
    "expected_url_change": true|false,
    "element_to_appear": "<selector for confirmation element, or null>"
  }
}
Never use temporary refs like e1, e12 as selectors. Never produce empty string selectors.
Reply with ONLY valid JSON, no preamble.`;

const STATE_IDENTIFY_PROMPT = `You are a browser automation expert. Given a page snapshot and current URL, identify the canonical "page state" — a stable, reusable key describing what type of page this is.
Reply ONLY with a valid JSON object:
{
  "state_key": "<snake_case key, e.g. landing_page_logged_out | search_results | user_dashboard | login_modal>",
  "identification": "<one-line description of how to detect this state, e.g. URL='/' AND Login button visible>"
}
Rules:
- state_key must be lowercase snake_case, ≤40 chars
- Be specific: "landing_page_logged_out" not "home"
- Focus on auth state + page type as the two axes
Reply with ONLY valid JSON, no preamble.`;

// ---------------------------------------------------------------------------
// HTTP helper — POST to browser.act (same as callBrowserAct in browser.agent.cjs)
// ---------------------------------------------------------------------------
function _browserAct(args, timeoutMs = 30000) {
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
        catch (e) { reject(new Error('explore.agent browser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('explore.agent browser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// _highlightElement — inject a visual pulse highlight into the headed browser
// during scan/learn so non-technical users can see what the agent is studying.
// Only fires when headed === true; silently no-ops otherwise.
// ---------------------------------------------------------------------------
async function _highlightElement(ref, label, sessionId, headed) {
  if (!headed || !ref) return;
  try {
    // Self-contained script — injects border + label chip, auto-removes in 1.5s
    const safeLabel = (label || '').replace(/"/g, '\\"').slice(0, 60);
    const script = `(function(){try{
      if(!document.getElementById('__td_kf')){var s=document.createElement('style');s.id='__td_kf';
      s.textContent='@keyframes __tdP{0%{opacity:0;transform:scale(0.98)}25%{opacity:1;transform:scale(1)}85%{opacity:1}100%{opacity:0}}';document.head.appendChild(s);}
      var r=el.getBoundingClientRect();if(!r||r.width===0)return;
      var d=document.createElement('div');
      d.setAttribute('data-thinkdrop','1');
      d.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f97316;border-radius:5px;box-shadow:0 0 0 4px rgba(249,115,22,0.18);left:'+(r.left-3)+'px;top:'+(r.top-3)+'px;width:'+(r.width+6)+'px;height:'+(r.height+6)+'px;animation:__tdP 1.5s ease forwards';
      var chip=document.createElement('div');
      chip.textContent='\\u26a1 Studying: "${safeLabel}"';
      chip.style.cssText='position:absolute;top:-26px;left:0;background:#f97316;color:#fff;font:600 11px/1 system-ui,sans-serif;padding:3px 8px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.25)';
      d.appendChild(chip);document.body.appendChild(d);
      setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d);},1500);
    }catch(e){}})()`;
    await _browserAct({ action: 'evaluate', text: script, ref, sessionId, headed }, 4000).catch(() => {});
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// JSON parser — tolerates markdown code fences
// ---------------------------------------------------------------------------
function _parseJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ---------------------------------------------------------------------------
// Progress event poster — non-fatal HTTP POST to a callback URL
// ---------------------------------------------------------------------------
function _postProgress(callbackUrl, event) {
  if (!callbackUrl) {
    logger.info(`[explore.agent] _postProgress: skipped - no callbackUrl`);
    return;
  }
  try {
    const body = JSON.stringify(event);
    const u = new URL(callbackUrl);
    logger.info(`[explore.agent] _postProgress: sending ${event.type} to ${u.hostname}:${u.port}${u.pathname}`);
    const req = http.request({
      hostname: u.hostname,
      port: parseInt(u.port || '80', 10),
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { 
      logger.info(`[explore.agent] _postProgress: ${event.type} sent - status ${res.statusCode}`);
      res.resume(); 
    });
    req.on('error', (err) => {
      logger.warn(`[explore.agent] _postProgress: ${event.type} failed - ${err.message}`);
    });
    req.write(body);
    req.end();
  } catch (err) {
    logger.warn(`[explore.agent] _postProgress: exception - ${err.message}`);
  }
}


// ---------------------------------------------------------------------------
// Skill registration helper — saves skill to disk and registers in skill-db
// ---------------------------------------------------------------------------
const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

function _ensureSkillsDir() {
  try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch (_) {}
}

async function _registerSkill(skillData) {
  _ensureSkillsDir();
  
  const skillName = skillData.skill_name || skillData.name;
  if (!skillName) {
    logger.warn(`[explore.agent] _registerSkill failed: no skill name provided`);
    return false;
  }
  
  const skillDir = path.join(SKILLS_DIR, skillName.replace(/\./g, '_'));
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    
    // Write skill index.cjs
    const skillCode = skillData.code || _generateSkillCode(skillData);
    fs.writeFileSync(path.join(skillDir, 'index.cjs'), skillCode, 'utf8');
    
    // Write skill metadata
    const _now = new Date().toISOString();
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: skillName,
        description: skillData.description,
        created_at: skillData._meta?.created_at || _now,
        scanned_at: skillData._meta?.scanned_at || _now,
        ...skillData._meta
      }, null, 2),
      'utf8'
    );
    
    logger.info(`[explore.agent] Skill saved to disk: ${skillName} at ${skillDir}`);
    
    // Register in skill-db via HTTP MCP
    try {
      const MEMORY_URL = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
      const MEMORY_KEY = process.env.MCP_USER_MEMORY_API_KEY || '';
      const parsedUrl = new URL(MEMORY_URL);
      const headers = {
        'Content-Type': 'application/json',
      };
      if (MEMORY_KEY) {
        headers['Authorization'] = `Bearer ${MEMORY_KEY}`;
      }
      const dbReq = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 3001,
        path: '/skill.upsert',
        method: 'POST',
        headers,
      }, res => {
        if (res.statusCode === 200) {
          logger.info(`[explore.agent] Skill registered in DB: ${skillName}`);
          res.resume();
        } else {
          let errorBody = '';
          res.on('data', chunk => { errorBody += chunk; });
          res.on('end', () => {
            logger.warn(`[explore.agent] Skill DB registration returned ${res.statusCode}: ${skillName} - ${errorBody}`);
          });
        }
      });
      dbReq.on('error', (err) => {
        logger.warn(`[explore.agent] Skill DB registration error for ${skillName}: ${err.message}`);
      });
      // Send correct MCP payload that skill-db /skill.upsert expects
      // Must include version, service, action, and payload fields
      // NOTE: skill files are written with dots replaced by underscores — match that here
      const skillDirName = skillName.replace(/\./g, '_');
      const registeredSkillDir = path.join(SKILLS_DIR, skillDirName);
      const execPath = path.join(registeredSkillDir, 'index.cjs');
      const skillDescription = skillData.description || `Skill for ${skillData.skill_name || skillData.name}`;
      const contractMd = [
        '---',
        `name: ${skillName}`,
        `description: ${skillDescription}`,
        `exec_path: ${execPath}`,
        `exec_type: node`,
        '---',
      ].join('\n');
      const dbPayload = {
        version: 'mcp.v1',
        service: 'user-memory',
        action: 'skill.upsert',
        payload: {
          name: skillName,
          description: skillDescription,
          execPath,
          execType: 'node',
          enabled: true,
          contractMd,
          sourceDomain: skillData._meta?.source_domain || null,
          sourceAction: skillData._meta?.source_action || null,
        },
        requestId: `explore_${Date.now()}`
      };
      dbReq.write(JSON.stringify(dbPayload));
      dbReq.end();
    } catch (dbErr) {
      logger.warn(`[explore.agent] Skill DB registration failed for ${skillName}: ${dbErr.message}`);
    }
    
    return true;
  } catch (e) {
    logger.warn(`[explore.agent] _registerSkill failed for ${skillName}: ${e.message}`);
    return false;
  }
}

// Generate minimal skill code from action data
function _generateSkillCode(skillData) {
  const { skill_name, interaction, locators, description, parameters } = skillData;
  const sourceDomain = skillData._meta?.source_domain || 'unknown';
  // Derive the default agentId session from the source domain hostname
  // e.g. 'perplexity.ai' → 'perplexity_agent'
  const defaultSessionId = sourceDomain !== 'unknown'
    ? sourceDomain.replace(/\..*$/, '').replace(/[^a-z0-9]/gi, '_') + '_agent'
    : null;
  return `'use strict';
// Auto-generated skill: ${skill_name}
// Generated at: ${new Date().toISOString()}
// Source domain: ${sourceDomain}
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${skill_name}',
  description: '${(description || ('Interact with ' + sourceDomain)).replace(/'/g, "\\'")}',
  parameters: {},

  async run(args = {}) {
    const sessionId = args.sessionId || ${defaultSessionId ? `'${defaultSessionId}'` : 'undefined'};
    const headed = args.headed !== undefined ? args.headed : false;
    const result = await browserAct({
      action: '${interaction}',
      ref: '${locators?.primary || ''}',
      selector: '${locators?.primary || ''}',
      sessionId,
      headed,
      timeoutMs: 15000
    });
    if (!result?.ok) throw new Error('Skill ${skill_name} failed: ' + (result?.error || 'Unknown error'));
    return { success: true, result: result?.result };
  }
};
`;
}

// ---------------------------------------------------------------------------
// Goal relevance scoring — prioritize actions matching user's stated goal(s)
// Supports single goal (string) or multiple goals (array) — returns highest relevance
// ---------------------------------------------------------------------------
function _calculateGoalRelevance(actionLabel, actionAttrs, interactionType, goalOrGoals) {
  // Normalize to array
  const goals = Array.isArray(goalOrGoals) ? goalOrGoals : (goalOrGoals ? [goalOrGoals] : []);
  if (goals.length === 0 || goals.every(g => !g || g.length < 3)) return 1.0; // No goals = accept all
  
  const labelLower = (actionLabel || '').toLowerCase();
  const textLower = (actionAttrs?.text || '').toLowerCase();
  const ariaLower = (actionAttrs?.ariaLabel || '').toLowerCase();
  const parentLower = (actionAttrs?.parentText || '').toLowerCase();
  const searchText = `${labelLower} ${textLower} ${ariaLower} ${parentLower}`;
  
  // Extract filler words to ignore
  const fillerWords = new Set(['to', 'the', 'a', 'an', 'and', 'or', 'on', 'in', 'at', 'for', 'with', 'using', 'use', 'from', 'of', 'by']);
  
  // Calculate relevance for each goal, return highest
  let maxRelevance = 0;
  let bestGoal = null;
  
  for (const goal of goals) {
    if (!goal || goal.length < 3) continue;
    
    const goalLower = goal.toLowerCase();
    const goalWords = goalLower.split(/\s+/).filter(w => w.length > 2 && !fillerWords.has(w));
    if (goalWords.length === 0) continue;
    
    // Score based on keyword matches
    let matchScore = 0;
    for (const word of goalWords) {
      if (searchText.includes(word)) {
        matchScore += 1;
        // Bonus for label match (most important)
        if (labelLower.includes(word)) matchScore += 0.5;
      }
    }
    
    // Normalize score (0-1 range)
    let relevance = Math.min(matchScore / goalWords.length, 1.0);
    
    // Boost for primary interactions that are commonly goal-relevant
    if (interactionType === 'click' && /search|ask|new|create|send|submit/.test(labelLower)) {
      relevance = Math.min(relevance + 0.2, 1.0);
    }
    
    if (relevance > maxRelevance) {
      maxRelevance = relevance;
      bestGoal = goal;
    }
  }
  
  return maxRelevance;
}

// ---------------------------------------------------------------------------
// Domain Map I/O helpers
// ---------------------------------------------------------------------------

function _ensureMapsDir() {
  try { fs.mkdirSync(DOMAIN_MAPS_DIR, { recursive: true }); } catch (_) {}
}

function _mapPath(hostname) {
  return path.join(DOMAIN_MAPS_DIR, `${hostname.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}

function _loadDomainMap(hostname) {
  _ensureMapsDir();
  const p = _mapPath(hostname);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { domain: hostname, version: '1.0', last_scanned: null, states: {} };
  }
}

function _saveDomainMap(hostname, map) {
  _ensureMapsDir();
  const p = _mapPath(hostname);
  try {
    map.last_scanned = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(map, null, 2), 'utf8');
    logger.info(`[explore.agent] domain map saved: ${p}`);
  } catch (err) {
    logger.warn(`[explore.agent] failed to save domain map: ${err.message}`);
  }
}

function _isDomainMapStale(hostname, thresholdMs = MAP_STALE_MS) {
  const p = _mapPath(hostname);
  try {
    const stat = fs.statSync(p);
    return (Date.now() - stat.mtimeMs) > thresholdMs;
  } catch (_) { return true; }
}

function _domainMapExists(hostname) {
  try { fs.accessSync(_mapPath(hostname)); return true; } catch (_) { return false; }
}

/**
 * Clean domain map before new scan - PRESERVE VERIFIED ACTIONS ONLY.
 * 
 * Strategy:
 * - Keep verified actions (verified=true AND failure_count < 3) - these are proven working
 * - Remove ALL unverified actions - they may be garbage from bad previous scans
 * - Clear data array entirely - let fresh scan populate with clean data
 * - Remove states that have no verified actions after cleanup
 */
function _cleanDomainMap(domainMap) {
  if (!domainMap || !domainMap.states) return domainMap;
  
  const cleaned = { ...domainMap };
  const cleanedStates = {};
  let verifiedKept = 0;
  let unverifiedRemoved = 0;
  let statesRemoved = 0;
  
  for (const [stateKey, state] of Object.entries(cleaned.states || {})) {
    if (!state.actions) {
      statesRemoved++;
      continue; // Skip states with no actions
    }
    
    const verifiedActions = {};
    
    for (const [actionKey, action] of Object.entries(state.actions)) {
      const isVerified = action.verified && (action.failure_count || 0) < 3;
      
      if (isVerified) {
        verifiedActions[actionKey] = action;
        verifiedKept++;
      } else {
        unverifiedRemoved++;
        logger.info(`[explore.agent] _cleanDomainMap: removed unverified action "${actionKey}"`);
      }
    }
    
    // Only keep states that have at least one verified action
    if (Object.keys(verifiedActions).length > 0) {
      cleanedStates[stateKey] = {
        ...state,
        actions: verifiedActions,
        data: [] // Clear old data, let fresh scan repopulate
      };
    } else {
      statesRemoved++;
    }
  }
  
  cleaned.states = cleanedStates;
  
  logger.info(`[explore.agent] _cleanDomainMap: kept ${verifiedKept} verified actions, removed ${unverifiedRemoved} unverified, removed ${statesRemoved} empty states`);
  
  return cleaned;
}

/**
 * Merge new state data into an existing domain map.
 * Verified actions with failure_count < 3 are never overwritten.
 * New states/actions are always added.
 */
function _mergeDomainMap(existing, incoming) {
  // Clean old history links from existing before merging
  const cleanedExisting = _cleanDomainMap(existing);
  const merged = { ...cleanedExisting };
  for (const [stateKey, stateData] of Object.entries(incoming.states || {})) {
    if (!merged.states[stateKey]) {
      merged.states[stateKey] = stateData;
      continue;
    }
    const existingState = merged.states[stateKey];
    for (const [actionKey, actionData] of Object.entries(stateData.actions || {})) {
      const existingAction = existingState.actions?.[actionKey];
      if (existingAction && existingAction.verified && (existingAction.failure_count || 0) < 3) {
        continue;
      }
      if (!existingState.actions) existingState.actions = {};
      existingState.actions[actionKey] = actionData;
    }
  }
  // Merge content_extraction if present in incoming
  if (incoming.content_extraction) {
    merged.content_extraction = incoming.content_extraction;
  }
  // Preserve metadata configs
  if (incoming._filterConfig) {
    merged._filterConfig = incoming._filterConfig;
  }
  if (incoming._schemas) {
    merged._schemas = incoming._schemas;
  }
  // Merge goals if present
  if (incoming.goals) {
    merged.goals = { ...existing.goals, ...incoming.goals };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Content Extraction Discovery — analyze DOM to find content selectors
// ---------------------------------------------------------------------------

async function _extractContentSignals(sessionId, headed) {
  try {
    const result = await _browserAct({
      action: 'run-code',
      code: `async page => {
        // Analyze DOM structure to find content containers
        const signals = {
          primary_selector: null,
          fallback_selector: null,
          content_type: 'unknown',
          confidence: 0,
          detected_patterns: []
        };
        
        // Check for common content patterns
        const tests = [
          { selector: 'article', type: 'article', weight: 0.9 },
          { selector: 'main', type: 'main_content', weight: 0.85 },
          { selector: '[role="main"]', type: 'main_landmark', weight: 0.8 },
          { selector: '.content, #content', type: 'content_class', weight: 0.7 },
          { selector: '[data-message-author-role]', type: 'conversation', weight: 0.9 },
          { selector: '.message, .chat-message', type: 'chat', weight: 0.8 },
          { selector: '[role="listitem"]', type: 'list_items', weight: 0.75 },
          { selector: '.email, .thread', type: 'email_thread', weight: 0.8 },
          { selector: '.prose, .answer, .response', type: 'prose_content', weight: 0.75 },
          { selector: '.result, .search-result', type: 'search_results', weight: 0.7 },
          { selector: 'table tbody tr', type: 'table_rows', weight: 0.6 },
        ];
        
        for (const test of tests) {
          try {
            const elements = await page.locator(test.selector).all();
            if (elements.length > 0) {
              const text = await page.locator(test.selector).first().innerText({ timeout: 1000 });
              if (text && text.length > 50) {
                signals.detected_patterns.push({
                  selector: test.selector,
                  type: test.type,
                  count: elements.length,
                  sample_length: text.length,
                  weight: test.weight
                });
              }
            }
          } catch (_) {}
        }
        
        // Sort by weight and pick best candidates
        signals.detected_patterns.sort((a, b) => b.weight - a.weight);
        
        if (signals.detected_patterns.length > 0) {
          signals.primary_selector = signals.detected_patterns[0].selector;
          signals.content_type = signals.detected_patterns[0].type;
          signals.confidence = signals.detected_patterns[0].weight;
          
          // Set fallback to second best if available
          if (signals.detected_patterns.length > 1) {
            signals.fallback_selector = signals.detected_patterns[1].selector;
          }
        }
        
        return signals;
      }`,
      sessionId,
      headed,
      timeoutMs: 15000
    }, 18000);
    
    if (result?.ok && result.result) {
      return result.result;
    }
    return null;
  } catch (err) {
    logger.debug(`[explore.agent] content extraction discovery failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Smart attribute-based selector extraction — no LLM, hierarchical fallbacks
// ---------------------------------------------------------------------------

// Detect dynamic IDs like "react-12345", "ember-6789"
function _isDynamicId(id) {
  if (!id || typeof id !== 'string') return false;
  // Pattern: word-12345 (word followed by 4+ digits)
  return /^[a-z]+-\d{4,}$/i.test(id);
}

// Filter out hashed/minified CSS classes
function _filterSemanticClasses(className) {
  if (!className || typeof className !== 'string') return [];
  return className.split(/\s+/).filter(c => 
    c && c.length > 2 && 
    !/^css-[a-z0-9]{5,}$/i.test(c) &&  // css-1a2b3c
    !/^[a-z0-9]{8,}$/i.test(c) &&      // random hashes
    !/^style_[a-z0-9]+$/i.test(c)      // style_abc123
  );
}

// Build smart selectors from element attributes
function _buildSmartSelectors(attrs) {
  const selectors = [];
  const { tag, id, dataTestId, dataQa, ariaLabel, role, name, href, className, text, contenteditable, placeholder, type } = attrs;
  
  // Tier 1: ID (if not dynamic)
  if (id && !_isDynamicId(id)) {
    selectors.push({ 
      selector: `[id="${id}"]`, 
      score: 100, 
      fingerprint: { id, tag, role },
      stable: true 
    });
    if (role) {
      selectors.push({ 
        selector: `[id="${id}"][role="${role}"]`, 
        score: 95,
        fingerprint: { id, role, tag },
        stable: true
      });
    }
  }
  
  // Tier 2: Data attributes (very stable)
  if (dataTestId) {
    selectors.push({ 
      selector: `[data-testid="${dataTestId}"]`, 
      score: 95,
      fingerprint: { dataTestId, tag },
      stable: true
    });
  }
  if (dataQa) {
    selectors.push({ 
      selector: `[data-qa="${dataQa}"]`, 
      score: 94,
      fingerprint: { dataQa, tag },
      stable: true
    });
  }
  
  // Tier 3: ARIA label + role combination
  if (ariaLabel && ariaLabel.length > 2) {
    if (role) {
      selectors.push({ 
        selector: `[role="${role}"][aria-label="${ariaLabel}"]`, 
        score: 90,
        fingerprint: { role, ariaLabel, tag },
        stable: true
      });
    }
    selectors.push({ 
      selector: `[aria-label="${ariaLabel}"]`, 
      score: 85,
      fingerprint: { ariaLabel, tag, role },
      stable: true
    });
  }
  
  // Tier 4: Name attribute (for inputs)
  if (name) {
    selectors.push({ 
      selector: `${tag || ''}[name="${name}"]`.trim(), 
      score: 80,
      fingerprint: { name, tag },
      stable: true
    });
  }
  
  // Tier 5: Placeholder (for inputs)
  if (placeholder && placeholder.length > 3) {
    selectors.push({ 
      selector: `[placeholder="${placeholder}"]`, 
      score: 75,
      fingerprint: { placeholder, tag },
      stable: false
    });
  }
  
  // Tier 6: Href for links (with partial pattern)
  if (tag === 'a' && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
    // Full href
    selectors.push({ 
      selector: `a[href="${href}"]`, 
      score: 70,
      fingerprint: { href, tag },
      stable: false
    });
    // Partial href pattern (e.g., /computer/*)
    const hrefParts = href.split('/').filter(Boolean);
    if (hrefParts.length >= 2) {
      const basePath = '/' + hrefParts.slice(0, 2).join('/');
      selectors.push({ 
        selector: `a[href^="${basePath}/"]`, 
        score: 65,
        fingerprint: { hrefBase: basePath, tag },
        stable: false
      });
    }
  }
  
  // Tier 7: Contenteditable
  if (contenteditable === 'true') {
    if (role) {
      selectors.push({ 
        selector: `[role="${role}"][contenteditable="true"]`, 
        score: 60,
        fingerprint: { role, contenteditable, tag },
        stable: false
      });
    }
    selectors.push({ 
      selector: `[contenteditable="true"]`, 
      score: 55,
      fingerprint: { contenteditable, tag },
      stable: false
    });
  }
  
  // Tier 8: Semantic CSS classes (filter out hashed classes)
  const semanticClasses = _filterSemanticClasses(className);
  if (semanticClasses.length > 0) {
    const classSelector = semanticClasses.slice(0, 2).join('.');
    selectors.push({ 
      selector: `${tag || ''}.${classSelector}`.trim(), 
      score: 50,
      fingerprint: { classes: semanticClasses, tag },
      stable: false
    });
  }
  
  // Tier 9: Text content (last resort)
  if (text && text.length > 0 && text.length < 50) {
    selectors.push({ 
      selector: `${tag || ''}:has-text("${text.replace(/"/g, '\\"')}")`.trim(), 
      score: 40,
      fingerprint: { text: text.slice(0, 30), tag },
      stable: false
    });
  }
  
  // Sort by score descending
  selectors.sort((a, b) => b.score - a.score);
  
  // Take top 4 (1 primary + 3 fallbacks max)
  const topSelectors = selectors.slice(0, 4);
  
  return {
    primary: topSelectors[0]?.selector || null,
    fallbacks: topSelectors.slice(1).map(s => s.selector),
    fingerprint: topSelectors[0]?.fingerprint || {},
    stability: topSelectors[0]?.stable || false,
    score: topSelectors[0]?.score || 0
  };
}

// Test selector at scan time to verify it works
async function _verifySelector(selector, tag, ref, sessionId, headed) {
  try {
    const testFunc = `(el) => el ? {
      tag: el.tagName.toLowerCase(),
      visible: el.offsetParent !== null,
      width: el.offsetWidth,
      height: el.offsetHeight
    } : null`;
    
    const testRes = await _browserAct({
      action: 'evaluate',
      text: testFunc,
      ref,
      sessionId,
      headed,
      timeoutMs: 5000,
    }, 6000).catch(() => null);
    
    if (testRes?.ok && testRes.result) {
      const result = typeof testRes.result === 'string' ? JSON.parse(testRes.result) : testRes.result;
      return result && result.tag === tag;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function _extractStableSelectors(ref, sessionId, headed, skillName, interaction) {
  if (!ref) {
    logger.info(`[explore.agent] _extractStableSelectors: no ref provided`);
    return null;
  }
  
  try {
    // Extract element attributes via browser evaluate
    // Enhanced to detect all interaction types: click, fill, type, select, check, scroll, drag, hover, upload
    const evalFunc = `(el) => el ? ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().slice(0, 80),
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-testid'),
      dataQa: el.getAttribute('data-qa'),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      href: el.getAttribute('href'),
      id: el.id || null,
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      className: (el.className || '').slice(0, 100),
      contenteditable: el.getAttribute('contenteditable'),
      // New attributes for comprehensive interaction detection
      draggable: el.getAttribute('draggable') === 'true',
      checked: el.checked || false,
      hasPopup: el.getAttribute('aria-haspopup'),
      expanded: el.getAttribute('aria-expanded'),
      selected: el.selected || false,
      // Container properties for scroll detection
      scrollHeight: el.scrollHeight || 0,
      clientHeight: el.clientHeight || 0,
      overflowY: window.getComputedStyle(el).overflowY,
      // File upload
      accept: el.getAttribute('accept'),
      multiple: el.hasAttribute('multiple'),
      // Options for select elements
      options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 10).map(o => ({ text: o.text, value: o.value })) : null,
      // Context
      inList: !!(el.closest && (el.closest('ul') || el.closest('ol') || el.closest('[role="list"]'))),
      parentText: el.parentElement ? (el.parentElement.getAttribute('aria-label') || el.parentElement.innerText || '').slice(0, 50) : '',
    }) : null`;

    logger.info(`[explore.agent] _extractStableSelectors: evaluating ref=${ref}`);
    const evalRes = await _browserAct({
      action: 'evaluate',
      text: evalFunc,
      ref,
      sessionId,
      headed,
      timeoutMs: 8000,
    }, 10000).catch((e) => {
      logger.info(`[explore.agent] _extractStableSelectors: evaluate failed for ref=${ref}: ${e.message}`);
      return null;
    });

    let attrs = null;
    if (evalRes?.ok && evalRes.result) {
      try {
        const raw = typeof evalRes.result === 'string' ? evalRes.result : JSON.stringify(evalRes.result);
        attrs = JSON.parse(raw);
        logger.info(`[explore.agent] _extractStableSelectors: extracted attrs for ref=${ref}: ${JSON.stringify(attrs).slice(0, 150)}`);
      } catch (e) { 
        logger.info(`[explore.agent] _extractStableSelectors: failed to parse attrs for ref=${ref}: ${e.message}`);
        return null; 
      }
    } else {
      logger.info(`[explore.agent] _extractStableSelectors: evaluate returned no result for ref=${ref}`);
      return null;
    }

    if (!attrs || !attrs.tag) {
      logger.info(`[explore.agent] _extractStableSelectors: no attrs or tag for ref=${ref}`);
      return null;
    }

    // Build smart selectors from attributes
    const selectorProfile = _buildSmartSelectors(attrs);
    
    if (!selectorProfile.primary) {
      logger.info(`[explore.agent] _extractStableSelectors: no selectors could be built for ref=${ref}, attrs=${JSON.stringify(attrs).slice(0, 100)}`);
      return null;
    }
    
    logger.info(`[explore.agent] _extractStableSelectors: built selectors for ref=${ref} - primary: ${selectorProfile.primary}, score: ${selectorProfile.score}, stable: ${selectorProfile.stability}`);

    // Test primary selector to verify it works
    const verified = await _verifySelector(selectorProfile.primary, attrs.tag, ref, sessionId, headed);
    if (!verified) {
      logger.info(`[explore.agent] _extractStableSelectors: primary selector failed verification for ref=${ref}, trying fallbacks`);
      // Try fallbacks
      for (let i = 0; i < selectorProfile.fallbacks.length; i++) {
        const fbVerified = await _verifySelector(selectorProfile.fallbacks[i], attrs.tag, ref, sessionId, headed);
        if (fbVerified) {
          logger.info(`[explore.agent] _extractStableSelectors: fallback ${i} verified for ref=${ref}: ${selectorProfile.fallbacks[i]}`);
          // Swap this fallback to primary
          selectorProfile.fallbacks[i] = selectorProfile.primary;
          selectorProfile.primary = selectorProfile.fallbacks.splice(i, 1)[0];
          break;
        }
      }
    } else {
      logger.info(`[explore.agent] _extractStableSelectors: primary selector verified for ref=${ref}`);
    }

    return {
      locators: {
        primary: selectorProfile.primary,
        fallback_1: selectorProfile.fallbacks[0] || null,
        fallback_2: selectorProfile.fallbacks[1] || null,
      },
      fingerprint: selectorProfile.fingerprint,
      success_criteria: { expected_url_change: interaction === 'click', element_to_appear: null },
      verified: verified,
      score: selectorProfile.score,
      stability: selectorProfile.stability
    };
  } catch (err) {
    logger.warn(`[explore.agent] _extractStableSelectors failed for ${ref}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locator resolver — tries primary → fallback_1 → fallback_2 in order
// ---------------------------------------------------------------------------

async function _resolveLocator(locators, sessionId, headed) {
  if (!locators) return null;
  const order = ['primary', 'fallback_1', 'fallback_2'];
  for (const strategy of order) {
    const selector = locators[strategy];
    if (!selector) continue;
    try {
      const res = await _browserAct({
        action: 'waitForSelector',
        selector,
        sessionId,
        headed,
          timeoutMs: 2000,
      }, 4000).catch(() => null);
      if (res?.ok) {
        logger.info(`[explore.agent] _resolveLocator: resolved via ${strategy} = "${selector}"`);
        return { selector, strategy };
      }
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page state identifier — snapshot → canonical state key
// ---------------------------------------------------------------------------

async function _identifyPageState(snapshot, currentUrl) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: STATE_IDENTIFY_PROMPT },
      { role: 'user',   content: `CURRENT_URL: ${currentUrl || 'unknown'}\n\nSNAPSHOT:\n${snapshot.slice(0, 5000)}` },
    ], { temperature: 0.1, maxTokens: 128, responseTimeoutMs: 10000 });
    const parsed = _parseJson(raw);
    return parsed?.state_key ? parsed : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Scan queue — sequential drain with concurrency cap (prevents browser flood)
// ---------------------------------------------------------------------------

const _MAX_CONCURRENT_SCANS = 1;          // never run more than 1 background scan at once
const _scanQueueSet  = new Set();          // hostnames currently queued OR active (dedup)
const _scanQueueList = [];                 // ordered pending items: { args, trigger, hostname }
let   _activeScanCount = 0;

function _drainScanQueue() {
  while (_activeScanCount < _MAX_CONCURRENT_SCANS && _scanQueueList.length > 0) {
    const { args, trigger, hostname } = _scanQueueList.shift();
    _activeScanCount++;
    logger.info(`[explore.agent] scan starting: ${hostname} (trigger=${trigger} active=${_activeScanCount} queued=${_scanQueueList.length})`);
    scanDomain({ ...args, _trigger: trigger })
      .catch(err => logger.warn(`[explore.agent] background scan failed for ${hostname}: ${err.message}`))
      .finally(() => {
        _activeScanCount--;
        _scanQueueSet.delete(hostname);
        _drainScanQueue(); // start next
      });
  }
}

function _enqueueScan(args, trigger = 'unknown') {
  let hostname;
  try { hostname = new URL(args.url).hostname.replace(/^www\./, ''); } catch (_) { return; }
  if (_scanQueueSet.has(hostname)) {
    logger.debug(`[explore.agent] scan already queued/active for ${hostname} — skipping`);
    return;
  }
  _scanQueueSet.add(hostname);
  _scanQueueList.push({ args, trigger, hostname });
  logger.info(`[explore.agent] scan queued: ${hostname} (trigger=${trigger} queueDepth=${_scanQueueList.length})`);
  _drainScanQueue();
}

// ---------------------------------------------------------------------------
// Login wall detector
// ---------------------------------------------------------------------------
const LOGIN_URL_PATTERNS = ['/login', '/signin', '/sign-in', '/auth/', '/oauth', '/accounts/'];

function _isLoginWall(snapshot, currentUrl) {
  if (currentUrl) {
    try {
      const u = new URL(currentUrl).pathname.toLowerCase();
      if (LOGIN_URL_PATTERNS.some(p => u.includes(p))) return true;
    } catch (_) {}
  }
  const t = (snapshot || '').toLowerCase();
  const signals = [
    'password', 'sign in', 'log in', 'create account',
    'forgot password', 'continue with google', 'continue with apple',
    'enter your email', 'welcome back',
  ];
  let hits = 0;
  for (const s of signals) { if (t.includes(s)) hits++; }
  return hits >= 2;
}

// ---------------------------------------------------------------------------
// Navigation item extraction — pulls ALL links + buttons from YAML snapshot
// Handles two formats emitted by playwright-cli:
//   Format A: "  - [e12] link \"Bible Study\" [href=...]"
//   Format B: "    - link \"Bible Study\" [ref=e52] [cursor=pointer]:"
// ---------------------------------------------------------------------------
function _extractNavItems(snapshot) {
  const items = [];
  const lines = (snapshot || '').split('\n');

  for (const line of lines) {
    let ref = null;
    let role = null;
    let label = '';

    // Format A: optional indent + dash + [eN] BEFORE role + "label" + optional attrs
    // Example: "  - [e12] link \"Bible Study\" [href=...]"
    const mA = line.match(/^\s*-?\s*\[?(e\d+)\]?\s+(\w[\w-]*)\s+"([^"]*)"/i);
    if (mA) {
      [, ref, role, label] = mA;
    } else {
      // Format B (.yml): optional indent + dash + role + optional "label" + optional attrs
      // Example: "    - link \"Bible Study\" [ref=e52]"
      const mB = line.match(/^\s*-\s+(\w[\w-]*)\s+"([^"]*)"/i);
      if (mB) {
        [, role, label] = mB;
        // Extract [ref=eN] from the line if present
        const refMatch = line.match(/\[ref=(e\d+)\]/i);
        ref = refMatch ? refMatch[1] : null;
      }
    }

    // Only keep interactive elements we can interact with
    // Note: playwright-cli uses e12 format (NOT @e12) - resolveRef checks /^e\d+$/i
    const roleLower = role ? role.toLowerCase() : '';
    const isClickable = roleLower === 'link' || roleLower === 'button';
    const isInputLike = roleLower === 'textbox' || roleLower === 'searchbox' || roleLower === 'combobox' || roleLower === 'spinbutton';
    const isContentEditable = roleLower === 'textbox';  // contenteditable elements have role=textbox
    
    if (ref && role && (isClickable || isInputLike || isContentEditable)) {
      items.push({ ref, label: label.trim(), role: roleLower });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Nav item scorer — word overlap between label and goal words (0-1)
// ---------------------------------------------------------------------------
function _scoreNavItem(label, goal) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'is', 'be', 'my', 'i']);
  const goalWords = goal.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w));
  if (goalWords.length === 0) return 0;
  const labelWords = label.toLowerCase().split(/\W+/);
  let hits = 0;
  for (const w of goalWords) {
    if (labelWords.some(lw => lw.includes(w) || w.includes(lw))) hits++;
  }
  return hits / goalWords.length;
}

// ---------------------------------------------------------------------------
// Get current URL from browser session
// ---------------------------------------------------------------------------
async function _getCurrentUrl(sessionId, headed) {
  try {
    const res = await _browserAct({
      action: 'evaluate',
      text: 'window.location.href',
      sessionId,
      headed,
      timeoutMs: 5000,
    }, 8000);
    return (res?.ok && typeof res?.result === 'string') ? res.result : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Learn successful navigation path as a context rule
// ---------------------------------------------------------------------------
async function _learnPath(agentId, history, goal, hostname) {
  if (!history || history.length < 1) return;
  try {
    const pathSummary = history.map(h => h.label || h.url || '').filter(Boolean).join(' → ');
    const ruleText = `For "${goal.slice(0, 40)}": ${pathSummary}`.slice(0, 150);
    await skillDb.setContextRule(agentId, ruleText, 'agent');
    if (hostname) await skillDb.setContextRule(hostname, ruleText, 'site');
    logger.info(`[explore.agent] learned path saved: "${ruleText}"`);
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function exploreAgent(args) {
  const {
    goal,
    url:          anchorUrl,
    agentId       = 'explore_agent',
    sessionId:    callerSessionId,
    maxDepth      = 4,
    maxNavItems   = 20,
    mode          = 'execute',
    _progressCallbackUrl,
  } = args || {};

  // Mode B — scan (no goal required, background probing)
  if (mode === 'scan') {
    if (!anchorUrl) throw new Error('[explore.agent] url is required for scan mode');
    return scanDomain({ url: anchorUrl, agentId, sessionId: callerSessionId, _progressCallbackUrl });
  }

  if (!goal)      throw new Error('[explore.agent] goal is required');
  if (!anchorUrl) throw new Error('[explore.agent] url is required');

  const start           = Date.now();
  const exploreSessionId = callerSessionId || `${agentId}_explore`;
  const headed          = true;

  let hostname;
  try { hostname = new URL(anchorUrl).hostname.replace(/^www\./, ''); } catch (_) { hostname = null; }

  const domainLockBlock = hostname
    ? `\n\nDOMAIN LOCK — ABSOLUTE:\nYou are automating '${hostname}'. NEVER navigate outside '${hostname}'.`
    : '';

  // Derive service key for fast-path OAuth hint
  const serviceKey = hostname ? hostname.split('.').slice(-2, -1)[0] : null;
  const serviceInfo = serviceKey ? (KNOWN_BROWSER_SERVICES[serviceKey] || null) : null;

  let _authAttempted = false;
  let _usedLearnedRules = false;
  let learnedRulesBlock = '';
  const history = []; // { label, url } steps taken

  // ── Phase 0 — Navigate ──────────────────────────────────────────────────
  const _navigate = async () => {
    logger.info(`[explore.agent] phase 0: navigating to ${anchorUrl}`);
    const navRes = await _browserAct({
      action: 'navigate',
      url: anchorUrl,
      sessionId: exploreSessionId,
      headed,
      timeoutMs: 20000,
    }, 25000);

    if (!navRes?.ok) {
      logger.warn(`[explore.agent] navigate failed: ${navRes?.error} — proceeding anyway`);
    }

    // settle + wait for nav bar (non-fatal)
    await _browserAct({
      action: 'waitForStableText',
      sessionId: exploreSessionId,
      headed,
      timeoutMs: 6000,
    }, 8000).catch(() => {});

    await _browserAct({
      action: 'waitForSelector',
      selector: '[role=navigation]',
      sessionId: exploreSessionId,
      headed,
      timeoutMs: 3000,
    }, 5000).catch(() => {});
  };

  // ── Phase 0.5 — Auth flow ───────────────────────────────────────────────
  const _handleAuth = async (currentUrl) => {
    if (_authAttempted) {
      logger.warn('[explore.agent] auth already attempted — skipping to avoid infinite loop');
      return;
    }
    logger.info(`[explore.agent] phase 0.5: login wall detected — starting waitForAuth`);
    _authAttempted = true;

    const authRes = await _browserAct({
      action: 'waitForAuth',
      url: currentUrl || anchorUrl,
      authSuccessUrl: anchorUrl,
      sessionId: exploreSessionId,
      headed,
      timeoutMs: 120000,
    }, 125000).catch(err => ({ ok: false, error: err.message }));

    if (authRes?.ok) {
      logger.info('[explore.agent] auth succeeded — restarting Phase 0');
      // Record login requirement as a rule
      if (hostname) {
        await skillDb.setContextRule(hostname, `${hostname}: requires login, use persistent profile`, 'site').catch(() => {});
      }
      // Full Phase 0 restart
      await _navigate();
    } else {
      logger.warn(`[explore.agent] waitForAuth failed or timed out: ${authRes?.error}`);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Fast-path: if service is known OAuth → don't even navigate, go straight to auth
  if (serviceInfo?.isOAuth && !_authAttempted) {
    logger.info(`[explore.agent] fast-path: ${serviceKey} is known OAuth — triggering waitForAuth first`);
    await _handleAuth(serviceInfo.signInUrl || anchorUrl);
  } else {
    await _navigate();
  }

  // Take initial snapshot
  let currentSnapshot = '';
  const initSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 10000 }, 12000).catch(() => null);
  if (initSnap?.ok && initSnap.result) currentSnapshot = initSnap.result;

  // Check for login wall after navigation
  const initUrl = await _getCurrentUrl(exploreSessionId, headed);
  if (_isLoginWall(currentSnapshot, initUrl)) {
    await _handleAuth(initUrl || anchorUrl);
    // Re-snapshot after auth
    const postAuthSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 10000 }, 12000).catch(() => null);
    if (postAuthSnap?.ok && postAuthSnap.result) currentSnapshot = postAuthSnap.result;
  }

  // ── Phase 1 — Validate learned rules ───────────────────────────────────
  logger.info('[explore.agent] phase 1: loading and validating learned rules');
  try {
    const ruleKeys = [agentId];
    if (hostname) ruleKeys.push(hostname);
    const rules = await skillDb.getContextRulesByKeys(ruleKeys);

    if (rules.length > 0) {
      logger.info(`[explore.agent] ${rules.length} learned rule(s) found — validating against current page`);
      let allValid = true;

      for (const rule of rules) {
        let validateRaw;
        try {
          validateRaw = await askWithMessages([
            { role: 'system', content: RULE_VALIDATE_PROMPT },
            { role: 'user',   content: `RULE TEXT: ${rule}\n\nCURRENT PAGE SNAPSHOT:\n${currentSnapshot.slice(0, 4000)}` },
          ], { temperature: 0.1, maxTokens: 128, responseTimeoutMs: 10000 });
        } catch (_) { continue; }

        const validateParsed = _parseJson(validateRaw);
        if (validateParsed?.valid === false) {
          logger.warn(`[explore.agent] stale rule detected: "${rule.slice(0, 60)}..." — evicting all rules for [${ruleKeys.join(', ')}]`);
          allValid = false;
          break;
        }
      }

      if (!allValid) {
        // Evict stale rules for all keys
        for (const key of ruleKeys) {
          await skillDb.deleteContextRulesByKey(key).catch(() => {});
        }
        logger.info('[explore.agent] stale rules evicted — continuing without learned rules');
      } else {
        learnedRulesBlock = `\n\nLEARNED RULES (from prior runs — follow exactly):\n${rules.map(r => `- ${r}`).join('\n')}`;
        _usedLearnedRules = true;
        logger.info('[explore.agent] learned rules validated and injected');
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Phase 2 — Immediate goal check ─────────────────────────────────────
  logger.info('[explore.agent] phase 2: immediate goal check on landing page');
  try {
    const gcRaw = await askWithMessages([
      { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
      { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
    ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 15000 });

    const gcParsed = _parseJson(gcRaw);
    if (gcParsed?.satisfied && (gcParsed.confidence ?? 0) >= 0.7) {
      logger.info('[explore.agent] goal already satisfied on landing page');
      const landingUrl = await _getCurrentUrl(exploreSessionId, headed);
      if (landingUrl) history.push({ label: anchorUrl, url: landingUrl });
      await _learnPath(agentId, history, goal, hostname);
      return { ok: true, goal, sessionId: exploreSessionId, result: gcParsed.result || 'Goal satisfied on landing page', turns: 0, done: true, executionTime: Date.now() - start };
    }
  } catch (err) {
    logger.warn(`[explore.agent] phase 2 goal-check error: ${err.message} — proceeding to loop`);
  }

  // ── Phase 3 — Explore loop ──────────────────────────────────────────────
  logger.info(`[explore.agent] phase 3: explore loop (maxDepth=${maxDepth})`);
  const visited = new Set();
  visited.add(anchorUrl);

  let depth = 0;
  while (depth < maxDepth) {
    depth++;
    logger.info(`[explore.agent] explore loop depth ${depth}/${maxDepth}`);

    // Fresh snapshot
    const snapRes = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 10000 }, 12000).catch(() => null);
    if (snapRes?.ok && snapRes.result) currentSnapshot = snapRes.result;

    const currentUrl = await _getCurrentUrl(exploreSessionId, headed);

    // Detect login wall in loop
    if (_isLoginWall(currentSnapshot, currentUrl) && !_authAttempted) {
      await _handleAuth(currentUrl || anchorUrl);
      continue;
    }

    // ── Execute fast-path: check domain map for cached selectors ──────────
    let cachedActionsBlock = '';
    let domainMapRef = null;
    if (hostname) {
      try {
        domainMapRef = _loadDomainMap(hostname);
        const pageState = await _identifyPageState(currentSnapshot, currentUrl);
        if (pageState?.state_key && domainMapRef.states?.[pageState.state_key]?.actions) {
          const stateActions = domainMapRef.states[pageState.state_key].actions;
          const actionKeys = Object.keys(stateActions);
          if (actionKeys.length > 0) {
            cachedActionsBlock = `\n\nCACHED_ACTIONS (pre-mapped stable selectors for state "${pageState.state_key}"):\n` +
              actionKeys.map(k => `- ${k}: interaction=${stateActions[k].interaction} selector=${stateActions[k].locators?.primary || '?'}`).join('\n');
          }
        }
      } catch (_) { domainMapRef = null; }
    }

    // Extract + score nav items
    const allItems = _extractNavItems(currentSnapshot);
    const scored   = allItems
      .map(item => ({ ...item, score: _scoreNavItem(item.label, goal) }))
      .filter(item => !visited.has(item.ref))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxNavItems);

    const itemList = scored.map((it, i) => `${i + 1}. [${it.ref}] "${it.label}" (score=${it.score.toFixed(2)})`).join('\n');

    let pickRaw;
    try {
      pickRaw = await askWithMessages([
        { role: 'system', content: EXPLORE_PICK_PROMPT + domainLockBlock + learnedRulesBlock },
        { role: 'user',   content: [
          `GOAL: ${goal}`,
          `CURRENT_URL: ${currentUrl || 'unknown'}`,
          `ANCHOR_URL: ${anchorUrl}`,
          `VISITED: ${[...visited].join(', ')}`,
          ``,
          `NAV_ITEMS (top ${scored.length}):`,
          itemList || '(none found)',
          cachedActionsBlock,
          ``,
          `SNAPSHOT_EXCERPT:\n${currentSnapshot.slice(0, 3000)}`,
        ].join('\n') },
      ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 15000 });
    } catch (err) {
      logger.warn(`[explore.agent] EXPLORE_PICK LLM error: ${err.message} — breaking`);
      break;
    }

    const pick = _parseJson(pickRaw);
    if (!pick) {
      logger.warn('[explore.agent] EXPLORE_PICK unparseable — breaking');
      break;
    }

    logger.info(`[explore.agent] EXPLORE_PICK decision=${pick.decision} ref=${pick.ref} label="${pick.label}" | ${pick.rationale}`);

    // ── Handle each decision ─────────────────────────────────────────────

    // use_cached — execute a pre-mapped stable selector directly
    if (pick.decision === 'use_cached' && pick.cachedActionKey && domainMapRef && hostname) {
      logger.info(`[explore.agent] use_cached: executing "${pick.cachedActionKey}" from domain map`);
      const pageState2 = await _identifyPageState(currentSnapshot, currentUrl);
      const cachedAction = pageState2?.state_key
        ? domainMapRef.states?.[pageState2.state_key]?.actions?.[pick.cachedActionKey]
        : null;

      if (cachedAction?.locators) {
        const resolved = await _resolveLocator(cachedAction.locators, exploreSessionId, headed);
        if (resolved) {
          // Execute the cached action
          let execRes;
          if (cachedAction.interaction === 'fill') {
            execRes = await _browserAct({
              action: 'fill',
              selector: resolved.selector,
              text: goal,
              sessionId: exploreSessionId,
              headed,
                      timeoutMs: 10000,
            }, 12000).catch(err => ({ ok: false, error: err.message }));
            if (execRes?.ok) {
              await _browserAct({ action: 'press', key: 'Enter', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
            }
          } else {
            execRes = await _browserAct({
              action: 'click',
              selector: resolved.selector,
              sessionId: exploreSessionId,
              headed,
                      timeoutMs: 10000,
            }, 12000).catch(err => ({ ok: false, error: err.message }));
          }

          if (execRes?.ok) {
            // Update verified status + reset failure count
            if (pageState2?.state_key && domainMapRef.states?.[pageState2.state_key]?.actions?.[pick.cachedActionKey]) {
              const act = domainMapRef.states[pageState2.state_key].actions[pick.cachedActionKey];
              act.verified = true;
              act.last_verified = new Date().toISOString();
              act.failure_count = 0;
              _saveDomainMap(hostname, domainMapRef);
            }
            await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
            const cachedUrl = await _getCurrentUrl(exploreSessionId, headed);
            if (cachedUrl) visited.add(cachedUrl);
            history.push({ label: pick.cachedActionKey, url: cachedUrl || '' });

            // Post-action goal check
            const cachedSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 8000 }, 10000).catch(() => null);
            if (cachedSnap?.ok && cachedSnap.result) currentSnapshot = cachedSnap.result;
            try {
              const cachedGcRaw = await askWithMessages([
                { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
                { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
              ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
              const cachedGc = _parseJson(cachedGcRaw);
              if (cachedGc?.satisfied && (cachedGc.confidence ?? 0) >= 0.7) {
                await _learnPath(agentId, history, goal, hostname);
                return { ok: true, goal, sessionId: exploreSessionId, result: cachedGc.result || `Reached via cached: ${pick.cachedActionKey}`, turns: depth, done: true, executionTime: Date.now() - start };
              }
            } catch (_) {}
            continue;
          } else {
            // Cached selector failed — increment failure_count, trigger self-heal re-scan
            logger.warn(`[explore.agent] use_cached execution failed for "${pick.cachedActionKey}" — incrementing failure_count, enqueuing re-scan`);
            if (pageState2?.state_key && domainMapRef.states?.[pageState2.state_key]?.actions?.[pick.cachedActionKey]) {
              const act = domainMapRef.states[pageState2.state_key].actions[pick.cachedActionKey];
              act.failure_count = (act.failure_count || 0) + 1;
              act.verified = false;
              _saveDomainMap(hostname, domainMapRef);
            }
            _postProgress(_progressCallbackUrl, { type: 'explore:relearn_triggered', hostname, state: pageState2?.state_key, action: pick.cachedActionKey, reason: 'cached_selector_failed', trigger: 'self_heal' });
            _enqueueScan({ url: anchorUrl, agentId, _progressCallbackUrl }, 'self_heal');
          }
        } else {
          // All fallbacks failed — self-heal
          logger.warn(`[explore.agent] _resolveLocator failed for all fallbacks on "${pick.cachedActionKey}" — enqueuing re-scan`);
          _postProgress(_progressCallbackUrl, { type: 'explore:relearn_triggered', hostname, state: pageState2?.state_key, action: pick.cachedActionKey, reason: 'locator_resolve_failed', trigger: 'self_heal' });
          _enqueueScan({ url: anchorUrl, agentId, _progressCallbackUrl }, 'self_heal');
        }
      }
      // Fall through to standard explore loop for this iteration
    }

    if (pick.decision === 'goal_met') {
      // Double-check with GOAL_CHECK_PROMPT for full extraction
      let finalResult = pick.label || 'Goal met';
      try {
        const gcRaw2 = await askWithMessages([
          { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
          { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
        ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
        const gc2 = _parseJson(gcRaw2);
        if (gc2?.result) finalResult = gc2.result;
      } catch (_) {}

      if (currentUrl) history.push({ label: pick.label || '', url: currentUrl });
      await _learnPath(agentId, history, goal, hostname);
      return { ok: true, goal, sessionId: exploreSessionId, result: finalResult, turns: depth, done: true, executionTime: Date.now() - start };
    }

    if (pick.decision === 'need_login') {
      if (!_authAttempted) {
        await _handleAuth(currentUrl || anchorUrl);
        depth--; // re-try this depth after auth
      } else {
        logger.warn('[explore.agent] need_login but auth already attempted — breaking');
        break;
      }
      continue;
    }

    if (pick.decision === 'none') {
      // Navigate back to anchor
      if (currentUrl && currentUrl === anchorUrl) {
        logger.info('[explore.agent] already at anchor — exploration exhausted');
        break;
      }
      logger.info('[explore.agent] no useful item found — navigating back to anchor');
      await _browserAct({ action: 'navigate', url: anchorUrl, sessionId: exploreSessionId, headed, timeoutMs: 15000 }, 18000).catch(() => {});
      await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 6000 }, 8000).catch(() => {});
      continue;
    }

    if (pick.decision === 'search') {
      logger.info(`[explore.agent] search decision — filling searchbox with: "${pick.searchQuery}"`);
      const fillRes = await _browserAct({
        action: 'run-code',
        code: `async page => { await page.getByRole('searchbox').first().fill(${JSON.stringify(pick.searchQuery || goal)}); await page.keyboard.press('Enter'); }`,
        sessionId: exploreSessionId,
        headed,
          timeoutMs: 10000,
      }, 12000).catch(err => ({ ok: false, error: err.message }));

      if (!fillRes?.ok) {
        logger.warn(`[explore.agent] search fill failed: ${fillRes?.error} — trying find-label fallback`);
        await _browserAct({
          action: 'run-code',
          code: `async page => { const inp = page.getByLabel('Search') || page.getByPlaceholder('Search'); await inp.fill(${JSON.stringify(pick.searchQuery || goal)}); await page.keyboard.press('Enter'); }`,
          sessionId: exploreSessionId,
          headed,
              timeoutMs: 10000,
        }, 12000).catch(() => {});
      }

      await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});

      // Immediate goal check on search results
      const srSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 8000 }, 10000).catch(() => null);
      if (srSnap?.ok && srSnap.result) currentSnapshot = srSnap.result;

      try {
        const srGcRaw = await askWithMessages([
          { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
          { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
        ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
        const srGc = _parseJson(srGcRaw);
        if (srGc?.satisfied && (srGc.confidence ?? 0) >= 0.6) {
          const srUrl = await _getCurrentUrl(exploreSessionId, headed);
          if (srUrl) history.push({ label: `search:${pick.searchQuery}`, url: srUrl });
          await _learnPath(agentId, history, goal, hostname);
          return { ok: true, goal, sessionId: exploreSessionId, result: srGc.result || 'Search results satisfied goal', turns: depth, done: true, executionTime: Date.now() - start };
        }
      } catch (_) {}

      continue;
    }

    if (pick.decision === 'click' && pick.ref) {
      // Mark as visited
      visited.add(pick.ref);

      const clickRes = await _browserAct({
        action: 'click',
        selector: pick.ref,
        sessionId: exploreSessionId,
        headed,
          timeoutMs: 10000,
      }, 12000).catch(err => ({ ok: false, error: err.message }));

      if (!clickRes?.ok) {
        logger.warn(`[explore.agent] click ${pick.ref} failed: ${clickRes?.error} — skipping`);
        continue;
      }

      await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
      const postClickUrl = await _getCurrentUrl(exploreSessionId, headed);
      if (postClickUrl) visited.add(postClickUrl);
      history.push({ label: pick.label || pick.ref, url: postClickUrl || '' });

      // Extract stable selectors for this element and save to domain map (lazy learning)
      if (hostname && pick.ref) {
        const selectorProfile = await _extractStableSelectors(pick.ref, exploreSessionId, headed, pick.label, 'click');
        if (selectorProfile?.locators?.primary) {
          try {
            const pageStateForLearn = await _identifyPageState(currentSnapshot, currentUrl);
            if (pageStateForLearn?.state_key) {
              const existingMap = _loadDomainMap(hostname);
              if (!existingMap.states[pageStateForLearn.state_key]) {
                existingMap.states[pageStateForLearn.state_key] = { identification: pageStateForLearn.identification || '', actions: {} };
              }
              const actionKey = (pick.label || pick.ref).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
              existingMap.states[pageStateForLearn.state_key].actions[actionKey] = {
                skill_name: actionKey,
                interaction: 'click',
                locators: selectorProfile.locators,
                fingerprint: selectorProfile.fingerprint,
                success_criteria: selectorProfile.success_criteria || { expected_url_change: true, element_to_appear: null },
                verified: false,
                last_verified: null,
                failure_count: 0,
              };
              _saveDomainMap(hostname, existingMap);
              logger.info(`[explore.agent] learned selector for "${actionKey}" on state "${pageStateForLearn.state_key}"`);
            }
          } catch (_) { /* non-fatal */ }
        }
      }

      // Post-click goal check
      const postClickSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 8000 }, 10000).catch(() => null);
      if (postClickSnap?.ok && postClickSnap.result) currentSnapshot = postClickSnap.result;

      try {
        const postGcRaw = await askWithMessages([
          { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
          { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
        ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
        const postGc = _parseJson(postGcRaw);
        if (postGc?.satisfied && (postGc.confidence ?? 0) >= 0.7) {
          await _learnPath(agentId, history, goal, hostname);
          return { ok: true, goal, sessionId: exploreSessionId, result: postGc.result || `Reached: ${pick.label}`, turns: depth, done: true, executionTime: Date.now() - start };
        }
      } catch (_) {}

      continue;
    }

    // Unknown decision — break
    logger.warn(`[explore.agent] unknown decision "${pick.decision}" — breaking`);
    break;
  }

  // ── Exhausted loop ───────────────────────────────────────────────────────
  if (_usedLearnedRules) {
    logger.warn('[explore.agent] goal not met after using learned rules — evicting stale rules');
    const evictKeys = [agentId];
    if (hostname) evictKeys.push(hostname);
    for (const key of evictKeys) {
      await skillDb.deleteContextRulesByKey(key).catch(() => {});
    }
  }

  logger.info(`[explore.agent] explore exhausted after ${depth} steps — goal not met`);
  return {
    ok: false,
    goal,
    sessionId: exploreSessionId,
    result: `Could not reach goal after ${depth} exploration step(s)`,
    turns: depth,
    done: false,
    executionTime: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// scanDomain — Mode B: background domain probe, builds/extends domain map
// ---------------------------------------------------------------------------
async function scanDomain(args) {
  const {
    url,
    agentId       = 'explore_agent',
    sessionId:    callerSessionId,
    maxScanDepth  = 1,
    goal,                         // Single goal (backward compat)
    goals,                        // Array of goals for multi-goal learning
    _progressCallbackUrl,
    _trigger      = 'manual',
    headed:       callerHeaded,  // caller may pass headed:true to reuse a visible learn session
    _preAuthed,                   // true if user was already logged in (skip auth overlay)
  } = args || {};

  if (!url) return { ok: false, error: 'url is required for scanDomain' };

  let hostname;
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {
    return { ok: false, error: `Invalid url: ${url}` };
  }

  // Normalize goals array from goal/goals parameters (multi-goal support)
  const goalsArray = goals || (goal ? [goal] : []);
  if (goalsArray.length > 0) {
    logger.info(`[explore.agent] Multi-goal scanning: ${goalsArray.length} goal(s)`);
  }

  const start          = Date.now();
  // Use stable session name (no timestamp) so the same Chrome profile dir is reused across scans.
  // Timestamped names created a new 20MB profile dir on every heartbeat/background scan.
  const scanSessionId  = callerSessionId || `${hostname}_scan`;
  // If caller provides a sessionId (e.g. learn_mode reusing auth session), respect their headed setting.
  // Standalone background scans (no callerSessionId) are always headless.
  const headed         = callerSessionId ? (callerHeaded !== undefined ? callerHeaded : true) : false;
  // When a caller session is provided (learn_mode), use tab-new per page so we never navigate
  // the auth tab (which would trigger Cloudflare re-challenges). Background scans navigate normally.
  const useTabStrategy = !!callerSessionId;
  let   _scanTabIdx    = -1; // index of the currently open scan tab (tab strategy only)
  let totalActions     = 0;
  let botBlocked       = false;
  
  // Scan-level statistics for completion summary
  let scanStats = {
    successCount: 0,
    failCount: 0,
    filteredCount: 0,
    totalElements: 0,
    statesScanned: 0
  };

  // Reset scan cancel flag at entry so previous cancellations don't affect this run
  _scanCancelFlag = false;

  logger.info(`[explore.agent] scanDomain config: session=${scanSessionId} headed=${headed} trigger=${_trigger}`);

  logger.info(`[explore.agent] scanDomain start: ${hostname} (trigger=${_trigger} maxScanDepth=${maxScanDepth})`);
  _postProgress(_progressCallbackUrl, { type: 'explore:scan_start', hostname, trigger: _trigger, agentId });

  try {
    // Navigate to start URL.
    // Tab strategy: open a new tab in the caller's already-authenticated Chrome window.
    // This avoids navigating the auth tab (which would re-trigger Cloudflare challenges).
    // Background scans (no callerSessionId): navigate normally in their own session.
    if (useTabStrategy) {
      logger.info(`[explore.agent] scan: tab-new strategy — opening scan tab for ${url} on session=${scanSessionId}`);
      const _tabNewRes = await _browserAct({ action: 'tab-new', url, sessionId: scanSessionId, headed, timeoutMs: 30000 }, 33000).catch(() => null);
      // Determine tab index from tab-list output embedded in result
      if (_tabNewRes?.result) {
        const _tabCount = ((_tabNewRes.result || '').match(/^\s*-\s+\d+:/gm) || []).length;
        _scanTabIdx = Math.max(0, _tabCount - 1);
      }
      // If user was already logged in, close the original tab (tab 0) to avoid duplicate site tabs
      if (_preAuthed && _scanTabIdx > 0) {
        logger.info(`[explore.agent] scan: closing original tab 0 (pre-authed, avoiding duplicate tabs)`);
        await _browserAct({ action: 'tab-close', sessionId: scanSessionId, headed, tabIndex: 0 }, 5000).catch(() => {});
        // Adjust scan tab index since tab 0 is now gone
        _scanTabIdx = Math.max(0, _scanTabIdx - 1);
      }
    } else {
      await _browserAct({ action: 'navigate', url, sessionId: scanSessionId, headed, timeoutMs: 25000 }, 28000).catch(() => {});
    }

    await _browserAct({ action: 'waitForStableText', sessionId: scanSessionId, headed, timeoutMs: 6000 }, 8000).catch(() => {});

    // Extract content extraction signals from the landing page
    logger.info(`[explore.agent] scan: extracting content signals for ${hostname}`);
    const contentSignals = await _extractContentSignals(scanSessionId, headed);
    if (contentSignals?.primary_selector) {
      logger.info(`[explore.agent] scan: detected content type="${contentSignals.content_type}" selector="${contentSignals.primary_selector}" confidence=${contentSignals.confidence}`);
    }

    const existingMap = _loadDomainMap(hostname);
    // Clean old history links from existing map before merging new scan data
    const cleanedExisting = _cleanDomainMap(existingMap);
    const newMap      = { 
      domain: hostname, 
      version: '2.0', 
      last_scanned: null, 
      states: {},
      // Store schemas for reference and validation
      _schemas: {
        interactions: INTERACTION_SCHEMAS,
        filter: DEFAULT_FILTER_CONFIG
      },
      ...(contentSignals?.primary_selector ? {
        content_extraction: {
          primary_selector: contentSignals.primary_selector,
          fallback_selector: contentSignals.fallback_selector,
          content_type: contentSignals.content_type,
          confidence: contentSignals.confidence,
          last_updated: new Date().toISOString()
        }
      } : {})
    };

    const visitedUrls = new Set([url]);
    const scanQueue   = [{ url, depth: 0 }];
    // _scanTabIdx declared above at function start (TDZ fix)

    while (scanQueue.length > 0) {
      // Cancel checkpoint — after each page in the scan queue
      if (_scanCancelFlag) {
        logger.info(`[explore.agent] scanDomain cancelled by user at page queue (${visitedUrls.size} pages visited)`);
        _postProgress(_progressCallbackUrl, { type: 'explore:scan_cancelled', hostname, message: 'Scan cancelled by user' });
        return { ok: false, hostname, reason: 'cancelled' };
      }

      const { url: pageUrl, depth } = scanQueue.shift();

      if (useTabStrategy) {
        // Tab strategy: open each page in a fresh tab on the authenticated session.
        // This keeps the Cloudflare-cleared session alive and avoids profile lock conflicts.
        // The initial tab-new for depth=0 was already done above; depth>0 opens new tabs.
        if (depth > 0) {
          const _dTabRes = await _browserAct({ action: 'tab-new', url: pageUrl, sessionId: scanSessionId, headed, timeoutMs: 28000 }, 31000).catch(() => null);
          if (_dTabRes?.result) {
            const _tc = ((_dTabRes.result || '').match(/^\s*-\s+\d+:/gm) || []).length;
            _scanTabIdx = Math.max(0, _tc - 1);
          }
          await _browserAct({ action: 'waitForStableText', sessionId: scanSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
        }
        // depth=0: already navigated via the initial tab-new above — just snapshot
      } else {
        // Background scan: navigate the single session tab normally
        const currentScanUrl = await _getCurrentUrl(scanSessionId, headed);
        if (currentScanUrl !== pageUrl) {
          await _browserAct({ action: 'navigate', url: pageUrl, sessionId: scanSessionId, headed, timeoutMs: 20000 }, 23000).catch(() => {});
          await _browserAct({ action: 'waitForStableText', sessionId: scanSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
        }
      }

      let snapRes = await _browserAct({ action: 'snapshot', sessionId: scanSessionId, headed, timeoutMs: 10000 }, 12000).catch(() => null);
      let snapshot = snapRes?.ok && snapRes.result ? snapRes.result : '';
      if (!snapshot) {
        if (useTabStrategy && depth > 0 && _scanTabIdx >= 0) {
          await _browserAct({ action: 'tab-close', sessionId: scanSessionId, headed, tabIndex: _scanTabIdx }, 5000).catch(() => {});
        }
        continue;
      }

      // If the page is a login wall, attempt auth with same session before extracting elements.
      // This handles sites that show a sign-in modal over '/' without redirecting to /login.
      if (_isLoginWall(snapshot, pageUrl)) {
        logger.info(`[explore.agent] scan: login wall detected at ${pageUrl} — attempting waitForAuth`);
        const authRes = await _browserAct({
          action: 'waitForAuth',
          url: pageUrl,
          authSuccessUrl: hostname,
          sessionId: scanSessionId,
          headed: true,
          timeoutMs: 120000,
        }, 125000).catch(err => ({ ok: false, error: err.message }));
        if (authRes?.ok) {
          logger.info(`[explore.agent] scan: auth succeeded — re-snapping`);
          snapRes = await _browserAct({ action: 'snapshot', sessionId: scanSessionId, headed: true, timeoutMs: 10000 }, 12000).catch(() => null);
          snapshot = snapRes?.ok && snapRes.result ? snapRes.result : '';
          if (!snapshot) continue;
        } else {
          logger.warn(`[explore.agent] scan: auth not completed (${authRes?.error}) — skipping page`);
          continue;
        }
      }

      const pageStateInfo = await _identifyPageState(snapshot, pageUrl);
      const stateKey = pageStateInfo?.state_key || `page_${depth}_${visitedUrls.size}`;
      const identification = pageStateInfo?.identification || `URL contains '${new URL(pageUrl).pathname}'`;

      logger.info(`[explore.agent] scan: state="${stateKey}" at ${pageUrl}`);

      // ---------------------------------------------------------------------------
      // Generic History Link Detection — works across ANY site, not Perplexity-specific
      // Uses configurable filter rules that can be overridden per-site
      // Returns: history score (0+), where >= minHistoryScore means likely history
      // ---------------------------------------------------------------------------
      const filterConfig = _getFilterConfigForSite(hostname, existingMap);
      
      function isGenericHistoryLink(element, surroundingText) {
        const href = element.href || '';
        const text = element.text || element.ariaLabel || '';
        const parentText = surroundingText || '';
        
        // Score-based detection (multiple signals = higher confidence)
        let historyScore = 0;
        
        // Signal 1: URL matches historical patterns from config
        for (const pattern of filterConfig.historicalUrlPatterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(href)) {
              historyScore += 2;
              break; // Only count once even if multiple patterns match
            }
          } catch (_) {
            // Skip invalid regex patterns
          }
        }
        
        // Signal 2: URL contains conversational path segments (fallback)
        const conversationalPaths = ['chat', 'conversation', 'thread', 'message', 'query', 'search'];
        if (conversationalPaths.some(p => href.toLowerCase().includes(`/${p}/`))) {
          historyScore += 1;
        }
        
        // Signal 3: Text looks like a user query (uses config patterns)
        for (const pattern of filterConfig.queryTextPatterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(text) && text.length > 10 && text.length < 200) {
              historyScore += 2;
              break;
            }
          } catch (_) {
            // Skip invalid regex patterns
          }
        }
        
        // Signal 4: Parent container suggests history list (uses config)
        for (const indicator of filterConfig.historyContainerIndicators) {
          if (parentText.toLowerCase().includes(indicator)) {
            historyScore += 2;
            break;
          }
        }
        
        // Signal 5: Element is in a list container (common for history)
        if (element.tag === 'a' && element.inList) {
          historyScore += 1;
        }
        
        // Signal 6: Long URL path (specific item, not general navigation)
        if (href.split('/').length > 4) {
          historyScore += 1;
        }
        
        // Signal 7: Very long text (likely user query, not UI label)
        if (text.length > 50) {
          historyScore += 2;
        }
        
        // Signal 8: Contains CJK characters (likely user query in Asian language)
        if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text)) {
          historyScore += 2;
        }
        
        // Return the score (caller checks against threshold)
        return historyScore;
      }
      
      // Check if element is a primary control (should always keep)
      function isPrimaryControl(element) {
        const text = (element.text || element.ariaLabel || '').toLowerCase();
        for (const pattern of filterConfig.primaryControlPatterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(text)) {
              return true;
            }
          } catch (_) {
            // Skip invalid regex patterns
          }
        }
        return false;
      }

      // ---------------------------------------------------------------------------
      // Generic UI Element Classification — determines what an element DOES
      // Returns interaction type and metadata for all 10+ interaction types
      // ---------------------------------------------------------------------------
      function classifyInteraction(attrs) {
        const { tag, role, type, contenteditable, draggable, hasPopup, checked, scrollHeight, clientHeight, overflowY, className, ariaLabel } = attrs;
        
        // 1. File upload (most specific)
        if (tag === 'input' && type === 'file') {
          return { type: 'upload', params: ['files'], priority: 1 };
        }
        
        // 2. Checkboxes
        if (tag === 'input' && type === 'checkbox') {
          return { type: checked ? 'uncheck' : 'check', params: [], priority: 2 };
        }
        
        // 3. Dropdowns
        if (tag === 'select' || (role === 'combobox' && hasPopup === 'listbox')) {
          return { type: 'select', params: ['value'], options: attrs.options || [], priority: 3 };
        }
        
        // 4. Contenteditable rich text editors (CRITICAL: Perplexity search input!)
        if (contenteditable === 'true' && (role === 'textbox' || !role)) {
          // Detect if this is a search input that needs Enter pressed after typing
          const isSearch = (ariaLabel || '').toLowerCase().includes('search') || 
                           (className || '').toLowerCase().includes('search') ||
                           (attrs.placeholder || '').toLowerCase().includes('search');
          return { 
            type: 'type', 
            params: ['text'], 
            priority: 4,
            followUp: isSearch ? { action: 'press', key: 'Enter' } : null
          };
        }
        
        // 5. Standard inputs
        if (tag === 'input' || tag === 'textarea') {
          // Detect if search input
          const isSearch = type === 'search' || 
                           (attrs.placeholder || '').toLowerCase().includes('search') ||
                           (ariaLabel || '').toLowerCase().includes('search');
          return { 
            type: 'fill', 
            params: ['text'], 
            priority: 5,
            followUp: isSearch ? { action: 'press', key: 'Enter' } : null
          };
        }
        
        // 6. Scrollable containers (feeds, lists, modals)
        if ((scrollHeight && clientHeight && scrollHeight > clientHeight * 1.2) ||
            overflowY === 'auto' || overflowY === 'scroll' ||
            (className || '').match(/scrollable|overflow|feed|list/)) {
          return { 
            type: 'scroll', 
            params: ['direction', 'distance'], 
            priority: 6,
            defaults: { direction: 'down', distance: 500 }
          };
        }
        
        // 7. Draggable
        if (draggable) {
          return { type: 'drag', params: ['targetSelector'], priority: 7 };
        }
        
        // 8. Hover menus (has popup/dropdown)
        if (hasPopup === 'true' || hasPopup === 'menu' || hasPopup === 'listbox') {
          return { type: 'hover', params: [], priority: 8, reveals: 'dropdown' };
        }
        
        // 9. Double-click (file managers, grids)
        if (role === 'gridcell' || role === 'listitem' || 
            (className || '').match(/grid|file|item/)) {
          return { type: 'dblclick', params: [], priority: 9 };
        }
        
        // 10. Default: click for buttons and links
        if (['button', 'a'].includes(tag) || role === 'button') {
          return { type: 'click', params: [], priority: 10 };
        }
        
        return { type: 'unknown', params: [], priority: 11 };
      }
      
      // ---------------------------------------------------------------------------
      // Multi-Step Action Detection — determines if action needs follow-up
      // ---------------------------------------------------------------------------
      function detectMultiStepSequence(interactionInfo, attrs) {
        const sequences = [];
        
        // Type/Fill → Press Enter (for search inputs)
        if ((interactionInfo.type === 'type' || interactionInfo.type === 'fill') && interactionInfo.followUp) {
          sequences.push({
            name: `${interactionInfo.type}_and_submit`,
            steps: [
              { action: interactionInfo.type, param: 'text' },
              interactionInfo.followUp
            ]
          });
        }
        
        // Hover → Click (for dropdown menus)
        if (interactionInfo.type === 'hover' && interactionInfo.reveals === 'dropdown') {
          sequences.push({
            name: 'open_dropdown_menu',
            steps: [
              { action: 'hover' },
              { action: 'click', target: 'revealed_item' }
            ]
          });
        }
        
        return sequences;
      }

      // ---------------------------------------------------------------------------
      // Skill Name Sanitizer — prevents empty, underscore-only, or invalid names
      // ---------------------------------------------------------------------------
      function generateSkillName(label, interaction) {
        if (!label || typeof label !== 'string') {
          return `${interaction}_element`;
        }
        
        // Remove special chars, limit length
        let name = label
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')  // Remove special chars
          .trim()
          .slice(0, 30)              // Limit length
          .replace(/\s+/g, '_');      // Spaces to underscores
        
        // Prevent empty or underscore-only names
        if (!name || name.match(/^_*$/) || name.length < 2) {
          name = `${interaction}_element`;
        }
        
        // Ensure it starts with a letter
        if (!/^[a-z]/.test(name)) {
          name = 'action_' + name;
        }
        
        return name;
      }

      // Detect bot/Cloudflare protection page — skip extraction, flag for caller
      const BOT_STATE_RE = /security.verif|cloudflare|bot.protect|captcha|ddos.protect|access.denied|challenge/i;
      if (BOT_STATE_RE.test(stateKey) || BOT_STATE_RE.test(identification)) {
        logger.warn(`[explore.agent] scan: bot-protection state detected ("${stateKey}") — skipping page`);
        botBlocked = true;
        _postProgress(_progressCallbackUrl, { type: 'explore:bot_detected', hostname, stateKey, pageUrl });
        if (useTabStrategy && depth > 0 && _scanTabIdx >= 0) {
          await _browserAct({ action: 'tab-close', sessionId: scanSessionId, headed, tabIndex: _scanTabIdx }, 5000).catch(() => {});
        }
        continue;
      }

      if (!newMap.states[stateKey]) {
        newMap.states[stateKey] = { identification, actions: {}, data: [] };
      }

      // Extract all interactable items from snapshot
      const allItems = _extractNavItems(snapshot);

      // Also extract inputs/selects from snapshot
      // Handles same formats as _extractNavItems:
      //   Format A: "  - [e12] textbox \"Search...\""
      //   Format B: "    - searchbox \"Search...\" [ref=e52]"
      const inputRefs = [];
      const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

      for (const line of snapshot.split('\n')) {
        let ref = null;
        let role = null;
        let label = '';

        // Format A: [eN] role "label"
        const mA = line.match(/^\s*-?\s*\[?(e\d+)\]?\s+(\w[\w-]*)\s+"([^"]*)"/i);
        if (mA) {
          [, ref, role, label] = mA;
        } else {
          // Format B: role "label" [ref=eN]
          const mB = line.match(/^\s*-\s+(\w[\w-]*)\s+"([^"]*)"/i);
          if (mB) {
            [, role, label] = mB;
            const refMatch = line.match(/\[ref=(e\d+)\]/i);
            ref = refMatch ? refMatch[1] : null;
          }
        }

        // Note: playwright-cli uses e12 format (NOT @e12) - resolveRef checks /^e\d+$/i
        if (ref && role && INPUT_ROLES.has(role.toLowerCase())) {
          inputRefs.push({ ref, label: label.trim() || role, role: role.toLowerCase() });
        }
      }

      // Merge links/buttons + inputs
      const allScanItems = [...allItems, ...inputRefs];
      let pageActions = 0;

      const totalElements = Math.min(allScanItems.length, 30);
      logger.info(`[explore.agent] scan: state="${stateKey}" — ${totalElements} elements to process (capped at 30)`);
      _postProgress(_progressCallbackUrl, { type: 'explore:scan_elements_start', hostname, state: stateKey, elementCount: totalElements, depth, message: `🔍 Discovering ${totalElements} interactive elements on ${stateKey}...` });

      // State-level counters (reset per state)
      let stateSuccess = 0;
      let stateFail = 0;
      let stateFiltered = 0;
      let processedCount = 0;
      
      for (const item of allScanItems.slice(0, 30)) {
        // Cancel checkpoint — during element extraction loop (every 5 elements)
        if (processedCount > 0 && processedCount % 5 === 0 && _scanCancelFlag) {
          logger.info(`[explore.agent] scanDomain cancelled by user during element extraction (${processedCount}/${totalElements})`);
          _postProgress(_progressCallbackUrl, { type: 'explore:scan_cancelled', hostname, message: 'Scan cancelled by user' });
          return { ok: false, hostname, reason: 'cancelled' };
        }

        processedCount++;
        scanStats.totalElements++;
        const progressPct = Math.round((processedCount / totalElements) * 100);
        
        // Send progress update every 3 elements or on first
        if (processedCount === 1 || processedCount % 3 === 0) {
          _postProgress(_progressCallbackUrl, {
            type: 'explore:scan_progress',
            hostname,
            state: stateKey,
            message: `📍 Processing element ${processedCount}/${totalElements} (${progressPct}%) — ${item.label}`,
            current: processedCount,
            total: totalElements,
            percent: progressPct,
            depth
          });
        }
        // First, extract attributes to determine interaction type and filter
        const attrsRes = await _browserAct({
          action: 'evaluate',
          text: `(el) => el ? ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').trim().slice(0, 80),
            ariaLabel: el.getAttribute('aria-label'),
            role: el.getAttribute('role'),
            type: el.getAttribute('type'),
            href: el.getAttribute('href'),
            id: el.id || null,
            contenteditable: el.getAttribute('contenteditable'),
            draggable: el.getAttribute('draggable') === 'true',
            checked: el.checked || false,
            hasPopup: el.getAttribute('aria-haspopup'),
            inList: !!(el.closest && (el.closest('ul') || el.closest('ol') || el.closest('[role="list"]'))),
            parentText: el.parentElement ? (el.parentElement.getAttribute('aria-label') || el.parentElement.innerText || '').slice(0, 50) : '',
          }) : null`,
          ref: item.ref,
          sessionId: scanSessionId,
          headed,
          timeoutMs: 5000,
        }, 7000).catch(() => null);
        
        if (!attrsRes?.ok || !attrsRes.result) {
          logger.info(`[explore.agent] scan: failed to extract attrs for ref=${item.ref} — skipping`);
          stateFail++;
          scanStats.failCount++;
          continue;
        }
        
        let attrs;
        try {
          attrs = JSON.parse(typeof attrsRes.result === 'string' ? attrsRes.result : JSON.stringify(attrsRes.result));
        } catch (e) {
          logger.info(`[explore.agent] scan: failed to parse attrs for ref=${item.ref} — skipping`);
          stateFail++;
          scanStats.failCount++;
          continue;
        }
        
        // Determine what type of element this is
        // Priority: 1. History detection (strong signals), 2. Primary controls, 3. Regular actions
        const historyScore = isGenericHistoryLink(attrs, attrs.parentText);
        const isHistory = historyScore >= filterConfig.minHistoryScore;
        const isPrimary = isPrimaryControl(attrs);
        
        // If it's clearly history, save to data array but don't add as action (unless it's also primary)
        if (isHistory && !isPrimary) {
          logger.info(`[explore.agent] scan: saving history item to data ref=${item.ref} label="${item.label}" score=${historyScore}`);
          
          // Add to data array for potential summarization/querying
          newMap.states[stateKey].data.push({
            type: 'history',
            ref: item.ref,
            label: item.label,
            href: attrs.href,
            timestamp: new Date().toISOString(),
            score: historyScore,
            attrs: {
              tag: attrs.tag,
              ariaLabel: attrs.ariaLabel,
              text: attrs.text
            }
          });
          
          _postProgress(_progressCallbackUrl, {
            type: 'explore:scan_data_collected',
            hostname,
            state: stateKey,
            message: `📊 Collected history item: "${item.label}"`,
            label: item.label,
            dataType: 'history'
          });
          
          stateFiltered++;
          scanStats.filteredCount++;
          continue;  // Skip adding as action - only save as data
        }
        
        // If it's a primary control, always keep it as an action (even if it looks like history)
        if (isPrimary) {
          logger.info(`[explore.agent] scan: keeping primary control ref=${item.ref} label="${item.label}"`);
          // Continue to process as action below
        }
        
        // Classify interaction type using comprehensive detection
        const interactionInfo = classifyInteraction(attrs);
        const interaction = interactionInfo.type;
        
        logger.info(`[explore.agent] scan: extracting selectors for ref=${item.ref} label="${item.label}" interaction=${interaction}`);
        _postProgress(_progressCallbackUrl, {
          type: 'explore:scan_extracting',
          hostname,
          state: stateKey,
          message: `🔧 Extracting selectors for: "${item.label}" (${interaction})`,
          label: item.label,
          interaction,
          ref: item.ref
        });

        // Visual highlight — pulses the element in the headed browser so the user
        // can see what the agent is studying in real time. No-op when headless.
        await _highlightElement(item.ref, item.label, scanSessionId, headed);

        // Skip unknown interactions
        if (interaction === 'unknown') {
          logger.info(`[explore.agent] scan: unknown interaction type for ref=${item.ref} — skipping`);
          stateFail++;
          scanStats.failCount++;
          continue;
        }
        
        const selectorProfile = await _extractStableSelectors(item.ref, scanSessionId, headed, item.label, interaction);
        if (!selectorProfile?.locators?.primary) {
          logger.info(`[explore.agent] scan: selector extract FAILED for ref=${item.ref} label="${item.label}" — skipping`);
          _postProgress(_progressCallbackUrl, {
            type: 'explore:scan_failed',
            hostname,
            state: stateKey,
            message: `❌ Failed to extract: "${item.label}"`,
            label: item.label
          });
          stateFail++;
          scanStats.failCount++;
          continue;
        }
        stateSuccess++;
        scanStats.successCount++;

        // Check goal relevance before adding action (support multi-goal)
        const relevance = _calculateGoalRelevance(item.label, attrs, interaction, goalsArray);
        const RELEVANCE_THRESHOLD = 0.3; // Minimum relevance to keep action
        
        if (relevance < RELEVANCE_THRESHOLD) {
          const goalsStr = goalsArray.length > 1 ? `${goalsArray.length} goals` : (goalsArray[0] || 'none');
          logger.info(`[explore.agent] scan: filtering out low-relevance action "${item.label}" (relevance: ${relevance.toFixed(2)}) for ${goalsStr}`);
          stateFiltered++;
          scanStats.filteredCount++;
          continue;
        }
        
        const goalsStr = goalsArray.length > 1 ? `${goalsArray.length} goals` : (goalsArray[0] || 'none');
        logger.info(`[explore.agent] scan: keeping relevant action "${item.label}" (relevance: ${relevance.toFixed(2)}) for ${goalsStr}`);

        // Use improved skill name generation
        const actionKey = generateSkillName(item.label, interaction);

        _postProgress(_progressCallbackUrl, {
          type: 'explore:scan_success',
          hostname,
          state: stateKey,
          message: `✅ Captured: "${item.label}" (${interaction})`,
          label: item.label,
          interaction,
          skillName: actionKey
        });
        
        // Build parameter metadata for parameterized skills
        const acceptsParams = interactionInfo.params || [];
        const paramMapping = {};
        const examples = [];
        
        if (acceptsParams.length > 0) {
          // Create param mapping for each parameter
          acceptsParams.forEach(param => {
            if (param === 'text') {
              paramMapping.query = { field: 'text', required: true };
            } else if (param === 'value') {
              paramMapping.selection = { field: 'value', required: true, options: interactionInfo.options || [] };
            } else if (param === 'files') {
              paramMapping.file_path = { field: 'files', required: true, type: 'array' };
            } else {
              paramMapping[param] = { field: param, required: true };
            }
          });
          
          // Generate example based on label
          if (item.label.toLowerCase().includes('search') || item.label.toLowerCase().includes('ask')) {
            examples.push({ query: 'best vegan restaurants near me' });
          } else if (interaction === 'fill' || interaction === 'type') {
            examples.push({ text: item.placeholder || 'Enter your text here' });
          }
        }
        
        // Detect multi-step sequences (e.g., type then press Enter)
        const multiStepSequences = detectMultiStepSequence(interactionInfo, attrs);
        
        // Build follow-up actions
        const followUpActions = [];
        if (interactionInfo.followUp) {
          followUpActions.push(interactionInfo.followUp);
        }
        if (interactionInfo.defaults) {
          followUpActions.push({ action: 'set_defaults', values: interactionInfo.defaults });
        }
        
        newMap.states[stateKey].actions[actionKey] = {
          skill_name: actionKey,
          interaction,
          locators: selectorProfile.locators,
          fingerprint: selectorProfile.fingerprint,
          success_criteria: selectorProfile.success_criteria || { expected_url_change: interaction === 'click', element_to_appear: null },
          verified: false,
          last_verified: null,
          failure_count: 0,
          // Parameter support for Phase 2
          accepts_params: acceptsParams,
          param_mapping: Object.keys(paramMapping).length > 0 ? paramMapping : null,
          examples: examples.length > 0 ? examples : null,
          // Multi-step action support (Phase 3)
          follow_up_actions: followUpActions.length > 0 ? followUpActions : null,
          multi_step_sequences: multiStepSequences.length > 0 ? multiStepSequences : null,
          // Parameter defaults for scroll, etc.
          param_defaults: interactionInfo.defaults || null,
          // Goal relevance tracking
          goal_relevance: relevance,
          goal_matched: goal || null,
          // Additional metadata
          _options: interactionInfo.options || null,
          _priority: interactionInfo.priority || 9,
          _reveals: interactionInfo.reveals || null,
        };
        pageActions++;
        totalActions++;
      }
      
      scanStats.statesScanned++;
      logger.info(`[explore.agent] scan: state="${stateKey}" — ${stateSuccess} succeeded, ${stateFail} failed, ${stateFiltered} filtered (history) out of ${Math.min(allScanItems.length, 30)} attempted`);

      _postProgress(_progressCallbackUrl, { type: 'explore:scan_progress', hostname, state: stateKey, actionsFound: pageActions, depth });

      // Close tab when done with this page (tab strategy only, depth>0 tabs)
      if (useTabStrategy && depth > 0 && _scanTabIdx >= 0) {
        await _browserAct({ action: 'tab-close', sessionId: scanSessionId, headed, tabIndex: _scanTabIdx }, 5000).catch(() => {});
      }

      // Enqueue same-hostname links for next depth level
      if (depth < maxScanDepth) {
        for (const item of allItems.slice(0, 10)) {
          // Only follow links with hrefs that stay on the same hostname
          // (we extract href from the snapshot fingerprint where possible)
          const hrefMatch = snapshot.match(new RegExp(`ref=${item.ref.replace('@', '@?')}[\\s\\S]{0,200}?href=["']([^"']+)`));
          if (hrefMatch) {
            try {
              const linkUrl = new URL(hrefMatch[1], url).href;
              const linkHostname = new URL(linkUrl).hostname.replace(/^www\./, '');
              if (linkHostname === hostname && !visitedUrls.has(linkUrl)) {
                visitedUrls.add(linkUrl);
                scanQueue.push({ url: linkUrl, depth: depth + 1 });
              }
            } catch (_) {}
          }
        }
      }
    }

    // Merge with cleaned existing map and save
    const mergedMap = _mergeDomainMap(cleanedExisting, newMap);
    
    // Update metadata for v2.0 schema
    mergedMap.version = '2.0';
    mergedMap._schemas = INTERACTION_SCHEMAS;
    mergedMap._filterConfig = {
      historyContainerIndicators: ['history', 'recent', 'previous', 'conversation'],
      primaryControlPatterns: ['new', 'search', 'ask', 'create', 'settings', 'computer']
    };
    mergedMap.last_scanned = new Date().toISOString();
    
    _saveDomainMap(hostname, mergedMap);

    const mapPath = _mapPath(hostname);
    const duration = Date.now() - start;
    logger.info(`[explore.agent] scanDomain complete: ${hostname} — ${totalActions} actions in ${duration}ms`);
    _postProgress(_progressCallbackUrl, {
      type: 'explore:scan_complete',
      hostname,
      totalActions,
      mapPath,
      duration,
      trigger: _trigger,
      message: `🛠️ Generating skills from ${totalActions} discovered actions...`,
      phase: 'generating'
    });

    // Cancel checkpoint — before skill generation phase
    if (_scanCancelFlag) {
      logger.info(`[explore.agent] scanDomain cancelled by user before skill generation`);
      _postProgress(_progressCallbackUrl, { type: 'explore:scan_cancelled', hostname, message: 'Scan cancelled by user' });
      // Still save the partial domain map so discovered states aren't lost
      const partialMerged = _mergeDomainMap(cleanedExisting, newMap);
      partialMerged.last_scanned = new Date().toISOString();
      _saveDomainMap(hostname, partialMerged);
      return { ok: false, hostname, reason: 'cancelled' };
    }

    // Generate skills from all discovered actions (skill cache)
    let skillsGenerated = 0;
    let actionCount = 0;
    
    logger.info(`[explore.agent] Starting skill generation from ${Object.keys(newMap.states || {}).length} states...`);
    
    for (const [stateKey, state] of Object.entries(newMap.states || {})) {
      const actionKeys = Object.keys(state.actions || {});
      logger.info(`[explore.agent] Processing state "${stateKey}" with ${actionKeys.length} actions`);
      
      for (const [actionKey, action] of Object.entries(state.actions || {})) {
        actionCount++;
        try {
          const skill = generateSkillFromAction(hostname, stateKey, actionKey);
          if (skill && !skill.error) {
            // Save skill with metadata for cache management
            const skillWithMeta = {
              ...skill,
              _meta: {
                source_domain: hostname,
                source_action: actionKey,
                created_at: new Date().toISOString(),
                goal_tied: true,  // All scanned skills are goal-tied initially
                use_count: 0,
                last_used: null
              }
            };
            
            // Register in skill registry
            await _registerSkill(skillWithMeta);
            skillsGenerated++;
            logger.info(`[explore.agent] Generated skill: ${skill.name || actionKey}`);
            
            if (skillsGenerated % 3 === 0) {
              _postProgress(_progressCallbackUrl, {
                type: 'explore:scan_skill_progress',
                hostname,
                message: `⚡ Generated ${skillsGenerated}/${totalActions} skills...`,
                current: skillsGenerated,
                total: totalActions
              });
            }
          } else if (skill?.error) {
            logger.warn(`[explore.agent] Skill generation failed for ${actionKey}: ${skill.error}`);
          }
        } catch (e) {
          logger.warn(`[explore.agent] Failed to generate skill for ${actionKey}: ${e.message}`);
        }
      }
    }
    
    // Generate navigate_history skill from collected data
    const dataItems = Object.values(newMap.states || {}).flatMap(state => state.data || []);
    const historyItems = dataItems.filter(d => d.type === 'history');
    
    if (historyItems.length > 0) {
      try {
        const navigateSkill = generateNavigateHistorySkill(hostname, historyItems);
        if (navigateSkill && !navigateSkill.error) {
          const _navHistoryTs = new Date().toISOString();
          const skillWithMeta = {
            ...navigateSkill,
            _meta: {
              source_domain: hostname,
              source_action: 'navigate_history',
              created_at: _navHistoryTs,
              scanned_at: _navHistoryTs,
              history_count: historyItems.length,
              goal_tied: true,
              use_count: 0,
              last_used: null
            }
          };
          await _registerSkill(skillWithMeta);
          skillsGenerated++;
          logger.info(`[explore.agent] Generated navigate_history skill with ${historyItems.length} history items`);
        }
      } catch (e) {
        logger.warn(`[explore.agent] Failed to generate navigate_history skill: ${e.message}`);
      }
    }
    
    // Count data items collected
    const dataItemsCount = dataItems.length;
    
    logger.info(`[explore.agent] Skill generation complete: ${skillsGenerated}/${actionCount} skills generated from ${Object.keys(newMap.states || {}).length} states, ${dataItemsCount} data items collected`);
    
    // Send completion summary with requiresDismissal flag to prevent auto-dismiss
    const summaryStats = {
      totalElements: scanStats.totalElements,
      successful: scanStats.successCount,
      failed: scanStats.failCount,
      filtered: scanStats.filteredCount,
      states: scanStats.statesScanned,
      skillsGenerated: skillsGenerated,
      dataItems: dataItemsCount,
      duration: Math.round(duration / 1000)
    };

    logger.info(`[explore.agent] Posting scan_summary event to ${_progressCallbackUrl} with requiresDismissal=true`);
    
    _postProgress(_progressCallbackUrl, {
      type: 'explore:scan_summary',
      hostname,
      message: `✨ Scan complete! Found ${totalActions} actions, collected ${dataItemsCount} data items, generated ${skillsGenerated} skills`,
      requiresDismissal: true,
      ...summaryStats,
      actions: Object.values(newMap.states || {}).flatMap(s => Object.keys(s.actions || {}))
    });
    
    logger.info(`[explore.agent] scan_summary event posted successfully`);

    // Collect generated skill names to pass back to learn.agent
    const generatedSkills = Object.values(newMap.states || {}).flatMap(state => 
      Object.values(state.actions || {}).map(action => ({
        name: action.skill_name || action.action_key,
        description: action.skill_description || `Interact with ${action.action_key}`
      }))
    );
    
    // Add navigate_history skill if history items were collected
    if (historyItems.length > 0) {
      const navigateSkillName = `${hostname.replace(/\./g, '_')}_navigate_history`;
      generatedSkills.push({
        name: navigateSkillName,
        description: 'Navigate to previous searches by fuzzy matching against history'
      });
    }

    return { ok: true, hostname, actionsFound: totalActions, mapPath, duration, botBlocked, summary: summaryStats, generatedSkills };

  } catch (err) {
    logger.warn(`[explore.agent] scanDomain error for ${hostname}: ${err.message}`);
    _postProgress(_progressCallbackUrl, { type: 'explore:scan_error', hostname, error: err.message });
    return { ok: false, hostname, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Maintenance Scan — state files + constants
// ---------------------------------------------------------------------------
const BROWSER_PROFILES_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
const SCAN_STATE_FILE       = path.join(os.homedir(), '.thinkdrop', 'scan-state.json');
const SCAN_SCHEDULE_FILE    = path.join(os.homedir(), '.thinkdrop', 'scan-schedule.json');
const USER_MEMORY_PORT      = parseInt(process.env.MCP_USER_MEMORY_PORT || '3001', 10);
const IDLE_THRESHOLD_MS     = 30 * 60 * 1000;   // 30 min idle before triggering
const SCAN_COOLDOWN_MS      = 24 * 60 * 60 * 1000; // 24h between auto scans
const IDLE_POLL_MS          = 5 * 60 * 1000;    // check idle every 5 min

let _idleWatcherTimer  = null;
let _scanSchedulerJob  = null;
let _maintenanceRunning = false;
let _maintenanceCancelRequested = false;
let _scanCancelFlag = false;  // Module-level flag to cancel active scanDomain calls

// ---------------------------------------------------------------------------
// Scan state I/O
// ---------------------------------------------------------------------------
function _loadScanState() {
  try {
    if (fs.existsSync(SCAN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SCAN_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastRunTs: null, lastRunAgents: [], lastDiscovery: [] };
}

function _saveScanState(state) {
  try {
    fs.mkdirSync(path.dirname(SCAN_STATE_FILE), { recursive: true });
    fs.writeFileSync(SCAN_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[explore.agent] could not save scan state: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Browser profile cleanup — removes leftover *_scan_* dirs, logs orphan *_agent dirs
// ---------------------------------------------------------------------------
function _cleanBrowserProfiles(knownAgentIds) {
  if (!fs.existsSync(BROWSER_PROFILES_DIR)) return;
  let cleaned = 0;
  let orphans = [];
  try {
    const entries = fs.readdirSync(BROWSER_PROFILES_DIR);
    for (const entry of entries) {
      if (/_scan_\d+$/.test(entry)) {
        try {
          fs.rmSync(path.join(BROWSER_PROFILES_DIR, entry), { recursive: true, force: true });
          cleaned++;
        } catch (e) {
          logger.warn(`[explore.agent] could not remove stale profile dir ${entry}: ${e.message}`);
        }
      } else if (entry.endsWith('_agent')) {
        const agentId = entry.replace(/_agent$/, '').replace(/_/g, '.') + '.agent';
        const simpleId = entry.replace(/_agent$/, '');
        const known = knownAgentIds.some(id =>
          id === agentId || id === simpleId || id.startsWith(simpleId)
        );
        if (!known) orphans.push(entry);
      }
    }
    if (cleaned > 0) logger.info(`[explore.agent] cleaned ${cleaned} stale scan profile dir(s)`);
    if (orphans.length > 0) logger.info(`[explore.agent] orphan browser profiles (no .md descriptor): ${orphans.join(', ')}`);
  } catch (err) {
    logger.warn(`[explore.agent] browser profile cleanup error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Collect agent list — merges agents/*.md + browser-profiles/*_agent, deduped
// ---------------------------------------------------------------------------
function _collectAgentList() {
  const agents = new Map(); // agentId → { agentId, startUrl, source }

  // Primary: ~/.thinkdrop/agents/*.md
  if (fs.existsSync(AGENTS_DIR)) {
    try {
      const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
          const startUrlMatch = content.match(/^start_url:\s*(.+)$/m);
          if (!startUrlMatch) continue;
          const startUrl = startUrlMatch[1].trim();
          const agentId = file.replace('.md', '');
          agents.set(agentId, { agentId, startUrl, source: 'agents_dir' });
        } catch (_) {}
      }
    } catch (err) {
      logger.warn(`[explore.agent] could not read agents dir: ${err.message}`);
    }
  }

  // Secondary: ~/.thinkdrop/browser-profiles/*_agent (catches profiles missing .md)
  if (fs.existsSync(BROWSER_PROFILES_DIR)) {
    try {
      const entries = fs.readdirSync(BROWSER_PROFILES_DIR).filter(e => e.endsWith('_agent'));
      for (const entry of entries) {
        const simpleId = entry.replace(/_agent$/, '');
        // Convert underscore-name to dot-name (e.g. gmail_agent → gmail.agent)
        const agentId = simpleId + '.agent';
        if (!agents.has(agentId)) {
          // No .md — we have a profile but no descriptor; log but skip (can't get start_url)
          logger.debug(`[explore.agent] browser profile ${entry} has no .md descriptor — skipping scan`);
        }
      }
    } catch (err) {
      logger.warn(`[explore.agent] could not read browser-profiles dir: ${err.message}`);
    }
  }

  return Array.from(agents.values());
}

// ---------------------------------------------------------------------------
// Browsing discovery — queries memory for frequently visited URLs not yet covered
// ---------------------------------------------------------------------------
async function _queryBrowsingDiscovery(knownHostnames) {
  try {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'user-memory', action: 'memory.retrieve',
      payload: { query: 'browser website url visit', topK: 200, type: 'screen_capture' },
    });
    const raw = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: USER_MEMORY_PORT,
        path: '/memory.retrieve', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

    const results = raw?.data?.results || raw?.results || [];
    const hostCount = new Map();
    const cutoffTs = Date.now() - 30 * 24 * 60 * 60 * 1000; // last 30 days

    for (const item of results) {
      let meta;
      try { meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata; } catch (_) { continue; }
      const url = meta?.url;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      if (item.created_at && new Date(item.created_at).getTime() < cutoffTs) continue;
      let hostname;
      try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
      // Skip already-known agents
      if (knownHostnames.has(hostname)) continue;
      // Skip trivial/utility domains
      if (/^(localhost|127\.|192\.|google\.com$|bing\.com$|duckduckgo\.com$|accounts\.|login\.)/.test(hostname)) continue;
      hostCount.set(hostname, (hostCount.get(hostname) || 0) + 1);
    }

    // Filter ≥ 3 visits, sort descending
    return Array.from(hostCount.entries())
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([hostname, visits]) => ({ hostname, visits }));
  } catch (err) {
    logger.warn(`[explore.agent] browsing discovery error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// _postMaintenanceProgress — emit progress to Electron renderer via /scan.progress
// ---------------------------------------------------------------------------
function _postMaintenanceProgress(payload) {
  try {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port: OVERLAY_PORT,
      path: '/scan.progress', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    }, (r) => { r.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(body);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Core: _runMaintenanceScan
// ---------------------------------------------------------------------------
async function _runMaintenanceScan(opts = {}) {
  if (_maintenanceRunning) {
    logger.info('[explore.agent] maintenance scan already running — skipping');
    return { ok: false, reason: 'already_running' };
  }
  _maintenanceRunning = true;
  _maintenanceCancelRequested = false;
  const trigger = opts.trigger || 'user';
  const start = Date.now();

  try {
    logger.info(`[explore.agent] maintenance scan starting (trigger=${trigger})`);

    // Step 1 — Collect agent list (needed for cleanup cross-ref)
    const agentList = _collectAgentList();
    const knownAgentIds = agentList.map(a => a.agentId);

    // Step 2 — Clean up stale scan profiles
    _cleanBrowserProfiles(knownAgentIds);

    // Step 3 — Discovery: find frequently visited sites not yet covered
    const knownHostnames = new Set(agentList.map(a => {
      try { return new URL(a.startUrl).hostname.replace(/^www\./, ''); } catch (_) { return null; }
    }).filter(Boolean));

    const suggestions = await _queryBrowsingDiscovery(knownHostnames);
    if (suggestions.length > 0) {
      logger.info(`[explore.agent] discovery found ${suggestions.length} candidate site(s): ${suggestions.map(s => s.hostname).join(', ')}`);
      _postMaintenanceProgress({ type: 'maintenance_scan_discovery', suggestions });
    }

    // Step 4 — Emit scan start
    const total = agentList.length;
    _postMaintenanceProgress({ type: 'maintenance_scan_start', total, agents: agentList.map(a => a.agentId), trigger });

    // Step 5 — Enqueue each agent sequentially via existing drain queue
    let completed = 0;
    for (const agent of agentList) {
      if (_maintenanceCancelRequested) {
        logger.info('[explore.agent] maintenance scan cancelled by user');
        _postMaintenanceProgress({ type: 'maintenance_scan_cancelled', completed, total });
        return { ok: false, reason: 'cancelled' };
      }

      // Wait for queue to drain before enqueuing next (ensures sequential, not concurrent)
      await new Promise((resolve) => {
        const tryEnqueue = () => {
          if (_activeScanCount < _MAX_CONCURRENT_SCANS && _scanQueueList.length === 0) {
            _enqueueScan({ url: agent.startUrl, agentId: agent.agentId }, 'maintenance');
            // Wait for this agent's scan to finish (also respects cancel flag)
            const waitDone = setInterval(() => {
              if (_maintenanceCancelRequested) {
                clearInterval(waitDone);
                resolve();
                return;
              }
              if (!_scanQueueSet.has(new URL(agent.startUrl).hostname.replace(/^www\./, ''))) {
                clearInterval(waitDone);
                completed++;
                _postMaintenanceProgress({
                  type: 'maintenance_scan_agent_done',
                  agentId: agent.agentId,
                  index: completed,
                  total,
                });
                resolve();
              }
            }, 1000);
          } else {
            setTimeout(tryEnqueue, 2000);
          }
        };
        try { tryEnqueue(); } catch (_) { completed++; resolve(); }
      });
    }

    const duration = Date.now() - start;
    const state = _loadScanState();
    _saveScanState({
      ...state,
      lastRunTs: new Date().toISOString(),
      lastRunAgents: knownAgentIds,
      lastDiscovery: suggestions,
    });

    logger.info(`[explore.agent] maintenance scan complete — ${completed}/${total} agents, ${duration}ms (trigger=${trigger})`);
    _postMaintenanceProgress({ type: 'maintenance_scan_complete', total: completed, duration, trigger });
    return { ok: true, completed, total, duration };

  } catch (err) {
    logger.warn(`[explore.agent] maintenance scan error: ${err.message}`);
    _postMaintenanceProgress({ type: 'maintenance_scan_error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    _maintenanceRunning = false;
  }
}

function cancelMaintenanceScan() {
  _maintenanceCancelRequested = true;
  _scanCancelFlag = true;  // Also cancel any active scanDomain call
}

// Cancel just the active scanDomain call (used by learn.agent cancel)
function cancelActiveScan() {
  _scanCancelFlag = true;
}

// ---------------------------------------------------------------------------
// getScanStatus — returns current state for UI polling
// ---------------------------------------------------------------------------
function getScanStatus() {
  const state = _loadScanState();
  let schedule = null;
  try {
    if (fs.existsSync(SCAN_SCHEDULE_FILE)) {
      schedule = JSON.parse(fs.readFileSync(SCAN_SCHEDULE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    active: _maintenanceRunning,
    queued: _scanQueueList.length,
    activeScanCount: _activeScanCount,
    lastRunTs: state.lastRunTs,
    lastRunAgents: state.lastRunAgents || [],
    lastDiscovery: state.lastDiscovery || [],
    schedule: schedule || null,
  };
}

// ---------------------------------------------------------------------------
// startScanScheduler — reads scan-schedule.json, registers a node-cron job
// ---------------------------------------------------------------------------
function startScanScheduler() {
  if (_scanSchedulerJob) {
    try { _scanSchedulerJob.stop(); } catch (_) {}
    _scanSchedulerJob = null;
  }
  if (!fs.existsSync(SCAN_SCHEDULE_FILE)) return;
  try {
    const config = JSON.parse(fs.readFileSync(SCAN_SCHEDULE_FILE, 'utf8'));
    if (!config.enabled || !config.cron) return;

    let nodeCron;
    try { nodeCron = require('node-cron'); } catch (_) {
      logger.warn('[explore.agent] node-cron not available — scan scheduler disabled');
      return;
    }

    if (!nodeCron.validate(config.cron)) {
      logger.warn(`[explore.agent] invalid cron expression in scan-schedule.json: ${config.cron}`);
      return;
    }

    _scanSchedulerJob = nodeCron.schedule(config.cron, () => {
      logger.info(`[explore.agent] scheduled maintenance scan firing (cron=${config.cron})`);
      _runMaintenanceScan({ trigger: 'scheduled' })
        .then(r => {
          const schedData = JSON.parse(fs.readFileSync(SCAN_SCHEDULE_FILE, 'utf8'));
          fs.writeFileSync(SCAN_SCHEDULE_FILE, JSON.stringify({
            ...schedData, lastRun: new Date().toISOString(),
          }, null, 2), 'utf8');
          logger.info(`[explore.agent] scheduled scan complete: ${JSON.stringify(r)}`);
        })
        .catch(err => logger.warn(`[explore.agent] scheduled scan error: ${err.message}`));
    });
    logger.info(`[explore.agent] scan scheduler registered (cron=${config.cron})`);
  } catch (err) {
    logger.warn(`[explore.agent] could not start scan scheduler: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// startIdleWatcher — polls ioreg every 5min, fires scan when idle ≥ 30min
// ---------------------------------------------------------------------------
function startIdleWatcher() {
  if (_idleWatcherTimer) return;

  async function _idleTick() {
    try {
      // Use ioreg via screen-intelligence-service /screen.idle
      const idleMs = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: SCREEN_SERVICE_PORT,
          path: '/screen.idle', method: 'GET',
          timeout: 3000,
        }, (r) => {
          let data = '';
          r.on('data', c => { data += c; });
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed?.idleMs ?? parsed?.data?.idleMs ?? null);
            } catch (_) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      });

      if (idleMs === null) return; // service unavailable — skip
      if (idleMs < IDLE_THRESHOLD_MS) return; // not idle enough

      // Check cooldown
      const state = _loadScanState();
      const lastRun = state.lastRunTs ? new Date(state.lastRunTs).getTime() : 0;
      if (Date.now() - lastRun < SCAN_COOLDOWN_MS) {
        logger.debug('[explore.agent] idle watcher: cooldown not elapsed — skipping');
        return;
      }

      // Gate: don't start if already running or a foreground scan is active
      if (_maintenanceRunning || _activeScanCount > 0) return;

      logger.info(`[explore.agent] idle watcher: system idle ${Math.round(idleMs / 60000)}min — triggering maintenance scan`);
      _runMaintenanceScan({ trigger: 'idle' }).catch(err =>
        logger.warn(`[explore.agent] idle-triggered scan error: ${err.message}`)
      );
    } catch (_) { /* non-fatal */ }
  }

  _idleWatcherTimer = setInterval(_idleTick, IDLE_POLL_MS);
  logger.info('[explore.agent] idle watcher started (poll=5min, threshold=30min, cooldown=24h)');
}

function stopIdleWatcher() {
  if (_idleWatcherTimer) { clearInterval(_idleWatcherTimer); _idleWatcherTimer = null; }
}

// ---------------------------------------------------------------------------
// Skill Generator — Creates parameterized skills from domain map actions
// ---------------------------------------------------------------------------
/**
 * Generate a parameterized skill from a domain map action
 * @param {string} hostname - Domain (e.g., 'perplexity.ai')
 * @param {string} stateKey - State key in domain map (e.g., 'home_page')
 * @param {string} actionKey - Action key in state (e.g., 'search_input')
 * @param {Object} customParams - Optional custom parameters to override defaults
 * @returns {Object} Generated skill code and metadata
 */
function generateSkillFromAction(hostname, stateKey, actionKey, customParams = {}) {
  // Load domain map
  const domainMap = _loadDomainMap(hostname);
  if (!domainMap || !domainMap.states[stateKey] || !domainMap.states[stateKey].actions[actionKey]) {
    return { error: `Action not found: ${hostname}.${stateKey}.${actionKey}` };
  }
  
  const action = domainMap.states[stateKey].actions[actionKey];
  const { skill_name, interaction, locators, accepts_params, param_mapping, examples, follow_up_actions } = action;
  
  // Extract follow-up action (e.g. press Enter after fill for search inputs)
  const followUp = (follow_up_actions || []).find(a => a.action === 'press') || null;
  
  // Build skill name
  const skillName = customParams.name || `${hostname.replace(/\./g, '_')}_${skill_name}`;
  const displayName = customParams.displayName || skill_name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  
  // Build parameter definitions
  const params = accepts_params || [];
  const paramDefs = {};
  
  if (param_mapping && Object.keys(param_mapping).length > 0) {
    Object.entries(param_mapping).forEach(([key, config]) => {
      paramDefs[key] = {
        type: config.type || 'string',
        required: config.required !== false,
        description: config.description || `Parameter for ${key}`,
        ...(config.options ? { options: config.options } : {})
      };
    });
  } else if (params.length > 0) {
    // Fallback: create param defs from accepts_params
    params.forEach(param => {
      const paramName = param === 'text' ? 'query' : param;
      paramDefs[paramName] = { type: 'string', required: true };
    });
  }
  
  // Generate skill code based on interaction type
  let skillCode;
  
  switch (interaction) {
    case 'fill':
    case 'type':
      skillCode = _generateFillSkill(skillName, locators, paramDefs, interaction, followUp);
      break;
    case 'click':
      skillCode = _generateClickSkill(skillName, locators);
      break;
    case 'select':
      skillCode = _generateSelectSkill(skillName, locators, paramDefs);
      break;
    case 'check':
    case 'uncheck':
      skillCode = _generateToggleSkill(skillName, locators, interaction);
      break;
    case 'upload':
      skillCode = _generateUploadSkill(skillName, locators, paramDefs);
      break;
    case 'scroll':
      skillCode = _generateScrollSkill(skillName, locators, paramDefs);
      break;
    case 'dblclick':
      skillCode = _generateDblclickSkill(skillName, locators);
      break;
    case 'hover':
      skillCode = _generateHoverSkill(skillName, locators);
      break;
    case 'drag':
      skillCode = _generateDragSkill(skillName, locators);
      break;
    default:
      skillCode = _generateGenericSkill(skillName, locators, interaction, paramDefs);
  }
  
  return {
    name: skillName,
    displayName,
    hostname,
    stateKey,
    actionKey,
    interaction,
    parameters: paramDefs,
    examples: examples || [],
    code: skillCode,
    locators,
  };
}

// Generate navigate_history skill from collected history data
function generateNavigateHistorySkill(hostname, historyItems) {
  if (!historyItems || historyItems.length === 0) {
    return { error: 'No history items provided' };
  }
  
  const skillName = `${hostname.replace(/\./g, '_')}_navigate_history`;
  const baseUrl = `https://${hostname}`;
  
  // Build skill code that fuzzy-matches and navigates
  const skillCode = `'use strict';
/**
 * Skill: ${skillName}
 * Navigate to previous search/conversation by fuzzy matching query against history
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

// History index built at skill creation time
const historyIndex = ${JSON.stringify(historyItems.map(h => ({ label: h.label, href: h.href, ref: h.ref })), null, 2)};

// Simple fuzzy match function
function fuzzyMatch(query, text) {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase().trim();
  
  // Exact match
  if (t.includes(q)) return 1.0;
  
  // Word-by-word match
  const qWords = q.split(/\\s+/);
  const tWords = t.split(/\\s+/);
  let matches = 0;
  for (const qw of qWords) {
    if (qw.length > 2 && tWords.some(tw => tw.includes(qw) || qw.includes(tw))) {
      matches++;
    }
  }
  return matches / qWords.length;
}

module.exports = {
  name: '${skillName}',
  description: 'Navigate to a previous search or conversation by describing it',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Keywords from the history item you want to navigate to (e.g., "winter clothes")'
    }
  },
  
  async run(args = {}) {
    const { sessionId, headed, query } = args;
    
    if (!query) {
      throw new Error('Missing required parameter: query');
    }
    
    // Find best match
    let bestMatch = null;
    let bestScore = 0;
    
    for (const item of historyIndex) {
      const score = fuzzyMatch(query, item.label);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }
    
    if (!bestMatch || bestScore < 0.3) {
      return { 
        success: false, 
        error: 'No history match found for "' + query + '". Try different keywords.',
        availableItems: historyIndex.slice(0, 5).map(h => h.label)
      };
    }
    
    // Navigate to the matched URL
    const fullUrl = bestMatch.href.startsWith('http') ? bestMatch.href : 'https://${hostname}' + bestMatch.href;
    
    const res = await browserAct({
      action: 'navigate',
      url: fullUrl,
      sessionId,
      headed,
      timeoutMs: 15000,
    });
    
    if (!res.ok) {
      throw new Error('Failed to navigate: ' + (res.error || 'Unknown error'));
    }
    
    return { 
      success: true, 
      navigatedTo: bestMatch.label,
      url: fullUrl,
      matchConfidence: Math.round(bestScore * 100) + '%'
    };
  }
};`;

  return {
    name: skillName,
    displayName: 'Navigate History',
    skill_name: skillName,
    description: 'Navigate to previous searches by fuzzy matching against history',
    interaction: 'navigate',
    code: skillCode,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keywords from the history item you want to navigate to'
      }
    },
    hostname,
  };
}

// Skill code generators for each interaction type
function _generateFillSkill(name, locators, paramDefs, interaction, followUp = null) {
  const paramNames = Object.keys(paramDefs);
  const mainParam = paramNames[0] || 'query';
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  const fallbackDefault = interaction === 'type' ? '[contenteditable="true"]' : '[data-testid="input"]';
  
  // Build follow-up action code (e.g. press Enter for search inputs)
  const followUpCode = followUp && followUp.action === 'press' ? `
    // Follow-up: press key after ${interaction}
    await browserAct({ action: 'press', key: '${followUp.key}', sessionId, headed, timeoutMs: 5000 }).catch(() => {});` : '';

  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: ${interaction}
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: '${interaction === 'type' ? 'Type text into contenteditable field' : 'Fill input field'}',
  parameters: ${JSON.stringify(paramDefs, null, 2)},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const text = args.${mainParam} || args[Object.keys(args).find(k => k !== 'sessionId' && k !== 'headed') || ''] || args.text;
    if (!text) throw new Error('Missing required parameter: ${mainParam}');
    
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', '${fallbackDefault}'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: '${interaction}',
        selector: sel,
        text: text,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to ${interaction}: \${res?.error || 'Unknown error'}\`);
    }
    ${followUpCode}
    return { success: true, text };
  }
};`;
}

function _generateClickSkill(name, locators) {
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: click
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Click element',
  parameters: {},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const selectors = ['${primary}', '${fallback1}', '${fallback2}'].filter(Boolean);
    if (!selectors.length) selectors.push('[data-testid="button"]');
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'click',
        selector: sel,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to click: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true };
  }
}`;
}

function _generateSelectSkill(name, locators, paramDefs) {
  const paramNames = Object.keys(paramDefs);
  const mainParam = paramNames[0] || 'selection';
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  const options = paramDefs[mainParam]?.options || [];
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: select (dropdown)
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Select option from dropdown',
  parameters: ${JSON.stringify(paramDefs, null, 2)},
  options: ${JSON.stringify(options)},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const value = args.${mainParam} || args.value;
    if (!value) throw new Error('Missing required parameter: ${mainParam}');
    
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', 'select'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'select',
        selector: sel,
        value: value,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to select: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true, selected: value };
  }
}`;
}

function _generateToggleSkill(name, locators, interaction) {
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: ${interaction}
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: '${interaction === 'check' ? 'Check checkbox' : 'Uncheck checkbox'}',
  parameters: {},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', 'input[type="checkbox"]'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: '${interaction}',
        selector: sel,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to ${interaction}: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true, action: '${interaction}' };
  }
}`;
}

function _generateUploadSkill(name, locators, paramDefs) {
  const paramNames = Object.keys(paramDefs);
  const mainParam = paramNames[0] || 'file_path';
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: upload
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: '${name}',
  description: 'Upload file(s)',
  parameters: ${JSON.stringify(paramDefs, null, 2)},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const fileArg = args.${mainParam} || args.file_path || args.files;
    const files = Array.isArray(fileArg) ? fileArg : [fileArg];
    
    // Validate files exist
    for (const file of files) {
      if (!fs.existsSync(file)) {
        throw new Error(\`File not found: \${file}\`);
      }
    }
    
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', 'input[type="file"]'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'upload',
        selector: sel,
        files: files,
        sessionId,
        headed,
        timeoutMs: 30000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to upload: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true, uploaded: files.length };
  }
}`;
}

function _generateGenericSkill(name, locators, interaction, paramDefs) {
  const paramNames = Object.keys(paramDefs);
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: ${interaction}
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Perform ${interaction} action',
  parameters: ${JSON.stringify(paramDefs, null, 2)},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', '[data-testid="element"]'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: '${interaction}',
        selector: sel,
        ${paramNames.length > 0 ? `text: args.${paramNames[0]},` : ''}
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to ${interaction}: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true };
  }
}`;
}

function _generateScrollSkill(name, locators, paramDefs) {
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: scroll
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Scroll container or page',
  parameters: ${JSON.stringify(paramDefs, null, 2)},
  defaults: { direction: 'down', distance: 500 },
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const dir = args.direction || 'down';
    const dist = args.distance || 500;
    const dy = dir === 'down' ? dist : dir === 'up' ? -dist : 0;
    const dx = dir === 'right' ? dist : dir === 'left' ? -dist : 0;
    
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', 'body'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'scroll',
        selector: sel,
        dx: dx,
        dy: dy,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to scroll: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true, scrolled: { direction: dir, distance: dist } };
  }
}`;
}

function _generateDblclickSkill(name, locators) {
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: double-click
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Double-click element (for file managers, grids)',
  parameters: {},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', '[data-testid="item"]'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'dblclick',
        selector: sel,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to double-click: \${res?.error || 'Unknown error'}\`);
    }
    
    return { success: true };
  }
}`;
}

function _generateHoverSkill(name, locators) {
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';
  
  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: hover
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Hover over element to reveal dropdown/menu',
  parameters: {},
  
  async run(args = {}) {
    const { sessionId, headed } = args;
    const selectors = ['${primary}', '${fallback1}', '${fallback2}', '[data-testid="hover-trigger"]'].filter(Boolean);
    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'hover',
        selector: sel,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }
    
    if (!res || !res.ok) {
      throw new Error(\`Failed to hover: \${res?.error || 'Unknown error'}\`);
    }
    
    // Follow-up: click the revealed dropdown item if needed
    return { success: true, revealed: 'dropdown' };
  }
}`;
}

// ---------------------------------------------------------------------------
// Drag skill generator (Part 2)
// ---------------------------------------------------------------------------
function _generateDragSkill(name, locators) {
  const primary = locators.primary || '';
  const fallback1 = locators.fallback_1 || '';
  const fallback2 = locators.fallback_2 || '';

  return `'use strict';
/**
 * Skill: ${name}
 * Interaction: drag
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${name}',
  description: 'Drag element to a target',
  parameters: {
    targetSelector: { type: 'string', required: true, description: 'CSS selector of the drop target' },
  },

  async run(args = {}) {
    const { sessionId, headed, targetSelector } = args;
    if (!targetSelector) throw new Error('Missing required parameter: targetSelector');

    const selectors = ['${primary}', '${fallback1}', '${fallback2}'].filter(Boolean);
    if (!selectors.length) throw new Error('No source selector available for drag');

    let res;
    for (const sel of selectors) {
      res = await browserAct({
        action: 'drag',
        selector: sel,
        targetSelector,
        sessionId,
        headed,
        timeoutMs: 15000,
      });
      if (res.ok) break;
    }

    if (!res || !res.ok) {
      throw new Error(\`Failed to drag: \${res?.error || 'Unknown error'}\`);
    }

    return { success: true };
  }
}`;
}

// ---------------------------------------------------------------------------
// Composite agent skill generator (Part 3)
// Called after a successful multi-step same-domain plan execution.
// orderedActions: Array of { stateKey, actionKey, interaction, locators, paramKey? }
// hostname: e.g. 'perplexity.ai'
// agentName: e.g. 'perplexity_history_search_agent'
// ---------------------------------------------------------------------------
function generateCompositeAgentSkill(hostname, agentName, orderedActions) {
  if (!orderedActions || orderedActions.length < 2) {
    return { error: 'Need at least 2 actions to generate a composite agent skill' };
  }

  // Collect which steps need a text/query param
  const fillSteps = orderedActions.filter(a =>
    a.interaction === 'fill' || a.interaction === 'type'
  );
  const hasQuery = fillSteps.length > 0;

  // Build per-step code blocks
  const stepBlocks = orderedActions.map((action, i) => {
    const stepNum = i + 1;
    const primary = action.locators?.primary || '';
    const fallback1 = action.locators?.fallback_1 || '';
    const fallback2 = action.locators?.fallback_2 || '';
    const selectors = [primary, fallback1, fallback2].filter(Boolean);
    const selectorLiteral = JSON.stringify(selectors);
    const isTextStep = action.interaction === 'fill' || action.interaction === 'type';
    const textArg = isTextStep ? `text: query,` : '';
    const followUpCode = action.followUp && action.followUp.action === 'press'
      ? `\n      await browserAct({ action: 'press', key: '${action.followUp.key}', sessionId, headed, timeoutMs: 5000 }).catch(() => {});`
      : '';

    return `
    // Step ${stepNum}: ${action.actionKey}
    {
      const _sels${stepNum} = ${selectorLiteral};
      let _res${stepNum};
      for (const sel of _sels${stepNum}) {
        _res${stepNum} = await browserAct({
          action: '${action.interaction}',
          selector: sel,
          ${textArg}
          sessionId,
          headed,
          timeoutMs: 15000,
        });
        if (_res${stepNum}.ok) break;
      }
      if (!_res${stepNum} || !_res${stepNum}.ok) throw new Error('Step ${stepNum} (${action.actionKey}) failed: ' + (_res${stepNum}?.error || 'Unknown'));${followUpCode}
    }`;
  }).join('\n');

  const skillCode = `'use strict';
/**
 * Composite agent skill: ${agentName}
 * Domain: ${hostname}
 * Steps: ${orderedActions.map(a => a.actionKey).join(' → ')}
 * Auto-generated from successful plan execution
 */
const { browserAct } = require('${BROWSER_ACT_PATH}');

module.exports = {
  name: '${agentName}',
  description: 'Multi-step agent for ${hostname}: ${orderedActions.map(a => a.actionKey).join(' → ')}',
  parameters: {${hasQuery ? `
    query: { type: 'string', required: true, description: 'Search query or text to use in fill steps' },` : ''}
  },

  async run(args = {}) {
    const { sessionId, headed${hasQuery ? ', query' : ''} } = args;
    ${hasQuery ? "if (!query) throw new Error('Missing required parameter: query');" : ''}
${stepBlocks}

    return { success: true, stepsCompleted: ${orderedActions.length} };
  }
};`;

  return {
    name: agentName,
    skill_name: agentName,
    hostname,
    interaction: 'composite',
    code: skillCode,
    parameters: hasQuery ? { query: { type: 'string', required: true } } : {},
    _meta: {
      source_domain: hostname,
      source_action: 'composite',
      composite_steps: orderedActions.map(a => a.actionKey),
      created_at: new Date().toISOString(),
      goal_tied: true,
      use_count: 0,
      last_used: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Export all functions
// ---------------------------------------------------------------------------
module.exports = {
  exploreAgent,
  scanDomain,
  startIdleWatcher,
  stopIdleWatcher,
  startScanScheduler,
  runMaintenanceScan: _runMaintenanceScan,
  cancelMaintenanceScan,
  cancelActiveScan,
  getScanStatus,
  enqueueScan: _enqueueScan,
  generateSkillFromAction,
  generateCompositeAgentSkill,
  // Export schemas for external reference
  INTERACTION_SCHEMAS,
};
