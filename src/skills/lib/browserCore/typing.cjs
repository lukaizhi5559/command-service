'use strict';

// ---------------------------------------------------------------------------
// browserCore/typing.cjs — the shared typing engine for atomic agents.
// Extracted from instruction.runner.cjs: _executeJustType + the type-* variant
// executors, _executeTypedField dispatch, field-activation helpers.
// Runner internals (_executeAction, _runtimeDiscoverCommands) are lazy-proxied
// via _r() to avoid circular module loads.
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');
const { browserAct } = require('../../browser.act.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _R = null;
const _r = () => (_R ||= require('../../instruction.runner.cjs'));
const _executeAction = (...a) => _r()._executeAction(...a);
const _runtimeDiscoverCommands = (...a) => _r()._runtimeDiscoverCommands(...a);


async function _clickFirstFillable(sessionId) {
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
      // Helper: build descriptor for an element
      function _desc(el) {
        el.click();
        el.focus();
        let ref = el.getAttribute('data-td-ref');
        if (!ref || !ref.startsWith('tm-')) {
          ref = 'tm-' + Math.random().toString(36).slice(2, 10);
          el.setAttribute('data-td-ref', ref);
        }
        // Scoped text: for contenteditable, use selection to read focused text node,
        // not parent's innerText (which flattens nested children like "Add icon Add cover...")
        let text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
        if (!text && el.isContentEditable) {
          try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              let node = sel.getRangeAt(0).startContainer;
              if (node.nodeType === 3) node = node.parentElement;
              while (node && node !== el && node.parentElement !== el) node = node.parentElement;
              text = (node?.innerText || node?.textContent || '').trim();
            }
          } catch (_) {}
          if (!text) text = el.innerText;
        }
        if (!text) text = el.textContent || '';
        text = text.trim().replace(/\\s+/g, ' ').slice(0, 120);
        return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text, ref, type: el.tagName === 'INPUT' ? (el.type || 'text') : '', isContentEditable: el.isContentEditable, ariaRoleDescription: el.getAttribute('aria-roledescription') || '', placeholder: el.getAttribute('placeholder') || '', dataPlaceholder: el.getAttribute('data-placeholder') || '' };
      }

      // 1. Try title field: contenteditable with title signals (generic — works for Notion, Google Docs, etc.)
      // Signals (strongest first): aria-roledescription*="page title", h1[contenteditable],
      // placeholder/data-placeholder includes "New page" or "Untitled"
      const _titleSel = [
        '[contenteditable="true"][aria-roledescription*="page title"]',
        '[contenteditable="true"][aria-roledescription*="title"]',
        'h1[contenteditable="true"]',
        '[contenteditable="true"][placeholder*="New page"]',
        '[contenteditable="true"][data-placeholder*="New page"]',
        '[contenteditable="true"][placeholder*="Untitled"]',
        '[contenteditable="true"][data-placeholder*="Untitled"]',
      ].join(', ');
      const _titleEl = document.querySelector(_titleSel);
      if (_titleEl) {
        const r = _titleEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return _desc(_titleEl);
      }

      // 2. Fallback: first visible fillable element, skipping non-editable div[role=group] placeholders
      const sel = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          // Skip non-contenteditable divs with role=group (Notion placeholder "Add icon Add cover...")
          if (el.tagName === 'DIV' && !el.isContentEditable && el.getAttribute('role') === 'group') continue;
          return _desc(el);
        }
      }
      return null;
    })()`,
    });
    const raw = res?.result;
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^"|"$/g, '').replace(/\\"/g, '"')) : raw;
    } catch (_) {
      // CLI fallback may return error text instead of JSON — log and return null
      logger.warn(`[instruction.runner] _clickFirstFillable: could not parse result (engine may be unavailable) — raw="${String(raw || '').slice(0, 80)}"`);
      return null;
    }
    if (parsed) logger.info(`[instruction.runner] _clickFirstFillable: focused ${parsed.tag} role=${parsed.role} ce=${parsed.isContentEditable} text="${parsed.text?.slice(0, 40)}"`);
    return parsed || null;
  } catch (e) {
    logger.warn(`[instruction.runner] _clickFirstFillable failed: ${e.message}`);
    return null;
  }
}

// ── Spreadsheet cell navigation helper ─────────────────────────────────
// Focuses a specific cell in Google Sheets / Excel Online via the Name Box.
// Flow: Cmd+J (Mac) / Ctrl+J (Win) → focus Name Box → type cell address → Enter → cell focused.
// Returns { ok, cellAddress, error }


// ── Backup helper ──
// Saves a backup of the current field content before any modification.
// Enables undo for all operations on fields with existing content.
// Files stored in ~/.thinkdrop/edits/copies/copy-{timestamp}-backup.md
async function _saveBackup(focusedElement) {
  const _editsDir = path.join(os.homedir(), '.thinkdrop', 'edits', 'copies');
  try {
    fs.mkdirSync(_editsDir, { recursive: true });
  } catch (e) {
    logger.warn(`[instruction.runner] _saveBackup: could not create edits dir: ${e.message}`);
    return;
  }

  const _content = focusedElement?.currentValue || '';
  if (!_content || _content.length < 5) return;

  const _timestamp = Date.now();
  const _backupFile = path.join(_editsDir, `copy-${_timestamp}-backup.md`);
  try {
    fs.writeFileSync(_backupFile, _content, 'utf8');
    logger.info(`[instruction.runner] _saveBackup: saved ${_content.length} chars to ${path.basename(_backupFile)}`);
  } catch (e) {
    logger.warn(`[instruction.runner] _saveBackup: could not save backup: ${e.message}`);
    return;
  }

  // Cleanup: keep only last 20 backup files
  try {
    const files = fs.readdirSync(_editsDir)
      .filter(f => f.startsWith('copy-'))
      .map(f => ({ name: f, path: path.join(_editsDir, f), mtime: fs.statSync(path.join(_editsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = 20; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path); } catch {}
    }
  } catch {}
}

// type-plain: single-line text + Enter (search, chat, simple form fields).
// Also handles multi-line contenteditable (block creation) — the existing _executeJustType logic.
// ctx = { isEdit, hasContent } — Meta+a only when isEdit && hasContent (uniform policy)


// _verifyTypedValueLanded — post-type confirmation that the typed value is in
// a fillable element AND that element is (or contains) the focused element.
// Runs after typing but BEFORE any submit keypress, so a mis-landed value is
// caught while it's still recoverable (submit clears the field, destroying
// the evidence).
//   { ok:true }                          — value found on the focused carrier
//   { ok:true }                          — value consumed into a chip/pill token
//   { ok:false, error:'value-not-landed' }  — no fillable contains the value
//   { ok:false, error:'value-misplaced' }   — value is on a non-focused element
//   { ok:true }                          — unreadable page → don't block
async function _verifyTypedValueLanded(sessionId, value) {
  const needle = String(value || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  if (!needle || needle.length < 2) return { ok: true };
  const expr = `(function(){
    var needle = ${JSON.stringify(needle.slice(0, 80).toLowerCase())};
    var norm = function(s){ return (s || '').toLowerCase(); };
    var els = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"], [role="searchbox"]');
    var carrier = null;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var v = norm(el.value !== undefined ? el.value : (el.innerText || el.textContent));
      if (v.indexOf(needle) !== -1) { carrier = el; break; }
    }
    if (!carrier) {
      // Token/chip fields (Gmail To/Cc/Bcc, recipient pickers, tag inputs)
      // consume the typed value into a pill element that is NOT a fillable —
      // without this branch every confirmed chip reads as value-not-landed
      // and the caller re-types in a loop (observed: Gmail To re-typed 5x).
      // Scoped to the open dialog (compose popups) or the focused field's own
      // container — a document-wide scan false-positives on recipient spans
      // rendered elsewhere on the page (e.g. Gmail thread header [email] spans).
      var PILLSEL = '[data-hovercard-id], [email], .vR .vN, [role="option"][data-name], [role="listbox"] [role="option"]';
      var scopes = [];
      var dlg = document.querySelector('[role="dialog"]');
      if (dlg) scopes.push(dlg);
      var p = document.activeElement, hops = 0;
      while (p && p !== document.body && p !== dlg && hops < 6) {
        if (p.querySelector && p.querySelector(PILLSEL)) { scopes.push(p); break; }
        p = p.parentElement; hops++;
      }
      for (var s = 0; s < scopes.length; s++) {
        var pills = scopes[s].querySelectorAll(PILLSEL);
        for (var pi = 0; pi < pills.length; pi++) {
          var pt = norm(pills[pi].textContent || '') + ' ' +
                   norm(pills[pi].getAttribute('email') || '') + ' ' +
                   norm(pills[pi].getAttribute('data-name') || '');
          if (pt.indexOf(needle) !== -1) return JSON.stringify({ landed: true, focused: true, chip: true });
        }
      }
      return JSON.stringify({ landed: false });
    }
    var ae = document.activeElement;
    var focused = ae === carrier || carrier.contains(ae) || ae.contains(carrier);
    return JSON.stringify({ landed: true, focused: focused });
  })()`;
  try {
    const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: expr });
    const raw = typeof res?.result === 'string' ? res.result.replace(/^"|"$/g, '') : '';
    const parsed = JSON.parse(raw || '{}');
    if (!parsed.landed) {
      logger.warn(`[instruction.runner] typed value not found in any fillable — value-not-landed`);
      return { ok: false, error: 'value-not-landed', suggestedAgent: 'turn.loop.agent' };
    }
    if (parsed.chip) {
      logger.info(`[instruction.runner] typed value consumed into chip/pill token — landed (token field)`);
      return { ok: true };
    }
    if (parsed.focused === false) {
      logger.warn(`[instruction.runner] typed value landed on a non-focused element — value-misplaced`);
      return { ok: false, error: 'value-misplaced', suggestedAgent: 'turn.loop.agent' };
    }
    return { ok: true };
  } catch (e) {
    logger.debug?.(`[instruction.runner] _verifyTypedValueLanded unreadable (${e.message}) — not blocking`);
    return { ok: true };
  }
}

// type-plain: single-line text + Enter (search, chat, simple form fields).
// Also handles multi-line contenteditable (block creation) — the existing _executeJustType logic.
// ctx = { isEdit, hasContent } — Meta+a only when isEdit && hasContent (uniform policy)
async function _executeTypePlain(sessionId, value, focusedElement, pageCategory, ctx = {}, goal = null, actionHistory = null) {
  const _tag = focusedElement.tag || '';
  const _role = focusedElement.role || '';

  logger.info(`[instruction.runner] type-plain: typing "${value.slice(0, 50)}" into ${_tag} "${(focusedElement.text || focusedElement.ariaLabel || '').slice(0, 40)}" (isEdit=${ctx.isEdit}, hasContent=${ctx.hasContent})`);

  // Detect contenteditable vs form input
  const _isFormInput = ['input', 'textarea'].includes(_tag);
  const _isContenteditable = !_isFormInput && (_role === 'textbox' || _tag === 'div');

  // Multi-line content for contenteditable (block creation in Notion, Google Docs, etc.)
  if (_isContenteditable && value.includes('\n')) {
    const lines = value.split('\n').filter(l => l.length > 0);
    logger.info(`[instruction.runner] type-plain: multi-line content (${lines.length} lines) for contenteditable`);

    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        // Only Meta+a when editing existing content; for create mode, just type
        if (ctx.isEdit && ctx.hasContent) {
          await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
          await _sleep(50);
        }
      } else {
        await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
        await _sleep(500);
      }
      await browserAct({ action: 'type', sessionId, text: lines[i], headed: true, timeoutMs: 10000 });
      await _sleep(300);
    }

    const _verify = await _verifyTypedValueLanded(sessionId, value);
    if (!_verify.ok) return { ok: false, pageChanged: false, error: _verify.error, suggestedAgent: _verify.suggestedAgent };

    if (pageCategory === 'ai_chat') {
      await _sleep(500);
      logger.info(`[instruction.runner] type-plain: pressing Enter for ai_chat submit`);
      await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
      await _sleep(1000);
    }

    return { ok: true, pageChanged: false };
  }

  // Single-line or form input: use _executeAction (includes reactFill, Meta+a for form inputs)
  const result = await _executeAction(sessionId, {
    action: 'Type',
    value: value,
    target: focusedElement.text || focusedElement.ariaLabel || '',
    pageCategory: pageCategory,
    ref: focusedElement.ref || null,
    hasContent: ctx.hasContent || focusedElement.hasContent || false,
    isEdit: ctx.isEdit || false,
    goal: goal,
    actionHistory: actionHistory,
  });

  if (!result?.ok) {
    return { ok: false, pageChanged: false, error: result?.error || 'Type failed' };
  }

  const _verify = await _verifyTypedValueLanded(sessionId, value);
  if (!_verify.ok) return { ok: false, pageChanged: false, error: _verify.error, suggestedAgent: _verify.suggestedAgent };

  // For AI chat, press Enter after typing to submit
  if (pageCategory === 'ai_chat') {
    await _sleep(500);
    logger.info(`[instruction.runner] type-plain: pressing Enter for ai_chat submit`);
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
    await _sleep(1000);
  }

  return { ok: true, pageChanged: false };
}

// type-list-item: typing into a list/checklist/todo item where Enter creates the next item.
// The LLM classifies the field as type-list-item via _extractFieldType (it sees the full
// focused element descriptor including aria-roledescription, the goal, and the value).
// This replaces the old regex-based _pressAfterIfNeeded list-item detection, which was
// fragile (broke for i18n, non-standard labels, hyphenated names like "to-do").
// The last-item guard prevents pressing Enter on the final item (would create an empty block).


// type-list-item: typing into a list/checklist/todo item where Enter creates the next item.
// The LLM classifies the field as type-list-item via _extractFieldType (it sees the full
// focused element descriptor including aria-roledescription, the goal, and the value).
// This replaces the old regex-based _pressAfterIfNeeded list-item detection, which was
// fragile (broke for i18n, non-standard labels, hyphenated names like "to-do").
// The last-item guard prevents pressing Enter on the final item (would create an empty block).
async function _executeTypeListItem(sessionId, value, focusedElement, pageCategory, ctx = {}, goal = null, actionHistory = null) {
  const _tag = focusedElement.tag || '';
  const _label = (focusedElement.text || focusedElement.ariaLabel || '').slice(0, 40);
  logger.info(`[instruction.runner] type-list-item: typing "${value.slice(0, 50)}" into ${_tag} "${_label}"`);

  // Type the value (same as type-plain for single-line)
  const result = await _executeAction(sessionId, {
    action: 'Type',
    value: value,
    target: focusedElement.text || focusedElement.ariaLabel || '',
    pageCategory: pageCategory,
    ref: focusedElement.ref || null,
    hasContent: ctx.hasContent || focusedElement.hasContent || false,
    isEdit: ctx.isEdit || false,
  });

  if (!result?.ok) {
    return { ok: false, pageChanged: false, error: result?.error || 'Type failed' };
  }

  // Last-item guard: don't press Enter on the last item (would create an empty block).
  // Parse goal for item count — handles both digit ("3 items") and word ("three items").
  if (goal && actionHistory) {
    const _wordNums = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const _digitMatch = goal.match(/(\d+)\s+(?:items?|todos?|tasks?|entries|things)/i);
    const _wordMatch = goal.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:items?|todos?|tasks?|entries|things)/i);
    let _targetCount = null;
    if (_digitMatch) _targetCount = parseInt(_digitMatch[1], 10);
    else if (_wordMatch) _targetCount = _wordNums[_wordMatch[1].toLowerCase()] || null;

    if (_targetCount) {
      // Count ONLY type-list-item entries (tagged with "(list-item)" in actionHistory).
      // This excludes type-plain (e.g. "Weekly Goals" into title) and type-commands
      // (e.g. "/todo" to create the block) which are not list items.
      // The +1 accounts for the current item (not yet pushed to actionHistory).
      const _typedItems = actionHistory.filter(a => /\(list-item\)/.test(a)).length + 1;
      if (_typedItems >= _targetCount) {
        logger.info(`[instruction.runner] type-list-item: last item (${_typedItems}/${_targetCount}) — skipping Enter`);
        return { ok: true, pageChanged: false, pressedEnter: false };
      }
    }
  }

  const _verify = await _verifyTypedValueLanded(sessionId, value);
  if (!_verify.ok) return { ok: false, pageChanged: false, error: _verify.error, suggestedAgent: _verify.suggestedAgent };

  // Press Enter to create the next list item
  logger.info(`[instruction.runner] type-list-item: pressing Enter to create next item`);
  await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
  await _sleep(500);
  return { ok: true, pageChanged: false, pressedEnter: true };
}

// type-edit: long-form content (generate or edit).
// Dispatches to _executeTypeGenerate or _executeTypeEditExisting based on isEdit from ctx.
// ctx.isEdit is pre-computed by _executeTypedField (hoisted edit/create decision).


// type-edit: long-form content (generate or edit).
// Dispatches to _executeTypeGenerate or _executeTypeEditExisting based on isEdit from ctx.
// ctx.isEdit is pre-computed by _executeTypedField (hoisted edit/create decision).
async function _executeTypeEdit(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx = {}) {
  const _currentValue = focusedElement?.currentValue || '';
  const _isEdit = ctx.isEdit === true && _currentValue && _currentValue.length > 10;

  logger.info(`[instruction.runner] type-edit: isEdit=${_isEdit}, goal="${String(goal || '').slice(0, 60)}"`);

  if (_isEdit) {
    return _executeTypeEditExisting(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext);
  }
  return _executeTypeGenerate(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext);
}

// type-edit (generate mode): LLM generates long text from the goal, then types it into the field.


// type-edit (generate mode): LLM generates long text from the goal, then types it into the field.
async function _executeTypeGenerate(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext) {
  const { askWithMessages } = require('../../../skill-helpers/skill-llm.cjs');

  // If the value from _extractValue is already long/multi-line, use it directly
  // (the LLM in _extractValue may have already generated the content)
  if (value && value.length > 100) {
    logger.info(`[instruction.runner] type-edit (generate): using provided value (${value.length} chars) — typing into field`);
    return _executeTypePlain(sessionId, value, focusedElement, pageCategory);
  }

  // Otherwise, generate the content from the goal
  logger.info(`[instruction.runner] type-edit (generate): generating content from goal`);

  const _contextBlock = agentContext ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}` : '';
  const _pageContext = pageContext ? `\nPage title: ${pageContext.title || 'unknown'}` : '';
  const _ard = focusedElement?.ariaRoleDescription || '';

  const systemPrompt = `You generate long-form content for a web page field based on the goal.
Return ONLY the content to type — no explanations, no markdown code fences.

Context-aware rules:
- If pageCategory is "social_feed": return ONLY the post/tweet text. NEVER return code, scripts, or automation instructions. The user wants to post a message, not automate posting.
- If the field is a code editor (aria-roledescription contains "code" or "editor", or the page is a code playground/IDE): returning code IS appropriate if the goal asks for code.
- If the goal explicitly asks to "write code", "write a script", "write a function": returning code IS appropriate.
- Otherwise: return human-readable prose only. NEVER return automation scripts (Playwright, Selenium, Puppeteer, browser automation code).

Content rules:
- If the value provided is already the complete content the user wants (e.g., a tweet text, a short answer), return it as-is — do NOT expand or generate additional content.
- Generate the full content requested by the goal
- Use appropriate formatting (paragraphs, lists, etc.) with \\n for line breaks
- Be thorough and complete
- Match the requested format (essay, document, prose, email body, code) — but only code when the context allows it (see rules above)`;

  const userPrompt = `Goal: ${goal}
Page category: ${pageCategory || 'unknown'}
Field: ${focusedElement?.tag || 'unknown'} role=${focusedElement?.role || 'none'} aria-roledescription="${_ard}"
Provided value: "${String(value || '').slice(0, 200)}"
${_pageContext}${_contextBlock}

Generate the content:`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 8000, temperature: 0.3, responseTimeoutMs: 60000, taskType: 'complex' });
    const generated = (raw || '').trim().replace(/^```(?:text|plaintext|markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

    if (!generated || generated.length < 20) {
      logger.warn(`[instruction.runner] type-edit (generate): LLM returned too little content (${generated.length} chars) — falling back to type-plain`);
      return _executeTypePlain(sessionId, value, focusedElement, pageCategory);
    }

    logger.info(`[instruction.runner] type-edit (generate): generated ${generated.length} chars — typing into field`);
    return _executeTypePlain(sessionId, generated, focusedElement, pageCategory);
  } catch (e) {
    logger.warn(`[instruction.runner] type-edit (generate) failed: ${e.message} — falling back to type-plain`);
    return _executeTypePlain(sessionId, value, focusedElement, pageCategory);
  }
}

// type-edit (edit mode): Meta+A → Meta+C → save to file → edit.agent → Meta+V paste back.


// type-edit (edit mode): Meta+A → Meta+C → save to file → edit.agent → Meta+V paste back.
async function _executeTypeEditExisting(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const _editsDir = path.join(os.homedir(), '.thinkdrop', 'edits', 'copies');
  try {
    fs.mkdirSync(_editsDir, { recursive: true });
  } catch (e) {
    logger.warn(`[instruction.runner] type-edit (edit): could not create edits dir: ${e.message}`);
  }

  // 1. Select all + copy (Meta+A → Meta+C)
  logger.info(`[instruction.runner] type-edit (edit): selecting all and copying field content`);
  await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
  await _sleep(100);
  await browserAct({ action: 'press', sessionId, key: 'Meta+c', headed: true, timeoutMs: 2000 });
  await _sleep(200);

  // 2. Read clipboard and save to file
  let clipboardContent = '';
  try {
    const clipRes = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(async () => {
        try { return await navigator.clipboard.readText(); }
        catch (e) { return null; }
      })()`,
    });
    clipboardContent = typeof clipRes?.result === 'string' ? clipRes.result : '';
  } catch { clipboardContent = ''; }

  if (!clipboardContent || clipboardContent.length < 10) {
    logger.warn(`[instruction.runner] type-edit (edit): clipboard empty or too short — falling back to generate`);
    return _executeTypeGenerate(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext);
  }

  // Save to file
  const _timestamp = Date.now();
  const _copyFile = path.join(_editsDir, `copy-${_timestamp}.md`);
  try {
    fs.writeFileSync(_copyFile, clipboardContent, 'utf8');
    logger.info(`[instruction.runner] type-edit (edit): saved ${clipboardContent.length} chars to ${path.basename(_copyFile)}`);
  } catch (e) {
    logger.warn(`[instruction.runner] type-edit (edit): could not save copy file: ${e.message}`);
    return _executeTypeGenerate(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext);
  }

  // 3. Call edit.agent to edit the file
  let editResult;
  try {
    const { editAgent } = require('../../edit.agent.cjs');
    editResult = await editAgent({ goal, filePath: _copyFile, agentContext });
  } catch (e) {
    logger.warn(`[instruction.runner] type-edit (edit): edit.agent failed: ${e.message}`);
    return _executeTypeGenerate(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext);
  }

  if (!editResult?.ok) {
    logger.warn(`[instruction.runner] type-edit (edit): edit.agent returned error: ${editResult?.error}`);
    return _executeTypeGenerate(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext);
  }

  logger.info(`[instruction.runner] type-edit (edit): edit.agent done — ${editResult.summary}`);

  // 4. Read the edited file
  let editedContent;
  try {
    editedContent = fs.readFileSync(_copyFile, 'utf8');
  } catch (e) {
    logger.warn(`[instruction.runner] type-edit (edit): could not read edited file: ${e.message}`);
    return { ok: false, pageChanged: false, error: 'Could not read edited file' };
  }

  // 5. Set clipboard to edited content and paste (Meta+V)
  try {
    await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        try { navigator.clipboard.writeText(${JSON.stringify(editedContent)}); return true; }
        catch (e) { return false; }
      })()`,
    });
    await _sleep(200);
  } catch (e) {
    logger.warn(`[instruction.runner] type-edit (edit): could not set clipboard: ${e.message}`);
  }

  // Select all + paste
  logger.info(`[instruction.runner] type-edit (edit): pasting edited content (${editedContent.length} chars)`);
  await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
  await _sleep(50);
  await browserAct({ action: 'press', sessionId, key: 'Meta+v', headed: true, timeoutMs: 5000 });
  await _sleep(500);

  // 6. Cleanup: keep only last 10 copy files
  try {
    const files = fs.readdirSync(_editsDir)
      .filter(f => f.startsWith('copy-'))
      .map(f => ({ name: f, path: path.join(_editsDir, f), mtime: fs.statSync(path.join(_editsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = 10; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path); } catch {}
    }
  } catch {}

  return { ok: true, pageChanged: false };
}

// ── Shared dropdown navigation helper ──
// Used by type-commands and type-search.
// 1. Type the trigger text (already done by caller)
// 2. Wait for dropdown to appear (poll for [role="menu"] or [role="listbox"] visible, up to 2s)
// 3. ArrowDown through options (cap at maxOptions), reading the highlighted option after each press
// 4. LLM call after each ArrowDown: "Is this the right option? Target: '...', Current: '...', Return YES/NO"
// 5. If YES → press Enter to select, return { ok: true, selectedLabel }
// 6. If no match after cap → press Escape, return { ok: false, error: 'No matching option found' }


// ── Shared dropdown navigation helper ──
// Used by type-commands and type-search.
// 1. Type the trigger text (already done by caller)
// 2. Wait for dropdown to appear (poll for [role="menu"] or [role="listbox"] visible, up to 2s)
// 3. ArrowDown through options (cap at maxOptions), reading the highlighted option after each press
// 4. LLM call after each ArrowDown: "Is this the right option? Target: '...', Current: '...', Return YES/NO"
// 5. If YES → press Enter to select, return { ok: true, selectedLabel }
// 6. If no match after cap → press Escape, return { ok: false, error: 'No matching option found' }
async function _executeTypeWithDropdown(sessionId, targetLabel, maxOptions = 10) {
  const { askWithMessages } = require('../../../skill-helpers/skill-llm.cjs');

  // Wait for dropdown to appear (poll for visible [role="option"] elements).
  // Notion's slash menu items have role="option" but are NOT inside a [role="menu"]
  // or [role="listbox"] container — they're standalone divs.
  // 5s timeout (25 attempts × 200ms) — Notion's slash menu can take 2-3s on first load
  let dropdownFound = false;
  for (let w = 0; w < 25; w++) {
    await _sleep(200);
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]');
        for (const opt of options) {
          const r = opt.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })()`,
    });
    if (res?.result === true || res?.result === 'true') {
      dropdownFound = true;
      break;
    }
  }
  if (!dropdownFound) {
    logger.info(`[instruction.runner] _executeTypeWithDropdown: no dropdown appeared after 5s`);
    return { ok: false, error: 'No dropdown appeared after typing trigger' };
  }
  logger.info(`[instruction.runner] _executeTypeWithDropdown: dropdown appeared, searching for "${targetLabel}"`);

  // Read ALL visible options at once via querySelectorAll.
  // Notion's slash menu is NOT virtualized — all items are in the DOM at once.
  // The engine path (page.evaluate) returns JS values directly — no JSON.parse needed.
  let allLabels = [];
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]');
        const labels = [];
        for (const opt of options) {
          const r = opt.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const text = (opt.innerText || opt.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
          if (text && text.length > 0 && !labels.includes(text)) {
            labels.push(text);
          }
        }
        return labels;
      })()`,
    });
    const raw = res?.result;
    if (Array.isArray(raw)) {
      allLabels = raw;
    } else if (typeof raw === 'string') {
      try { allLabels = JSON.parse(raw); } catch { allLabels = []; }
    }
  } catch (e) {
    logger.warn(`[instruction.runner] _executeTypeWithDropdown: could not read options: ${e.message}`);
  }

  if (allLabels.length === 0) {
    logger.info(`[instruction.runner] _executeTypeWithDropdown: no options found in dropdown — pressing Escape`);
    await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
    await _sleep(300);
    return { ok: false, error: `No options found in dropdown` };
  }

  logger.info(`[instruction.runner] _executeTypeWithDropdown: found ${allLabels.length} options: ${allLabels.slice(0, 5).join(', ')}${allLabels.length > 5 ? '...' : ''}`);

  // LLM call: find the best matching option from the full list.
  // Return the 1-based index of the best match, or 0 if no match.
  let matchIndex = -1;
  try {
    const numbered = allLabels.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const raw = await askWithMessages([
      { role: 'system', content: 'You are a dropdown option matcher. Return ONLY the number (1-based index) of the option that best matches the target. Return 0 if no option matches.' },
      { role: 'user', content: `Target: "${targetLabel}"\n\nOptions:\n${numbered}\n\nWhich option number matches?` },
    ], { maxTokens: 30, temperature: 0.1, responseTimeoutMs: 5000 });
    const parsed = parseInt((raw || '').trim(), 10);
    if (parsed >= 1 && parsed <= allLabels.length) {
      matchIndex = parsed - 1;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] _executeTypeWithDropdown: LLM match failed: ${e.message}`);
  }

  if (matchIndex < 0) {
    logger.info(`[instruction.runner] _executeTypeWithDropdown: no match found — pressing Escape`);
    await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
    await _sleep(300);
    return { ok: false, error: `No matching option found for "${targetLabel}"` };
  }

  const matchedLabel = allLabels[matchIndex];
  logger.info(`[instruction.runner] _executeTypeWithDropdown: match found at #${matchIndex + 1}: "${matchedLabel}" — ArrowDown ${matchIndex} times + Enter`);

  // Navigate to the matched option with ArrowDown, then press Enter.
  // The first option is already highlighted (index 0), so we need matchIndex ArrowDowns.
  for (let i = 0; i < matchIndex; i++) {
    await browserAct({ action: 'press', sessionId, key: 'ArrowDown', headed: true, timeoutMs: 2000 });
    await _sleep(100);
  }
  await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
  await _sleep(500);
  return { ok: true, selectedLabel: matchedLabel };
}

