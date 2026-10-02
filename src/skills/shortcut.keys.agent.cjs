'use strict';

// ---------------------------------------------------------------------------
// shortcut.keys.agent.cjs — Atomic agent: press an app keyboard shortcut.
//
// Tier-3 executor. Picks the shortcut from the app's known shortcut table
// (appKnowledge) via the existing LLM picker, or uses an explicit keyCombo.
//
// Contract:
//   args: { goal, keyCombo?, sessionId, agentId?, pageCategory?, agentContext?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _executeShortcut, _readActiveElement } = require('./instruction.runner.cjs');
const { _extractShortcut } = require('./browser.agent.cjs');
const { loadShortcutTable } = require('./lib/browserCore/knowledge.cjs');
const { probePageStructure, detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { browserAct } = require('./browser.act.cjs');

function hostnameOf(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }

async function shortcutKeysAgent(args = {}) {
  const { goal = '', sessionId, agentId = '', pageCategory = 'web_generic', agentContext = '', _progressCallbackUrl } = args;
  if (!sessionId) return { ok: false, error: 'shortcut.keys.agent: no sessionId' };
  if (!goal && !args.keyCombo) return { ok: false, error: 'shortcut.keys.agent: no goal/keyCombo' };

  return withSessionMutex(sessionId, async () => {
    let keyCombo = args.keyCombo;
    const actionHistory = [];

    if (!keyCombo) {
      let currentUrl = '';
      try {
        const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
        const raw = res?.result;
        currentUrl = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : (raw || '');
      } catch (_) {}
      const hostname = hostnameOf(currentUrl);
      const shortcuts = loadShortcutTable(hostname);
      if (shortcuts.length === 0) {
        return { ok: false, error: `No known shortcuts for ${hostname || 'this site'}`, suggestedAgent: 'tab.map.agent' };
      }
      const overlay = await detectOverlay(sessionId, pageCategory).catch(() => null);
      const focused = await _readActiveElement(sessionId).catch(() => null);
      const shortcutLabels = shortcuts.map((s, i) => `${i + 1}. ${s.key} — ${s.desc}`).join('\n');
      const picked = await _extractShortcut(goal, actionHistory, hostname, agentContext || shortcutLabels, currentUrl, !!(overlay && overlay.active), focused, pageCategory, null, '');
      keyCombo = picked?.keyCombo || picked?.key || null;
      if (!keyCombo || keyCombo === '0') {
        return { ok: false, error: 'No shortcut matched the goal', suggestedAgent: 'tab.map.agent' };
      }
    }

    postProgress(_progressCallbackUrl, { tier: 'shortcuts', message: `shortcut.keys.agent: pressing ${keyCombo}` });
    const res = await _executeShortcut(sessionId, keyCombo, goal, actionHistory);
    actionHistory.push(`Shortcut: pressed "${keyCombo}" ${res?.ok ? '→ ok' : '→ FAILED'}`);
    return {
      ok: !!res?.ok,
      output: res?.ok ? `Pressed ${keyCombo}` : undefined,
      error: res?.error,
      suggestedAgent: res?.ok ? undefined : 'tab.map.agent',
      sessionId,
      actionHistory,
    };
  });
}

module.exports = { shortcutKeysAgent };
