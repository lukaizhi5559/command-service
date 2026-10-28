'use strict';

// ---------------------------------------------------------------------------
// dom.act.cjs — Deterministic dispatcher skill for `on-page-action` plan steps.
//
// The planner emits { skill: 'dom.act', stepType: 'on-page-action', agentHint?,
// args: { task/goal, agentId, sessionId? } }. At execution time this skill
// probes the real page state (router.cjs — no LLM) and delegates to the atomic
// agent that fits: just.type / meta.find / shortcut.keys / tab.map / gesture /
// arrow.grid / turn.loop.
//
// The resolved agent name is returned on the result as `resolvedAgent` so the
// UI trace and replan logic can see which executor actually ran.
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { routeOnPageAction } = require('./lib/browserCore/router.cjs');
const { deriveSessionId, qualifyOpenTab, resolveExtSession } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { hasVisibleDialog } = require('./lib/browserCore/overlayProbe.cjs');
const { deepLinkOpensOverlay, classifyDeepLinkType } = require('../skill-helpers/deep-link-types.cjs');
const { inferPageCategory } = require('../skill-helpers/page-category.cjs');
const { _noSubmitGoalRe } = require('./lib/browserCore/tabMap.cjs');
const { resolveOrdinalItem } = require('./lib/browserCore/ordinal.cjs');

// True when the goal is *only* the create/compose action that a
// creation/compose deep-link already performed. Any residual work in the
// goal (titling, filling, clicking, navigating) disqualifies it — those
// still need an agent. Excluded-word list errs toward not gating.
const _CREATE_ACTION_RE = /\b(create|compose|new|make|start|open)\b/i;
const _RESIDUAL_WORK_RE = /\b(and|then|titled|named?|called|with|fill|type|write|set|add|enter|including|containing|click|that says|body|subject|send|about)\b/i;
function _isPureCreateGoal(goal, priorNavType) {
  if (priorNavType !== 'creation' && priorNavType !== 'compose') return false;
  const g = String(goal || '').trim();
  if (!g) return false;
  return _CREATE_ACTION_RE.test(g) && !_RESIDUAL_WORK_RE.test(g);
}

// Activation/readiness goals — "ensure X is in focus and ready for
// interaction", "bring the session to the foreground", "activate the tab".
// Lead verb + readiness-state noun required; a residual ACTION verb vetoes
// ("ready to type", "ensure the field is filled" fall through to the router).
const _ACTIVATION_LEAD_RE = /^\s*(?:please\s+)?(?:ensure|make\s+sure|confirm|verify|check\s+(?:that|if)|wait\s+(?:until|for)|activate|bring|focus|switch\s+to|prepare|set\s+up)\b/i;
const _ACTIVATION_STATE_RE = /\b(in\s+focus|focused|ready|open|load(?:ed|ing)?|activat\w+|foreground|forefront|front|visible|usable|prepared|available|for\s+interaction|interact)/i;
const _ACTIVATION_RESIDUAL_RE = /\b(type|fill|write|enter|send|click|press|submit|post|scroll|select|choose|download|upload|compose|reply|forward|delete)\w*\s+(?:"[^"]+"|'[^']+'|[a-z])/i;
function _isActivationGoal(goal) {
  const g = String(goal || '').trim();
  if (!g || g.length > 200) return false;
  return _ACTIVATION_LEAD_RE.test(g) && _ACTIVATION_STATE_RE.test(g) && !_ACTIVATION_RESIDUAL_RE.test(g);
}

function _hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

// ── Email-compose field extraction ──────────────────────────────────────────
// Two grammars, kept separate on purpose:
//   labeled  — "To: x@y.com, Subject: 'Q3', Body: 'hi'" (planner-emitted shape;
//              values slice between label boundaries, quoted runs captured
//              verbatim, unquoted values end at the first , or ;)
//   freeform — "send a quick email to x@y.com saying the update is ready"
//              (bare-email + `saying` body)
// Recipient values validate — URLs/domains/sentence captures are rejected so a
// false-positive parse can never be typed into the page or sent to.
const _EMAIL_LABEL_RE = /(?:^|[,;\s—–])(to|cc|bcc|subject|body)\s*:/gi;
const _EMAIL_FREEFORM_TO_RE = /(?:email|e-mail|mail|message|to|recipient)\s+([\w.+-]+@[\w-]+\.[\w.]+)/i;
const _EMAIL_SAYING_RE = /\bsaying\s+["'‘“]?([^"'’”]+)["'’”]?/i;
const _EMAIL_QUOTED_SUBJ_RE = /\bsubject\s*[:=]?\s*["'‘“]([^"'’”]+)["'’”]/i;
const _EMAIL_VALID_TO_RE = /^[\w.+-]+@[\w-]+\.[\w.]+$/;
const _EMAIL_VALID_NAME_RE = /^[\w][\w .'-]{1,60}$/;

function _parseEmailFields(text) {
  const fields = {};
  const hits = [];
  let m;
  while ((m = _EMAIL_LABEL_RE.exec(text || ''))) {
    hits.push({ key: m[1].toLowerCase(), segStart: m.index, valStart: m.index + m[0].length });
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].segStart : (text || '').length;
    let v = String(text || '').slice(hits[i].valStart, end).trim();
    const q = /^["'‘“]([^"'’”]+)["'’”]/.exec(v);
    if (q) v = q[1].trim();
    else v = v.replace(/[,;][\s\S]*$/, '').trim();
    if (v && !fields[hits[i].key]) fields[hits[i].key] = v;
  }
  if (!fields.to) {
    const em = _EMAIL_FREEFORM_TO_RE.exec(text || '');
    if (em) fields.to = em[1];
  }
  if (!fields.body) {
    const sm = _EMAIL_SAYING_RE.exec(text || '');
    if (sm) fields.body = sm[1].trim();
  }
  if (!fields.subject) {
    const sub = _EMAIL_QUOTED_SUBJ_RE.exec(text || '');
    if (sub) fields.subject = sub[1].trim();
  }
  for (const k of ['to', 'cc', 'bcc']) {
    if (fields[k] && !_EMAIL_VALID_TO_RE.test(fields[k]) && !_EMAIL_VALID_NAME_RE.test(fields[k])) delete fields[k];
  }
  return fields;
}