// type-commands: typing with / or @ commands that open a dropdown (Notion blocks, Slack commands)
// Flow: load cached command list (or discover) → LLM picks number → type trigger + Enter → type content
// Fallback: if type+Enter fails verification, fall back to ArrowDown+LLM (_executeTypeWithDropdown)


// type-commands: typing with / or @ commands that open a dropdown (Notion blocks, Slack commands)
// Flow: load cached command list (or discover) → LLM picks number → type trigger + Enter → type content
// Fallback: if type+Enter fails verification, fall back to ArrowDown+LLM (_executeTypeWithDropdown)
async function _executeTypeCommands(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx = {}) {
  const { _extractCommandPlan } = require('../../browser.agent.cjs');
  const plan = await _extractCommandPlan(goal, focusedElement, value, [], agentContext);

  if (!plan) {
    logger.info(`[instruction.runner] type-commands: no command plan extracted — falling back to type-plain`);
    return _executeTypePlain(sessionId, value, focusedElement, pageCategory, ctx);
  }

  logger.info(`[instruction.runner] type-commands: trigger="${plan.trigger}", commandLabel="${plan.commandLabel}", content="${(plan.content || '').slice(0, 50)}"`);

  // Load cached command list from appKnowledge
  let cachedCommands = null;
  let _appHostname = null;
  try {
    const _urlRes = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.hostname' });
    _appHostname = (typeof _urlRes?.result === 'string' ? _urlRes.result : '').replace(/^www\./, '').replace(/^"|"$/g, '');
  } catch {}
  if (_appHostname) {
    try {
      const { loadAppKnowledge } = require('../appKnowledge.cjs');
      const _entries = loadAppKnowledge(_appHostname);
      const _cmdEntry = _entries.find(e => e.type === 'command_system');
      if (_cmdEntry && _cmdEntry.details.commands && _cmdEntry.details.commands.length > 0) {
        cachedCommands = _cmdEntry.details.commands;
        logger.info(`[instruction.runner] type-commands: loaded ${cachedCommands.length} cached commands from appKnowledge for ${_appHostname}`);
      }
    } catch {}
  }

  // If no cached commands, run discovery first
  if (!cachedCommands || cachedCommands.length === 0) {
    logger.info(`[instruction.runner] type-commands: no cached commands — running discovery first`);
    const _discovered = await _runtimeDiscoverCommands(sessionId, plan.trigger.charAt(0) || '/', _appHostname);
    if (_discovered && _discovered.length > 0) {
      cachedCommands = _discovered;
      // Re-read focus after discovery (may have shifted)
      // Note: caller (_executeJustType) will also re-read, but we need it here for the title guard
    }
  }

  // Use LLM to pick the command number from the cached list
  let selectedCommand = null;
  if (cachedCommands && cachedCommands.length > 0) {
    // Build numbered list for LLM
    const _numberedList = cachedCommands.map((c, i) => {
      const _label = typeof c === 'string' ? c : c.label;
      return `${i + 1}. ${_label}`;
    }).join('\n');

    try {
      const raw = await askWithMessages([
        { role: 'system', content: 'You pick the best command from a list to achieve a goal. Return ONLY the number (e.g. "1"). No explanation.' },
        { role: 'user', content: `Goal: ${goal}\n\nAvailable commands:\n${_numberedList}\n\nWhich command number achieves this goal?` },
      ], { maxTokens: 30, temperature: 0.1, responseTimeoutMs: 8000 });
      const _num = parseInt((raw || '').trim(), 10);
      if (_num >= 1 && _num <= cachedCommands.length) {
        selectedCommand = cachedCommands[_num - 1];
        const _label = typeof selectedCommand === 'string' ? selectedCommand : selectedCommand.label;
        logger.info(`[instruction.runner] type-commands: LLM picked #${_num} → "${_label}"`);
      } else {
        logger.warn(`[instruction.runner] type-commands: LLM returned invalid number "${raw}" — using plan.commandLabel`);
      }
    } catch (e) {
      logger.warn(`[instruction.runner] type-commands: LLM pick failed: ${e.message} — using plan.commandLabel`);
    }
  }

  // Determine the trigger text to type.
  // If LLM picked a command from cache, use its trigger; otherwise use plan.trigger.
  // Fix: don't prepend the prefix if the trigger already starts with it (avoids //turnbullet).
  let _triggerText = plan.trigger;
  if (selectedCommand) {
    const _trigger = typeof selectedCommand === 'string' ? selectedCommand.toLowerCase() : (selectedCommand.trigger || selectedCommand.label.toLowerCase());
    // Ensure trigger starts with the prefix (e.g. /) — but don't double it
    if (_trigger.startsWith(plan.trigger.charAt(0))) {
      _triggerText = _trigger;
    } else {
      _triggerText = plan.trigger.charAt(0) + _trigger;
    }
  }

  // 1. Type the trigger (e.g. "/todo" or "/to-do list")
  // Only Meta+a if editing existing content (rare for commands — commands create new blocks)
  if (ctx.isEdit && ctx.hasContent) {
    await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
    await _sleep(50);
  }
  await browserAct({ action: 'type', sessionId, text: _triggerText, headed: true, timeoutMs: 5000 });
  await _sleep(300);

  // 2. Wait for dropdown + press Enter to select top match (type+Enter approach)
  // Notion's slash menu filters as you type, so the top match is usually correct.
  // Poll for visible [role="option"] elements (Notion's menu items have role="option"
  // but are NOT inside a [role="menu"] or [role="listbox"] container).
  let dropdownFound = false;
  for (let w = 0; w < 25; w++) {
    await _sleep(200);
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]');
        for (const opt of options) {
          const r = opt.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })()`,
    });
    if (res?.result === true || res?.result === 'true') {
      dropdownFound = true;
      break;
    }
  }

  if (!dropdownFound) {
    logger.warn(`[instruction.runner] type-commands: no dropdown appeared after typing "${_triggerText}" — falling back to type-plain`);
    // Clean up with Backspace (not Escape — keeps focus in body)
    await browserAct({ action: 'press', sessionId, key: 'Backspace', headed: true, timeoutMs: 2000 });
    await _sleep(100);
    return _executeTypePlain(sessionId, value, focusedElement, pageCategory, ctx);
  }

  const _verify = await _verifyTypedValueLanded(sessionId, _triggerText || value);
  if (!_verify.ok) return { ok: false, pageChanged: false, error: _verify.error, suggestedAgent: _verify.suggestedAgent };

  // Press Enter to select the top filtered match
  logger.info(`[instruction.runner] type-commands: pressing Enter to select top match for "${_triggerText}"`);
  await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
  await _sleep(500);

  // 3. Verify the correct block was created (check for checkbox/todo DOM for todo commands)
  let _verifyOk = true;
  if (plan.commandLabel && /todo|to-do|checkbox/i.test(plan.commandLabel)) {
    try {
      const _verifyRes = await browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [class*="todo"], [data-type="todo"]');
          let visible = 0;
          for (const el of checkboxes) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) visible++;
          }
          return visible;
        })()`,
      });
      const _count = parseInt(_verifyRes?.result, 10) || 0;
      _verifyOk = _count > 0;
      logger.info(`[instruction.runner] type-commands: verify checkboxes=${_count} ok=${_verifyOk}`);
    } catch (e) {
      logger.warn(`[instruction.runner] type-commands: verify failed: ${e.message}`);
      _verifyOk = false;
    }
  }

  // 4. If verify failed, fall back to ArrowDown+LLM approach
  if (!_verifyOk) {
    logger.warn(`[instruction.runner] type-commands: type+Enter verify failed — falling back to ArrowDown+LLM`);
    // Clean up the current state: Backspace to delete the trigger
    await browserAct({ action: 'press', sessionId, key: 'Backspace', headed: true, timeoutMs: 2000 });
    await _sleep(200);
    // Re-type the trigger and use ArrowDown+LLM
    await browserAct({ action: 'type', sessionId, text: plan.trigger, headed: true, timeoutMs: 5000 });
    await _sleep(300);
    const dropdownResult = await _executeTypeWithDropdown(sessionId, plan.commandLabel, 10);
    if (!dropdownResult.ok) {
      logger.warn(`[instruction.runner] type-commands: ArrowDown+LLM also failed — falling back to type-plain`);
      await browserAct({ action: 'press', sessionId, key: 'Backspace', headed: true, timeoutMs: 2000 });
      await _sleep(100);
      return _executeTypePlain(sessionId, value, focusedElement, pageCategory, ctx);
    }
    logger.info(`[instruction.runner] type-commands: ArrowDown+LLM selected "${dropdownResult.selectedLabel}"`);
  }

  // 5. Type the content after the command (if any)
  if (plan.content) {
    await _sleep(500); // wait for the new block/field to settle
    logger.info(`[instruction.runner] type-commands: typing content "${plan.content.slice(0, 50)}"`);

    // Multi-line content: type each line, press Enter between
    if (plan.content.includes('\n')) {
      const lines = plan.content.split('\n').filter(l => l.length > 0);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
          await _sleep(500);
        }
        await browserAct({ action: 'type', sessionId, text: lines[i], headed: true, timeoutMs: 10000 });
        await _sleep(300);
      }
    } else {
      await browserAct({ action: 'type', sessionId, text: plan.content, headed: true, timeoutMs: 10000 });
      await _sleep(300);
    }
  }

  return { ok: true, pageChanged: false };
}

