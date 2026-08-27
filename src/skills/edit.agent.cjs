// edit.agent.cjs — File-based editing agent for long-form content editing.
// Works like a mini Devin: reads a file, understands the goal, applies edits
// using LLM + string replacements, saves the file.
//
// Used by:
//   - instruction.runner.cjs type-edit (Edit mode) — browser fields
//   - app.agent.cjs — editing files in desktop apps (VS Code, TextEdit)
//   - cli.agent.cjs — editing files via CLI (vim, nano)
//
// API:
//   const { editAgent } = require('./edit.agent.cjs');
//   const result = await editAgent({ goal, filePath, agentContext? });
//   // result = { ok: true, summary: "Edited 3 sections" } | { ok: false, error: "..." }

const fs = require('fs');
const path = require('path');

let _logger;
try {
  _logger = require('../skill-helpers/skill-logger.cjs');
} catch {
  _logger = { info: console.log, warn: console.warn, error: console.error };
}
const logger = _logger;

// ── Helpers ──
function _readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    logger.warn(`[edit.agent] _readFile failed: ${e.message}`);
    return null;
  }
}

function _writeFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) {
    logger.warn(`[edit.agent] _writeFile failed: ${e.message}`);
    return false;
  }
}

// ── Small file editing (< 10k chars) ──
// LLM returns the full edited content.
async function _editSmallFile(goal, content, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}` : '';

  const systemPrompt = `You are a precise text editor. You edit the given content according to the goal.
Return ONLY the edited content — no explanations, no markdown code fences.
- Apply the requested changes precisely
- Preserve the overall structure and formatting
- Do not add or remove content beyond what the goal asks for
- If the goal asks to add a section, add it in the appropriate place
- If the goal asks to fix something, fix only that
- Return the full edited content (not just the changes)`;

  const userPrompt = `Goal: ${goal}
${_contextBlock}

Content to edit:
---
${content}
---

Edited content:`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 8000, temperature: 0.2, responseTimeoutMs: 60000, taskType: 'complex' });
    const edited = (raw || '').trim().replace(/^```(?:text|plaintext|markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    if (!edited || edited.length < content.length * 0.3) {
      logger.warn(`[edit.agent] _editSmallFile: edited content suspiciously short (${edited.length} vs ${content.length}) — rejecting`);
      return null;
    }
    return edited;
  } catch (e) {
    logger.warn(`[edit.agent] _editSmallFile failed: ${e.message}`);
    return null;
  }
}

// ── Large file editing (>= 10k chars) ──
// LLM identifies sections to edit and returns string replacements.
async function _editLargeFile(goal, content, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext ? `\n\nAgent context:\n${String(agentContext).slice(0, 500)}` : '';

  // Send a summary (first 2000 + last 2000 chars) + ask for replacements
  const _summary = content.slice(0, 2000) + '\n\n[... middle truncated ...]\n\n' + content.slice(-2000);

  const systemPrompt = `You are a precise text editor for large files. You cannot see the full file,
but you can see the beginning and end. Return ONLY a JSON array of string replacements:
[{"old": "exact text to find", "new": "replacement text"}, ...]
Rules:
- Each "old" must be an EXACT substring that appears in the file (copy it precisely)
- Each "new" is the replacement text
- Keep replacements small and targeted (a few lines each)
- Do NOT include the full file — only the parts that need changing
- If no changes needed, return []
- Return ONLY the JSON array, no explanations`;

  const userPrompt = `Goal: ${goal}
${_contextBlock}

File summary (first 2000 + last 2000 chars):
---
${_summary}
---

Replacements (JSON array):`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 4000, temperature: 0.2, responseTimeoutMs: 60000, taskType: 'complex' });
    const cleaned = (raw || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    const replacements = JSON.parse(cleaned);

    if (!Array.isArray(replacements) || replacements.length === 0) {
      logger.info(`[edit.agent] _editLargeFile: no replacements returned`);
      return content; // no changes
    }

    // Apply replacements
    let edited = content;
    let applied = 0;
    for (const rep of replacements) {
      if (rep.old && edited.includes(rep.old)) {
        edited = edited.replace(rep.old, rep.new || '');
        applied++;
      } else {
        logger.warn(`[edit.agent] _editLargeFile: replacement "old" not found: "${String(rep.old || '').slice(0, 80)}"`);
      }
    }
    logger.info(`[edit.agent] _editLargeFile: applied ${applied}/${replacements.length} replacements`);
    return edited;
  } catch (e) {
    logger.warn(`[edit.agent] _editLargeFile failed: ${e.message}`);
    return null;
  }
}

// ── Main entry point ──
// { goal, filePath, agentContext? } → { ok, summary } | { ok: false, error }
async function editAgent({ goal, filePath, agentContext }) {
  if (!filePath) return { ok: false, error: 'No filePath provided' };
  if (!goal) return { ok: false, error: 'No goal provided' };

  const content = _readFile(filePath);
  if (content === null) return { ok: false, error: `Could not read file: ${filePath}` };

  logger.info(`[edit.agent] editAgent: goal="${String(goal).slice(0, 80)}", file=${path.basename(filePath)}, size=${content.length} chars`);

  let edited;
  if (content.length < 10000) {
    edited = await _editSmallFile(goal, content, agentContext);
  } else {
    edited = await _editLargeFile(goal, content, agentContext);
  }

  if (edited === null) {
    return { ok: false, error: 'LLM edit failed — no output' };
  }

  if (edited === content) {
    logger.info(`[edit.agent] editAgent: no changes made`);
    return { ok: true, summary: 'No changes needed' };
  }

  const written = _writeFile(filePath, edited);
  if (!written) {
    return { ok: false, error: `Could not write file: ${filePath}` };
  }

  const _changePct = Math.round(Math.abs(edited.length - content.length) / content.length * 100);
  logger.info(`[edit.agent] editAgent: done — ${content.length} → ${edited.length} chars (${_changePct}% change)`);
  return { ok: true, summary: `Edited: ${content.length} → ${edited.length} chars` };
}

module.exports = { editAgent };