const _EMAIL_SEND_RE = /\b(?:send|dispatch|deliver|fire\s+off|shoot\s+off)\b/i;
const _EMAIL_DRAFT_ONLY_RE = /\b(?:draft|don'?t\s+send|do\s+not\s+send|just\s+(?:write|compose|draft)|no\s+send|without\s+sending|save\s+(?:it\s+)?as\s+(?:a\s+)?draft)\b/i;

const AGENT_RUNNERS = {
  'just.type.agent':    () => require('./just.type.agent.cjs').justTypeAgent,
  'meta.find.agent':    () => require('./meta.find.agent.cjs').metaFindAgent,
  'shortcut.keys.agent':() => require('./shortcut.keys.agent.cjs').shortcutKeysAgent,
  'tab.map.agent':      () => require('./tab.map.agent.cjs').tabMapAgent,
  'form.fill.agent':    () => require('./form.fill.agent.cjs').formFillAgent,
  'gesture.agent':      () => require('./gesture.agent.cjs').gestureAgent,
  'arrow.grid.agent':   () => require('./arrow.grid.agent.cjs').arrowGridAgent,
  'turn.loop.agent':    () => require('./turn.loop.agent.cjs').turnLoopAgent,
};

// Fill-the-form goals → form.fill.agent (memory resolution + deterministic
// fill) instead of tab.map's per-step LLM loop. Fires only when the goal
// names a form/fields AND the probe confirmed a multi-field surface.
function _isFillFormGoal(goal, args = {}) {
  if (args.fields || args.resolvedFields || args.gatheredAnswers) return true;
  const g = String(goal || '');
  return /\b(?:fill|complete|enter|type)[^.]{0,40}\b(?:form|application|registration|signup|fields?)\b/i.test(g)
      || /\b(?:form|application|registration|signup)\b[^.]{0,40}\b(?:fill|complete)\b/i.test(g);
}

async function domAct(args = {}) {
  const {
    task, goal: _goalArg, agentId = 'default.agent', sessionId: _sid,
    pageCategory: _pageCategoryArg, agentContext = '', agentHint = null,
    triedAgents = null, _progressCallbackUrl,
    priorNavUrl = null, priorNavType = null, expectOverlay: _expectOverlayArg = false,
  } = args;
  const goal = task || _goalArg || '';
  if (!goal) return { ok: false, error: 'dom.act: no task/goal' };

  // Category derivation — the planner may emit pageCategory, but most steps
  // don't. Infer deterministically (service map → host map → cached LLM) so
  // category gating (ai_chat just-type, allowedTiers, overlay hints) actually
  // engages on the atomic path.
  let pageCategory = _pageCategoryArg;
  if (!pageCategory || pageCategory === 'web_generic') {
    try {
      pageCategory = await inferPageCategory({ agentId, task: goal });
      if (pageCategory !== _pageCategoryArg) {
        logger.info(`[dom.act] pageCategory inferred: ${pageCategory} (agentId=${agentId}, was=${_pageCategoryArg || 'none'})`);
      }
    } catch (_) { pageCategory = _pageCategoryArg || 'web_generic'; }
  }

  const sessionId = qualifyOpenTab(await resolveExtSession(_sid || deriveSessionId(agentId)), goal);

  // Bound-page precondition — an on-page goal presumes a live bound page.
  // A dead/missing/blank binding must surface as a structured failure so the
  // caller can re-navigate to the context URL and retry, rather than let
  // probes "succeed" on about:blank and route a real goal to an empty page
  // (observed: "click the third item" ran entirely on a minted about:blank,
  // then turn.loop navigated it to an unrelated laptop SERP).
  let _boundPageUrl = null;
  try {
    // A bound tab can race a fresh chrome.tabs.create / in-flight navigation —
    // the tab exists but is still about:blank when this step starts. Poll a
    // short window (fast-exit on a real http(s) URL, earlier still when the
    // host already matches the prior nav target) before declaring the binding
    // dead. Observed: tab checked ~250ms after creation, about:blank →
    // bound-page-missing → turn-loop burned 8 turns on an empty page.
    const _expectHost = _hostOf(priorNavUrl);
    const _blankish = (h) => !h || /^(about:|chrome:|edge:|brave:|chrome-extension:)/i.test(h);
    const _readHref = async () => {
      const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 4000, text: 'location.href' }).catch(() => null);
      return { ok: !!r?.ok, href: String(r?.result ?? '').replace(/^"|"$/g, ''), error: r?.error };
    };
    let _last = await _readHref();
    let _deadline = Date.now() + 12000;
    while (_last.ok && _blankish(_last.href) && Date.now() < _deadline) {
      await new Promise(r => setTimeout(r, 400));
      _last = await _readHref();
      if (_last.ok && !_blankish(_last.href)) {
        const h = _hostOf(_last.href);
        if (!_expectHost || !h || h === _expectHost || h.endsWith('.' + _expectHost) || Date.now() > _deadline - 9000) break;
      }
    }
    if (!_last.ok || _blankish(_last.href)) {
      logger.warn(`[dom.act] bound-page-missing: session=${sessionId} url=${_last.href || '(none)'} err=${_last.error || 'none'} (after poll)`);
      return {
        ok: false,
        error: 'bound-page-missing',
        detail: _last.error || `bound tab is on '${_last.href || 'no url'}'`,
        expectedHost: _expectHost,
        actualUrl: _last.href || null,
        sessionId,
      };
    }
    _boundPageUrl = _last.href;
  } catch (_) { /* probe failure is non-fatal — routing reports its own errors */ }

  // Settle gate: the previous step (url.first) resolves at domcontentloaded —
  // heavy SPAs (Gmail compose, Calendar dialogs) keep rendering after that.
  // Wait for page text to stabilize so the probe sees the real post-nav state.
  try {
    await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 });
  } catch (_) { /* non-fatal — probe anyway */ }

  // Expected-overlay gate. Two signals, observation-first:
  //   (a) DOM observation — a dialog is already mounted (handles ANY nav-
  //       triggered modal regardless of URL param knowledge), and a short
  //       late-mount poll when a nav just preceded this step (lazy React
  //       modals — LinkedIn share composer mounts ~1-3s after hydration).
  //   (b) URL classification — deepLinkOpensOverlay (generic param-key
  //       heuristic now covers unknown-site params like ?shareActive).
  // When overlay is expected/seen: poll until the dialog exists so downstream
  // detection finds it, and flag expectOverlay so tab.map never fires the
  // Escape+top-left focus reset that would dismiss it.
  // Single bounded dialog wait (~6s): exits the moment a modal-like layer is
  // detected, so an already-mounted or quickly-mounting dialog adds ~zero
  // startup delay. Covers (a) already-mounted modals, (b) lazy post-nav React
  // mounts, (c) URL-classified overlay intent. Late mounts beyond the bound
  // self-heal downstream (click→overlayChanged→rescan, scan-time dialog scope).
  const _looseOverlayProbe = () => hasVisibleDialog(sessionId);

  let overlaySeen = await _looseOverlayProbe();
  const expectOverlay = overlaySeen || deepLinkOpensOverlay(priorNavUrl, priorNavType) || _expectOverlayArg;
  if (!overlaySeen && (priorNavUrl || expectOverlay)) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const late = await detectOverlay(sessionId, pageCategory).catch(() => null);
      if (late?.active || await _looseOverlayProbe()) { overlaySeen = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    logger.info(`[dom.act] overlay wait (priorNavType=${priorNavType}, expect=${expectOverlay}) → dialog ${overlaySeen ? 'mounted' : 'NOT confirmed after 6s'}`);
  }
  // A step that NEEDS a dialog (the prior step produced one — openedDialog
  // propagated expectOverlay) can't proceed when the wait found none —
  // whatever follows (tab-map scan, fill) operates on the wrong state.
  // Observed: 'c' popin dismissed → tab.map scanned the month view and
  // clicked "31" on the mini calendar, navigating to a different month.
  if (expectOverlay && !overlaySeen) {
    return { ok: false, sessionId, agentId, error: 'expected dialog did not mount — prior step may have dismissed it or the shortcut missed focus', suggestedAgent: 'shortcut.keys.agent' };
  }

  // Already-satisfied gate: a creation/compose deep-link performs the action
  // itself (docs.google.com/document/create creates AND opens the doc). A
  // follow-on step whose whole goal is "create a new X" is therefore a no-op —
  // routing it to an LLM lets it wander (observed: tab-map clicked "Doc home"
  // and created a second document). Deliberately narrow: only fires when the
  // goal is purely the create action — fused goals ("create a doc titled X")
  // fall through so the residual part still executes.
  if (_isPureCreateGoal(goal, priorNavType)) {
    logger.info(`[dom.act] already satisfied — "${goal.slice(0, 60)}" done by ${priorNavType} deep-link (${priorNavUrl || 'unknown url'})`);
    postProgress(_progressCallbackUrl, { tier: 'done', message: `dom.act: already satisfied by navigation` });
    return { ok: true, alreadySatisfied: true, sessionId, agentId, url: priorNavUrl, output: `Already done — ${priorNavType} deep-link created it (${priorNavUrl || ''})` };
  }

  // Activation/readiness gate — "ensure X is in focus and ready", "bring the
  // session to the foreground", "activate the tab" are WINDOW-level ops, not
  // on-page actions. Routing them to an element executor lets it wander —
  // observed: "Ensure ChatGPT is in focus" → tab.map.agent's forced element
  // picks clicked through the user's chat sidebar (3× ~20s rescans, then
  // exhausted). Satisfy deterministically: activate the bound tab+window via
  // tab-select — the settle gate above already confirmed the page is stable.
  // Narrow: only fires when the goal is PURELY activation/readiness — a
  // residual action verb (fill/click/send…) falls through to the router.
  if (_isActivationGoal(goal)) {
    postProgress(_progressCallbackUrl, { tier: 'route', message: 'dom.act → activate: bringing bound tab to foreground' });
    try { await browserAct({ action: 'tab-select', sessionId, headed: true, timeoutMs: 5000 }); } catch (_) {}
    logger.info(`[dom.act] activation satisfied — "${goal.slice(0, 60)}" (tab-select on ${sessionId})`);
    return { ok: true, alreadySatisfied: true, routeRule: 'activation-goal', sessionId, agentId, url: _boundPageUrl || priorNavUrl || null, output: 'Activated the bound tab and confirmed the page is loaded' };
  }

  // Google Docs title gate — the doc is canvas-rendered but its title lives in
  // the known `.docs-title-input` box. A "set/rename the document title" goal
  // is a deterministic focus→select→type→Enter over the REAL input path
  // (a JS .value write doesn't commit to Docs' model). Routing it to
  // turn.loop burned a 6-turn observe loop on a node whose address is known.
  const _boundHost = _boundPageUrl ? _hostOf(_boundPageUrl) : null;
  if (_boundHost === 'docs.google.com'
      && /\b(?:set|rename|change|update|name|title)\b[^.]{0,40}\b(?:title|name|document|doc)\b/i.test(goal)) {
    const _tm = /(?:titled?|title\s+(?:to|as)|named?|called?|as)\s*["'‘“]([^"'’”]+)["'’”]/i.exec(goal)
      || /["'‘“]([^"'’”]+)["'’”]/.exec(goal)
      || /\btitle\s+to\s+(.+?)\s*$/i.exec(goal);
    const _newTitle = _tm ? _tm[1].trim() : null;
    if (_newTitle) {
      postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → docs title: "${_newTitle.slice(0, 40)}"` });
      try {
        const _focus = await browserAct({
          action: 'evaluate', sessionId, headed: true, timeoutMs: 6000,
          text: `(() => { const i = document.querySelector('input.docs-title-input') || document.querySelector('.docs-title-outer input') || document.querySelector('[aria-label*="Rename" i], [data-tooltip*="Rename" i]'); if (!i) return 'no-title-input'; i.focus(); if (i.select) i.select(); return 'focused'; })()`,
        });
        if (_focus?.ok && String(_focus.result || '').includes('focused')) {
          await browserAct({ action: 'type', sessionId, text: _newTitle, headed: true, timeoutMs: 15000 });
          await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 8000 });
          const _verify = await browserAct({
            action: 'evaluate', sessionId, headed: true, timeoutMs: 6000,
            text: `(document.title || '') + '|' + ((document.querySelector('input.docs-title-input') || {}).value || '')`,
          });
          const _v = String(_verify?.result || '');
          const _titleSet = _v.toLowerCase().includes(_newTitle.toLowerCase());
          logger.info(`[dom.act] docs-title: "${_newTitle.slice(0, 50)}" → ${_titleSet ? 'VERIFIED' : 'unverified'} (${_v.slice(0, 90)})`);
          return {
            ok: true, resolvedAgent: 'dom.act:docs-title', routeRule: 'docs-title',
            sessionId, agentId, url: _boundPageUrl, verified: _titleSet, mutationApplied: true,
            output: `Set the document title to "${_newTitle}"${_titleSet ? ' (verified in tab title)' : ''}`,
          };
        }
        logger.warn(`[dom.act] docs-title: title input not found (${_focus?.result || _focus?.error || 'probe failed'}) — falling through to router`);
      } catch (e) {
        logger.warn(`[dom.act] docs-title failed: ${e.message} — falling through to router`);
      }
    }
  }

  // Email-compose gate — a send/compose-email goal on an email_compose surface
  // is an app workflow, not a generic form: known selectors carry the values
  // (goal-parsed, NOT profile-resolved — form.fill's contract can't see "To:
  // X saying Y"), recipients commit as chips via Enter, and the send itself is
  // sendEmailWithVerification (validated click → post-send proof). Observed:
  // "Send a quick email to X saying Y" → routed to form.fill → nothing-filled
  // → false failure. Fail-closed: a send goal with no valid recipient and no
  // committed chip does not reach the send call.
  const _isComposeCtx = pageCategory === 'email_compose' || _boundHost === 'mail.google.com';
  if (_isComposeCtx) {
    const _fields = _parseEmailFields(goal) ;
    const _taskFields = _parseEmailFields(task);
    for (const k of ['to', 'cc', 'bcc', 'subject', 'body']) {
      if (!_fields[k] && _taskFields[k]) _fields[k] = _taskFields[k];
    }
    const _wantsSend = _EMAIL_SEND_RE.test(goal) && !_EMAIL_DRAFT_ONLY_RE.test(goal);
    if (Object.keys(_fields).length || _wantsSend) {
      postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → email-compose: ${Object.keys(_fields).join('+') || 'send-only'}` });
      try {
        // Composer presence gate — a compose window must actually be open
        // before field fills are attempted. Deep-links have landed tasks on
        // Gmail SEARCH pages where every fill silently failed and the run
        // still reported ok (observed: filled [] → "sent" hallucination).
        const _COMPOSER_PROBE = '!!document.querySelector(\'input[name="to"],textarea[name="to"],input[name="subjectbox"],div[aria-label="Message Body"]\')';
        const _probe = async () => {
          const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 6000, text: _COMPOSER_PROBE }).catch(() => null);
          return r?.result === true || r?.result === 'true';
        };
        let _composerOpen = await _probe();
        if (!_composerOpen && (_fields.to || _fields.subject || _fields.body || _wantsSend)) {
          // Try opening the composer via the canonical compose deep-link.
          const _composeUrl = _boundHost === 'mail.google.com'
            ? 'https://mail.google.com/mail/u/0/#inbox?compose=new'
            : null;
          if (_composeUrl) {
            logger.warn('[dom.act] email-compose: no composer open — navigating to compose deep-link');
            await browserAct({ action: 'navigate', sessionId, url: _composeUrl, headed: true, timeoutMs: 20000 });
            await new Promise(r => setTimeout(r, 1500));
            _composerOpen = await _probe();
          }
        }
        if (!_composerOpen && (_fields.to || _fields.subject || _fields.body)) {
          logger.warn('[dom.act] email-compose: composer not present and could not be opened — refusing silent no-op');
          return {
            ok: false, resolvedAgent: 'dom.act:email-compose', routeRule: 'email-compose',
            sessionId, agentId, url: _boundPageUrl, mutationApplied: false,
            error: 'email-compose: no compose window found — deep link did not open a composer',
          };
        }
        const _fill = async (sel, value, commitChip) => {
          const c = await browserAct({ action: 'click', selector: sel, sessionId, headed: true, timeoutMs: 8000 });
          if (!c?.ok) { logger.warn(`[dom.act] email-compose fill: click failed on ${sel} — ${c?.error || 'no element'}`); return false; }
          const t = await browserAct({ action: 'type', text: value, sessionId, headed: true, timeoutMs: 15000 });
          if (!t?.ok) { logger.warn(`[dom.act] email-compose fill: type failed after ${sel} — ${t?.error || 'unknown'}`); return false; }
          if (commitChip) {
            await browserAct({ action: 'press', key: 'Enter', sessionId, headed: true, timeoutMs: 5000 });
            await new Promise(r => setTimeout(r, 500));
          }
          return true;
        };
        const _filled = [];
        for (const k of ['to', 'cc', 'bcc']) {
          if (_fields[k]) {
            if (await _fill('input[name="to"],textarea[name="to"]', _fields[k], true)) _filled.push(k);
          }
        }
        if (_fields.subject) {
          if (await _fill('input[name="subjectbox"]', _fields.subject, false)) _filled.push('subject');
        }
        if (_fields.body) {
          if (await _fill('div[aria-label="Message Body"]', _fields.body, false)) _filled.push('body');
        }
        if (_wantsSend) {
          const _send = await browserAct({
            action: 'sendEmailWithVerification', sessionId,
            selector: 'div[data-tooltip*="Send"]', headed: true, timeoutMs: 30000,
          });
          if (_send?.ok) {
            logger.info(`[dom.act] email-compose: filled [${_filled.join(',')}] + VERIFIED SEND (session=${sessionId})`);
            return {
              ok: true, resolvedAgent: 'dom.act:email-compose', routeRule: 'email-compose+send',
              sessionId, agentId, url: _boundPageUrl, verified: true, mutationApplied: true,
              output: `Email ${_filled.length ? `filled (${_filled.join(', ')}) and ` : ''}sent — verified compose closed`,
            };
          }
          logger.warn(`[dom.act] email-compose: send verification failed — ${_send?.error || 'unknown'}`);
          return {
            ok: false, resolvedAgent: 'dom.act:email-compose', routeRule: 'email-compose+send',
            sessionId, agentId, url: _boundPageUrl, mutationApplied: _filled.length > 0,
            error: `email-compose: send failed after filling [${_filled.join(',')}] — ${_send?.error || 'unknown'}`,
            missingInputs: _fields.to ? undefined : [{ field: 'to', question: 'Who is the recipient?' }],
          };
        }
        logger.info(`[dom.act] email-compose: filled [${_filled.join(',')}] (draft — no send intent)`);
        return {
          ok: true, resolvedAgent: 'dom.act:email-compose', routeRule: 'email-compose',
          sessionId, agentId, url: _boundPageUrl, verified: _filled.length > 0, mutationApplied: _filled.length > 0,
          output: `Email draft filled (${_filled.join(', ') || 'nothing parsed'}) — left unsent`,
        };
      } catch (e) {
        logger.warn(`[dom.act] email-compose failed: ${e.message} — falling through to router`);
      }
    }
  }

  // Deterministic ordinal lane — "click/open the Nth item/result/listing"
  // resolves positionally against the live DOM: enumerate result-shaped
  // anchors in visual order and navigate to the Nth href. No LLM loop, no
  // element-map scan — and a navigate can't be occluded by page overlays.
  try {
    const _ordItem = await resolveOrdinalItem(browserAct, { sessionId, goal, headed: true });
    if (_ordItem?.href) {
      postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → ordinal: opening item #${_ordItem.nth}` });
      const _nav = await browserAct({ action: 'navigate', sessionId, url: _ordItem.href, headed: true, timeoutMs: 30000 });
      if (_nav?.ok) {
        await new Promise(r => setTimeout(r, 1200));
        const _urlAfter = (await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 5000, text: 'location.href' }).catch(() => null))?.result;
        const _navOk = _urlAfter && String(_urlAfter) !== String(_boundPageUrl || '');
        if (_navOk) {
          const _bodyText = (await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 6000, text: 'document.body ? document.body.innerText.slice(0, 4000) : ""' }).catch(() => null))?.result || '';
          logger.info(`[dom.act] ordinal lane: item #${_ordItem.nth} → ${String(_urlAfter).slice(0, 110)}`);
          return {
            ok: true,
            resolvedAgent: 'dom.act:ordinal',
            routeRule: 'ordinal-item',
            sessionId,
            url: String(_urlAfter),
            output: `Opened item #${_ordItem.nth}: "${(_ordItem.text || '').slice(0, 120)}" → ${String(_urlAfter).slice(0, 200)}` + (_bodyText ? `\n\nPage content:\n${String(_bodyText).slice(0, 3000)}` : ''),
          };
        }
        logger.warn('[dom.act] ordinal lane: navigate returned ok but URL unchanged — falling through to router');
      }
    } else if (_ordItem?.rowClick && _ordItem.sel) {
      // SPA row target (Gmail tr.zA, ARIA grid rows) — no href to navigate;
      // click the marked row and require an observable state change (URL or
      // body text) so a dead click can't be reported as success.
      postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → ordinal: clicking row #${_ordItem.nth}` });
      const _preText = (await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 5000, text: 'location.href + "|" + (document.body ? document.body.innerText.length : 0)' }).catch(() => null))?.result || '';
      let _clicked = await browserAct({ action: 'click', sessionId, selector: _ordItem.sel, headed: true, timeoutMs: 10000 }).catch(() => null);
      if (!_clicked?.ok && _ordItem.x != null) {
        _clicked = await browserAct({ action: 'clickAt', sessionId, x: _ordItem.x, y: _ordItem.y, headed: true, timeoutMs: 10000 }).catch(() => null);
      }
      if (_clicked?.ok) {
        await new Promise(r => setTimeout(r, 1500));
        const _postText = (await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 5000, text: 'location.href + "|" + (document.body ? document.body.innerText.length : 0)' }).catch(() => null))?.result || '';
        if (_postText !== _preText) {
          const _urlAfter = String(_postText).split('|')[0];
          const _bodyText = (await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 6000, text: 'document.body ? document.body.innerText.slice(0, 4000) : ""' }).catch(() => null))?.result || '';
          logger.info(`[dom.act] ordinal lane: row #${_ordItem.nth} clicked → ${_urlAfter.slice(0, 110)}`);
          return {
            ok: true,
            resolvedAgent: 'dom.act:ordinal',
            routeRule: 'ordinal-row',
            sessionId,
            url: _urlAfter,
            output: `Opened item #${_ordItem.nth}: "${(_ordItem.text || '').slice(0, 120)}" → ${_urlAfter.slice(0, 200)}` + (_bodyText ? `\n\nPage content:\n${String(_bodyText).slice(0, 3000)}` : ''),
          };
        }
        logger.warn('[dom.act] ordinal lane: row click reported ok but page state unchanged — falling through to router');
      }
    }
  } catch (e) {
    logger.warn(`[dom.act] ordinal lane error (non-fatal): ${e.message}`);
  }

  // Confirm/verify-only goals ("confirm you are on YouTube", "verify the page
  // is loaded", "make sure we're on gmail") are READ steps that leaked into the
  // on-page-action lane. The bound page's own URL answers them in one evaluate —
  // routing them into the cascade sent "navigate"-containing confirm text to
  // tab.map's 150-element scan loop (observed: youtube/amazon/chatgpt scans).
  // Guard: requires an explicit destination token after on/at/in, so action
  // goals ("check the box", "verify the email exists") can never match.
  try {
    const _confirmM = goal.match(/\b(?:confirm|verify|ensure|make sure)\b[\s\S]{0,80}?\b(?:on|at|in)\s+(?:the\s+|my\s+)?([a-z0-9-]+)/i);
    if (_confirmM && !/\b(?:click|type|fill|enter\s+text|press|scroll|select|submit|send|add\s+to)\b/i.test(goal)) {
      const _want = _confirmM[1].toLowerCase();
      const _ev = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 5000, text: 'location.href' }).catch(() => null);
      const _href = String(_ev?.result || '').toLowerCase();
      if (_href && _href.includes(_want)) {
        logger.info(`[dom.act] confirm-only goal — bound page already on "${_want}" — done without agent scan`);
        postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act: confirmed on ${_want}` });
        return {
          ok: true,
          resolvedAgent: 'dom.act:confirm',
          routeRule: 'confirm-only',
          sessionId,
          url: _href,
          output: `Confirmed: the page is on ${_href}`,
        };
      }
      if (_href) logger.info(`[dom.act] confirm goal — bound page is ${_href.slice(0, 70)}, not "${_want}" — routing normally`);
    }
  } catch (_) {}

  // Bounded re-route: a routed agent that fails (e.g. shortcut agent finds no
  // matching hotkey) is added to triedAgents and the router picks the next-best
  // candidate. Prevents one wrong classification from dead-ending the step.
  const tried = new Set(triedAgents || []);
  const MAX_ROUTE_ATTEMPTS = 3;
  // Total step budget — a routed agent's inner LLM loop can stall for minutes
  // on slow providers (observed: a "type into the field" step ran 2m17s until
  // the user cancelled). Bound the whole route loop and propagate an abort
  // signal so cooperative executors (turn.loop/playwright) stop mid-loop
  // instead of running on as a zombie while a re-route fires.
  const STEP_BUDGET_MS = Number(args.stepTimeoutMs || process.env.DOM_ACT_STEP_BUDGET_MS || 120000);
  const _stepDeadline = Date.now() + STEP_BUDGET_MS;
  const _budgetAbort = new AbortController();
  const _onCallerAbort = () => _budgetAbort.abort();
  if (args._abortSignal) {
    if (args._abortSignal.aborted) _budgetAbort.abort();
    else args._abortSignal.addEventListener('abort', _onCallerAbort, { once: true });
  }
  let res = null;
  let lastRoute = null;
  for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
    if (Date.now() > _stepDeadline) {
      logger.warn(`[dom.act] step budget ${Math.round(STEP_BUDGET_MS / 1000)}s exceeded before attempt ${attempt + 1} — stopping`);
      break;
    }
    const route = await routeOnPageAction({
      sessionId, goal, pageCategory,
      // A failing agent steers its successor: just.type's value-not-landed
      // suggests turn.loop, tab.map exhaustion suggests turn.loop, etc.
      agentHint: attempt === 0 ? agentHint : (res?.suggestedAgent || null),
      triedAgents: tried,
    });
    lastRoute = route;
    // On-page gate: the goal isn't a page action at all (activation/window-
    // level) — satisfy it deterministically instead of picking an executor.
    if (route?.notOnPage) {
      logger.info(`[dom.act] router.onPage: goal is not on-page — activating bound tab instead of forcing an element lane ("${goal.slice(0, 60)}")`);
      try { await browserAct({ action: 'tab-select', sessionId, headed: true, timeoutMs: 5000 }); } catch (_) {}
      return { ok: true, alreadySatisfied: true, routeRule: route.rule, sessionId, agentId, url: route.currentUrl || _boundPageUrl || null, output: 'Goal was window/tab-level, not an on-page action — activated the bound tab.' };
    }
    // Vision-verify: the screenshot already satisfies the goal — done with no
    // agent (e.g. "confirm you are on YouTube" on the loaded homepage).
    if (route?.verifySatisfied) {
      logger.info(`[dom.act] vision:verify — goal already satisfied on ${String(route.currentUrl || '').slice(0, 80)}`);
      return {
        ok: true,
        resolvedAgent: 'dom.act:vision-verify',
        routeRule: route.rule,
        sessionId,
        url: route.currentUrl || undefined,
        output: `Confirmed by page screenshot: the goal is already satisfied on ${route.currentUrl || 'the bound page'}.`,
      };
    }
    // The router probed the live URL and may have refined a web_generic
    // category by hostname — adopt it for the executor (drives just.type's
    // Enter-on-submit behavior and overlay scoping).
    if (route.pageCategory && route.pageCategory !== pageCategory) {
      logger.info(`[dom.act] pageCategory refined by router → ${route.pageCategory}`);
      pageCategory = route.pageCategory;
    }
    // Form-fill override: explicit fill-the-form goals on a real multi-field
    // surface belong to form.fill.agent — it resolves values from memory and
    // fills deterministically instead of burning an LLM call per field.
    if (route.agent === 'tab.map.agent' && _isFillFormGoal(goal, args)
        && (route.probe?.fillableCount || 0) >= 2 && !tried.has('form.fill.agent')) {
      route.agent = 'form.fill.agent';
      route.rule += '+form-fill';
    }
    if (tried.has(route.agent)) break; // forced fallback re-picked a tried agent — stop
    logger.info(`[dom.act] routed "${goal.slice(0, 60)}" → ${route.agent} (rule=${route.rule}, attempt=${attempt + 1})`);
    postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → ${route.agent} (${route.rule})` });

    const run = AGENT_RUNNERS[route.agent];
    if (!run) break;
    // Progress heartbeat — the UI otherwise sits on a static "Still working
    // on…" while the inner loop burns remote LLM calls. Post which executor
    // is running and for how long.
    const _attemptStart = Date.now();
    const _hb = setInterval(() => {
      postProgress(_progressCallbackUrl, {
        tier: 'work',
        message: `dom.act: ${route.agent} working (${Math.round((Date.now() - _attemptStart) / 1000)}s)`,
      });
    }, 10000);
    _hb.unref?.();
    const _remaining = Math.max(_stepDeadline - Date.now(), 1000);
    const _budgetTimer = setTimeout(() => _budgetAbort.abort(), _remaining);
    _budgetTimer.unref?.();
    try {
      res = await run()({
        ...args,
        goal,
        sessionId,
        agentId,
        pageCategory,
        agentContext,
        expectOverlay,
        // No-submit goals propagate to tab.map/form.fill even when the planner
        // didn't emit an explicit noSubmit flag — the phrase is self-protecting.
        noSubmit: args.noSubmit === true || _noSubmitGoalRe.test(goal),
        _abortSignal: _budgetAbort.signal,
        _progressCallbackUrl,
      });
    } finally {
      clearTimeout(_budgetTimer);
      clearInterval(_hb);
    }
    if (Date.now() > _stepDeadline && !res?.ok) {
      logger.warn(`[dom.act] ${route.agent} exceeded step budget (${Math.round(STEP_BUDGET_MS / 1000)}s) — stopping instead of re-routing`);
      res = { ...(res || {}), ok: false, error: res?.error || 'dom.act-step-timeout', stopReason: 'step-budget-exceeded' };
      lastRoute = route;
      break;
    }
    if (res?.ok) break;
    // Mutation-applied guard: a failed executor that already landed the goal's
    // quoted value (e.g. verify criteria were over-strict) must not trigger a
    // re-route — the next agent would blindly re-type into whatever is focused.
    // Two honesty gates before crediting it:
    //   1. The failure must be a verify-REJECTED done attempt ("Done rejected")
    //      — exhaustion/element-mismatch errors mean incomplete work, not an
    //      over-strict verifier.
    //   2. The page must not still sit on an unsubmitted creation/compose URL
    //      (eventedit, ?action=TEMPLATE, /new) — a quoted value typed into an
    //      unsaved form is transient and will be lost on nav.
    if (_mutationApplied(res, goal) && !(await _stillOnUnsubmittedForm(sessionId))) {
      logger.info(`[dom.act] ${route.agent} reported failure but the goal's value was already applied — treating as complete (verification over-strict)`);
      return {
        ok: true, mutationApplied: true,
        note: 'mutation applied; verification inconclusive',
        resolvedAgent: route.agent, routeRule: route.rule, sessionId,
        output: res.output || res.result || `Applied: ${goal.slice(0, 80)}`,
      };
    }
    // Unquoted typed-value early exit — _mutationApplied needs a quoted value,
    // but planner steps often phrase the value bare ("type in the ask anything
    // field how are you doing"). Probe editable elements for a 4+-word window
    // of the goal's tail — if the text landed, a failed verify/exhaustion
    // shouldn't trigger a re-route that re-types into whatever is focused.
    if (/\b(?:type|enter|input|write|put|fill)\b/i.test(goal) && await _typedValueLanded(sessionId, goal)) {
      if (!(await _stillOnUnsubmittedForm(sessionId))) {
        logger.info(`[dom.act] ${route.agent} failed but the typed value is present in a page field — treating as complete`);
        return {
          ok: true, mutationApplied: true,
          note: 'typed value present in page field; verification inconclusive',
          resolvedAgent: route.agent, routeRule: route.rule, sessionId,
          output: res?.output || res?.result || `Applied: ${goal.slice(0, 80)}`,
        };
      }
    }
    if (attempt === MAX_ROUTE_ATTEMPTS - 1) break;
    // Surface whatever diagnostic the executor gave — error, stopReason,
    // verdict, last action — a bare "(unknown)" leaves the failure opaque
    // (observed: turn.loop bail logged 'unknown' when error was unset).
    const _why = res?.error || res?.stopReason || res?.verdict || res?.reason
      || res?.note || (res?.actionHistory || []).slice(-1)[0] || 'unknown';
    logger.warn(`[dom.act] ${route.agent} failed (${_why}) — re-routing`);
    tried.add(route.agent);
    res.routeRule = route.rule;
  }
  if (args._abortSignal) {
    try { args._abortSignal.removeEventListener('abort', _onCallerAbort); } catch (_) {}
  }
  // Read-only guard — a mutation goal can never be satisfied by actions that
  // only READ the page. Observed: a calendar-event delete step returned
  // "Get page text → ok" and downstream synthesis hedged instead of failing —
  // the event was never touched. With no click/fill/key/submit/nav evidence
  // the step did nothing; report unsatisfied so the planner replans.
  if (res?.ok && !res.alreadySatisfied && !res.mutationApplied
      && /\b(delete|delte|remove|erase|trash|cancel|send|post|submit|create|add|book|schedule|rename|edit|update|fill|type|click|select|check|purchase|order|pay|reschedul\w*|move|change)\b/i.test(goal)) {
    const _hist = [...(res.actionHistory || []), ...(res.transcript || [])].map(String);
    const _mutEvidence = _hist.some(h => /\b(click|fill|type|keypress|press|enter|submit|delet\w*|remov\w*|select|save|send|post|confirm|tap|drag|nav|open)\w*\b/i.test(h));
    if (!_mutEvidence) {
      logger.warn(`[dom.act] mutation goal answered by read-only actions only — reporting unsatisfied ("${goal.slice(0, 60)}")`);
      return {
        ok: false, unsatisfied: true,
        error: 'read-only actions cannot satisfy a mutation goal',
        resolvedAgent: lastRoute?.agent, routeRule: lastRoute?.rule, sessionId,
        output: res.output || res.result || '',
      };
    }
  }
  return { ...(res || {}), resolvedAgent: lastRoute?.agent, routeRule: res?.routeRule || lastRoute?.rule, sessionId };
}