// type-search: typing to filter a dynamic dropdown (@mentions, assignee pickers, page pickers)
// Flow: type trigger+query → wait for dropdown → ArrowDown + LLM pick → Enter to select
// ctx = { isEdit, hasContent } — Meta+a only when isEdit && hasContent (uniform policy)


// type-search: typing to filter a dynamic dropdown (@mentions, assignee pickers, page pickers)
// Flow: type trigger+query → wait for dropdown → ArrowDown + LLM pick → Enter to select
// ctx = { isEdit, hasContent } — Meta+a only when isEdit && hasContent (uniform policy)
async function _executeTypeSearch(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx = {}) {
  const { _extractSearchPlan } = require('../../browser.agent.cjs');
  const plan = await _extractSearchPlan(goal, focusedElement, value, [], agentContext);

  if (!plan) {
    logger.info(`[instruction.runner] type-search: no search plan extracted — falling back to type-plain`);
    return _executeTypePlain(sessionId, value, focusedElement, pageCategory, ctx);
  }

  logger.info(`[instruction.runner] type-search: trigger="${plan.trigger}", query="${plan.query}", targetLabel="${plan.targetLabel}"`);

  // If the focused field is already a global search field (e.g. Google Cloud Console
  // "Search (/)" field), the trigger was already pressed to focus it. Do NOT re-type
  // the trigger — just type the query and submit with Enter.
  const _label = (focusedElement?.ariaLabel || focusedElement?.placeholder || focusedElement?.text || '').toLowerCase();
  const _tag = focusedElement?.tag || '';
  const _role = focusedElement?.role || '';
  const _isGlobalSearch = (_label.includes('search') && (_label.includes('(/)') || _role === 'combobox' || _role === 'searchbox' || _tag === 'input'));

  // 1. Type the trigger + query (e.g. "@John") for mention/dropdown searches, or just the query for global search
  // Only Meta+a when editing existing content; for create mode, just type
  if (ctx.isEdit && ctx.hasContent) {
    await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
    await _sleep(50);
  }
  const fullQuery = _isGlobalSearch ? plan.query : (plan.trigger + plan.query);
  await browserAct({ action: 'type', sessionId, text: fullQuery, headed: true, timeoutMs: 5000 });

  const _verify = await _verifyTypedValueLanded(sessionId, plan.query || fullQuery);
  if (!_verify.ok) return { ok: false, pageChanged: false, error: _verify.error, suggestedAgent: _verify.suggestedAgent };

  if (_isGlobalSearch) {
    // Global search: submit immediately with Enter, no dropdown wait
    await _sleep(300);
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
    await _sleep(500);
    return { ok: true, pageChanged: true };
  }

  await _sleep(500); // extra wait for dynamic dropdown to filter

  // 2. Wait for dropdown + navigate to find the target (for dropdown-style searches like assignee pickers)
  // If the dropdown doesn't appear or no match is found, try pressing Enter — many
  // search fields (Google Cloud Console, AI Studio, etc.) submit on Enter without a dropdown.
  const dropdownResult = await _executeTypeWithDropdown(sessionId, plan.targetLabel, 10);

  if (!dropdownResult.ok) {
    logger.warn(`[instruction.runner] type-search: dropdown selection failed (${dropdownResult.error}) — trying Enter to submit as plain search`);
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
    await _sleep(500);
    return { ok: true, pageChanged: true };
  }

  logger.info(`[instruction.runner] type-search: selected "${dropdownResult.selectedLabel}"`);
  return { ok: true, pageChanged: false };
}

