'use strict';

/**
 * recipe.run — executes trained waypoint/agent recipes (.skill.json / .recipe.json)
 * from ~/.thinkdrop/skills/. This is the surviving slice of the retired
 * external.skill executor: recipes are data (waypoints, instructions, params),
 * not code — no index.cjs require, no process spawn, no contract plumbing.
 *
 * Args: { name: string, args?: object, execPath?: string, timeoutMs?: number, sessionId?: string }
 * Returns: { ok, output?, error?, skillName?, discoveredKeyPath? }
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

const SKILLS_BASE_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;


/**
 * Resolve a recipe file for `name`. Search order:
 *   1. explicit execPath arg (validated, must be a recipe file)
 *   2. ~/.thinkdrop/skills/<dir>/<name>.skill.json | <name>.json | <name>.recipe.json
 *   3. ~/.thinkdrop/skills/<name|name-variants>/skill.json
 *   4. any nested skills/DIR/<name>.skill.json match
 * Only recipe files (.json with waypoints/instructions/skills) resolve —
 * index.cjs/python/shell installed skills are retired and never resolve here.
 */
function _recipeCandidates(name) {
  const cands = [];
  const variants = [name, name.replace(/\./g, '_'), name.replace(/\./g, '-')].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(SKILLS_BASE_DIR)) {
      const d = path.join(SKILLS_BASE_DIR, dir);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const v of variants) {
        cands.push(path.join(d, `${v}.skill.json`));
        cands.push(path.join(d, `${v}.json`));
        cands.push(path.join(d, `${v}.recipe.json`));
      }
    }
    for (const v of variants) {
      cands.push(path.join(SKILLS_BASE_DIR, v, 'skill.json'));
      cands.push(path.join(SKILLS_BASE_DIR, v, 'recipe.json'));
    }
  } catch (_) {}
  return cands;
}