// Did a type-goal's value actually land in a page field? Probes editable
// elements (input/textarea/contenteditable/textbox) for a 4+-word window of
// the goal's tail — the typed value is usually the goal's trailing phrase
// ("…how are you doing"), while the field name sits mid-goal and lives in
// placeholder attributes (never in el.value), so suffix windows distinguish
// the two without an LLM call.
async function _typedValueLanded(sessionId, goal) {
  try {
    const words = String(goal || '').toLowerCase().replace(/["'`]/g, '').split(/\s+/).filter(w => w.length > 1);
    if (words.length < 4) return false;
    const probes = [];
    for (let k = 4; k <= Math.min(8, words.length); k++) probes.push(words.slice(-k).join(' '));
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 4000,
      text: `(() => {
        const probes = ${JSON.stringify(probes)};
        const els = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
        for (const el of els) {
          const v = String(el.value || el.innerText || '').toLowerCase().replace(/\\s+/g, ' ').trim();
          if (v.length < 8) continue;
          for (const p of probes) { if (v.includes(p)) return p; }
        }
        return '';
      })()`,
    });
    const hit = String(res?.result || '').replace(/^"|"$/g, '');
    if (hit) logger.info(`[dom.act] typed-value probe hit: field contains "${hit.slice(0, 60)}"`);
    return !!hit;
  } catch (_) { return false; }
}