// Dispatcher: routes to the correct type executor based on fieldType.
// Hoists the edit/create decision (_extractEditMode) so all type flows share the same
// Meta+a policy: only select-all when isEdit && hasContent. Also saves a backup before
// any modification to a field with existing content.


// Dispatcher: routes to the correct type executor based on fieldType.
// Hoists the edit/create decision (_extractEditMode) so all type flows share the same
// Meta+a policy: only select-all when isEdit && hasContent. Also saves a backup before
// any modification to a field with existing content.
async function _executeTypedField(sessionId, fieldType, value, focusedElement, goal, pageCategory, agentContext, pageContext, actionHistory) {
  logger.info(`[instruction.runner] _executeTypedField: fieldType=${fieldType}, value="${String(value || '').slice(0, 40)}"`);

  // ── Uniform edit/create decision ──
  const _hasContent = focusedElement?.hasContent === true;
  const _currentValue = focusedElement?.currentValue || '';
  let _isEdit = false;
  if (_hasContent && _currentValue.length > 10) {
    try {
      const { _extractEditMode } = require('../../browser.agent.cjs');
      _isEdit = (await _extractEditMode(goal, focusedElement, _currentValue, agentContext)) === 'edit';
    } catch (e) {
      logger.warn(`[instruction.runner] _executeTypedField: _extractEditMode failed: ${e.message} — defaulting to create`);
    }
  }
  const ctx = { isEdit: _isEdit, hasContent: _hasContent };
  logger.info(`[instruction.runner] _executeTypedField: isEdit=${_isEdit}, hasContent=${_hasContent}`);

  // ── Save backup before any modification to a field with existing content ──
  if (_hasContent) {
    await _saveBackup(focusedElement);
  }

  switch (fieldType) {
    case 'type-edit':
      return _executeTypeEdit(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx);
    case 'type-commands':
      return _executeTypeCommands(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx);
    case 'type-search':
      return _executeTypeSearch(sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx);
    case 'type-list-item':
      return _executeTypeListItem(sessionId, value, focusedElement, pageCategory, ctx, goal, actionHistory);
    case 'type-plain':
    default:
      return _executeTypePlain(sessionId, value, focusedElement, pageCategory, ctx, goal, actionHistory);
  }
}


