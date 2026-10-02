'use strict';

// ---------------------------------------------------------------------------
// tab.map.agent.cjs — Atomic agent: Tab-Map on-page interaction.
//
// The default on-page executor. Scans the page's focusable/actionable element
// map, then runs a bounded inner loop (LLM picks next action → execute →
// repeat) until the step's sub-goal is done or maxSteps is hit. No Tab-Flow,
// no tier selection — the plan owns sequencing.
//
// Contract:
//   args: { goal, sessionId, agentId?, pageCategory?, agentContext?, stepType?,
//           maxSteps?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _tabMapInnerStep, buildTabMap } = require('./lib/browserCore/tabMap.cjs');
const { detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { browserAct } = require('./browser.act.cjs');

async function tabMapAgent(args = {}) {
  const {
    goal = '', sessionId, agentId = '', pageCategory = 'web_generic',
    stepType = 'on-page-action', maxSteps = 6,
    expectOverlay = false, _progressCallbackUrl,
  } = args;
  let agentContext = args.agentContext || '';
  if (!sessionId) return { ok: false, error: 'tab.map.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'tab.map.agent: no goal' };

  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'tab-map', message: `tab.map.agent: ${goal.slice(0, 60)}` });

    const overlay = await detectOverlay(sessionId, pageCategory).catch(() => null);
    // expectOverlay: a prior deep-link step said a dialog should be open —
    // never fire the Escape+top-left focus reset, which would dismiss it.
    // Not const — updated mid-session when a click opens/closes a DOM modal
    // (overlayChanged signal), so the rescan doesn't Escape the new dialog.
    let overlayActive = !!(overlay && overlay.active) || expectOverlay === true;
    logger.info(`[tab.map.agent] overlayActive=${overlayActive} (detected=${!!overlay?.active}, expectOverlay=${expectOverlay}) → skipReset=${overlayActive}`);

    let currentUrl = '';
    const readUrl = async () => {
      try {
        const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
        const raw = res?.result;
        return (typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : raw) || '';
      } catch (_) { return currentUrl; }
    };
    currentUrl = await readUrl();

    let tabMap = await buildTabMap(sessionId, 150, { skipReset: overlayActive }).catch(() => null);
    let tabMapUrl = currentUrl;
    if (!tabMap || tabMap.length === 0) {
      return { ok: false, error: 'Tab-map scan returned no actionable elements', suggestedAgent: 'turn.loop.agent', sessionId };
    }

    const actionHistory = [];
    // Seed from prior browser steps (same session + page only — a navigated
    // page gets a clean slate so stale fills don't poison the new map).
    const filledFields = (Array.isArray(args.priorFilledFields) &&
      (!args.priorNavUrl || !currentUrl || args.priorNavUrl === currentUrl))
      ? args.priorFilledFields
          .filter(f => f && (f.label || f.value) && (!f.url || !currentUrl || f.url === currentUrl))
          .map(f => ({ ref: f.ref, label: f.label, value: f.value }))
      : [];
    if (filledFields.length) {
      logger.info(`[tab.map.agent] seeded ${filledFields.length} prior filled field(s)`);
    }
    const consumedRefs = new Set();
    const clickedRefs = new Set();
    const clickedSubmitRefs = new Set();
    let lastVerifyFailed = false;
    let extractedPageText = '';
    let lastError = null;

    // Hollow-done guard: the LLM can answer "Done" without executing any
    // action (observed after a replan — it saw the open compose dialog and
    // stopped). A done-with-zero-actions result is a non-completion, not a
    // success: correct once via agentContext, then fail if it repeats.
    let hollowDoneCorrected = false;

    for (let i = 0; i < maxSteps; i++) {
      const res = await _tabMapInnerStep(
        sessionId, goal, actionHistory, currentUrl, overlayActive, pageCategory,
        agentContext, tabMap, filledFields, consumedRefs, lastVerifyFailed,
        extractedPageText, stepType, clickedRefs, clickedSubmitRefs,
      );

      // ── Bookkeeping FIRST: record what the step did — including the
      // session-ending action. A submit click that verifies returns
      // { done, ok, stateChanged } — if this ran only in the not-done branch,
      // the final "Click Send → page changed" would be dropped and downstream
      // synthesis would report "composed but not sent" (observed live).
      if (res?.action) {
        const note = res.stateChanged ? '→ page changed'
          : res.alreadyFilled ? '→ already filled'
          : res.suppressed ? '→ suppressed (already submitted)'
          : res.verifyFailed ? '→ done rejected'
          : res.ok ? '→ ok' : '→ FAILED';
        actionHistory.push(`${res.action} ${note}`);
      }
      if (res?.filledRef) {
        filledFields.push({ ref: res.filledRef, label: res.filledLabel, value: res.filledValue });
        // Patch the cached map entry — the map isn't rebuilt after a fill, so
        // its snapshot value ("Untitled document") would otherwise keep
        // contradicting the [FILLED] marker and the LLM re-acts on a done field.
        if (Array.isArray(tabMap)) {
          const _fe = tabMap.find(e => e.ref === res.filledRef);
          if (_fe && res.filledValue !== undefined) { _fe.value = res.filledValue; _fe.currentValue = res.filledValue; }
        }
        // A new fill changes form state — a submit clicked before it may now
        // succeed. Re-enable suppressed submit elements.
        clickedSubmitRefs.clear();
        logger.info(`[tab.map.agent] filled "${res.filledLabel}" — marked [FILLED] for next LLM call (${filledFields.length} fields filled)`);
      }
      if (res?.consumedRef) consumedRefs.add(res.consumedRef);
      if (res?.clickedRef) {
        clickedRefs.add(res.clickedRef);
        if (res.clickedSubmit) clickedSubmitRefs.add(res.clickedRef);
      }
      if (res?.extractedText) extractedPageText = res.extractedText;
      lastVerifyFailed = res?.verifyFailed === true;

      // Parse failure is recoverable: nudge the LLM to emit one clean action
      // line on the next iteration instead of aborting the whole step.
      if (res?.parseFailed) {
        agentContext = [agentContext, 'Correction: your last reply was not a valid action. Output exactly ONE action line (e.g. Type "..." into the "..." field, Click "...", Press Enter, DONE) — no reasoning, no explanation, no repeated drafts.'].filter(Boolean).join('\n\n');
      }

      if (res?.done) {
        if (res.ok) {
          if (actionHistory.length === 0 && !hollowDoneCorrected) {
            hollowDoneCorrected = true;
            logger.warn('[tab.map.agent] LLM said Done with zero actions — correcting and continuing');
            agentContext = [agentContext, 'Correction: you reported Done but no action has been executed yet. The goal is NOT complete — perform the next concrete action (click/type/press) toward it.'].filter(Boolean).join('\n\n');
            continue;
          }
          if (actionHistory.length === 0) {
            lastError = 'LLM reported Done without executing any actions';
            break;
          }
          postProgress(_progressCallbackUrl, { tier: 'tab-map', message: `tab.map.agent: done after ${i + 1} step(s)` });
          return {
            ok: true, output: actionHistory.join('; ') || 'done', sessionId,
            actionHistory, filledFields, clickedRefs: [...clickedRefs],
          };
        }
        lastError = res.error || 'Tab-map inner step failed';
        break;
      }

      // ── Rescan when the step signals stale state (target collapsed/
      // detached/not-found) or the page navigated. Refs persist on live DOM
      // nodes across rebuilds — unrelated entries keep their refs.
      if (res?.rescan) {
        // A click may have opened/closed a DOM modal — track it so the rescan
        // doesn't Escape the dialog we just opened (and the next prompt knows
        // an overlay is active).
        if (res.overlayOpened === true) overlayActive = true;
        else if (res.overlayOpened === false) overlayActive = false;
        logger.info(`[tab.map.agent] rescan signaled (${res.error || (res.overlayOpened ? 'dialog opened' : 'stale element')}) — rebuilding tab-map`);
        tabMap = await buildTabMap(sessionId, 150, { skipReset: overlayActive }).catch(() => tabMap);
        const newUrl = await readUrl();
        if (newUrl) { tabMapUrl = newUrl; currentUrl = newUrl; }
      } else {
        const newUrl = await readUrl();
        if (newUrl && newUrl !== tabMapUrl) {
          tabMapUrl = newUrl;
          currentUrl = newUrl;
          tabMap = await buildTabMap(sessionId, 150, { skipReset: overlayActive }).catch(() => tabMap);
        }
      }
      lastError = res?.error || lastError;
    }

    logger.warn(`[tab.map.agent] exhausted/failed: ${lastError || 'max steps'}`);
    return {
      ok: false, error: lastError || `Exceeded ${maxSteps} inner steps`,
      suggestedAgent: 'turn.loop.agent', sessionId,
      actionHistory, filledFields, clickedRefs: [...clickedRefs],
    };
  });
}

module.exports = { tabMapAgent };