function resolveRecipePath(name, execPath) {
  if (execPath) {
    const resolved = path.resolve(execPath);
    if (!resolved.startsWith(SKILLS_BASE_DIR)) {
      throw new Error(`Security violation: exec_path "${execPath}" is outside the skills directory`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Recipe file not found: ${resolved}`);
    }
    if (!resolved.endsWith('.json')) {
      throw new Error(`exec_path "${resolved}" is not a recipe file (.json)`);
    }
    return resolved;
  }
  if (!name || typeof name !== 'string') return null;
  for (const cand of _recipeCandidates(name)) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

// ── Recipe skill runner ───────────────────────────────────────────────────────
// Executes a trained waypoint recipe (.skill.json) by running each waypoint
// through browser.act in sequence. Params from skillArgs are substituted for
// {{paramRef}} placeholders in fill/paste/select values.
//
// Recipe schema:
//   {
//     name, startUrl, targetUrl, params: [{ name, type, required, description }],
//     waypoints: [{ step, type, selector, altSelectors?, value?, paramRef?, ... }]
//   }
//
// Returns: { ok, output?, error? }
//

// ---------------------------------------------------------------------------
// Agent skill runner: delegates to playwrightAgent with natural language instructions.
// The agent snapshots the live DOM, finds elements by intent, and executes step-by-step.
// No CSS selectors are stored or replayed — the agent adapts to the live page.
// ---------------------------------------------------------------------------
async function runAgentSkill(recipe, skillArgs, timeoutMs, recipePath) {
  const sessionId = skillArgs?.sessionId;
  if (!sessionId) {
    return { ok: false, error: 'Agent skill execution requires a sessionId' };
  }

  const instructions = recipe.instructions || '';
  if (!instructions) {
    return { ok: false, error: `Agent skill "${recipe.name}" has no instructions` };
  }

  // Build args with defaults from recipe params (use example values if arg is missing)
  const args = { ...(skillArgs || {}) };
  for (const p of recipe.params || []) {
    if (args[p.name] === undefined && p.example !== undefined) {
      args[p.name] = p.example;
    }
  }

  // Fail fast on missing required params (don't let the agent hallucinate values)
  for (const p of recipe.params || []) {
    if (p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === '')) {
      return { ok: false, error: `Missing required parameter: ${p.name}` };
    }
  }

  logger.info(`[recipe.run] runAgentSkill: "${recipe.name}" instructions="${instructions.substring(0, 200)}" sessionId=${sessionId}`);

  try {
    // Use the keyboard-path instruction runner.
    // First run: discovers the key path (Tab/Arrow/Enter) from the address bar — slow.
    // Subsequent runs: uses cached keyPath for fast, deterministic replay.
    const { runInstructionSkill } = require('./instruction.runner.cjs');
    const result = await runInstructionSkill({
      instructions,
      keyPath: recipe.keyPath || null, // cached keyboard path (null = first run, will discover)
      params: recipe.params || [],
      skillArgs: args,
      startUrl: recipe.startUrl,
      sessionId,
      timeoutMs: timeoutMs || 120000, // longer timeout for first-run discovery
    });

    // Cache the discovered key path back to the recipe for fast subsequent runs
    if (result?.discoveredKeyPath && result.discoveredKeyPath.length > 0 && !recipe.keyPath) {
      try {
        recipe.keyPath = result.discoveredKeyPath;
        // Use the provided recipePath (direct execPath) or fall back to _findRecipePath
        const savePath = recipePath || _findRecipePath(recipe.name);
        if (savePath) {
          fs.writeFileSync(savePath, JSON.stringify(recipe, null, 2));
          logger.info(`[recipe.run] Cached keyPath for "${recipe.name}" (${result.discoveredKeyPath.length} steps) to ${savePath}`);
        }
      } catch (e) {
        logger.warn(`[recipe.run] Could not cache keyPath: ${e.message}`);
      }
    }

    logger.info(`[recipe.run] runAgentSkill: "${recipe.name}" ok=${result?.ok}${result?.error ? ' error=' + result.error : ''}`);
    return {
      ok: !!result?.ok,
      output: result?.output || (result?.ok ? `Completed agent skill ${recipe.name}` : ''),
      error: result?.ok ? undefined : (result.error || 'Agent skill failed'),
      discoveredKeyPath: result?.discoveredKeyPath || null,
    };
  } catch (e) {
    logger.error(`[recipe.run] runAgentSkill threw: ${e.message}`);
    return { ok: false, error: `Agent skill "${recipe.name}" failed: ${e.message}` };
  }
}

// Helper: find the recipe file path by skill name
function _findRecipePath(skillName) {
  try {
    const skillsDir = path.join(__dirname, '..', 'skills-installed');
    if (!fs.existsSync(skillsDir)) return null;
    const files = fs.readdirSync(skillsDir);
    for (const f of files) {
      if (f.includes(skillName) && f.endsWith('.json')) {
        return path.join(skillsDir, f);
      }
    }
  } catch {}
  return null;
}

async function runRecipeSkill(resolvedPath, skillArgs, timeoutMs) {
  let recipe;
  try {
    recipe = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Failed to read recipe at ${resolvedPath}: ${e.message}` };
  }

  const sessionId = skillArgs?.sessionId;
  if (!sessionId) {
    return { ok: false, error: 'Recipe execution requires a sessionId' };
  }

  // ── Agent-based skill: delegate to playwrightAgent with natural language instructions ──
  // New format: { execType: "agent", instructions: "...", params: [...], startUrl: "..." }
  // The agent snapshots the live DOM, finds elements by intent, and executes step-by-step.
  if (recipe.execType === 'agent' || (recipe.instructions && !Array.isArray(recipe.waypoints))) {
    logger.info(`[recipe.run] Agent skill "${recipe.name}" — delegating to playwrightAgent`);
    return await runAgentSkill(recipe, skillArgs, timeoutMs, resolvedPath);
  }

  // ── Composite recipe: chain multiple .skill.json files ───────────────────
  // A composite .recipe.json has a `skills: [{ skill: "name.skill" }]` array
  // referencing other skill files in the same directory. We run each in order,
  // passing paramFlow between them (extract returns feed the next skill's args).
  if (Array.isArray(recipe.skills) && recipe.skills.length > 0 && !Array.isArray(recipe.waypoints)) {
    logger.info(`[recipe.run] Composite recipe "${recipe.name}" — chaining ${recipe.skills.length} skill(s)`);
    const recipeDir = path.dirname(resolvedPath);
    const chainArgs = { ...(skillArgs || {}) };

    // Initialize args with defaults from recipe params
    for (const p of recipe.params || []) {
      if (chainArgs[p.name] === undefined && p.example !== undefined) {
        chainArgs[p.name] = p.example;
      }
    }

    let totalWaypoints = 0;
    for (let i = 0; i < recipe.skills.length; i++) {
      const skillRef = recipe.skills[i];
      const skillName = skillRef.skill || skillRef.name;
      if (!skillName) {
        return { ok: false, error: `Composite recipe ${recipe.name}: skill #${i + 1} has no name` };
      }

      // Resolve the referenced skill file from the same directory
      const skillFileCandidates = [
        path.join(recipeDir, `${skillName}.json`),
        path.join(recipeDir, `${skillName}.skill.json`),
        path.join(recipeDir, `${skillName}.recipe.json`),
      ];
      let skillFilePath = null;
      for (const candidate of skillFileCandidates) {
        if (fs.existsSync(candidate)) { skillFilePath = candidate; break; }
      }
      if (!skillFilePath) {
        return { ok: false, error: `Composite recipe ${recipe.name}: skill "${skillName}" not found in ${recipeDir}` };
      }

      logger.info(`[recipe.run] Composite recipe step ${i + 1}/${recipe.skills.length}: running ${skillName} from ${skillFilePath}`);

      // Run the referenced skill (which may itself be a single-skill .skill.json
      // or a nested composite .recipe.json — recursion handles both)
      const subResult = await runRecipeSkill(skillFilePath, chainArgs, timeoutMs);
      if (!subResult.ok) {
        return { ok: false, error: `Composite recipe ${recipe.name} failed at skill "${skillName}": ${subResult.error}` };
      }

      totalWaypoints += subResult.waypointCount || 0;

      // Propagate extract returns into chainArgs for the next skill
      if (subResult.returns && typeof subResult.returns === 'object') {
        for (const [key, val] of Object.entries(subResult.returns)) {
          chainArgs[key] = val;
        }
        logger.info(`[recipe.run] Composite recipe: propagated returns from ${skillName}: ${Object.keys(subResult.returns).join(', ')}`);
      }
    }

    return { ok: true, output: `Completed composite recipe ${recipe.name} (${recipe.skills.length} skills, ${totalWaypoints} waypoints)`, waypointCount: totalWaypoints };
  }

  // ── Single-skill recipe: run waypoints directly ──────────────────────────
  const waypoints = Array.isArray(recipe.waypoints) ? recipe.waypoints : [];
  if (waypoints.length === 0) {
    return { ok: false, error: `Recipe ${recipe.name} has no waypoints and no chained skills` };
  }

  // Build args with defaults from recipe params
  const args = { ...(skillArgs || {}) };
  for (const p of recipe.params || []) {
    if (args[p.name] === undefined && p.example !== undefined) {
      args[p.name] = p.example;
    }
  }

  // Resolve params in a value string like "{{playlist_name}}"
  const resolveValue = (value) => {
    if (typeof value !== 'string' || !value.includes('{{')) return value;
    return value.replace(/\{\{(\s*[^}\s]+\s*)\}\}/g, (_, rawName) => {
      const name = rawName.trim();
      return args[name] !== undefined ? String(args[name]) : _;
    });
  };

  // If the recipe does not start with a navigation, jump to startUrl first
  const effectiveWaypoints = waypoints.slice();
  if (effectiveWaypoints[0].type !== 'navigate' && recipe.startUrl) {
    effectiveWaypoints.unshift({ step: 0, type: 'navigate', url: recipe.startUrl });
  }

  const actionTimeout = Math.min(timeoutMs || 15000, 30000);
  const returns = {};

  for (const wp of effectiveWaypoints) {
    const value = resolveValue(wp.value || '');

    // Navigate waypoints don't need selector resolution
    if (wp.type === 'navigate') {
      try {
        const res = await browserAct({ sessionId, action: 'navigate', url: wp.url || recipe.startUrl, timeoutMs: actionTimeout });
        if (res && !res.ok) {
          return { ok: false, error: `Waypoint ${wp.step} (navigate) failed: ${res.error || 'unknown'}` };
        }
      } catch (e) {
        return { ok: false, error: `Waypoint ${wp.step} (navigate) threw: ${e.message}` };
      }
      continue;
    }

    // Extract waypoints — not yet implemented
    if (wp.type === 'extract') {
      logger.info(`[recipe.run] Extract waypoint ${wp.step} skipped in runtime (not yet implemented)`);
      continue;
    }

    // Build candidate selectors: primary + all altSelectors
    const selectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);

    // Determine the browserAct action and extra args for this waypoint type
    const actionMap = {
      click:     { action: 'click',  extraArgs: {} },
      dblclick:  { action: 'click',  extraArgs: {} },
      rightclick:{ action: 'click',  extraArgs: {} },
      fill:      { action: 'fill',   extraArgs: { text: value } },
      paste:     { action: 'type',   extraArgs: { text: value } },
      select:    { action: 'select', extraArgs: { value } },
      check:     { action: 'check',  extraArgs: { checked: !!wp.checked } },
      submit:    { action: 'press',  extraArgs: { key: 'Enter' } },
      keycombo:  { action: 'press',  extraArgs: { key: wp.key || 'Enter' } },
    };
    const actionInfo = actionMap[wp.type];
    if (!actionInfo) {
      return { ok: false, error: `Unknown waypoint type: ${wp.type}` };
    }

    let res = null;
    let lastError = '';

    // ── Fast path: try each candidate selector ──────────────────────────
    for (const sel of selectors) {
      try {
        res = await browserAct({ sessionId, selector: sel, action: actionInfo.action, ...actionInfo.extraArgs, timeoutMs: actionTimeout });
        if (res && res.ok) break;
        lastError = res?.error || 'not found';
      } catch (e) {
        lastError = e.message;
      }
    }

    // ── LLM path: if all selectors failed, find element by intent ───────
    if (!res || !res.ok) {
      const intent = wp.intent || (wp.elementText ? `${wp.type} the "${wp.elementText}" element` : null);
      if (intent) {
        logger.info(`[recipe.run] Waypoint ${wp.step} (${wp.type}): all ${selectors.length} selector(s) failed — trying LLM intent resolution`);
        try {
          const ref = await _resolveElementByIntent(sessionId, intent, wp.elementText, wp.type, actionTimeout);
          if (ref) {
            logger.info(`[recipe.run] LLM resolved intent to ref=${ref}`);
            res = await browserAct({ sessionId, selector: ref, action: actionInfo.action, ...actionInfo.extraArgs, timeoutMs: actionTimeout });
            if (!res || !res.ok) {
              lastError = res?.error || `LLM ref ${ref} failed`;
            }
          } else {
            lastError = `LLM could not find element for intent: "${intent}"`;
          }
        } catch (e) {
          lastError = `LLM resolution error: ${e.message}`;
        }
      }
    }

    if (!res || !res.ok) {
      const triedCount = selectors.length + (wp.intent || wp.elementText ? 1 : 0);
      return { ok: false, error: `Waypoint ${wp.step} (${wp.type}) failed: tried ${triedCount} approach(es) — ${lastError}` };
    }

    // ── Verify expectedResult (if present) ──────────────────────────────
    // For click waypoints with expectedResult: { type: "url_pattern", pattern: "/playlist/*" }
    // Wait briefly for navigation, then check if the URL matches the pattern.
    if (wp.expectedResult && wp.expectedResult.type === 'url_pattern') {
      const pattern = wp.expectedResult.pattern;
      try {
        // Wait 2 seconds for navigation to settle
        await new Promise(r => setTimeout(r, 2000));
        const urlRes = await browserAct({ action: 'getPageText', sessionId, timeoutMs: 5000 });
        // getPageText doesn't give us the URL — use a snapshot which includes URL
        const snapRes = await browserAct({ action: 'snapshot', sessionId, headed: true, timeoutMs: 5000 });
        const currentUrl = snapRes?.url || snapRes?.result?.match(/URL:\s*(\S+)/)?.[1] || '';
        if (currentUrl) {
          // Convert pattern to regex: /playlist/* → /playlist/[^/]+
          // Escape regex special chars first, then convert * to a wildcard.
          const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedPattern.replace(/\*/g, '[^/?]+'));
          if (!regex.test(currentUrl)) {
            logger.warn(`[recipe.run] Waypoint ${wp.step}: expectedResult pattern ${pattern} did not match URL ${currentUrl} — continuing anyway`);
          } else {
            logger.info(`[recipe.run] Waypoint ${wp.step}: expectedResult pattern ${pattern} matched URL ${currentUrl}`);
          }
        }
      } catch (e) {
        logger.warn(`[recipe.run] Waypoint ${wp.step}: expectedResult verification error: ${e.message}`);
      }
    }
  }

  return { ok: true, output: `Completed ${effectiveWaypoints.length} waypoints for ${recipe.name}`, waypointCount: effectiveWaypoints.length, returns };
}