async function _executeJustType(sessionId, value, focusedElement, pageCategory, goal, agentContext, pageContext, overlayActive, actionHistory) {
  // PRESS_<KEY> runs before the no-focus refusal — a keypress needs no fillable
  // element (End/PageDown scroll the body; Enter submits whatever's focused).
  if (value === 'PRESS_ENTER') {
    const _lastAction = (actionHistory && actionHistory[actionHistory.length - 1]) || '';
    if (_lastAction.includes('pressed Enter to create next item')) {
      logger.info(`[instruction.runner] Just-type: PRESS_ENTER after list-item Enter — overriding to SKIP (will re-extract next iteration)`);
      return { ok: false, pageChanged: false, error: 'PRESS_ENTER overridden — empty block after list-item Enter' };
    }
  }
  if (value === 'PRESS_ENTER' || (value && value.startsWith('PRESS_'))) {
    const _keyMap = {
      enter: 'Enter', tab: 'Tab', escape: 'Escape', space: ' ',
      arrow_down: 'ArrowDown', arrow_up: 'ArrowUp',
      arrow_left: 'ArrowLeft', arrow_right: 'ArrowRight',
      backspace: 'Backspace', delete: 'Delete',
      end: 'End', home: 'Home', pageup: 'PageUp', pagedown: 'PageDown',
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    };
    const _modMap = { shift: 'Shift', meta: 'Meta', control: 'Control', ctrl: 'Control', alt: 'Alt' };
    const _keySpec = value.replace('PRESS_', '');
    const _parts = _keySpec.split('+');
    let _key, _mods = [];
    if (_parts.length > 1) {
      _mods = _parts.slice(0, -1).map(m => _modMap[m.toLowerCase()] || m);
      _key = _parts[_parts.length - 1];
    } else {
      _key = _parts[0];
    }
    const _finalKey = _keyMap[_key.toLowerCase()] || _key;
    const _combo = [..._mods, _finalKey].join('+');

    // Scroll-position probe — evidence for synthesize/reviewExecution and the
    // stop condition for scroll-to-bottom loops on infinite-scroll pages.
    const _readScrollMetrics = async () => {
      try {
        const _r = await browserAct({
          action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
          text: `JSON.stringify({scrollY:Math.round(window.scrollY),scrollHeight:document.documentElement.scrollHeight,viewportHeight:window.innerHeight,url:location.href})`,
        });
        const _m = JSON.parse(_r?.result || _r?.stdout || 'null');
        if (_m && typeof _m.scrollY === 'number') {
          _m.atBottom = _m.scrollY + _m.viewportHeight >= _m.scrollHeight - 4;
          return _m;
        }
      } catch (_) {}
      return null;
    };

    // "Scroll to the bottom" on an infinite-scroll page needs repeated End
    // presses — one press lands mid-feed. Loop until at-bottom or the metrics
    // plateau (no new content after 2 consecutive presses), bounded at 8.
    const _isBottomGoal = _finalKey === 'End' && /\bbottom\b/i.test(goal || '');
    const _isScrollKey = /^(End|Home|PageUp|PageDown|ArrowDown|ArrowUp|Space)$/.test(_finalKey);

    logger.info(`[instruction.runner] Just-type: pressing ${_combo} (from ${value})`);
    let _obs = null;
    if (_isBottomGoal) {
      let _prevKey = null;
      for (let _i = 0; _i < 8; _i++) {
        await browserAct({ action: 'press', sessionId, key: _combo, headed: true, timeoutMs: 5000 });
        await _sleep(700);
        _obs = await _readScrollMetrics();
        if (!_obs) break;
        if (_obs.atBottom) break;
        const _key = `${_obs.scrollY}|${_obs.scrollHeight}`;
        if (_key === _prevKey) break; // plateau — no new content rendered
        _prevKey = _key;
      }
    } else {
      await browserAct({ action: 'press', sessionId, key: _combo, headed: true, timeoutMs: 5000 });
      await _sleep(800);
      if (_isScrollKey) _obs = await _readScrollMetrics();
    }
    return { ok: true, pageChanged: false, observation: _obs || undefined };
  }

  if (!focusedElement) {
    // No focused element — check if an overlay/dialog is open
    if (!overlayActive) {
      // No overlay open — Just-type without a focused field is unreliable
      // (would blindly type into "Search for people" or other page-level inputs)
      logger.info(`[instruction.runner] Just-type: no focused element and no overlay open — refusing to type into random field`);
      return { ok: false, pageChanged: false, error: 'No focused element and no overlay open — need Tab-Map to pick the right field', suggestedAgent: 'turn.loop.agent' };
    }
    // Overlay is open — safe to click first fillable inside the dialog
    logger.info(`[instruction.runner] Just-type: no focused element — clicking first fillable to focus (overlay open)`);
    const _firstFillable = await _clickFirstFillable(sessionId);
    if (!_firstFillable) return { ok: false, pageChanged: false, error: 'No focused element and no fillable element found' };
    focusedElement = _firstFillable;
  }

  const _tag = focusedElement.tag || '';
  const _role = focusedElement.role || '';

  // NOW check fillable for actual typing (PRESS_<KEY> already handled above)
  const _isFillable = ['input', 'textarea'].includes(_tag) ||
                      _role === 'combobox' || _role === 'textbox' ||
                      focusedElement.isContentEditable === true;
  if (!_isFillable) {
    return { ok: false, pageChanged: false, error: `Focused element ${_tag} role=${_role} is not fillable` };
  }
  if (value === 'SKIP' || !value) {
    return { ok: false, pageChanged: false, error: 'LLM says skip this field' };
  }

  // Determine field type and dispatch to the right executor
  const { _extractFieldType } = require('../../browser.agent.cjs');
  const fieldType = await _extractFieldType(goal, focusedElement, value, [], pageContext || {}, agentContext, pageCategory);
  const result = await _executeTypedField(sessionId, fieldType, value, focusedElement, goal, pageCategory, agentContext, pageContext, actionHistory);
  // Attach fieldType so the caller can tag actionHistory entries (e.g. list-item tracking)
  if (result && typeof result === 'object') result.fieldType = fieldType;
  return result;
}

