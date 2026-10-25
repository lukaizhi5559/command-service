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
//           maxSteps?, noSubmit?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _tabMapInnerStep, buildTabMap } = require('./lib/browserCore/tabMap.cjs');
const { detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { preflightStateGate } = require('./lib/browserCore/stateEyes.cjs');
const { deriveShape } = require('./lib/browserCore/shapeMap.cjs');
const { saveFormMap } = require('./lib/appKnowledge.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { browserAct } = require('./browser.act.cjs');
const { inferPageCategory } = require('../skill-helpers/page-category.cjs');

async function tabMapAgent(args = {}) {
  const {
    goal = '', sessionId, agentId = '',
    stepType = 'on-page-action', maxSteps = 6,
    expectOverlay = false, noSubmit = false, _progressCallbackUrl,
  } = args;
  let pageCategory = args.pageCategory || 'web_generic';
  let agentContext = args.agentContext || '';
  if (!sessionId) return { ok: false, error: 'tab.map.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'tab.map.agent: no goal' };

  // Self-derive category for standalone calls — overlay detection uses it.
  if (pageCategory === 'web_generic') {
    try { pageCategory = await inferPageCategory({ agentId, task: goal }); } catch (_) {}
  }

  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'tab-map', message: `tab.map.agent: ${goal.slice(0, 60)}` });

    const overlay = await detectOverlay(sessionId, pageCategory).catch(() => null);
    // expectOverlay: a prior deep-link step said a dialog should be open —
    // never fire the Escape+top-left focus reset, which would dismiss it.
    // Not const — updated mid-session when a click opens/closes a DOM modal
    // (overlayChanged signal), so the rescan doesn't Escape the new dialog.
    let overlayActive = !!(overlay && overlay.active) || expectOverlay === true;
    logger.info(`[tab.map.agent] overlayActive=${overlayActive} (detected=${!!overlay?.active}, expectOverlay=${expectOverlay}) → skipReset=${overlayActive}`);

    // ── Pre-scan eyes (shared stateEyes gate) — state→skill contract runs
    // BEFORE the destructive reset. tab.map's own overlay check above is kept
    // for the fast path; the gate adds dead-session detection, widened dialog
    // sight, and the tev1 tie-breaker for ambiguous states. A dialog-scoped
    // verdict sets overlayActive → skipReset protects the live dialog.
    const _gate = await preflightStateGate({ sessionId, skill: 'tab.map', goal });
    if (_gate.redirect) return { ok: false, suggestedAgent: _gate.redirect, why: _gate.why, sessionId };
    if (_gate.satisfied) return { ok: true, alreadySatisfied: true, output: _gate.why, sessionId };
    if (_gate.abort)    return { ok: false, error: _gate.reason, sessionId };
    if (!overlayActive && (_gate.dialogScoped || _gate.state?.dialogOpen)) {
      overlayActive = true;
      logger.info('[tab.map.agent] gate: dialog detected/expected — dialog-scoped scan, reset skipped');
    }

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

    // ── Shape emit + persist — the scan is the discovery primitive. Derive
    // the page shape (semantic fields, submit, signature) and cache it under
    // host+intent so later runs skip the scan entirely.
    let _pageShape = null;
    try {
      _pageShape = deriveShape(tabMap, { url: currentUrl, dialogOpen: overlayActive, includeRefs: true });
      if (_pageShape) {
        const _host = (() => { try { return new URL(currentUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
        const _intent = /event|meeting|calendar/i.test(goal) ? 'scheduling'
          : /e-?mail|compose|draft/i.test(goal) ? 'mail'
          : /fill|form|sign.?up|register|checkout/i.test(goal) ? 'form' : 'generic';
        if (_host) {
          // Cache the durable copy — refs are per-scan ephemeral, selectors persist.
          saveFormMap(_host, _intent, {
            ..._pageShape,
            fields: _pageShape.fields.map(({ ref, ...rest }) => rest),
            submit: _pageShape.submit ? (({ ref, ...rest }) => rest)(_pageShape.submit) : null,
          });
          logger.info(`[tab.map.agent] shape emitted: ${_pageShape.fields.length} fields (${_pageShape.fields.map(f => f.semanticRole || f.key).join('/')}) → form_map[${_host}.${_intent}]`);
        }
      }
    } catch (_) { /* shape persistence is advisory — never fail the scan */ }

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
    // Rescan budget — each rebuild costs ~20s of DOM traversal. Goals that keep
    // staling the map (unsatisfiable on this page — e.g. an activation goal
    // misrouted here) used to burn the whole step budget on rebuilds; cap them
    // so a stale-loop fails fast instead of scanning forever.
    let rescans = 0;
    const MAX_RESCANS = 2;

    // Hollow-done guard: the LLM can answer "Done" without executing any
    // action (observed after a replan — it saw the open compose dialog and
    // stopped). A done-with-zero-actions result is a non-completion, not a
    // success: correct once via agentContext, then fail if it repeats.
    let hollowDoneCorrected = false;

    for (let i = 0; i < maxSteps; i++) {
      const res = await _tabMapInnerStep(
        sessionId, goal, actionHistory, currentUrl, overlayActive, pageCategory,
        agentContext, tabMap, filledFields, consumedRefs, lastVerifyFailed,
        extractedPageText, stepType, clickedRefs, clickedSubmitRefs, noSubmit,
      );

      // ── Bookkeeping FIRST: record what the step did — including the
      // session-ending action. A submit click that verifies returns
      // { done, ok, stateChanged } — if this ran only in the not-done branch,
      // the final "Click Send → page changed" would be dropped and downstream
      // synthesis would report "composed but not sent" (observed live).
      if (res?.action) {
        const note = res.stateChanged ? '→ page changed'
          : res.alreadyFilled ? '→ already filled'
          : res.noSubmitBlocked ? '→ blocked (no-submit policy)'
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
            pageShape: _pageShape || undefined, pageCategory: _pageShape?.pageCategory || pageCategory,
            tabMap, tabMapUrl,
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
        if (++rescans > MAX_RESCANS) {
          lastError = `tab-map rebuilds exhausted (${MAX_RESCANS}) — goal likely unsatisfiable on this page`;
          logger.warn(`[tab.map.agent] ${lastError} — suggesting turn.loop`);
          return { ok: false, error: lastError, suggestedAgent: 'turn.loop.agent', sessionId };
        }
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
  }, args._mutexOwner);
}

module.exports = { tabMapAgent };