// Did a failed executor still land the goal's quoted value? Conservative:
// needs a quoted value in the goal AND a successful fill/type/reactFill
// carrying it in the result's filledFields/actionHistory/transcript — and
// the failure must be a verify-rejected done claim. Exhaustion ("Exceeded N
// inner steps", "Element mismatch"), transport and parse errors mean the
// work is incomplete — the executor never believed it was done.
function _mutationApplied(res, goal) {
  if (!res || res.ok) return false;
  const err = String(res.error || res.note || '');
  if (!/done\s+rejected|verif/i.test(err)) return false;
  const q = String(goal || '').match(/"([^"]{2,120})"/) || String(goal || '').match(/'([^']{2,120})'/);
  const target = q ? q[1].trim().toLowerCase() : '';
  if (!target) return false;
  for (const f of res.filledFields || []) {
    if (f && String(f.value || '').toLowerCase().includes(target)) return true;
  }
  const hay = [...(res.actionHistory || []), ...(res.transcript || [])]
    .map(String).filter(Boolean);
  return hay.some(h =>
    /(?:fill|type|reactfill)/i.test(h) &&
    !/→\s*failed/i.test(h) &&
    h.toLowerCase().includes(target));
}

// True when the current URL is still an unsubmitted creation/compose surface
// (eventedit form, ?action=TEMPLATE, /new shortcut, compose overlay): values
// typed there are transient until a Save/submit lands, so a failed executor's
// fill evidence must not be credited as applied work.
function _isUnsubmittedFormUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  try {
    if (classifyDeepLinkType(u) === 'compose') return true;
    const host = new URL(u).hostname;
    // Bare *.new create shortcuts (docs.new, sheets.new, cal.new): a live
    // page still showing the shortcut means the create-redirect is mid-flight
    // — transient surface, not applied work.
    if (/\.new$/.test(host)) return true;
  } catch (_) {}
  return /\/eventedit(\/|$|\?|#)|action=TEMPLATE|\/new\b|[?&#](?:new|create|draft|compose)=/i.test(u);
}

// Probe the live page URL; true when it still sits on an unsubmitted form.
// A dead/unreadable page counts as "still on the form" — conservative: when
// we can't confirm the work persisted, we don't claim it did.
async function _stillOnUnsubmittedForm(sessionId) {
  try {
    const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
    const raw = res?.result;
    const url = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : (raw || '');
    return _isUnsubmittedFormUrl(url);
  } catch (_) {
    return true;
  }
}

module.exports = { domAct, _isPureCreateGoal, _mutationApplied, _isUnsubmittedFormUrl };