// ---------------------------------------------------------------------------
// LLM element resolution: snapshot DOM → ask LLM to find element by intent
// Returns a tdN ref string, or null if the LLM can't find a matching element.
// Uses browser-engine.cjs's buildRefTree via browserAct({ action: 'snapshot' }).
// ---------------------------------------------------------------------------
async function _resolveElementByIntent(sessionId, intent, elementText, actionType, timeoutMs) {
  // Take a DOM snapshot — this tags elements with tdN refs and returns YAML
  const snapResult = await browserAct({ action: 'snapshot', sessionId, headed: true, timeoutMs: Math.min(timeoutMs, 10000) });
  if (!snapResult || !snapResult.ok) {
    logger.warn(`[recipe.run] LLM resolution: snapshot failed — ${snapResult?.error || 'unknown'}`);
    return null;
  }

  const snapshotYaml = snapResult.result || snapResult.stdout || '';
  if (!snapshotYaml || snapshotYaml.length < 10) {
    logger.warn(`[recipe.run] LLM resolution: empty snapshot`);
    return null;
  }

  // Trim snapshot to avoid token explosion (keep first 4000 chars)
  const trimmedSnapshot = snapshotYaml.length > 4000
    ? snapshotYaml.slice(0, 4000) + '\n... (truncated)'
    : snapshotYaml;

  const systemPrompt = `You find a specific UI element on a web page. You will be given:
1. An intent describing what element to interact with
2. A DOM snapshot with element refs (tdN format)

Return ONLY a JSON object (no markdown, no explanation):
{"ref": "tdN", "confidence": "high|medium|low"}

If no matching element exists, return: {"ref": null}`;

  const userPrompt = `I need to ${intent}.

Current page snapshot:
${trimmedSnapshot}

Which element should I interact with? Return the ref (e.g. td5).`;

  // ── Local decision fast path — bounded pick over the snapshot's refs ────
  // Extract the tdN refs + their line context as options. Over the option
  // cap → skip to remote (dense snapshots need the bigger model anyway).
  {
    const _refLines = [];
    for (const line of trimmedSnapshot.split('\n')) {
      const m = line.match(/\btd\d+\b/);
      if (m) _refLines.push({ ref: m[0], line: line.trim().slice(0, 160) });
    }
    if (_refLines.length > 0 && _refLines.length <= 25) {
      const _decision = require('../skill-helpers/decision.cjs');
      const _picked = await _decision.boundedDecision({
        site: 'externalSkill.resolveRef',
        questions: [{
          id: 'ref', type: 'choice',
          question: `Which element should be interacted with to "${intent}"? Pick "none" if no element matches.`,
          options: [..._refLines.map(r => `${r.ref}: ${r.line}`), 'none'],
        }],
        state: `I need to ${intent}.\nCurrent page snapshot (refs in tdN format):\n${trimmedSnapshot.slice(0, 2000)}`,
        local: (a) => {
          const i = a.ref?.index;
          return (i != null && i < _refLines.length) ? _refLines[i].ref : null;
        },
        remote: async () => null,
        logger,
      });
      if (_picked) return _picked;
    }
  }
  try {
    const response = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0, maxTokens: 50, responseTimeoutMs: 10000 });

    const raw = (response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(raw);
    if (parsed.ref && typeof parsed.ref === 'string') {
      return parsed.ref;
    }
    logger.info(`[recipe.run] LLM resolution: no ref returned for intent "${intent}"`);
    return null;
  } catch (e) {
    logger.warn(`[recipe.run] LLM resolution parse error: ${e.message}`);
    return null;
  }
}

async function run(args) {
  const { name, args: skillArgs, timeoutMs: rawTimeout, execPath: directExecPath, sessionId } = args || {};
  const timeoutMs = Math.min(rawTimeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const mergedSkillArgs = { ...(skillArgs || {}), ...(sessionId ? { sessionId } : {}) };

  let resolvedPath;
  try {
    resolvedPath = resolveRecipePath(name, directExecPath);
  } catch (e) {
    return { ok: false, skillName: name, error: e.message };
  }
  if (!resolvedPath) {
    return {
      ok: false, skillName: name,
      error: `No recipe found for "${name}". Installed code skills (index.cjs/python/shell) are retired — reusable procedures are authored plans.`,
    };
  }

  const result = await runRecipeSkill(resolvedPath, mergedSkillArgs, timeoutMs);
  return { ...result, skillName: name, execType: 'recipe' };
}

module.exports = { run };