// ── Strategy 2: Meta+F search ──────────────────────────────────────────
// Find specific text on the page using window.find(), then click the element.
// Returns { ok, pageChanged, error }

// Find closest clickable ancestor of the currently focused element.
// Sets data-td-ref on it and returns { ref, tag, role, text }.


// Find closest clickable ancestor of the currently focused element.
// Sets data-td-ref on it and returns { ref, tag, role, text }.
async function _findClosestClickable(sessionId, focused) {
  // If focused element is already clickable, return it
  const _tag = focused?.tag || '';
  const _role = focused?.role || '';
  if (['a', 'button'].includes(_tag) || ['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(_role)) {
    return focused;
  }

  // Walk up to closest clickable ancestor via DOM
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        let el = document.activeElement;
        while (el && el !== document.body) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          if (tag === 'a' || tag === 'button' || role === 'button' || role === 'link' || role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox' || el.hasAttribute('onclick')) {
            let ref = el.getAttribute('data-td-ref');
            if (!ref || !ref.startsWith('tm-')) {
              ref = 'tm-' + Math.random().toString(36).slice(2, 10);
              el.setAttribute('data-td-ref', ref);
            }
            const r = el.getBoundingClientRect();
            return { ref, tag, role, text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          }
          el = el.parentElement;
        }
        return null;
      })()`,
    });
    if (res?.result) return res.result;
    // Fallback: no clickable ancestor found — search descendants of the focused
    // element. window.find() focuses the text node's parent container (e.g.,
    // cfc-panel), but the actual clickable link is a CHILD of that container,
    // not an ancestor. Walk down to find the first clickable descendant.
    const descRes = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        let el = document.activeElement;
        if (!el || el === document.body) return null;
        const clickable = el.querySelector('a, button, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [onclick]');
        if (clickable) {
          const r = clickable.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          let ref = clickable.getAttribute('data-td-ref');
          if (!ref || !ref.startsWith('tm-')) {
            ref = 'tm-' + Math.random().toString(36).slice(2, 10);
            clickable.setAttribute('data-td-ref', ref);
          }
          return { ref, tag: clickable.tagName.toLowerCase(), role: clickable.getAttribute('role') || '',
                   text: (clickable.innerText || clickable.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
                   x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
        return null;
      })()`,
    });
    return descRes?.result || null;
  } catch (e) {
    logger.warn(`[instruction.runner] _findClosestClickable failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  _clickFirstFillable,
  _saveBackup,
  _executeTypePlain,
  _executeTypeListItem,
  _executeTypeEdit,
  _executeTypeGenerate,
  _executeTypeEditExisting,
  _executeTypeWithDropdown,
  _executeTypeCommands,
  _executeTypeSearch,
  _executeTypedField,
  _verifyTypedValueLanded,
  _executeJustType,
  _findClosestClickable,
};
