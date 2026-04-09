'use strict';

/**
 * skill: playwright.agent
 *
 * Agentic browser loop — given a plain-language goal, runs an internal
 * snapshot → LLM → action → repeat cycle until the goal is achieved or
 * max_turns is reached.
 *
 * Unlike browser.act (which executes a single pre-planned step), this skill
 * owns its own reasoning loop: it reads what's on the page after every action
 * and decides the next step itself. The StateGraph issues ONE step:
 *
 *   { skill: 'playwright.agent', args: { goal: '...', sessionId: '...' } }
 *
 * and this skill returns when the goal is done (or on failure), with a full
 * turn-by-turn transcript attached.
 *
 * Args:
 *   goal        {string}  — plain-language description of what to accomplish
 *   sessionId   {string}  — browser session id (default: 'playwright_agent')
 *   maxTurns    {number}  — hard cap on reasoning turns (default: 12)
 *   timeoutMs   {number}  — per-action timeout ms passed to browser.act (default: 15000)
 *   headed      {boolean} — show browser window (default: true)
 *   url         {string}  — optional: navigate here before starting the loop
 *
 * Returns:
 * {
 *   ok:          boolean,
 *   goal:        string,
 *   sessionId:   string,
 *   turns:       number,          — how many turns were consumed
 *   done:        boolean,         — true if LLM declared DONE
 *   result:      string,          — final summary from LLM
 *   transcript:  Array<Turn>,     — full turn log
 *   error?:      string,
 *   executionTime: number,
 * }
 *
 * Turn shape:
 * {
 *   turn:     number,
 *   action:   object,   — the browser.act args the LLM chose
 *   outcome:  object,   — browser.act result
 *   thoughts: string,   — LLM reasoning (optional, may be empty)
 * }
 */

const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

// ---------------------------------------------------------------------------
// System prompt — sent once at start of each agentic loop
// ---------------------------------------------------------------------------
const AGENT_SYSTEM_PROMPT = `You are a browser automation agent controlling a real Chrome browser via playwright-cli.

Each turn you receive:
  GOAL: <the overall task to accomplish>
  TURN: <current turn number> / <max turns>
  SNAPSHOT: <ARIA accessibility tree of the current page (YAML format)>
  HISTORY: <list of actions taken so far and their results>

You must respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

{
  "thoughts": "<one sentence about what you see and why you're taking this action>",
  "done": false,
  "action": {
    "action": "<browser.act action name>",
    ... browser.act args ...
  }
}

OR when the goal is fully accomplished:

{
  "thoughts": "<what you did and confirmed>",
  "done": true,
  "result": "<one sentence summary of what was achieved>"
}

Valid browser.act actions (most common):
  navigate  { url }
  click     { selector }  — selector is a label/role string or ref like e12
  fill      { selector, text }
  press     { key }  — e.g. "Enter", "Tab", "Escape"
  scroll    { direction, distance }
  snapshot  {}  — re-read the page (use when unsure what changed)
  getText   {}  — extract full page text
  screenshot { filePath }
  waitForSelector { selector }
  waitForContent  { text }
  evaluate  { text: "<JS expression>" }
  state-save { filePath }
  state-load { filePath }
  close     {}

Rules:
- Always check the snapshot before clicking — use element refs (e12) when visible, labels otherwise.
- If an action fails, try a different approach rather than repeating the same thing.
- Declare done:true ONLY when you have confirmed the goal is achieved (not just attempted).
- If you cannot proceed after 3 consecutive failures, declare done:false with a result explaining why.
- Never navigate away from the current URL unless the goal requires it.
- Use state-save/state-load for auth persistence: filePath = ~/.thinkdrop/browser-sessions/<sessionId>.json`;

// ---------------------------------------------------------------------------
// Parse LLM response — extract JSON even if wrapped in prose
// ---------------------------------------------------------------------------
function parseAgentResponse(text) {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch (_) {}

  // Strip markdown fences
  const stripped = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}

  // Extract first {...} block
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build the per-turn user message
// ---------------------------------------------------------------------------
function buildTurnMessage(goal, turn, maxTurns, snapshotText, history) {
  const historyLines = history.length === 0
    ? '(none yet)'
    : history.map((h, i) =>
        `Turn ${i + 1}: ${JSON.stringify(h.action)} → ${h.outcome.ok ? 'OK' : 'FAILED'} ${h.outcome.error ? '(' + h.outcome.error + ')' : ''}`
      ).join('\n');

  const snapTrimmed = snapshotText
    ? (snapshotText.length > 8000 ? snapshotText.slice(0, 8000) + '\n[...snapshot truncated]' : snapshotText)
    : '(no snapshot available yet)';

  return [
    `GOAL: ${goal}`,
    `TURN: ${turn} / ${maxTurns}`,
    '',
    'SNAPSHOT:',
    snapTrimmed,
    '',
    'HISTORY:',
    historyLines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function playwrightAgent(args) {
  const {
    goal,
    sessionId  = 'playwright_agent',
    maxTurns   = 12,
    timeoutMs  = 15000,
    headed     = true,
    url,
  } = args || {};

  const start = Date.now();

  if (!goal) {
    return { ok: false, error: 'goal is required', executionTime: 0 };
  }

  logger.info(`[playwright.agent] start goal="${goal}" session=${sessionId} maxTurns=${maxTurns}`);

  const transcript = [];
  let currentSnapshot = '';
  let consecutiveFailures = 0;

  // Optional: navigate to a starting URL before the loop begins
  if (url) {
    logger.info(`[playwright.agent] navigating to starting URL: ${url}`);
    const navResult = await browserAct({ action: 'navigate', sessionId, url, headed, timeoutMs: Math.max(timeoutMs, 30000) });
    if (!navResult.ok) {
      return {
        ok: false, goal, sessionId, turns: 0, done: false,
        result: `Failed to navigate to starting URL: ${navResult.error}`,
        transcript: [],
        error: navResult.error,
        executionTime: Date.now() - start,
      };
    }
  }

  // Take initial snapshot
  const initSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
  if (initSnap.ok && initSnap.result) {
    currentSnapshot = initSnap.result;
  }

  const messages = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];

  for (let turn = 1; turn <= maxTurns; turn++) {
    logger.info(`[playwright.agent] turn ${turn}/${maxTurns}`);

    // Build user message with current state
    const userMsg = buildTurnMessage(goal, turn, maxTurns, currentSnapshot, transcript);
    messages.push({ role: 'user', content: userMsg });

    // Ask LLM what to do next
    let llmResponse;
    try {
      llmResponse = await askWithMessages(messages, {
        temperature: 0.1,
        responseTimeoutMs: 20000,
      });
    } catch (err) {
      logger.error(`[playwright.agent] LLM error on turn ${turn}: ${err.message}`);
      return {
        ok: false, goal, sessionId,
        turns: turn, done: false,
        result: `LLM unavailable: ${err.message}`,
        transcript,
        error: err.message,
        executionTime: Date.now() - start,
      };
    }

    // Parse LLM response
    const parsed = parseAgentResponse(llmResponse);
    if (!parsed) {
      logger.warn(`[playwright.agent] could not parse LLM response on turn ${turn}: ${llmResponse?.slice(0, 200)}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 3) break;
      // Add assistant response to message history and continue
      messages.push({ role: 'assistant', content: llmResponse || '' });
      continue;
    }

    // Add assistant response to message history for multi-turn context
    messages.push({ role: 'assistant', content: llmResponse });

    const { thoughts = '', done, action: actionArgs, result: doneResult } = parsed;
    logger.info(`[playwright.agent] turn ${turn} thoughts="${thoughts}" done=${done}`);

    // Goal achieved
    if (done) {
      logger.info(`[playwright.agent] DONE after ${turn} turns: ${doneResult}`);
      return {
        ok: true, goal, sessionId,
        turns: turn, done: true,
        result: doneResult || 'Goal accomplished.',
        transcript,
        executionTime: Date.now() - start,
      };
    }

    // Execute the action
    if (!actionArgs || !actionArgs.action) {
      logger.warn(`[playwright.agent] LLM returned no action on turn ${turn}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 3) break;
      continue;
    }

    // Inject session context into every browser.act call
    const actArgs = { ...actionArgs, sessionId, headed, timeoutMs };
    let outcome;
    try {
      outcome = await browserAct(actArgs);
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }

    logger.info(`[playwright.agent] turn ${turn} action=${actionArgs.action} ok=${outcome.ok}${outcome.error ? ' err=' + outcome.error : ''}`);

    if (outcome.ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      logger.warn(`[playwright.agent] action failed (${consecutiveFailures} consecutive): ${outcome.error}`);
    }

    transcript.push({ turn, action: actionArgs, outcome, thoughts });

    // Refresh snapshot after each action so the LLM sees the updated page
    try {
      const snap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
      if (snap.ok && snap.result) {
        currentSnapshot = snap.result;
      }
    } catch (_) {}

    if (consecutiveFailures >= 3) {
      logger.warn(`[playwright.agent] 3 consecutive failures — aborting loop`);
      break;
    }
  }

  // Exited loop without done:true
  return {
    ok: false, goal, sessionId,
    turns: transcript.length, done: false,
    result: `Goal not completed within ${maxTurns} turns.`,
    transcript,
    error: consecutiveFailures >= 3 ? '3 consecutive action failures' : `Reached max turns (${maxTurns})`,
    executionTime: Date.now() - start,
  };
}

module.exports = { playwrightAgent };
