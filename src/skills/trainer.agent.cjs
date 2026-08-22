'use strict';
// ---------------------------------------------------------------------------
// trainer.agent.cjs — Interactive Path Recording + Waypoint Recipe Generator
//
// Architecture:
// 1. Opens browser to agent's start_url (headed mode)
// 2. Injects CDP event listener script to capture user clicks/navigations
// 3. Polls captured events and emits them to the UI as recorded steps
// 4. On "Save": LLM cleans raw events into a minimal waypoint recipe JSON
// 5. Skill saved to ~/.thinkdrop/skills/<agentId>/<dotName>.skill.json
//
// Called from main.js when user clicks "Train" on an agent
// ---------------------------------------------------------------------------

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const logger  = require('../logger.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

const OVERLAY_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
const AGENTS_DIR   = path.join(os.homedir(), '.thinkdrop', 'agents');
const SKILLS_DIR   = path.join(os.homedir(), '.thinkdrop', 'skills');

// Active training sessions
const activeSessions = new Map(); // agentId -> session

// Normalize agentId for skills directory (strip .agent suffix if present)
function _skillDirId(agentId) {
  return agentId.endsWith('.agent') ? agentId.slice(0, -6) : agentId;
}

// Build the on-disk filename for a skill/recipe.
// Skill names already end with `.skill` (e.g. `spotify.create.playlist.skill`),
// so we append `.json` instead of `.skill.json` to avoid the double extension.
function _skillFileName(skillName) {
  if (!skillName) return `${skillName}.skill.json`;
  if (skillName.endsWith('.skill') || skillName.endsWith('.recipe')) {
    return `${skillName}.json`;
  }
  return `${skillName}.skill.json`;
}

// ---------------------------------------------------------------------------
// Progress reporting to Electron UI
// ---------------------------------------------------------------------------
function _postProgress(agentId, payload) {
  try {
    const data = JSON.stringify({ ...payload, agentId, timestamp: Date.now() });
    const req = http.request({
      hostname: '127.0.0.1',
      port: OVERLAY_PORT,
      path: '/training.progress',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    }, () => {});
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// CDP Recorder Script — injected into the browser page
// Universal recorder: captures clicks (any element), contenteditable/CodeMirror
// input, dblclick, rightclick, paste, key combos, Tab focus, hover-reveal,
// drag, scroll (window + containers), popstate back/forward, tab detection,
// form submit, checkbox/radio, select, and URL navigation polling.
// Results stored in window.__tdTrainEvents for polling.
// ---------------------------------------------------------------------------
const CDP_RECORDER_SCRIPT = `
(function() {
  if (window.__tdRecorderActive) return;
  window.__tdRecorderActive = true;
  window.__tdTrainEvents = window.__tdTrainEvents || [];

  // Ping the trainer backend to confirm the recorder is alive and the CDP binding works
  if (window.__tdPushEvent) {
    window.__tdPushEvent({ type: 'recorder_init', url: location.href, _tabIndex: 0, timestamp: Date.now() });
  }

  // ── Selector helpers (ported from explore.agent.cjs _buildSmartSelectors) ───
  // Tiered priority: data-testid → data-qa → role+aria-label → aria-label →
  // role+text → name → placeholder → href → contenteditable → semantic classes → text
  // Dynamic IDs (react-12345, ember-6789) are skipped.

  function isDynamicId(id) {
    if (!id || typeof id !== 'string') return false;
    // IDs with 4+ trailing digits: button-1234, input-5678
    if (/^[a-z]+-\\d{4,}$/i.test(id)) return true;
    // Hashed/suffixed IDs: text-input-8ba291fde73c1845, abc-1a2b3c4d5e6f7890
    if (/[a-f0-9]{8,}$/i.test(id)) return true;
    // Pure long hex IDs
    if (/^[a-f0-9]{12,}$/i.test(id)) return true;
    // css-in-js and style scoping
    if (/^css-[a-z0-9]{5,}$/i.test(id)) return true;
    if (/^style_[a-z0-9]+$/i.test(id)) return true;
    return false;
  }

  // Extract a stable prefix from a dynamic ID by stripping the trailing
  // hash/numeric suffix. e.g. text-input-8ba291fde73c1845 → text-input-
  function getStableIdPrefix(id) {
    if (!id || typeof id !== 'string') return null;
    var prefix = id.replace(/[a-f0-9]{8,}$/i, '');
    if (prefix.length >= 4 && prefix.indexOf('-') !== -1) return prefix;
    prefix = id.replace(/\\d{4,}$/, '');
    if (prefix.length >= 4 && prefix.indexOf('-') !== -1) return prefix;
    return null;
  }

  function filterSemanticClasses(className) {
    if (!className || typeof className !== 'string') return [];
    return className.split(/\\s+/).filter(function(c) {
      return c && c.length > 2 &&
        !/^css-[a-z0-9]{5,}$/i.test(c) &&
        !/^[a-z0-9]{8,}$/i.test(c) &&
        !/^style_[a-z0-9]+$/i.test(c);
    });
  }

  function getSelector(el) {
    if (!el || !el.tagName) return 'body';
    var tag = el.tagName.toLowerCase();
    var id = el.id || null;
    var dataTestId = el.getAttribute('data-testid');
    var dataQa = el.getAttribute('data-qa');
    var ariaLabel = el.getAttribute('aria-label');
    var role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : null);
    var name = el.getAttribute('name');
    var placeholder = el.getAttribute('placeholder');

    // Tier 1: ID (if not dynamic)
    if (id && !isDynamicId(id)) return '[id="' + id + '"]';

    // Tier 1b: Dynamic ID with a meaningful prefix — combine prefix + stable attr
    // e.g. text-input-8ba291fde73c1845 + placeholder="Playlist name" →
    //      [id^="text-input-"][placeholder="Playlist name"]
    if (id && isDynamicId(id)) {
      var prefix = getStableIdPrefix(id);
      if (prefix) {
        if (placeholder && placeholder.length > 3) return '[id^="' + prefix + '"][placeholder="' + placeholder + '"]';
        if (name) return '[id^="' + prefix + '"][name="' + name + '"]';
        if (ariaLabel && ariaLabel.length > 2) return '[id^="' + prefix + '"][aria-label="' + ariaLabel + '"]';
        if (role) return '[id^="' + prefix + '"][role="' + role + '"]';
      }
    }

    // Tier 2: Data attributes (very stable)
    if (dataTestId) return '[data-testid="' + dataTestId + '"]';
    if (dataQa) return '[data-qa="' + dataQa + '"]';

    // Tier 3: Role + ARIA label (gold standard for semantic selectors)
    if (role && ariaLabel && ariaLabel.length > 2) return '[role="' + role + '"][aria-label="' + ariaLabel + '"]';
    if (ariaLabel && ariaLabel.length > 2) return '[aria-label="' + ariaLabel + '"]';

    // Tier 3b: Role + text (for buttons with clear text labels)
    var text = (el.textContent || '').trim().substring(0, 30);
    if (role && text && text.length > 0 && text.length < 30) return '[role="' + role + '"]:has-text("' + text.replace(/"/g, '\\\\"') + '")';

    // Tier 4: Name attribute (for inputs)
    if (name) return tag + '[name="' + name + '"]';

    // Tier 5: Placeholder (for inputs)
    if (placeholder && placeholder.length > 3) return '[placeholder="' + placeholder + '"]';

    // Tier 6: Walk up ancestors for a stable anchor (id/testid/aria-label)
    var ancestor = el.parentElement;
    for (var i = 0; i < 4 && ancestor && ancestor !== document.body; i++, ancestor = ancestor.parentElement) {
      var aId = ancestor.id;
      var aTestId = ancestor.getAttribute('data-testid');
      var aAriaLabel = ancestor.getAttribute('aria-label');
      if (aId && !isDynamicId(aId)) return '[id="' + aId + '"] ' + tag;
      if (aTestId) return '[data-testid="' + aTestId + '"] ' + tag;
      if (aAriaLabel && aAriaLabel.length > 2) return '[aria-label="' + aAriaLabel + '"] ' + tag;
    }

    // Tier 7: Semantic CSS classes (filter out hashed/minified classes)
    var semanticClasses = filterSemanticClasses(el.className);
    if (semanticClasses.length > 0) {
      var path = tag + '.' + semanticClasses.slice(0, 2).join('.');
      var parent = el.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
        if (siblings.length > 1) path += ':nth-child(' + (siblings.indexOf(el) + 1) + ')';
      }
      return path;
    }

    // Tier 8: Fallback — tag + nth-child
    var fallback = tag;
    var parent2 = el.parentElement;
    if (parent2) {
      var siblings2 = Array.from(parent2.children).filter(function(c) { return c.tagName === el.tagName; });
      if (siblings2.length > 1) fallback += ':nth-child(' + (siblings2.indexOf(el) + 1) + ')';
    }
    return fallback;
  }

  function getAltSelectors(el) {
    var alts = [];
    if (!el || !el.tagName) return alts;
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || '').trim().substring(0, 50);
    var href = el.getAttribute('href') || '';
    var id = el.id || null;
    var dataTestId = el.getAttribute('data-testid');
    var dataQa = el.getAttribute('data-qa');
    var ariaLabel = el.getAttribute('aria-label');
    var ariaLabelledBy = el.getAttribute('aria-labelledby');
    var role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : null);
    var name = el.getAttribute('name');
    var placeholder = el.getAttribute('placeholder');

    // Tier 1: ID (if not dynamic and not already primary)
    if (id && !isDynamicId(id)) {
      alts.push('[id="' + id + '"]');
      if (role) alts.push('[id="' + id + '"][role="' + role + '"]');
    }

    // Tier 1b: Dynamic ID with meaningful prefix — add prefix-combined alts
    if (id && isDynamicId(id)) {
      var prefix = getStableIdPrefix(id);
      if (prefix) {
        if (placeholder && placeholder.length > 3) alts.push('[id^="' + prefix + '"][placeholder="' + placeholder + '"]');
        if (name) alts.push('[id^="' + prefix + '"][name="' + name + '"]');
        if (ariaLabel) alts.push('[id^="' + prefix + '"][aria-label="' + ariaLabel + '"]');
      }
    }

    // Tier 2: Data attributes
    if (dataQa) alts.push('[data-qa="' + dataQa + '"]');

    // Tier 3: ARIA-based
    if (ariaLabel) {
      alts.push(tag + '[aria-label="' + ariaLabel + '"]');
      if (role) alts.push('[role="' + role + '"][aria-label="' + ariaLabel + '"]');
    }
    if (ariaLabelledBy) alts.push(tag + '[aria-labelledby="' + ariaLabelledBy + '"]');

    // href-based (for links)
    if (href && text && tag === 'a') {
      alts.push(tag + '[href*="' + href.split('?')[0].split('/').pop() + '"]:has-text("' + text.substring(0, 20) + '")');
    }
    if (href) {
      alts.push(tag + '[href="' + href + '"]');
      var pathPart = href.split('?')[0];
      if (pathPart && pathPart !== href) alts.push(tag + '[href*="' + pathPart.split('/').pop() + '"]');
      var fname = href.split('/').pop().split('?')[0];
      if (fname && fname.length > 3) alts.push(tag + '[href*="' + fname + '"]');
    }

    // Text-based
    if (text && text.length > 1 && text.length < 60) {
      alts.push(tag + ':has-text("' + text.substring(0, 30) + '")');
      alts.push(tag + ':text-is("' + text.substring(0, 30) + '")');
    }

    // Name + placeholder
    if (name) alts.push(tag + '[name="' + name + '"]');
    if (placeholder && placeholder.length > 3) alts.push('[placeholder="' + placeholder + '"]');

    // Class+text
    var classes = filterSemanticClasses(el.className);
    if (classes.length > 0 && text) alts.push(tag + '.' + classes.slice(0, 2).join('.') + ':has-text("' + text.substring(0, 20) + '")');

    // Legacy
    if (text) alts.push('text=' + text);
    if (role && (ariaLabel || text)) alts.push('role=' + role + '[name="' + (ariaLabel || text).substring(0, 40) + '"]');

    return alts;
  }

  // Universal click target resolver — two-phase:
  // Phase 1: semantic interactive ancestor (extended role list)
  // Phase 2: walk up 4 levels for any stable id/testid/aria-label anchor
  // Phase 3: if inside contenteditable, use that container
  function getClickTarget(raw) {
    // Phase 1: semantic ancestor
    var preferred = raw.closest(
      'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"],' +
      '[role="option"], [role="treeitem"], [role="checkbox"], [role="radio"],' +
      '[role="switch"], [role="combobox"], [role="listbox"], input[type="submit"],' +
      'input[type="button"], input[type="reset"], [onclick], summary'
    );
    if (preferred) return preferred;
    // Phase 2: contenteditable container
    var ceContainer = raw.closest('[contenteditable="true"]');
    if (ceContainer) return ceContainer;
    // Phase 3: walk up for stable anchor
    var el = raw;
    for (var i = 0; i < 4; i++) {
      if (!el.parentElement || el.parentElement === document.body) break;
      el = el.parentElement;
      if (el.id || el.getAttribute('data-testid') || el.getAttribute('aria-label')) return el;
    }
    return raw;
  }

  // Clean elementText: prefer aria-label, then the longest clean child/leaf label,
  // then normalized innerText. Avoid concatenating multiple child labels.
  // Also captures debug info into window.__tdLastCleanDebug for diagnosis.
  function _charCodes(s) {
    // Show char codes for non-ASCII or non-printable chars (invisible char detection)
    var codes = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 127 || (c < 32 && c !== 10 && c !== 13 && c !== 9)) {
        codes.push({ i: i, char: s[i], code: c, hex: '0x' + c.toString(16) });
      }
    }
    return codes;
  }
  function cleanElementText(el) {
    var aria = el.getAttribute('aria-label');
    var debug = { tag: el.tagName, ariaLabel: aria, candidates: [], result: '' };
    if (aria && aria.trim()) {
      var ariaResult = trimWordBoundary(aria.trim().replace(/\s+/g, ' '), 80);
      debug.result = ariaResult;
      debug.source = 'aria-label';
      window.__tdLastCleanDebug = debug;
      return ariaResult;
    }

    // Resolve aria-labelledby / aria-describedby references to get clean text
    // from elements outside the click target (e.g. Spotify menu row titles).
    var ariaId = el.getAttribute('aria-labelledby') || el.getAttribute('aria-describedby');
    if (ariaId) {
      var ref = document.getElementById(ariaId);
      if (ref) {
        var refText = (ref.textContent || ref.innerText || '').trim().replace(/\s+/g, ' ');
        if (refText) {
          var refResult = trimWordBoundary(refText, 80);
          debug.result = refResult;
          debug.source = 'aria-ref';
          debug.ariaRef = ariaId;
          window.__tdLastCleanDebug = debug;
          return refResult;
        }
      }
    }

    // Collect all leaf text candidates: direct text nodes and leaf span/label/p/div children
    var candidates = [];

    // Direct text nodes
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3) {
        var t = node.textContent.trim();
        if (t) {
          candidates.push(t);
          debug.candidates.push({ source: 'textNode', text: t.substring(0, 80), len: t.length, charCodes: _charCodes(t.substring(0, 80)) });
        }
      }
    }

    // Leaf child elements (no element children of their own)
    var children = el.querySelectorAll('span, label, div, p, h1, h2, h3, h4, h5, h6');
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.children.length > 0) continue; // only leaves
      // Prefer textContent (raw DOM text) over innerText (rendered) to avoid
      // CSS/pseudo text that drops characters like 's' (Spotify menu items)
      var t = (child.textContent || child.innerText || '').trim();
      if (t) {
        candidates.push(t);
        debug.candidates.push({ source: child.tagName.toLowerCase(), text: t.substring(0, 80), len: t.length, charCodes: _charCodes(t.substring(0, 80)) });
      }
    }

    var firstText = '';
    if (candidates.length > 0) {
      // Prefer the longest leaf text that looks like a description (not a short header)
      candidates.sort(function(a, b) { return b.length - a.length; });
      firstText = candidates[0];
      debug.source = 'longest-leaf';
    }

    if (!firstText) {
      // Prefer textContent (raw DOM) over innerText for the same reason
      firstText = (el.textContent || el.innerText || '').trim();
      debug.source = 'textContent-fallback';
    }

    // Normalize whitespace and strip counter patterns
    firstText = firstText.replace(/\s+/g, ' ');
    firstText = firstText.replace(/\\s*\\d+\\/\\d+/g, '').replace(/\\s*\\+\\s*$/g, '').trim();
    var result = trimWordBoundary(firstText, 80);
    debug.result = result;
    debug.rawTextContent = (el.textContent || '').substring(0, 100);
    debug.rawTextCharCodes = _charCodes(debug.rawTextContent);
    window.__tdLastCleanDebug = debug;
    return result;
  }

  function trimWordBoundary(text, max) {
    if (!text || text.length <= max) return text;
    var cut = text.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max; // if no good cut found, take up to max
    return text.substring(0, cut).trim();
  }

  // ── Checkbox / Radio ──────────────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    var el = e.target;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      var label = (el.labels && el.labels[0]) ? el.labels[0].textContent.trim().substring(0, 60) : '';
      window.__tdTrainEvents.push({
        type: 'check', selector: getSelector(el), altSelectors: getAltSelectors(el),
        checked: el.checked, label: label, inputType: el.type,
        elementTag: 'input', url: location.href, timestamp: Date.now()
      });
    }
  }, true);

  // ── Generic click (any element) ───────────────────────────────────────────
  document.addEventListener('click', function(e) {
    var raw = e.target;
    if (raw.tagName === 'INPUT' && (raw.type === 'checkbox' || raw.type === 'radio')) return;
    // Skip body/html — too generic
    if (!raw || raw === document.body || raw === document.documentElement) return;
    var el = getClickTarget(raw);
    var selector = getSelector(el);
    if (selector === 'body' || selector === 'html') return;
    var text = cleanElementText(el);
    var href = el.href || (el.closest('a') || {}).href || '';
    var debugInfo = window.__tdLastCleanDebug || null;
    window.__tdTrainEvents.push({
      type: 'click', selector: selector, altSelectors: getAltSelectors(el),
      elementText: text, elementTag: el.tagName.toLowerCase(),
      href: href, url: location.href, timestamp: Date.now(),
      _debug: debugInfo
    });
  }, true);

  // ── Double-click ──────────────────────────────────────────────────────────
  document.addEventListener('dblclick', function(e) {
    var raw = e.target;
    if (!raw || raw === document.body || raw === document.documentElement) return;
    var el = getClickTarget(raw);
    var selector = getSelector(el);
    if (selector === 'body' || selector === 'html') return;
    window.__tdTrainEvents.push({
      type: 'dblclick', selector: selector, altSelectors: getAltSelectors(el),
      elementText: cleanElementText(el),
      elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now()
    });
  }, true);

  // ── Right-click / context menu ────────────────────────────────────────────
  document.addEventListener('contextmenu', function(e) {
    var raw = e.target;
    if (!raw || raw === document.body || raw === document.documentElement) return;
    var el = getClickTarget(raw);
    var selector = getSelector(el);
    if (selector === 'body' || selector === 'html') return;
    window.__tdTrainEvents.push({
      type: 'rightclick', selector: selector, altSelectors: getAltSelectors(el),
      elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now()
    });
  }, true);

  // ── Paste (Ctrl+V / Cmd+V) ────────────────────────────────────────────────
  document.addEventListener('paste', function(e) {
    var text = e.clipboardData ? e.clipboardData.getData('text') : '';
    var el = e.target;
    var selector = getSelector(el);
    if (selector === 'body' || selector === 'html') return;
    window.__tdTrainEvents.push({
      type: 'paste', selector: selector, altSelectors: getAltSelectors(el),
      text: text.substring(0, 500),
      elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now()
    });
  }, true);

  // ── Key combos (action keys only, not regular typing) ────────────────────
  document.addEventListener('keydown', function(e) {
    var key = e.key;
    var ctrl = e.ctrlKey || e.metaKey;
    // Only capture: Ctrl/Meta+anything, Enter, Escape, F1-F12
    var isCombo = ctrl || key === 'Enter' || key === 'Escape' || /^F\\d+$/.test(key);
    if (!isCombo) return;
    if (key === 'Tab') return; // handled by focusin
    var activeEl = document.activeElement;
    var selector = activeEl ? getSelector(activeEl) : 'body';
    if (selector === 'body' || selector === 'html') return;
    window.__tdTrainEvents.push({
      type: 'keycombo', key: key,
      ctrl: ctrl, shift: e.shiftKey, alt: e.altKey,
      selector: selector,
      url: location.href, timestamp: Date.now()
    });
  }, true);

  // ── Tab focus navigation (keyboard only) ─────────────────────────────────
  document.addEventListener('focusin', function(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    // Only keyboard Tab navigation (relatedTarget exists = prior focus existed)
    if (!e.relatedTarget) return;
    var interactive = ['INPUT','TEXTAREA','SELECT','BUTTON','A'].indexOf(el.tagName) !== -1
      || el.getAttribute('contenteditable') === 'true'
      || el.getAttribute('tabindex') !== null;
    if (!interactive) return;
    var selector = getSelector(el);
    if (selector === 'body' || selector === 'html') return;
    window.__tdTrainEvents.push({
      type: 'focus', selector: selector, altSelectors: getAltSelectors(el),
      elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now()
    });
  }, true);

  // ── ContentEditable + textarea + range input (live, debounced 800ms) ──────
  var _inputTimers = {};
  document.addEventListener('input', function(e) {
    var el = e.target;
    var isCE = el.getAttribute && el.getAttribute('contenteditable') === 'true';
    var isTextarea = el.tagName === 'TEXTAREA';
    var isRange = el.tagName === 'INPUT' && el.type === 'range';
    var isInput = el.tagName === 'INPUT' && !isRange && el.type !== 'checkbox' && el.type !== 'radio';
    if (!isCE && !isTextarea && !isRange && !isInput) return;
    var selector = getSelector(el);
    clearTimeout(_inputTimers[selector]);
    _inputTimers[selector] = setTimeout(function() {
      // For contenteditable, prefer textContent over innerText to preserve case
      // and avoid CSS text-transform / rendered text stripping.
      var value = el.value !== undefined ? el.value : (isCE ? (el.textContent || el.innerText || '') : (el.value || el.innerText || el.textContent || ''));
      if (!value) return; // skip empty
      var fieldLabel = (el.getAttribute('aria-label') || el.placeholder || el.getAttribute('name') || el.getAttribute('id') || '').trim();
      var elementText = cleanElementText(el) || fieldLabel;
      var debugInfo = window.__tdLastCleanDebug || null;
      window.__tdTrainEvents.push({
        type: isRange ? 'fill' : (el.tagName === 'SELECT' ? 'select' : 'fill'),
        selector: selector, altSelectors: getAltSelectors(el),
        value: String(value).substring(0, 2000),
        elementText: elementText,
        placeholder: el.placeholder || '',
        elementTag: el.tagName.toLowerCase(),
        url: location.href, timestamp: Date.now(),
        _debug: debugInfo
      });
    }, 800);
  }, true);

  // ── Native change (SELECT dropdown + blur fallback for inputs) ────────────
  document.addEventListener('change', function(e) {
    var el = e.target;
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) === -1) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;
    var selector = getSelector(el);
    // Cancel any pending input-debounce timer for this selector — change supersedes
    // it, and without this both the debounced input fill AND the change fill get
    // pushed, producing a doubled fill step in the recording.
    if (_inputTimers[selector]) { clearTimeout(_inputTimers[selector]); delete _inputTimers[selector]; }
    var fieldLabel = (el.getAttribute('aria-label') || el.placeholder || el.getAttribute('name') || el.getAttribute('id') || '').trim();
    var elementText = cleanElementText(el) || fieldLabel;
    var debugInfo = window.__tdLastCleanDebug || null;
    window.__tdTrainEvents.push({
      type: el.tagName === 'SELECT' ? 'select' : 'fill',
      selector: selector, altSelectors: getAltSelectors(el),
      value: el.value,
      elementText: elementText,
      placeholder: el.placeholder || '',
      elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now(),
      _debug: debugInfo
    });
  }, true);

  // ── Hover → reveal dropdowns/menus (aria-haspopup elements) ──────────────
  var _hoverTimers = {};
  document.addEventListener('mouseover', function(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var hasPopup = el.getAttribute('aria-haspopup');
    var hasExpanded = el.getAttribute('aria-expanded') !== null;
    var hasToggle = el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle');
    if (!hasPopup && !hasExpanded && !hasToggle) return;
    var selector = getSelector(el);
    if (selector === 'body' || selector === 'html') return;
    clearTimeout(_hoverTimers[selector]);
    _hoverTimers[selector] = setTimeout(function() {
      window.__tdTrainEvents.push({
        type: 'hover', selector: selector, altSelectors: getAltSelectors(el),
        elementTag: el.tagName.toLowerCase(),
        url: location.href, timestamp: Date.now()
      });
    }, 400);
  }, true);

  // ── Drag-and-drop (pointerdown/pointerup, 30px minimum) ──────────────────
  var _dragState = null;
  document.addEventListener('pointerdown', function(e) {
    _dragState = { startX: e.clientX, startY: e.clientY, el: e.target, time: Date.now() };
  }, true);
  document.addEventListener('pointerup', function(e) {
    if (!_dragState) return;
    var dx = e.clientX - _dragState.startX;
    var dy = e.clientY - _dragState.startY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 30) {
      window.__tdTrainEvents.push({
        type: 'drag', fromSelector: getSelector(_dragState.el),
        altSelectors: getAltSelectors(_dragState.el),
        fromX: _dragState.startX, fromY: _dragState.startY,
        toX: e.clientX, toY: e.clientY,
        distance: Math.round(dist),
        url: location.href, timestamp: Date.now()
      });
    }
    _dragState = null;
  }, true);

  // ── Scroll — window + specific scrollable containers ─────────────────────
  var _scrollTimer = null;
  var _scrollStart = { x: window.scrollX, y: window.scrollY };
  document.addEventListener('scroll', function(e) {
    var target = e.target;
    // Window scroll
    if (!target || target === document || target === document.body || target === document.documentElement) {
      if (!_scrollTimer) _scrollStart = { x: window.scrollX, y: window.scrollY };
      clearTimeout(_scrollTimer);
      _scrollTimer = setTimeout(function() {
        var deltaX = window.scrollX - _scrollStart.x;
        var deltaY = window.scrollY - _scrollStart.y;
        if (Math.abs(deltaX) > 50 || Math.abs(deltaY) > 50) {
          window.__tdTrainEvents.push({
            type: 'scroll', deltaX: deltaX, deltaY: deltaY,
            scrollY: window.scrollY,
            viewportHeight: window.innerHeight,
            pageHeight: document.documentElement.scrollHeight,
            url: location.href, timestamp: Date.now()
          });
        }
        _scrollTimer = null;
      }, 500);
      return;
    }
    // Container scroll (scrollable div, code editor panel, etc.)
    var containerSelector = getSelector(target);
    if (containerSelector === 'body' || containerSelector === 'html') return;
    clearTimeout(target.__tdScrollTimer);
    var startTop = target.__tdScrollStart !== undefined ? target.__tdScrollStart : target.scrollTop;
    if (target.__tdScrollStart === undefined) target.__tdScrollStart = target.scrollTop;
    target.__tdScrollTimer = setTimeout(function() {
      var deltaY = target.scrollTop - startTop;
      if (Math.abs(deltaY) > 30) {
        window.__tdTrainEvents.push({
          type: 'scroll', selector: containerSelector,
          deltaX: 0, deltaY: deltaY,
          scrollY: target.scrollTop,
          url: location.href, timestamp: Date.now()
        });
      }
      target.__tdScrollStart = undefined;
    }, 500);
  }, true);

  // ── Browser back / forward (popstate) ────────────────────────────────────
  var _popstateLastUrl = location.href;
  window.addEventListener('popstate', function() {
    var newUrl = location.href;
    var direction = 'back'; // heuristic: we can't know for sure without history index
    window.__tdTrainEvents.push({
      type: direction, fromUrl: _popstateLastUrl, url: newUrl,
      timestamp: Date.now()
    });
    _popstateLastUrl = newUrl;
  });

  // ── URL navigation polling (SPA + normal nav) ────────────────────────────
  var lastUrl = location.href;
  var _lastBlankUrl = null;
  setInterval(function() {
    var cur = location.href;
    if (cur !== lastUrl) {
      // Tab-new heuristic: was about:blank briefly, then a real URL
      if (lastUrl === 'about:blank' && cur !== 'about:blank') {
        window.__tdTrainEvents.push({
          type: 'tab-new', url: cur, timestamp: Date.now()
        });
      } else {
        window.__tdTrainEvents.push({
          type: 'navigate', url: cur, previousUrl: lastUrl,
          pageTitle: document.title, timestamp: Date.now()
        });
      }
      lastUrl = cur;
    }
  }, 300);

  // ── Form submit ───────────────────────────────────────────────────────────
  document.addEventListener('submit', function(e) {
    window.__tdTrainEvents.push({
      type: 'submit', selector: getSelector(e.target),
      url: location.href, timestamp: Date.now()
    });
  }, true);

  // ── Shadow DOM piercing ───────────────────────────────────────────────────
  // Capture events inside shadow roots (web components, Gmail, Salesforce, etc.)
  function addShadowListeners(root) {
    if (!root || root.__tdShadowListenersAdded) return;
    root.__tdShadowListenersAdded = true;

    // Same listeners as main document, but scoped to shadow root
    root.addEventListener('click', function(e) {
      var raw = e.target;
      if (!raw || raw === root) return;
      var el = getClickTarget(raw);
      var selector = getSelector(el);
      if (selector === 'body' || selector === 'html') return;
      var text = (el.textContent || '').trim().substring(0, 60);
      var href = el.href || (el.closest('a') || {}).href || '';
      window.__tdTrainEvents.push({
        type: 'click', selector: selector, altSelectors: getAltSelectors(el),
        elementText: text, elementTag: el.tagName.toLowerCase(),
        href: href, url: location.href, inShadow: true, timestamp: Date.now()
      });
    }, true);

    root.addEventListener('input', function(e) {
      var el = e.target;
      var isCE = el.getAttribute && el.getAttribute('contenteditable') === 'true';
      var isTextarea = el.tagName === 'TEXTAREA';
      var isInput = el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio';
      if (!isCE && !isTextarea && !isInput) return;
      var selector = getSelector(el);
      clearTimeout((root.__tdInputTimers || {})[selector]);
      if (!root.__tdInputTimers) root.__tdInputTimers = {};
      root.__tdInputTimers[selector] = setTimeout(function() {
        var value = el.value !== undefined ? el.value : (el.innerText || el.textContent || '');
        if (!value) return;
        var fieldLabel = (el.getAttribute('aria-label') || el.placeholder || el.getAttribute('name') || el.getAttribute('id') || '').trim();
        window.__tdTrainEvents.push({
          type: 'fill', selector: selector, altSelectors: getAltSelectors(el),
          value: String(value).substring(0, 2000),
          elementText: cleanElementText(el) || fieldLabel,
          placeholder: el.placeholder || '',
          elementTag: el.tagName.toLowerCase(),
          url: location.href, inShadow: true, timestamp: Date.now()
        });
      }, 800);
    }, true);

    // Recursively check for deeper shadow roots
    var allElements = root.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var elem = allElements[i];
      if (elem.shadowRoot && !elem.shadowRoot.__tdShadowListenersAdded) {
        addShadowListeners(elem.shadowRoot);
      }
    }
  }

  // Monkey-patch attachShadow to catch dynamically created shadow roots
  var originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {
    var shadowRoot = originalAttachShadow.call(this, init);
    addShadowListeners(shadowRoot);
    return shadowRoot;
  };

  // Find and instrument existing shadow roots
  function findAndInstrumentShadowRoots(node) {
    if (!node) return;
    var walker = document.createTreeWalker(node, Node.ELEMENT_NODE, null, false);
    var elem;
    while (elem = walker.nextNode()) {
      if (elem.shadowRoot) {
        addShadowListeners(elem.shadowRoot);
        findAndInstrumentShadowRoots(elem.shadowRoot);
      }
    }
  }
  findAndInstrumentShadowRoots(document.body);

  // ── Initial navigation anchor ─────────────────────────────────────────────
  window.__tdTrainEvents.push({
    type: 'navigate', url: location.href,
    pageTitle: document.title, timestamp: Date.now()
  });
})();
`;

// ---------------------------------------------------------------------------
// Main training action — start CDP recording session
// ---------------------------------------------------------------------------
async function actionTrain(args) {
  let { agentId, mode = 'fresh', task = null, startUrl: startUrlOverride = null, keepSession = false, browserSessionId = null } = args || {};
  if (agentId) agentId = agentId.toLowerCase();

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (activeSessions.has(agentId)) return { ok: false, error: 'Training already in progress' };

  const agentFile = agentId.endsWith('.agent') ? `${agentId}.md` : `${agentId}.agent.md`;
  const agentPath = path.join(AGENTS_DIR, agentFile);

  let descriptor = '';
  if (fs.existsSync(agentPath)) {
    descriptor = fs.readFileSync(agentPath, 'utf8');
  } else {
    // .md file missing — fall back to command-service HTTP /agents.list (avoids DuckDB lock conflict)
    logger.info(`[trainer.agent] .md not on disk for ${agentId}, trying HTTP fallback via /agents.list`);
    try {
      const CMD_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
      const listResult = await new Promise((resolve, reject) => {
        const body = JSON.stringify({});
        const req = http.request(
          { hostname: '127.0.0.1', port: CMD_PORT, path: '/agents.list', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          (res) => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
          }
        );
        req.on('error', reject);
        req.write(body); req.end();
      });
      const agents = listResult?.agents || [];
      const _norm = id => (id || '').replace(/\.agent$/, '').toLowerCase().trim();
      const match = agents.find(a => _norm(a.id) === _norm(agentId) || a.id === agentId);
      if (match?.descriptor) {
        descriptor = match.descriptor;
        logger.info(`[trainer.agent] Loaded descriptor from HTTP /agents.list for ${agentId}`);
      }
    } catch (httpErr) {
      logger.warn(`[trainer.agent] HTTP fallback failed: ${httpErr.message}`);
    }
    if (!descriptor) return { ok: false, error: `Agent not found: ${agentId}` };
  }

  const startUrlMatch = descriptor.match(/^start_url:\s*(.+)$/m);
  if (!startUrlMatch) return { ok: false, error: 'Agent missing start_url' };

  const descriptorStartUrl = startUrlMatch[1].trim();
  const hostname = new URL(descriptorStartUrl).hostname.replace(/^www\./, '');

  // ── Train-from-current-page (mode='here') ──────────────────────────────────
  // Attach the recorder to the live browser session from the failed run instead
  // of navigating to the agent's start_url. The user demonstrates only the
  // missing steps (e.g. type the update + click Post) on the page they're
  // already on. Distillation prepends the deep-link navigate automatically.
  const isHereMode = mode === 'here' && (browserSessionId || startUrlOverride);
  // Use the persistent profile session (same as browser.agent.cjs) so auth
  // cookies are preserved. Format: '<agentId without .agent>_agent'.
  const sessionId = isHereMode ? browserSessionId : `${agentId.replace(/\.agent$/, '')}_agent`;
  const effectiveStartUrl = isHereMode ? (startUrlOverride || descriptorStartUrl) : descriptorStartUrl;

  const session = {
    agentId, hostname, startUrl: effectiveStartUrl, sessionId,
    rawEvents: [],
    startTime: Date.now(),
    pollInterval: null,
    cancelRequested: false,
    injectedTabs: new Set(), // tab indices where recorder script has been injected
    ctxBound: false,          // whether context.exposeBinding has been called
    httpServer: null,        // local HTTP event-push server
    httpPort: null,
    // Failure-handoff context — used by distillation to convert the demo into a
    // URL-first recipe keyed to the original task.
    trainMode: mode,
    trainTask: task,
    isHereMode,
    ownsSession: !isHereMode, // 'here' mode borrows the live session — don't close it on save/cancel
  };
  activeSessions.set(agentId, session);

  logger.info(`[trainer.agent] Starting real-time training for ${agentId} at ${effectiveStartUrl} (mode=${mode}${isHereMode ? ', attach to live session' : ''})`);

  try {
    const { browserAct } = require('./browser.act.cjs');

    _postProgress(agentId, { type: 'training:start', hostname, startUrl: effectiveStartUrl });

    // Start local HTTP server that receives events pushed via fetch() from the page
    await _startEventHttpServer(session);
    logger.info(`[trainer.agent] Event HTTP server ready on port ${session.httpPort}`);

    if (isHereMode) {
      // Attach recorder to the existing page — no navigation. The user is already
      // on the failure page (e.g. LinkedIn composer). Just inject the recorder.
      // Check the current URL to confirm we're attached.
      let _currentUrl = effectiveStartUrl;
      try {
        const _urlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed: true, timeoutMs: 5000 }).catch(() => ({ ok: false }));
        if (_urlRes?.ok && _urlRes.result) _currentUrl = String(_urlRes.result).replace(/^"|"$/g, '');
      } catch (_) {}
      logger.info(`[trainer.agent] train-from-here: attached to session ${sessionId} at ${_currentUrl}`);
      await _injectRecorderScript(session, 0);
      _startTabWatcher(session);
      _postProgress(agentId, {
        type: 'training:step-recorded',
        stepType: 'url',
        target: `${hostname} \u2192 (current page)`,
        url: _currentUrl,
        pageTitle: hostname,
      });
    } else {
      // Navigate to start URL (fresh mode — existing behavior)
      await browserAct({ action: 'navigate', url: effectiveStartUrl, sessionId, headed: true, timeoutMs: 30000 });
      await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 }).catch(() => {});

      // Inject recorder script on tab 0 and start tab-watcher loop
      await _injectRecorderScript(session, 0);
      _startTabWatcher(session);

      logger.info(`[trainer.agent] HTTP-push recorder active on tab 0`);

      // Emit initial step to UI
      _postProgress(agentId, {
        type: 'training:step-recorded',
        stepType: 'url',
        target: `${hostname} \u2192 Landing`,
        url: effectiveStartUrl,
        pageTitle: hostname,
      });
    }

    return { ok: true, agentId, message: `Training recording started (HTTP push, mode=${mode}).` };
  } catch (err) {
    logger.error(`[trainer.agent] Start failed: ${err.message}`);
    activeSessions.delete(agentId);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Extract target domain from agentId (e.g., "w3schools.agent" → "w3schools.com")
// Handle variations: w3schools.agent, w3schools.com.agent, etc.
// ---------------------------------------------------------------------------
function _extractTargetDomain(agentId, startUrl) {
  // If we have a startUrl from the recipe, use that
  if (startUrl) {
    try {
      const url = new URL(startUrl);
      return url.hostname; // e.g., "www.w3schools.com"
    } catch {}
  }

  // Fallback: derive from agentId
  // w3schools.agent → w3schools.com
  // perplexity.agent → perplexity.ai (common mapping)
  // stackoverflow.agent → stackoverflow.com
  const baseName = agentId.replace(/\.(agent|skill|recipe)$/i, '');

  // Common domain mappings
  const domainMap = {
    w3schools: 'w3schools.com',
    perplexity: 'perplexity.ai',
    stackoverflow: 'stackoverflow.com',
    github: 'github.com',
    gmail: 'gmail.com',
    google: 'google.com',
  };

  if (domainMap[baseName]) return domainMap[baseName];

  // Default: assume .com
  return `${baseName}.com`;
}

// Extract base domain for matching (e.g., "w3schools.com" from "www.w3schools.com")
function _getBaseDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    // For domains like "www.w3schools.com" or "profile.w3schools.com", return "w3schools.com"
    return parts.slice(-2).join('.');
  }
  return hostname;
}

// ---------------------------------------------------------------------------
// HTTP-push real-time recorder
// Browser page scripts call fetch('http://127.0.0.1:PORT/e', POST) for every event.
// Node.js HTTP server receives and routes to _processEvent immediately.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Build a per-session recorder script with the HTTP push endpoint baked in.
// Replaces every window.__tdTrainEvents.push( with an async fetch POST.
// ---------------------------------------------------------------------------
function _buildRecorderScript(port) {
  // Replace the array-push token with a binding-preferred push that falls back
  // to fetch. The CDP binding (window.__tdPushEvent) is installed via
  // page.exposeFunction and bypasses Content-Security-Policy — fetch to
  // http://127.0.0.1 is blocked by Spotify's CSP (and many modern sites).
  // The fetch fallback is kept for the CLI (playwright-cli) path where
  // exposeFunction is not available.
  return CDP_RECORDER_SCRIPT
    .split('window.__tdTrainEvents.push(')
    .join(`(function(ev){try{if(window.__tdPushEvent){window.__tdPushEvent(ev);}else{fetch('http://127.0.0.1:${port}/e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev)}).catch(function(){});}}catch(e_){}})(`);
}

// ---------------------------------------------------------------------------
// Start a local HTTP server that receives events POSTed by the injected script.
// Stores server + port on session so it can be closed on cancel.
// ---------------------------------------------------------------------------
function _startEventHttpServer(session) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // CORS headers so the browser page can POST freely
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/e') { res.writeHead(404); res.end(); return; }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(204); res.end();
        try {
          const evt = JSON.parse(body);
          // tabIndex is embedded in the event by the injected script guard
          _processEvent(session, evt, evt._tabIndex);
        } catch (e) {
          logger.warn(`[trainer.agent] HTTP event parse error: ${e.message}`);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      session.httpServer = server;
      session.httpPort   = port;
      logger.info(`[trainer.agent] Event HTTP server listening on 127.0.0.1:${port}`);
      resolve(port);
    });

    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Inject the recorder script into the current tab via run-code + addScriptTag.
// No exposeFunction needed — events arrive via fetch POST to the HTTP server.
// ---------------------------------------------------------------------------
async function _injectRecorderScript(session, tabIndex) {
  const { agentId, sessionId, httpPort } = session;
  const { browserAct } = require('./browser.act.cjs');

  if (!session.targetDomain) {
    session.targetDomain = _extractTargetDomain(agentId, session.startUrl);
  }

  // _buildRecorderScript bakes in the push-token (binding-preferred, fetch fallback).
  // Stamp each event with the tab index by patching the JSON.stringify(ev) token.
  const baseScript = _buildRecorderScript(httpPort);
  const script = baseScript
    .split('JSON.stringify(ev)')
    .join(`JSON.stringify(Object.assign(ev,{_tabIndex:${tabIndex}}))`)
    .split('window.__tdPushEvent(ev)')
    .join(`(ev._tabIndex = ${tabIndex}, window.__tdPushEvent(ev))`);

  // ── Engine path: context.exposeBinding + page.addInitScript ────────────────
  // context.exposeBinding creates a CDP binding (window.__tdPushEvent) that
  // bypasses Content-Security-Policy — fetch to http://127.0.0.1 is blocked by
  // Spotify and many modern sites' CSP. Unlike page.exposeFunction, context-level
  // bindings persist across ALL pages in the context (new tabs, navigations,
  // SPA reloads) automatically. addInitScript re-injects the recorder script on
  // every new document.
  let engineInjected = false;
  try {
    const engine = require('./browser-engine.cjs');
    const ctx = engine.getContext(sessionId);
    const page = engine.getPage(sessionId);
    if (ctx && page && !page.isClosed()) {
      // context.exposeBinding can only be called ONCE per context per name.
      // Track which contexts have already been bound via a module-level Set.
      if (!session.ctxBound) {
        try {
          // Playwright exposeBinding passes (source, ...args) where source is
          // { frame, page, context }. The actual event data is the 2nd argument.
          // Bug fix: previously only (evt) was declared, so evt was actually the
          // source object — all recorded events were undefined.
          await ctx.exposeBinding('__tdPushEvent', (source, evt) => {
            try {
              if (!evt || typeof evt !== 'object') {
                logger.warn(`[trainer.agent] __tdPushEvent received non-object: ${typeof evt}`);
                return;
              }
              logger.info(`[trainer.agent] __tdPushEvent received: type=${evt.type || '?'} url=${evt.url || '?'} tab=${evt._tabIndex || tabIndex}`);
              const _tabIdx = evt?._tabIndex !== undefined ? evt._tabIndex : tabIndex;
              _processEvent(session, evt, _tabIdx);
            } catch (e) {
              logger.warn(`[trainer.agent] __tdPushEvent callback error: ${e.message}`);
            }
          });
          session.ctxBound = true;
          logger.info(`[trainer.agent] Context binding __tdPushEvent registered for session=${sessionId}`);
        } catch (e) {
          if (/already exposed/i.test(e.message)) {
            session.ctxBound = true;
          } else {
            logger.warn(`[trainer.agent] context.exposeBinding failed: ${e.message}`);
          }
        }
      }

      // addInitScript runs on every new document (navigations, reloads, SPA route
      // changes that trigger a document reload). This is critical for Spotify which
      // does full page reloads when switching between some sections.
      // NOTE: we pass the string here for future docs; for the current doc we use
      // direct function evaluation to bypass `script-src` CSP on sites like Spotify.
      await page.addInitScript(script);

      // Directly evaluate the recorder on the current page in the main world.
      // This avoids creating a `<script>` DOM element, which is blocked by CSP.
      // We wrap the string as a Node function so Playwright serializes and runs
      // the IIFE body directly without needing `eval` in the browser.
      const recorderFn = new Function(script);
      let currentDocActive = false;
      try {
        await page.evaluate(recorderFn);
        currentDocActive = true;
      } catch (e) {
        logger.warn(`[trainer.agent] page.evaluate direct recorder injection failed on tab ${tabIndex}: ${e.message}`);
      }

      // Verify the recorder actually activated and the binding is reachable
      try {
        const status = await page.evaluate(() => ({
          active: !!window.__tdRecorderActive,
          hasPush: typeof window.__tdPushEvent === 'function',
          eventCount: (window.__tdTrainEvents || []).length,
          url: (typeof window !== 'undefined' && window.location && window.location.href) || '',
        }));
        logger.info(`[trainer.agent] Recorder status on tab ${tabIndex}: active=${status.active} hasPush=${status.hasPush} eventCount=${status.eventCount} url="${status.url}"`);
      } catch (e) {
        logger.warn(`[trainer.agent] Recorder status check failed on tab ${tabIndex}: ${e.message}`);
      }

      // Inject into existing child frames too
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          await frame.evaluate(recorderFn);
        } catch (e) {
          logger.warn(`[trainer.agent] Frame recorder injection failed on tab ${tabIndex}: ${e.message}`);
        }
      }

      logger.info(`[trainer.agent] Recorder injected on tab ${tabIndex} via engine (context.exposeBinding + addInitScript) currentDocActive=${currentDocActive}`);
      session.injectedTabs.add(tabIndex);
      engineInjected = true;
      return;
    }
  } catch (e) {
    logger.warn(`[trainer.agent] Engine injection failed on tab ${tabIndex}: ${e.message} — falling back to run-code`);
  }

  if (engineInjected) return;

  // ── CLI fallback: run-code + addScriptTag (no exposeFunction available) ─────
  // The CLI path can't use context.exposeBinding, so we use page.exposeFunction
  // to create window.__tdPushEvent as a binding that forwards events to the HTTP
  // server. This bypasses CSP (which blocks fetch to http://127.0.0.1 on Spotify
  // and many modern sites). If exposeFunction fails (e.g. already exposed), the
  // recorder script's fetch fallback still works on sites without strict CSP.
  const scriptJson = JSON.stringify(script);
  const injectCode = `async page => {
    // Set up __tdPushEvent binding BEFORE injecting the recorder script.
    // page.exposeFunction creates a CDP binding that bypasses CSP.
    try {
      await page.exposeFunction('__tdPushEvent', (evt) => {
        try {
          const http = require('http');
          const data = JSON.stringify(evt);
          const req = http.request('http://127.0.0.1:${httpPort}/e', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          });
          req.on('error', () => {});
          req.write(data);
          req.end();
        } catch(_) {}
        return 'ok';
      });
    } catch(e) {
      // exposeFunction throws if already exposed — that's fine, the binding still works
    }

    const src = ${scriptJson};

    // Use addScriptTag on first inject; fall back to evaluate for re-injects after nav
    try {
      await page.addScriptTag({ content: src });
    } catch(e) {
      // addScriptTag may fail if already injected — use evaluate to re-inject if needed
      await page.evaluate((code) => {
        if (!window.__tdRecorderActive) {
          const s = document.createElement('script');
          s.textContent = code;
          (document.head || document.documentElement).appendChild(s);
        }
      }, src);
    }

    // Inject into existing child frames too
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        await frame.evaluate((code) => {
          if (!window.__tdRecorderActive) {
            const s = document.createElement('script');
            s.textContent = code;
            (document.head || document.documentElement).appendChild(s);
          }
        }, src);
      } catch(_) {}
    }

    return 'injected';
  }`;

  const result = await browserAct({
    action: 'run-code',
    sessionId,
    headed: true,
    timeoutMs: 15000,
    code: injectCode,
  });

  if (result.ok) {
    logger.info(`[trainer.agent] Recorder injected on tab ${tabIndex}: ${result.result}`);
    session.injectedTabs.add(tabIndex);
  } else {
    logger.warn(`[trainer.agent] Recorder injection failed on tab ${tabIndex}: ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// Tab watcher — checks for new tabs every 2s and injects recorder on new ones
// ---------------------------------------------------------------------------
function _startTabWatcher(session) {
  const { sessionId } = session;
  const { browserAct } = require('./browser.act.cjs');

  let watching = false;

  session.pollInterval = setInterval(async () => {
    if (session.cancelRequested) { clearInterval(session.pollInterval); return; }
    if (watching) return;
    watching = true;

    try {
      const tabListResult = await browserAct({ action: 'tab-list', sessionId, headed: true, timeoutMs: 5000 });
      const tabListOutput = tabListResult.result || tabListResult.stdout || '';

      const resultSectionMatch = tabListOutput.match(/^([\s\S]*?)(?=###\s|$)/i);
      const resultSection = resultSectionMatch ? resultSectionMatch[1] : tabListOutput;
      const tabMatches = [...resultSection.matchAll(/^\s*-\s+(\d+):\s+(?:\(current\)\s+)?\[([^\]]+)\]\(([^)]+)\)/gm)];
      const tabs = tabMatches.map(m => ({ index: parseInt(m[1]), title: m[2].trim(), url: m[3].trim() }));

      for (const tab of tabs) {
        if (!session.injectedTabs.has(tab.index)
            && tab.url !== 'about:blank'
            && !tab.url.startsWith('chrome://')) {
          // Switch to the new tab to inject the recorder script.
          // Do NOT switch back after injection — the user opened this tab
          // intentionally and should stay on it. Switching back would yank
          // focus away from the tab they're actively using.
          await browserAct({ action: 'tab-select', sessionId, headed: true, timeoutMs: 5000, index: tab.index });
          await _injectRecorderScript(session, tab.index);
          logger.info(`[trainer.agent] Injected recorder on new tab ${tab.index}: ${tab.url.substring(0, 60)}`);
        }
      }
    } catch (e) {
      logger.warn(`[trainer.agent] Tab watcher error: ${e.message}`);
    }
    watching = false;
  }, 2000);
}

// ---------------------------------------------------------------------------
// Process a single event pushed from the browser via HTTP fetch POST
// ---------------------------------------------------------------------------
function _processEvent(session, evt, tabIndex) {
  if (!evt || session.cancelRequested) return;
  if (evt.type === 'recorder_init') return; // internal ping, not a user action
  const { agentId } = session;
  const targetDomain = session.targetDomain;

  // Use _tabIndex stamped into the event by the injected script, or fallback param
  const resolvedTab = evt._tabIndex !== undefined ? evt._tabIndex : (tabIndex !== undefined ? tabIndex : 0);
  evt.tabIndex = resolvedTab;
  delete evt._tabIndex;

  const last = session.rawEvents[session.rawEvents.length - 1];

  // ── Filters ────────────────────────────────────────────────────────────
  // 1. Off-domain
  const urlToCheck = evt.url || evt.frameUrl;
  if (urlToCheck && targetDomain) {
    let hostname;
    try { hostname = new URL(urlToCheck).hostname; } catch { hostname = urlToCheck; }
    const isOnDomain = _getBaseDomain(hostname) === _getBaseDomain(targetDomain);
    const isAboutBlank = urlToCheck === 'about:blank' || urlToCheck.startsWith('about:');
    if (!isOnDomain && !isAboutBlank) return;
  }

  // 2. about:blank / srcdoc navigations
  if (evt.type === 'navigate' && evt.url === 'about:blank') return;
  if (evt.type === 'navigate' && evt.url && (evt.url.startsWith('about:srcdoc') || evt.url.includes('srcdoc'))) return;

  // 3. Base dedup: same type+selector within 500ms
  if (last && last.type === evt.type && last.selector === evt.selector
      && Math.abs((evt.timestamp || 0) - (last.timestamp || 0)) < 500) return;

  // 4. Skip clicks on body/html
  if (['click','dblclick','rightclick','focus'].includes(evt.type)
      && (!evt.selector || ['body','html','document'].includes(evt.selector))) return;

  // 5. Skip empty fill
  if (evt.type === 'fill' && !evt.value) return;

  // 6. Duplicate navigate same URL + tab
  if (evt.type === 'navigate' && evt.url) {
    if (session.rawEvents.some(e => e.type === 'navigate' && e.url === evt.url && e.tabIndex === evt.tabIndex)) return;
  }

  // 7. dblclick too close to click on same selector
  if (evt.type === 'dblclick') {
    const lastClick = session.rawEvents.filter(e => e.type === 'click' && e.selector === evt.selector).pop();
    if (lastClick && Math.abs((evt.timestamp || 0) - (lastClick.timestamp || 0)) < 400) return;
  }

  // 8. Duplicate Enter keycombo within 300ms
  if (evt.type === 'keycombo' && evt.key === 'Enter') {
    const lastEnter = session.rawEvents.filter(e => e.type === 'keycombo' && e.key === 'Enter' && e.selector === evt.selector).pop();
    if (lastEnter && Math.abs((evt.timestamp || 0) - (lastEnter.timestamp || 0)) < 300) return;
  }

  // 9. Skip hover — not a meaningful user action for recipe building
  if (evt.type === 'hover') return;

  // 10. Skip focus — focus shifts are not recipe steps; the subsequent fill/click is
  if (evt.type === 'focus') return;

  // 11. Skip keycombo that is not Enter (arrow keys, Escape, F-keys, etc.)
  if (evt.type === 'keycombo' && evt.key !== 'Enter') return;

  // 12. Skip clicks on browser chrome / navigation elements (top-bar-forward, etc.)
  if (['click','dblclick'].includes(evt.type) && evt.selector) {
    const _navPattern = /top-bar|topbar|forward|back|navigate|nav-bar|navigation/i;
    if (_navPattern.test(evt.selector) || _navPattern.test(evt.elementText || '')) return;
  }

  // 13. Fill dedup: same type+selector+value within 2s (catches input+change doubling
  //     when other events arrived between the debounced input fill and the change fill)
  if (evt.type === 'fill' && evt.value) {
    const _recent = session.rawEvents.slice(-5);
    for (const prev of _recent) {
      if (prev.type === 'fill' && prev.selector === evt.selector
          && prev.value === evt.value
          && Math.abs((evt.timestamp || 0) - (prev.timestamp || 0)) < 2000) return;
    }
  }

  session.rawEvents.push(evt);

  // Debug: log raw event details for click/fill/paste/dblclick to diagnose garbling
  if (['click','fill','paste','dblclick','rightclick','select','check'].includes(evt.type)) {
    logger.info(`[trainer.agent] DEBUG push event: type=${evt.type} selector="${(evt.selector || '').substring(0, 80)}" elementText="${(evt.elementText || '').substring(0, 80)}" placeholder="${(evt.placeholder || '').substring(0, 80)}" value="${(evt.value || '').substring(0, 80)}"`);
    if (evt._debug) {
      const ariaRefInfo = evt._debug.ariaRef ? ` ariaRef="${evt._debug.ariaRef}"` : '';
      logger.info(`[trainer.agent] DEBUG cleanElementText: result="${(evt._debug.result || '').substring(0, 80)}" source=${evt._debug.source} tag=${evt._debug.tag} ariaLabel="${(evt._debug.ariaLabel || '').substring(0, 80)}"${ariaRefInfo} rawTextContent="${(evt._debug.rawTextContent || '').substring(0, 100)}"`);
      if (evt._debug.candidates && evt._debug.candidates.length > 0) {
        for (const c of evt._debug.candidates) {
          logger.info(`[trainer.agent] DEBUG candidate: source=${c.source} text="${c.text}" charCodes=${JSON.stringify(c.charCodes)}`);
        }
      }
    }
  }

  const uiStep = _eventToUIStep(evt);
  logger.info(`[trainer.agent] push event: type=${evt.type} tab=${evt.tabIndex} uiStep=${!!uiStep}`);
  if (uiStep) _postProgress(agentId, { type: 'training:step-recorded', ...uiStep });

  // NOTE: Guided training no longer auto-matches events to steps. All events
  // go to rawEvents regardless of which guided step is "current". On Save,
  // the LLM organizes the full path via actionPreviewSplit (using the guided
  // plan as context hints). The guided checklist is purely a UI guide — the
  // user manually marks steps done via agents:guided-train-done/skip.
}

// DEAD CODE PRESERVED FOR REFERENCE — replaced by _setupExposeFunction
async function _startWebSocketServer(session) {
  const { agentId, startUrl } = session;

  // Extract target domain for filtering (needed before resolve)
  const targetDomain = _extractTargetDomain(agentId, startUrl);
  session.targetDomain = targetDomain;

  return new Promise((resolve, reject) => {
    // Create WebSocket server on random available port
    const wss = new WebSocket.Server({ port: 0 }, (err) => {
      if (err) {
        logger.error(`[trainer.agent] WebSocket server failed to start: ${err.message}`);
        reject(err);
        return;
      }
    });

    // Get the assigned port
    const address = wss.address();
    const port = address.port;
    session.wsServer = wss;
    session.wsPort = port;

    // Track connected clients
    const clients = new Set();
    session.wsClients = clients;

    logger.info(`[trainer.agent] WebSocket server listening on port ${port}`);

    wss.on('connection', (ws) => {
      logger.info(`[trainer.agent] Extension connected to WebSocket`);
      clients.add(ws);

      // Handle messages from extension
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          _handleWebSocketMessage(session, message, ws);
        } catch (e) {
          logger.error(`[trainer.agent] Failed to parse WebSocket message: ${e.message}`);
        }
      });

      // Handle disconnect
      ws.on('close', () => {
        logger.info(`[trainer.agent] Extension disconnected from WebSocket`);
        clients.delete(ws);
      });

      // Send ping every 30 seconds to keep connection alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
    });

    wss.on('error', (err) => {
      logger.error(`[trainer.agent] WebSocket server error: ${err.message}`);
    });

    // Start HTTP discovery server on fixed port 63790
    // The Chrome extension fetches GET http://localhost:63790/port to discover the WS port
    const httpDiscovery = http.createServer((req, res) => {
      // Allow CORS so Chrome extension can fetch it
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/port' || req.url === '/') {
        res.writeHead(200);
        res.end(JSON.stringify({ port, active: true, timestamp: Date.now() }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });

    session.httpDiscovery = httpDiscovery;

    httpDiscovery.on('error', (err) => {
      // Port 63790 might be in use from a previous session — not fatal
      logger.warn(`[trainer.agent] HTTP discovery server error (non-fatal): ${err.message}`);
    });

    httpDiscovery.listen(TRAINER_DISCOVERY_PORT, '127.0.0.1', () => {
      logger.info(`[trainer.agent] HTTP discovery server listening on port ${TRAINER_DISCOVERY_PORT}`);
    });

    resolve(port);
  });
}

// Handle messages from Chrome Extension via WebSocket
function _handleWebSocketMessage(session, message, ws) {
  const { agentId } = session;
  const targetDomain = session.targetDomain;
  
  switch (message.type) {
    case 'event':
      // Event from content script - process it
      const evt = message.event;
      if (!evt) return;
      
      // Add tab info from message if present
      if (message.tabIndex !== undefined) evt.tabIndex = message.tabIndex;
      if (message.tabUrl) evt.tabUrl = message.tabUrl;
      if (message.tabTitle) evt.tabTitle = message.tabTitle;
      
      // Apply same filters as polling
      const last = session.rawEvents[session.rawEvents.length - 1];
      
      // Filter 1: Skip off-domain events
      const urlToCheck = evt.url || evt.frameUrl;
      if (urlToCheck && targetDomain) {
        let hostname;
        try {
          hostname = new URL(urlToCheck).hostname;
        } catch {
          hostname = urlToCheck;
        }
        const targetBaseDomain = _getBaseDomain(targetDomain);
        const eventBaseDomain = _getBaseDomain(hostname);
        const isOnDomain = eventBaseDomain === targetBaseDomain;
        const isAboutBlank = urlToCheck === 'about:blank' || urlToCheck.startsWith('about:');
        
        if (!isOnDomain && !isAboutBlank) {
          logger.debug(`[trainer.agent] Skipping off-domain event: ${hostname}`);
          return;
        }
      }
      
      // Filter 2: Skip about:blank navigations
      if (evt.type === 'navigate' && evt.url === 'about:blank') {
        logger.debug(`[trainer.agent] Skipping about:blank navigation`);
        return;
      }
      
      // Filter 3: Skip about:srcdoc navigations
      if (evt.type === 'navigate' && evt.url && (evt.url.startsWith('about:srcdoc') || evt.url.includes('srcdoc'))) {
        logger.debug(`[trainer.agent] Skipping iframe srcdoc navigation: ${evt.url}`);
        return;
      }
      
      // Filter 4: Base dedup (same type+selector within 500ms)
      if (last && last.type === evt.type && last.selector === evt.selector
          && Math.abs((evt.timestamp || 0) - (last.timestamp || 0)) < 500) {
        return;
      }
      
      // Filter 5: Skip clicks on body/html/document
      if (['click','dblclick','rightclick','focus'].includes(evt.type)
          && (!evt.selector || ['body','html','document'].includes(evt.selector))) {
        return;
      }
      
      // Filter 6: Skip empty fill values
      if (evt.type === 'fill' && !evt.value) {
        return;
      }
      
      // Filter 7: Skip duplicate navigation events (same URL, same tab)
      if (evt.type === 'navigate' && evt.url) {
        const alreadyRecorded = session.rawEvents.some(e =>
          e.type === 'navigate' && e.url === evt.url && e.tabIndex === evt.tabIndex
        );
        if (alreadyRecorded) {
          logger.debug(`[trainer.agent] Skipping duplicate navigation to ${evt.url}`);
          return;
        }
      }
      
      // Filter 8: Skip dblclick if a click on same selector within 400ms
      if (evt.type === 'dblclick') {
        const lastClick = session.rawEvents.filter(e => e.type === 'click' && e.selector === evt.selector).pop();
        if (lastClick && Math.abs((evt.timestamp || 0) - (lastClick.timestamp || 0)) < 400) {
          return;
        }
      }
      
      // Filter 9: Skip duplicate Enter keycombo within 300ms
      if (evt.type === 'keycombo' && evt.key === 'Enter') {
        const lastEnter = session.rawEvents.filter(e => e.type === 'keycombo' && e.key === 'Enter' && e.selector === evt.selector).pop();
        if (lastEnter && Math.abs((evt.timestamp || 0) - (lastEnter.timestamp || 0)) < 300) {
          return;
        }
      }
      
      // Add event to session
      session.rawEvents.push(evt);
      
      // Emit to UI
      const uiStep = _eventToUIStep(evt);
      logger.info(`[trainer.agent] real-time event: type=${evt.type}, tab=${evt.tabIndex}, uiStep=${!!uiStep}`);
      if (uiStep) {
        _postProgress(agentId, { type: 'training:step-recorded', ...uiStep });
      }
      break;
      
    case 'tab_activated':
      // Tab activation event - log it
      logger.info(`[trainer.agent] Tab activated: index=${message.tabIndex}, url=${message.url}`);
      break;
      
    case 'tab_closed':
      logger.info(`[trainer.agent] Tab closed: id=${message.tabId}`);
      break;
      
    case 'pong':
      // Extension responding to ping
      break;
      
    case 'connection':
      logger.info(`[trainer.agent] Extension connection status: ${message.status}`);
      break;
      
    default:
      logger.debug(`[trainer.agent] Unknown WebSocket message type: ${message.type}`);
  }
}

// ---------------------------------------------------------------------------
// Poll injected event array every 2s (DEPRECATED - use WebSocket instead)
// Kept for fallback if extension fails to load
// ---------------------------------------------------------------------------
function _startEventPoller(session) {
  const { agentId, sessionId } = session;
  let lastIndex = 0;
  let polling = false; // lock to prevent concurrent poll cycles

  // Extract target domain for origin-based filtering (e.g., "w3schools.com" for "w3schools.agent")
  const targetDomain = _extractTargetDomain(agentId, session.startUrl);
  logger.info(`[trainer.agent] Origin domain filter: ${targetDomain}`);

  // Build poll code per-cycle with the current lastIndex baked in.
  // KEY FIX: playwright-cli hard-caps run-code output at ~1024 chars. If we return
  // ALL events as one JSON string it gets truncated after ~3 events and the parser
  // can never see new events. Instead we pass lastIndex into the browser context and
  // return ONLY the new slice — a small array regardless of total event count.
  // The browser also clears delivered events to keep the array from growing unbounded.
  const RECORDER_SCRIPT_JSON = JSON.stringify(CDP_RECORDER_SCRIPT);
  function buildPollCode(idx) {
    return `async page => {
    const active = await page.evaluate(() => !!window.__tdRecorderActive);
    if (!active) {
      await page.addScriptTag({ content: ${RECORDER_SCRIPT_JSON} });
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          const fa = await frame.evaluate(() => !!window.__tdRecorderActive).catch(() => false);
          if (!fa) await frame.addScriptTag({ content: ${RECORDER_SCRIPT_JSON} }).catch(() => {});
        } catch (_) {}
      }
      return '__REINJECTED__';
    }
    // Return only new events starting at lastIndex, then trim delivered events
    const fromIdx = ${idx};
    const all = await page.evaluate(() => window.__tdTrainEvents || []);
    const newEvts = all.slice(fromIdx);
    // Collect new events from child frames
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameUrl = frame.url();
        const fa = await frame.evaluate(() => !!window.__tdRecorderActive).catch(() => false);
        if (!fa) { await frame.addScriptTag({ content: ${RECORDER_SCRIPT_JSON} }).catch(() => {}); continue; }
        const fe = await frame.evaluate(() => { const ev = (window.__tdTrainEvents||[]).slice(0); window.__tdTrainEvents=[]; return ev; }).catch(() => []);
        for (const e of fe) newEvts.push({ ...e, frameUrl, inFrame: true });
      } catch (_) {}
    }
    // Trim main frame events to keep array small (keep only last 5 as reference)
    await page.evaluate((keepFrom) => {
      if (window.__tdTrainEvents && window.__tdTrainEvents.length > keepFrom) {
        window.__tdTrainEvents = window.__tdTrainEvents.slice(keepFrom);
        window.__tdKeepOffset = (window.__tdKeepOffset || 0) + keepFrom;
      }
    }, Math.max(0, all.length - 5));
    return JSON.stringify(newEvts);
  }`;
  }

  // Track per-tab last indices for multi-tab collection
  const tabLastIndices = new Map(); // tabIndex -> lastIndex
  let mainTabIndex = 0; // Assume main tab is index 0 initially

  session.pollInterval = setInterval(async () => {
    if (session.cancelRequested) { clearInterval(session.pollInterval); return; }
    if (polling) return; // previous cycle still in flight
    polling = true;

    try {
      const { browserAct } = require('./browser.act.cjs');

      // ── Multi-tab collection: get list of all tabs ─────────────────────
      const tabListResult = await browserAct({ action: 'tab-list', sessionId, headed: true, timeoutMs: 5000 });
      // browserAct returns {result, stdout} - result is trimmed stdout, prefer that
      const tabListOutput = tabListResult.result || tabListResult.stdout || '';

      // Debug logging to see raw tab-list output
      logger.info(`[trainer.agent] tab-list raw output (${tabListOutput.length} chars): ${JSON.stringify(tabListOutput.substring(0, 300))}`);

      // Parse tab list: extract content before first ### header to avoid duplicates
      const resultSectionMatch = tabListOutput.match(/^([\s\S]*?)(?=###\s|$)/i);
      const resultSection = resultSectionMatch ? resultSectionMatch[1] : tabListOutput;
      const tabMatches = [...resultSection.matchAll(/^\s*-\s+(\d+):\s+(?:\(current\)\s+)?\[([^\]]+)\]\(([^)]+)\)/gm)];
      const tabs = tabMatches.map(m => ({ index: parseInt(m[1]), title: m[2].trim(), url: m[3].trim() }));

      if (tabs.length === 0) {
        // Fallback to single-page poll if tab-list fails
        logger.debug('[trainer.agent] tab-list empty, falling back to single-page poll');
        tabs.push({ index: 0, title: 'main', url: 'unknown' });
      }

      // Debug logging for tab detection
      logger.info(`[trainer.agent] tab-list parsed: ${tabs.length} tabs: ${JSON.stringify(tabs.map(t => ({i: t.index, url: t.url.substring(0, 60), title: t.title.substring(0, 30)})))}`);

      // ── Collect events from ACTIVE tab only ───────────────────────────────
      // Find which tab is currently active (marked with "(current)" in tab-list)
      const currentMatch = tabListOutput.match(/- (\d+): \(current\)/);
      const activeTabIndex = currentMatch ? parseInt(currentMatch[1]) : 0;
      const activeTab = tabs.find(t => t.index === activeTabIndex) || tabs[0];

      // Track for reference
      mainTabIndex = activeTabIndex;

      let allNewEvents = [];
      let anyReinjected = false;

      // Only poll the active tab - skip about:blank and chrome://
      if (activeTab.url !== 'about:blank' && !activeTab.url.startsWith('chrome://')) {
        // Ensure this tab has a lastIndex tracker
        if (!tabLastIndices.has(activeTab.index)) {
          tabLastIndices.set(activeTab.index, 0);
        }
        const tabLastIdx = tabLastIndices.get(activeTab.index);

        // Poll the active tab's recorder state (no tab switching needed!)
        try {
          const result = await browserAct({
            action: 'run-code', sessionId, headed: true, timeoutMs: 15000,
            code: buildPollCode(tabLastIdx),
          });

          if (result.ok && result.result) {
            const raw = result.result;
            if (raw === '__REINJECTED__') {
              anyReinjected = true;
            } else {
              // Parse events from this tab
              let tabEvents;
              try {
                let parsed = JSON.parse(raw);
                if (typeof parsed === 'string') parsed = JSON.parse(parsed);
                tabEvents = Array.isArray(parsed) ? parsed : [];
              } catch {
                try {
                  const unescaped = JSON.parse('"' + raw + '"');
                  const parsed2 = JSON.parse(unescaped);
                  tabEvents = Array.isArray(parsed2) ? parsed2 : [];
                } catch { tabEvents = []; }
              }

              // Tag events with tab index and update this tab's lastIndex
              if (tabEvents.length > 0) {
                tabEvents.forEach(e => {
                  e.tabIndex = activeTab.index;
                  e.tabUrl = activeTab.url;
                  e.tabTitle = activeTab.title;
                });
                allNewEvents.push(...tabEvents);
                tabLastIndices.set(activeTab.index, tabLastIdx + tabEvents.length);

                logger.debug(`[trainer.agent] Tab ${activeTab.index}: ${tabEvents.length} new events from ${activeTab.url.substring(0, 50)}`);
              }
            }
          }
        } catch (tabPollErr) {
          logger.warn(`[trainer.agent] Failed to poll active tab ${activeTab.index}: ${tabPollErr.message}`);
        }
      }

      if (anyReinjected) {
        logger.info(`[trainer.agent] Re-injected CDP recorder in active tab`);
      }

      // Use events from active tab
      const newEvents = allNewEvents;
      logger.info(`[trainer.agent] poll: ${newEvents.length} new events from active tab ${activeTabIndex}`);

      for (const evt of newEvents) {
        const last = session.rawEvents[session.rawEvents.length - 1];

        // ── Noise filters ─────────────────────────────────────────────────
        // 1. Base dedup: same type+selector within 500ms
        if (last && last.type === evt.type && last.selector === evt.selector
            && Math.abs((evt.timestamp || 0) - (last.timestamp || 0)) < 500) continue;

        // 2. Skip clicks/dblclicks/rightclicks on body/html/document
        if (['click','dblclick','rightclick','focus'].includes(evt.type)
            && (!evt.selector || ['body','html','document'].includes(evt.selector))) continue;

        // 3. Skip fill with empty value
        if (evt.type === 'fill' && !evt.value) continue;

        // 4. Skip hover if same selector hovered within 2s
        if (evt.type === 'hover') {
          const lastHover = session.rawEvents.filter(e => e.type === 'hover' && e.selector === evt.selector).pop();
          if (lastHover && Math.abs((evt.timestamp || 0) - (lastHover.timestamp || 0)) < 2000) continue;
        }

        // 5. Skip focus if its selector matches the last click target (already captured)
        if (evt.type === 'focus') {
          const lastClick = session.rawEvents.filter(e => e.type === 'click').pop();
          if (lastClick && lastClick.selector === evt.selector
              && Math.abs((evt.timestamp || 0) - (lastClick.timestamp || 0)) < 1000) continue;
        }

        // 6. Skip duplicate Enter keycombo within 300ms on same selector
        if (evt.type === 'keycombo' && evt.key === 'Enter') {
          const lastEnter = session.rawEvents.filter(e => e.type === 'keycombo' && e.key === 'Enter' && e.selector === evt.selector).pop();
          if (lastEnter && Math.abs((evt.timestamp || 0) - (lastEnter.timestamp || 0)) < 300) continue;
        }

        // 7. Skip dblclick if a click on the same selector was recorded within 400ms
        if (evt.type === 'dblclick') {
          const lastClick = session.rawEvents.filter(e => e.type === 'click' && e.selector === evt.selector).pop();
          if (lastClick && Math.abs((evt.timestamp || 0) - (lastClick.timestamp || 0)) < 400) continue;
        }

        // 8. Skip contextmenu on body/html
        if (evt.type === 'rightclick'
            && (!evt.selector || ['body','html'].includes(evt.selector))) continue;

        // 9. Skip events from off-domain URLs (filters ads, trackers, third-party content)
        const urlToCheck = evt.url || evt.frameUrl;
        if (urlToCheck && targetDomain) {
          // Extract hostname from URL
          let hostname;
          try {
            hostname = new URL(urlToCheck).hostname;
          } catch {
            hostname = urlToCheck; // fallback for relative URLs or malformed
          }

          // Use base domain matching (e.g., "w3schools.com" matches "www.w3schools.com" and "profile.w3schools.com")
          const targetBaseDomain = _getBaseDomain(targetDomain);
          const eventBaseDomain = _getBaseDomain(hostname);
          const isOnDomain = eventBaseDomain === targetBaseDomain;

          // Also allow about:blank for same-page navigation events
          const isAboutBlank = urlToCheck === 'about:blank' || urlToCheck.startsWith('about:');

          if (!isOnDomain && !isAboutBlank) {
            logger.debug(`[trainer.agent] Skipping off-domain event: ${hostname} (not ${targetDomain})`);
            continue;
          }
        }

        // 9.5. Skip duplicate navigation events (same URL, same tab)
        if (evt.type === 'navigate' && evt.url) {
          const alreadyRecorded = session.rawEvents.some(e =>
            e.type === 'navigate' && e.url === evt.url && e.tabIndex === evt.tabIndex
          );
          if (alreadyRecorded) {
            logger.debug(`[trainer.agent] Skipping duplicate navigation to ${evt.url}`);
            continue;
          }
        }

        // 10. Skip about:blank navigations - they're iframe placeholders, not user actions
        if (evt.type === 'navigate' && evt.url === 'about:blank') {
          logger.debug(`[trainer.agent] Skipping about:blank navigation`);
          continue;
        }

        // 11. Skip about:srcdoc and iframe navigations that aren't meaningful
        if (evt.type === 'navigate' && evt.url) {
          if (evt.url.startsWith('about:srcdoc') || evt.url.includes('srcdoc')) {
            logger.debug(`[trainer.agent] Skipping iframe srcdoc navigation: ${evt.url}`);
            continue;
          }
        }

        session.rawEvents.push(evt);

        // Debug: log cleanElementText diagnostics for click events
        if (evt.type === 'click' && evt._debug) {
          logger.info(`[trainer.agent] cleanElementText DEBUG for click: result="${evt._debug.result}" source=${evt._debug.source} tag=${evt._debug.tag} ariaLabel=${JSON.stringify(evt._debug.ariaLabel)}`);
          if (evt._debug.candidates && evt._debug.candidates.length > 0) {
            for (const c of evt._debug.candidates) {
              logger.info(`[trainer.agent] cleanElementText DEBUG candidate: source=${c.source} len=${c.len} text="${c.text}" charCodes=${JSON.stringify(c.charCodes)}`);
            }
          }
          if (evt._debug.rawTextContent) {
            logger.info(`[trainer.agent] cleanElementText DEBUG rawTextContent="${evt._debug.rawTextContent}" charCodes=${JSON.stringify(evt._debug.rawTextCharCodes)}`);
          }
        }

        // Emit to UI
        const uiStep = _eventToUIStep(evt);
        logger.info(`[trainer.agent] emitting step: type=${evt.type} uiStep=${!!uiStep}`);
        if (uiStep) _postProgress(agentId, { type: 'training:step-recorded', ...uiStep });
      }
    } catch (pollErr) { logger.warn(`[trainer.agent] poll error: ${pollErr.message}`); }
    polling = false;
  }, 1000);
}

// ---------------------------------------------------------------------------
// Convert raw CDP event to UI step format
// ---------------------------------------------------------------------------
function _eventToUIStep(evt) {
  // Add [Tab X] prefix for all event types when tabIndex is present
  const tabPrefix = evt.tabIndex !== undefined ? `[Tab ${evt.tabIndex}] ` : '';
  
  switch (evt.type) {
    case 'navigate':
      return {
        stepType: 'url',
        target: `${tabPrefix}${evt.pageTitle || new URL(evt.url).pathname} \u2192 Page`,
        url: evt.url,
        pageTitle: evt.pageTitle,
        tabIndex: evt.tabIndex,
      };
    case 'click':
      return {
        stepType: 'click',
        target: `${tabPrefix}${evt.elementText || evt.selector} \u2192 Clicked`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'fill':
      return {
        stepType: 'fill',
        target: `${tabPrefix}${evt.selector} \u2192 "${(evt.value || '').substring(0, 30)}"`,
        selector: evt.selector,
        value: evt.value,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'select':
      return {
        stepType: 'select',
        target: `${tabPrefix}${evt.selector} \u2192 Selected "${(evt.value || '').substring(0, 30)}"`,
        selector: evt.selector,
        value: evt.value,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'submit':
      return {
        stepType: 'submit',
        target: `${tabPrefix}Form submitted`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'check':
      return {
        stepType: 'check',
        target: `${tabPrefix}${evt.label || evt.selector} \u2192 ${evt.checked ? 'checked' : 'unchecked'}`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'drag':
      return {
        stepType: 'drag',
        target: `${tabPrefix}${evt.fromSelector} \u2192 dragged ${evt.distance}px`,
        selector: evt.fromSelector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'scroll':
      return {
        stepType: 'scroll',
        target: `${tabPrefix}Scrolled ${evt.deltaY > 0 ? 'down' : 'up'} ${Math.abs(evt.deltaY)}px`,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'extract':
      return {
        stepType: 'extract',
        target: `${tabPrefix}Extract "${evt.extractName}" from ${evt.selector}`,
        selector: evt.selector,
        extractName: evt.extractName,
        extractType: evt.extractType,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'dblclick':
      return {
        stepType: 'dblclick',
        target: `${tabPrefix}${evt.elementText || evt.selector} \u2192 Double-clicked`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'rightclick':
      return {
        stepType: 'rightclick',
        target: `${tabPrefix}${evt.selector} \u2192 Right-clicked`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'paste':
      return {
        stepType: 'paste',
        target: `${tabPrefix}${evt.selector} \u2192 Pasted "${(evt.text || '').substring(0, 30)}"`,
        selector: evt.selector,
        text: evt.text,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'keycombo': {
      const combo = [evt.ctrl ? 'Ctrl' : '', evt.shift ? 'Shift' : '', evt.alt ? 'Alt' : '', evt.key].filter(Boolean).join('+');
      return {
        stepType: 'keycombo',
        target: `${tabPrefix}${evt.selector} \u2192 ${combo}`,
        selector: evt.selector,
        key: evt.key,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    }
    case 'focus':
      return {
        stepType: 'focus',
        target: `${tabPrefix}${evt.selector} \u2192 Focused (Tab)`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'hover':
      return {
        stepType: 'hover',
        target: `${tabPrefix}${evt.selector} \u2192 Hovered`,
        selector: evt.selector,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'back':
      return {
        stepType: 'back',
        target: `${tabPrefix}Browser \u2192 Back`,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'forward':
      return {
        stepType: 'forward',
        target: `${tabPrefix}Browser \u2192 Forward`,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    case 'tab-new':
      return {
        stepType: 'tab-new',
        target: `${tabPrefix}New tab \u2192 ${evt.url || ''}`,
        url: evt.url,
        tabIndex: evt.tabIndex,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Save training — LLM cleans events into waypoint recipe, saves to disk
// ---------------------------------------------------------------------------
async function actionSaveTraining(args) {
  let { agentId, skillName } = args || {};
  if (agentId) agentId = agentId.toLowerCase();

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!skillName) return { ok: false, error: 'skillName is required' };

  // Validate dot-name format — must end with .skill suffix
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.skill$/.test(skillName)) {
    return { ok: false, error: 'Skill name must be dot-separated and end with .skill (e.g. w3schools.tryit.skill)' };
  }

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };
  if (session.rawEvents.length < 2) return { ok: false, error: 'Not enough recorded steps' };

  // Stop polling
  if (session.pollInterval) clearInterval(session.pollInterval);
  session.cancelRequested = true;

  _postProgress(agentId, { type: 'training:saving', message: 'Building waypoint recipe...' });

  try {
    // Build recipe via LLM cleanup
    const recipe = await _buildRecipe(session, skillName);

    // Save recipe file
    const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

    const recipePath = path.join(skillDir, _skillFileName(skillName));
    fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2), 'utf8');

    // Update agent descriptor with trained_skills entry
    _registerSkillInAgent(agentId, skillName, recipe);

    // Clean up session — close HTTP server, close browser daemon, remove session
    if (session.httpServer) {
      session.httpServer.close(() => {
        logger.info(`[trainer.agent] Event HTTP server closed after save (port ${session.httpPort})`);
      });
    }
    // Only close the browser session if we own it. In 'here' mode (train-from-
    // current-page) we borrowed the live session from the failed run — don't
    // close it; the user may want to retry or it'll be cleaned up by the caller.
    if (session.ownsSession !== false) {
      const { browserAct } = require('./browser.act.cjs');
      browserAct({ action: 'close', sessionId: session.sessionId }).catch(() => {});
    }
    activeSessions.delete(agentId);

    logger.info(`[trainer.agent] Recipe saved: ${recipePath}`);
    _postProgress(agentId, {
      type: 'training:saved',
      skillName,
      recipePath,
      waypointCount: recipe.waypoints.length,
      message: `Skill "${skillName}" saved with ${recipe.waypoints.length} waypoints.`,
    });

    return { ok: true, skillName, recipePath, recipe };
  } catch (err) {
    logger.error(`[trainer.agent] Save failed: ${err.message}`);
    _postProgress(agentId, { type: 'training:error', message: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Preview auto-split: analyze recorded events and return proposed skill split
// Does NOT save to disk — returns preview data for the review UI
// ---------------------------------------------------------------------------
async function actionPreviewSplit(args) {
  let { agentId, skillName, guidedPlan } = args || {};
  if (agentId) agentId = agentId.toLowerCase();
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!skillName) return { ok: false, error: 'skillName is required' };

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };
  if (session.rawEvents.length < 2) return { ok: false, error: 'Not enough recorded steps' };

  // Use guidedPlan from args, or fall back to session.guidedPlan if present
  const planContext = guidedPlan || session.guidedPlan || null;

  // Stop polling during preview — but do NOT set cancelRequested (that would
  // make the session look cancelled to actionCancelTraining checks). We use a
  // separate flag so cancel can still interrupt the preview.
  if (session.pollInterval) clearInterval(session.pollInterval);
  session.previewInProgress = true;

  logger.info(`[trainer.agent] actionPreviewSplit started: ${session.rawEvents.length} raw events, skillName="${skillName}"`);
  _postProgress(agentId, { type: 'training:saving', message: 'Analyzing recorded steps…' });

  try {
    // Auto-split events into action segments (with optional guided plan context)
    const actions = await _autoSplitEvents(session, planContext);

    // Check if cancelled during LLM call
    if (session.cancelRequested || !activeSessions.has(agentId)) {
      logger.info('[trainer.agent] actionPreviewSplit cancelled by user');
      return { ok: false, error: 'Preview cancelled by user', cancelled: true };
    }

    // Check for reject response from LLM
    if (actions.rejected) {
      logger.info(`[trainer.agent] _autoSplitEvents rejected: ${actions.reason}`);
      return { ok: false, rejected: true, reason: actions.reason || 'Could not understand the recorded actions' };
    }
    // For instruction-based skills, don't use _collapseNavigation (which drops
    // essential clicks like "open dropdown menu" before a dynamic-URL navigation).
    // Instead, pass raw events to _buildInstructionSkill, which already cleans
    // noise via _cleanEventsForInstruction and lets the LLM identify essential steps.
    const collapsed = session.rawEvents;

    if (actions.length <= 1) {
      // Single action — no split needed
      const skillPreview = await _buildInstructionSkill(session, collapsed, 0, collapsed.length, skillName, actions[0]);
      if (skillPreview.rejected) {
        session.previewInProgress = false;
        return { ok: false, rejected: true, reason: skillPreview.reason };
      }
      session.previewInProgress = false;
      return { ok: true, agentId, singleAction: true, skills: [skillPreview], recipe: null };
    }

    // Multi-action — build skill previews + recipe preview
    const skills = [];
    const cleanAgentId = agentId.replace(/\.agent$/, '');
    const baseName = skillName.replace(/\.(skill|recipe)$/, '');

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const actionEvents = collapsed.slice(action.eventStart, action.eventEnd);
      const actionSkillName = `${baseName}.${action.name.replace(/\s+/g, '_').toLowerCase()}.skill`;
      const skillPreview = await _buildInstructionSkill(session, actionEvents, action.eventStart, action.eventEnd, actionSkillName, action);
      if (skillPreview.rejected) {
        session.previewInProgress = false;
        return { ok: false, rejected: true, reason: skillPreview.reason };
      }
      skills.push(skillPreview);
    }

    // Build recipe preview
    const recipeName = `${baseName}.recipe`;
    const allParams = [];
    const paramFlow = {};
    const seenParams = new Set();
    for (const skill of skills) {
      for (const param of skill.params || []) {
        if (!seenParams.has(param.name)) {
          seenParams.add(param.name);
          allParams.push(param);
        }
        if (!paramFlow[param.name]) paramFlow[param.name] = [];
        paramFlow[param.name].push(skill.name);
      }
    }

    const recipe = {
      name: recipeName,
      agentId: cleanAgentId,
      skills: skills.map(s => ({ skill: s.name })),
      params: allParams,
      paramFlow,
    };

    logger.info(`[trainer.agent] actionPreviewSplit: ${skills.length} skills + recipe "${recipeName}"`);
    session.previewInProgress = false;
    return { ok: true, agentId, singleAction: false, skills, recipe };
  } catch (err) {
    logger.error(`[trainer.agent] Preview split failed: ${err.message}`);
    session.previewInProgress = false;
    _postProgress(agentId, { type: 'training:error', message: err.message });
    return { ok: false, error: err.message };
  }
}

// Clean noisy recording events before generating instructions.
// Drops hover/focus/drag noise, merges duplicate fills, dedupes rapid clicks.
function _cleanEventsForInstruction(events) {
  const cleaned = [];
  const DROP_TYPES = new Set(['hover', 'focus', 'drag', 'blur', 'scroll']);
  let lastClickKey = null;
  let lastClickTime = 0;
  let lastFillKey = null;
  let lastFillTime = 0;
  let lastNavUrl = null;

  for (const evt of events) {
    // Drop noise events entirely
    if (DROP_TYPES.has(evt.type)) continue;

    // Dedupe consecutive navigates to the same URL
    if (evt.type === 'navigate') {
      const url = (evt.url || '').split('?')[0]; // ignore query params
      if (url === lastNavUrl) continue;
      lastNavUrl = url;
      cleaned.push(evt);
      continue;
    }

    // Dedupe rapid clicks on the same element (within 800ms)
    if (evt.type === 'click') {
      const key = `${evt.selector || ''}|${evt.elementText || ''}`;
      const now = evt.timestamp || 0;
      if (key === lastClickKey && now - lastClickTime < 800) continue;
      lastClickKey = key;
      lastClickTime = now;
      cleaned.push(evt);
      continue;
    }

    // Merge rapid fills on the same field (within 2s) — keep only the latest value
    if (evt.type === 'fill' || evt.type === 'paste') {
      const key = `${evt.selector || ''}`;
      const now = evt.timestamp || 0;
      if (key === lastFillKey && now - lastFillTime < 2000) {
        // Replace the last fill's value with this one
        const last = cleaned[cleaned.length - 1];
        if (last && (last.type === 'fill' || last.type === 'paste') && (last.selector || '') === key) {
          if (evt.type === 'fill') last.value = evt.value;
          else last.text = evt.text;
          lastFillTime = now;
          continue;
        }
      }
      lastFillKey = key;
      lastFillTime = now;
      cleaned.push(evt);
      continue;
    }

    // Keep all other event types (submit, select, check, keycombo, dblclick)
    cleaned.push(evt);
  }

  return cleaned;
}

// Build an instruction-based skill preview from a segment of events.
// Instead of generating CSS-selector waypoints, this calls the LLM to convert
// the raw browser interactions into a natural language instruction that
// playwrightAgent can execute against the live DOM at runtime.
async function _buildInstructionSkill(session, events, eventStart, eventEnd, skillName, action) {
  // Clean noise from the recording before generating instructions
  const segmentEvents = _cleanEventsForInstruction(events);

  // Filter out all navigate events except the first one before sending to the LLM
  let navigateCount = 0;
  const filteredEvents = segmentEvents.filter(e => {
    if (e.type === 'navigate') {
      if (navigateCount === 0) { navigateCount++; return true; }
      return false;
    }
    return true;
  });

  // Build a human-readable event summary for the LLM (no selectors — just intent)
  // Use the recorded elementText as-is (cleaned by the browser recorder) and include field labels for fill
  const eventSummary = filteredEvents.map((e, i) => {
    switch (e.type) {
      case 'navigate': return `${i + 1}. Started at ${e.url}`;
      case 'click': {
        const text = (e.elementText || 'an element').trim();
        return `${i + 1}. Clicked "${text}"`;
      }
      case 'dblclick': {
        const text = (e.elementText || 'an element').trim();
        return `${i + 1}. Double-clicked "${text}"`;
      }
      case 'fill': {
        const fieldName = (e.placeholder || e.elementText || 'a text field').trim();
        return `${i + 1}. Typed "${(e.value || '').substring(0, 80)}" into the "${fieldName}" field`;
      }
      case 'paste': return `${i + 1}. Pasted text into the "${(e.placeholder || e.elementText || 'a field').trim()}" field`;
      case 'select': return `${i + 1}. Selected "${e.value || ''}" from the "${(e.elementText || 'dropdown').trim()}" dropdown`;
      case 'check': return `${i + 1}. ${e.checked ? 'Checked' : 'Unchecked'} "${e.label || 'a checkbox'}"`;
      case 'submit': return `${i + 1}. Submitted a form`;
      case 'keycombo': return `${i + 1}. Pressed ${e.key || 'Enter'}${e.ctrl ? ' + Ctrl/Meta' : ''}`;
      default: return null;
    }
  }).filter(Boolean).join('\n');

  const trainTask = session.trainTask || action?.description || '';

  const prompt = `You are writing STEP-BY-STEP INSTRUCTIONS for an AI agent that will perform this task on the same website.

The user recorded themselves performing the task once. Here is what they did (each "Clicked" line uses the exact text of the element that was clicked):
${eventSummary}

${trainTask ? `The task was: "${trainTask}"\n` : ''}Write instructions the agent can follow. The agent will start at the startUrl and read the live DOM. Every "Click" step MUST use text that actually exists on the page or in a dropdown/modal — the agent matches by exact or partial element text.

CRITICAL RULES:
1. Use the EXACT text of the element that was clicked. Do NOT invent vague descriptions like "the playlist you wish to edit" or "the playlist title" or "the field". If the event says Clicked "Church Music", write "Click "Church Music"". If it says Clicked "Edit details", write "Click "Edit details"".
2. ONLY the startUrl is a literal URL. Do NOT include any other "Navigate to" steps — if a click causes a page change, the agent will follow it automatically. Never hardcode dynamic URLs like /playlist/<id> from the recording.
3. If the recording starts already on a page (e.g. already on a specific playlist page), the first step is the first click recorded on that page — NOT a step about selecting the playlist or navigating there again.
4. Replace any value the user would change each time (names, titles, messages, search queries) with a {{param_name}} placeholder. Add each to the params array with a description and example.
5. Keep static values (button labels, fixed menu items, playlist names, headings) as-is — do NOT parameterize them.
6. KEEP IT SHORT — only the essential steps. A typical skill is 3-5 steps, NOT 7+.
7. Drop duplicate actions (e.g. clicking "Edit details" twice is a recording artifact).
8. Drop optional cosmetic steps (e.g. "Choose photo") unless they are the core task.
9. MERGE multiple fills on the same field into a single "Type" step with the final value.
10. Do NOT merge sequential clicks that open menus/dialogs. If the user clicked "Create" then clicked "Create a playlist" from the dropdown, keep BOTH as separate steps.
11. Use EXACTLY these action formats (one action per sentence, separated by ". "):
    - Click the "X" button
    - Click "X"
    - Type "{{param_name}}" into the "Field Name" field
    - Type "{{param_name}}" into the "Name" field (use the real field label from the recording)
    - Select "value" from the "Dropdown" dropdown
    - Press Enter
    - Check "X"
    - Submit the form
12. If the recording contains multiple unrelated actions, return rejected: true.

GOOD example: "Click the "Create" button. Click "Create a <some-item>". Click "Name & details". Type "{{item_name}}" into the "Name" field. Click "Save"."
GOOD example: "Click "Church Music". Click "Edit details". Type "{{item_name}}" into the "Name" field. Click "Save"."
BAD example: "Click the <some-item> you wish to edit. Click the <some-item> title to open the edit details dialog. Type "{{item_name}}" into the text field. Click "Save"."
BAD example: "Go to https://<some-site>.com/ and create a new <some-item> with the name {{item_name}}." — this is a single GOAL sentence, NOT step-by-step actions. Do NOT write goal sentences. Each sentence must be ONE concrete action (Click, Type, Select, Press).

Output ONLY valid JSON:
{
  "name": "${skillName}",
  "description": "<one sentence describing what this skill does>",
  "params": [{ "name": "param_name", "type": "string", "required": true, "description": "...", "example": "..." }],
  "instructions": "<concrete step-by-step actions with {{param}} placeholders, one action per sentence>",
  "startUrl": "<initial URL where the agent should start>",
  "rejected": false
}

If the recording is too chaotic or contains multiple unrelated actions:
{ "rejected": true, "reason": "This recording contains multiple actions. Please record one action at a time." }`;

  try {
    logger.info(`[trainer.agent] _buildInstructionSkill: calling LLM for ${segmentEvents.length} events, skillName="${skillName}"`);
    const response = await askWithMessages([
      { role: 'system', content: 'You convert browser recordings into clear instructions for AI agents. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 1000, temperature: 0.2, responseTimeoutMs: 20000 });

    if (session.cancelRequested) {
      return { rejected: true, reason: 'Cancelled by user' };
    }

    let json = (response || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    let parsed = JSON.parse(json);

    if (parsed.rejected) {
      return { rejected: true, reason: parsed.reason || 'Could not understand the recording' };
    }

    // ── Coerce instructions to string ──
    // The LLM sometimes returns instructions as an array of steps or an object
    // instead of a single string. Coerce to string so parseInstructions doesn't
    // throw with "instructions.split is not a function".
    if (parsed.instructions !== null && typeof parsed.instructions !== 'string') {
      if (Array.isArray(parsed.instructions)) {
        parsed.instructions = parsed.instructions.join('. ');
        logger.info(`[trainer.agent] _buildInstructionSkill: coerced instructions array to string (${parsed.instructions.length} chars)`);
      } else if (typeof parsed.instructions === 'object' && parsed.instructions.steps && Array.isArray(parsed.instructions.steps)) {
        parsed.instructions = parsed.instructions.steps.join('. ');
        logger.info(`[trainer.agent] _buildInstructionSkill: coerced instructions.steps array to string (${parsed.instructions.length} chars)`);
      } else if (typeof parsed.instructions === 'object' && parsed.instructions.text) {
        parsed.instructions = String(parsed.instructions.text);
        logger.info(`[trainer.agent] _buildInstructionSkill: coerced instructions.text to string (${parsed.instructions.length} chars)`);
      } else {
        logger.warn(`[trainer.agent] _buildInstructionSkill: instructions was ${typeof parsed.instructions}, JSON-stringifying`);
        parsed.instructions = JSON.stringify(parsed.instructions);
      }
    }

    // ── Validation: check that parseInstructions can parse the instructions ──
    // If the LLM produced a high-level goal sentence instead of step-by-step
    // actions, retry once with a stricter prompt.
    let { parseInstructions } = require('./instruction.runner.cjs');
    let parsedSteps = parseInstructions(parsed.instructions || '');
    if (parsedSteps.length === 0 && !session.cancelRequested) {
      logger.warn(`[trainer.agent] _buildInstructionSkill: LLM produced unparseable instructions: "${(parsed.instructions || '').substring(0, 120)}" — retrying with stricter prompt`);
      const retryResponse = await askWithMessages([
        { role: 'system', content: 'You convert browser recordings into clear instructions for AI agents. Output ONLY valid JSON.' },
        { role: 'user', content: `Your previous response was NOT step-by-step actions. It was a single goal sentence that cannot be parsed.

BAD (what you wrote): "${parsed.instructions}"
BAD pattern: "Go to https://... and create a new <some-item> with the name {{item_name}}." — this is ONE goal sentence, NOT steps.

You MUST write CONCRETE step-by-step actions, one action per sentence, separated by ". ".

${prompt}` },
      ], { maxTokens: 1000, temperature: 0.1, responseTimeoutMs: 20000 });

      if (!session.cancelRequested) {
        json = (retryResponse || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
        parsed = JSON.parse(json);
        if (parsed.rejected) {
          return { rejected: true, reason: parsed.reason || 'Could not understand the recording' };
        }
        parsedSteps = parseInstructions(parsed.instructions || '');
        if (parsedSteps.length === 0) {
          logger.warn(`[trainer.agent] _buildInstructionSkill: retry still unparseable: "${(parsed.instructions || '').substring(0, 120)}" — using fallback`);
        } else {
          logger.info(`[trainer.agent] _buildInstructionSkill: retry succeeded — ${parsedSteps.length} steps parsed`);
        }
      }
    } else {
      logger.info(`[trainer.agent] _buildInstructionSkill: validated — ${parsedSteps.length} steps parsed from instructions`);
    }

    // Ensure required fields
    const result = {
      id: `skill_${eventStart}_${eventEnd}`,
      name: skillName,
      description: parsed.description || action?.description || skillName,
      eventStart,
      eventEnd,
      instructions: parsed.instructions || '',
      params: parsed.params || [],
      startUrl: parsed.startUrl || session.startUrl,
      execType: 'agent',
    };

    logger.info(`[trainer.agent] _buildInstructionSkill: generated ${result.instructions.length} chars of instructions, ${result.params.length} params`);
    return result;
  } catch (e) {
    logger.warn(`[trainer.agent] _buildInstructionSkill LLM failed: ${e.message} — falling back to heuristic instructions`);
    // Fallback: build simple instructions from events
    return _buildInstructionFallback(session, segmentEvents, eventStart, eventEnd, skillName, action);
  }
}

// Two-tier generic field label detection (shared logic with instruction.runner.cjs).
// Returns true if the label is too generic to help locate the field.
// Tier 1: unambiguously generic words (articles, fillers, generic nouns)
// Tier 2a: borderline verbs (always generic — they don't name a field)
// Tier 2b: borderline nouns (preserved if ≥5 chars — they might name a field)
// Rule: null only if ALL words are Tier 1, OR ALL words are Tier 1+2 AND no Tier 2b noun is ≥5 chars.
const _GENERIC_TIER1 = new Set([
  'the', 'a', 'an', 'your', 'our', 'my', 'here', 'there', 'please',
  'something', 'anything', 'text', 'field', 'input', 'box', 'area', 'placeholder',
]);
const _GENERIC_TIER2_VERBS = new Set([
  'enter', 'type', 'add', 'put', 'write', 'edit',
]);
const _GENERIC_TIER2_NOUNS = new Set([
  'new', 'default', 'empty', 'blank', 'value', 'content', 'data', 'form', 'string',
]);
function _isGenericFieldLabel(label) {
  if (!label) return true;
  const words = label.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;
  const allTier1 = words.every(w => _GENERIC_TIER1.has(w));
  if (allTier1) return true;
  const allGeneric = words.every(w =>
    _GENERIC_TIER1.has(w) || _GENERIC_TIER2_VERBS.has(w) || _GENERIC_TIER2_NOUNS.has(w)
  );
  if (allGeneric) {
    const hasLongNoun = words.some(w => _GENERIC_TIER2_NOUNS.has(w) && w.length >= 5);
    return !hasLongNoun;
  }
  return false;
}

// Heuristic fallback: build instructions from events without LLM
function _buildInstructionFallback(session, events, eventStart, eventEnd, skillName, action) {
  // Clean noise from the recording first
  const cleanedEvents = _cleanEventsForInstruction(events);
  const steps = [];
  const params = [];
  const usedParamNames = new Set();

  let navigateCount = 0;
  for (const evt of cleanedEvents) {
    if (evt.type === 'navigate') {
      navigateCount++;
      // Only the first navigate is the start URL; intermediate navigations are
      // caused by clicks and the agent will follow them automatically.
      if (navigateCount === 1) steps.push(`Navigate to ${evt.url}`);
      continue;
    } else if (evt.type === 'click' && evt.elementText) {
      steps.push(`Click the "${evt.elementText}" button`);
    } else if (evt.type === 'dblclick') {
      steps.push(`Double-click "${evt.elementText || 'the element'}"`);
    } else if (evt.type === 'fill') {
      const val = evt.value || '';
      // Derive a field label from placeholder, elementText, or aria-label — not generic "text field"
      const placeholder = evt.placeholder || evt.altSelectors?.find(s => s.includes('placeholder='))?.match(/placeholder="([^"]+)"/)?.[1] || '';
      const fieldLabel = placeholder || evt.elementText || '';
      // Use two-tier generic detection to decide if label is too generic to be useful
      const isGenericLabel = _isGenericFieldLabel(fieldLabel);
      const labelClause = isGenericLabel ? '' : ` the "${fieldLabel}" field`;
      if (isGenericLabel && fieldLabel) {
        logger.info(`[trainer.agent] _buildInstructionFallback: generic field label "${fieldLabel}" — omitting from instruction`);
      }
      // Treat as param if non-static
      const isStatic = /^https?:\/\//i.test(val) || /^[\w.+-]+@[\w-]+\.\w+$/.test(val) || /^\d+$/.test(val) || val.length < 3;
      if (isStatic) {
        steps.push(`Type "${val}" into${labelClause || ' the text field'}`);
      } else {
        let paramName = 'value';
        if (placeholder) paramName = placeholder.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        let baseName = paramName, suffix = 1;
        while (usedParamNames.has(paramName)) paramName = `${baseName}_${suffix++}`;
        usedParamNames.add(paramName);
        params.push({ name: paramName, type: 'string', required: true, description: paramName.replace(/_/g, ' '), example: val.substring(0, 50) });
        steps.push(`Type "{{${paramName}}}" into${labelClause || ' the text field'}`);
      }
    } else if (evt.type === 'paste') {
      const placeholder = evt.placeholder || evt.altSelectors?.find(s => s.includes('placeholder='))?.match(/placeholder="([^"]+)"/)?.[1] || '';
      const fieldLabel = placeholder || evt.elementText || '';
      const isGenericLabel = _isGenericFieldLabel(fieldLabel);
      if (isGenericLabel && fieldLabel) {
        logger.info(`[trainer.agent] _buildInstructionFallback: generic field label "${fieldLabel}" — omitting from paste instruction`);
      }
      steps.push(`Paste text into${isGenericLabel ? ' the field' : ` the "${fieldLabel}" field`}`);
    } else if (evt.type === 'select') {
      steps.push(`Select "${evt.value || ''}" from the dropdown`);
    } else if (evt.type === 'check') {
      steps.push(`${evt.checked ? 'Check' : 'Uncheck'} the "${evt.label || 'checkbox'}"`);
    } else if (evt.type === 'submit') {
      steps.push('Submit the form');
    } else if (evt.type === 'keycombo') {
      steps.push(`Press ${evt.key || 'Enter'}`);
    }
  }

  const lastNav = cleanedEvents.filter(e => e.type === 'navigate').pop();
  return {
    id: `skill_${eventStart}_${eventEnd}`,
    name: skillName,
    description: action?.description || skillName,
    eventStart,
    eventEnd,
    instructions: steps.join('. ') + '.',
    params,
    startUrl: lastNav?.url || session.startUrl,
    execType: 'agent',
  };
}

// Build a skill preview from a segment of events (legacy waypoint format — kept for backward compat)
async function _buildSkillPreview(session, events, eventStart, eventEnd, skillName, action) {
  const segmentEvents = events.map(e => ({ ...e }));

  // Apply LLM-detected param mappings (if the LLM provided them in the action)
  if (action?.paramMappings && Array.isArray(action.paramMappings)) {
    for (const mapping of action.paramMappings) {
      // eventIndex is relative to the full collapsed array; convert to segment-local index
      const localIdx = mapping.eventIndex - eventStart;
      const evt = segmentEvents[localIdx];
      if (evt && (evt.type === 'fill' || evt.type === 'paste')) {
        evt._paramRef = mapping.paramName;
        evt._originalValue = mapping.originalValue || '';
        if (evt.type === 'fill') evt.value = `{{${mapping.paramName}}}`;
        else evt.text = `{{${mapping.paramName}}}`;
      }
    }
  }

  // Use LLM-detected params if available, otherwise fall back to heuristic
  const detectedParams = action?.params || _detectParamsFallback(segmentEvents, session);

  // Build waypoints from segment events (reuse fallback recipe builder logic)
  const waypoints = [];
  let step = 0;
  const seenUrls = new Set();

  for (const evt of segmentEvents) {
    if (evt.type === 'navigate' && !seenUrls.has(evt.url)) {
      seenUrls.add(evt.url);
      step++;
      waypoints.push({ step, type: 'navigate', intent: `Navigate to ${evt.url}`, url: evt.url, pageTitle: evt.pageTitle || '', checkpoint: `Page loaded: ${evt.pageTitle || evt.url}` });
    } else if (evt.type === 'click' && evt.elementText) {
      step++;
      const intent = evt._expectedResult
        ? `Click the "${evt.elementText}" ${evt.elementTag || 'element'} to trigger navigation (expect: ${evt._expectedResult.pattern})`
        : `Click the "${evt.elementText}" ${evt.elementTag || 'element'}`;
      const wp = { step, type: 'click', intent, selector: evt.selector, altSelectors: evt.altSelectors || [], elementText: evt.elementText, href: evt.href || '' };
      if (evt._expectedResult) wp.expectedResult = evt._expectedResult;
      waypoints.push(wp);
    } else if (evt.type === 'dblclick') {
      step++;
      const intent = `Double-click the "${evt.elementText || 'element'}" ${evt.elementTag || 'element'}`;
      const wp = { step, type: 'dblclick', intent, selector: evt.selector, altSelectors: evt.altSelectors || [], elementText: evt.elementText || '' };
      if (evt._expectedResult) wp.expectedResult = evt._expectedResult;
      waypoints.push(wp);
    } else if (evt.type === 'fill') {
      step++;
      const fillText = evt.value || '';
      const intent = `Type "${fillText.substring(0, 50)}" into the "${(evt.elementText || evt.selector || '').substring(0, 40)}" field`;
      waypoints.push({ step, type: 'fill', intent, selector: evt.selector, altSelectors: evt.altSelectors || [], value: evt.value || '', paramRef: evt._paramRef || undefined, originalValue: evt._originalValue || undefined });
    } else if (evt.type === 'paste') {
      step++;
      const intent = `Paste text into the "${(evt.elementText || evt.selector || '').substring(0, 40)}" field`;
      waypoints.push({ step, type: 'paste', intent, selector: evt.selector, altSelectors: evt.altSelectors || [], text: evt.text || '', paramRef: evt._paramRef || undefined, originalValue: evt._originalValue || undefined });
    } else if (evt.type === 'select') {
      step++;
      const intent = `Select "${evt.value || ''}" from the dropdown`;
      waypoints.push({ step, type: 'select', intent, selector: evt.selector, value: evt.value || '', paramRef: evt._paramRef || undefined });
    } else if (evt.type === 'check') {
      step++;
      const intent = `Check the "${evt.label || 'checkbox'}" ${evt.inputType || 'checkbox'}`;
      waypoints.push({ step, type: 'check', intent, selector: evt.selector, label: evt.label || '', checked: evt.checked });
    } else if (evt.type === 'submit') {
      step++;
      waypoints.push({ step, type: 'submit', intent: 'Submit the form', selector: evt.selector });
    } else if (evt.type === 'keycombo') {
      step++;
      const intent = `Press ${evt.key || 'Enter'}${evt.ctrl ? ' + Ctrl/Meta' : ''}${evt.shift ? ' + Shift' : ''}`;
      waypoints.push({ step, type: 'keycombo', intent, key: evt.key || 'Enter', ctrl: evt.ctrl || false, shift: evt.shift || false, alt: evt.alt || false, selector: evt.selector || '' });
    }
    // NOTE: hover/focus are intentionally NOT emitted as waypoints — they are
    // not meaningful recipe steps. The subsequent click/fill is what matters.
  }

  // ── Dedupe pass: merge consecutive same-type/same-selector waypoints ──────
  // This removes duplicate clicks (e.g. clicking a modal twice) within a 500ms window
  const deduped = [];
  for (const wp of waypoints) {
    const prev = deduped[deduped.length - 1];
    if (prev &&
        prev.type === wp.type &&
        prev.selector === wp.selector &&
        (prev.elementText || '') === (wp.elementText || '') &&
        !prev.expectedResult && !wp.expectedResult) {
      // Skip duplicate — keep the first one
      continue;
    }
    deduped.push(wp);
  }
  // Re-number steps after dedupe
  for (let i = 0; i < deduped.length; i++) {
    deduped[i].step = i + 1;
  }

  const lastNav = segmentEvents.filter(e => e.type === 'navigate').pop();

  return {
    id: `skill_${eventStart}_${eventEnd}`,
    name: skillName,
    description: action?.description || skillName,
    eventStart,
    eventEnd,
    waypoints: deduped,
    params: detectedParams,
    startUrl: session.startUrl,
    targetUrl: lastNav?.url || session.startUrl,
    targetDescription: action?.description || `Target: ${lastNav?.url || session.startUrl}`,
  };
}

// ---------------------------------------------------------------------------
// Save skills + recipe from user-adjusted review data
// ---------------------------------------------------------------------------
async function actionSaveSkillsAndRecipe(args) {
  let { agentId, skills, recipe } = args || {};
  if (agentId) agentId = agentId.toLowerCase();
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!Array.isArray(skills) || skills.length === 0) return { ok: false, error: 'skills array is required' };

  // Validate skill names end with .skill, recipe name ends with .recipe
  for (const s of skills) {
    if (s.name && !s.name.endsWith('.skill')) {
      return { ok: false, error: `Skill name "${s.name}" must end with .skill` };
    }
  }
  if (recipe && recipe.name && !recipe.name.endsWith('.recipe')) {
    return { ok: false, error: `Recipe name "${recipe.name}" must end with .recipe` };
  }

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };

  _postProgress(agentId, { type: 'training:saving', message: `Saving ${skills.length} skill(s)…` });

  try {
    const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

    const savedSkills = [];
    for (const skill of skills) {
      // Build the skill JSON from the preview data
      const skillJson = {
        name: skill.name,
        agentId: _skillDirId(agentId),
        startUrl: skill.startUrl || session.startUrl,
        targetUrl: skill.targetUrl || skill.startUrl || session.startUrl,
        params: skill.params || [],
        // Instruction-based skills (new format) — execType: "agent" + instructions
        execType: skill.execType || 'agent',
        instructions: skill.instructions || '',
        // Deterministic keyboard path (discovered during preview run) — enables
        // fast subsequent runs without re-discovering Tab/Arrow counts.
        keyPath: skill.keyPath || null,
        // Waypoint-based skills (legacy format) — kept for backward compat
        waypoints: skill.waypoints || [],
        targetDescription: skill.description || skill.targetDescription || '',
        created: new Date().toISOString(),
        userConfirmed: true,
        urlFirst: true,
      };

      const skillPath = path.join(skillDir, _skillFileName(skill.name));
      fs.writeFileSync(skillPath, JSON.stringify(skillJson, null, 2), 'utf8');
      _registerSkillInAgent(agentId, skill.name, skillJson);
      savedSkills.push({ name: skill.name, path: skillPath });
      logger.info(`[trainer.agent] Saved skill: ${skillPath}`);
    }

    let savedRecipe = null;
    if (recipe && recipe.skills && recipe.skills.length > 0) {
      const recipeJson = {
        name: recipe.name,
        agentId: _skillDirId(agentId),
        skills: recipe.skills,
        params: recipe.params || [],
        paramFlow: recipe.paramFlow || {},
        created: new Date().toISOString(),
        userConfirmed: true,
      };
      const recipePath = path.join(skillDir, `${recipe.name}.recipe.json`);
      fs.writeFileSync(recipePath, JSON.stringify(recipeJson, null, 2), 'utf8');
      _registerSkillInAgent(agentId, recipe.name, recipeJson);
      savedRecipe = { name: recipe.name, path: recipePath };
      logger.info(`[trainer.agent] Saved recipe: ${recipePath}`);
    }

    // Clean up session
    if (session.httpServer) {
      session.httpServer.close(() => {
        logger.info(`[trainer.agent] Event HTTP server closed after save (port ${session.httpPort})`);
      });
    }
    if (session.ownsSession !== false) {
      const { browserAct } = require('./browser.act.cjs');
      browserAct({ action: 'close', sessionId: session.sessionId }).catch(() => {});
    }
    activeSessions.delete(agentId);

    _postProgress(agentId, {
      type: 'training:saved',
      skillName: savedSkills[0]?.name,
      recipePath: savedRecipe?.path,
      waypointCount: savedSkills.reduce((sum, s) => sum + (s.waypoints?.length || 0), 0),
      message: `Saved ${savedSkills.length} skill(s)${savedRecipe ? ` + recipe` : ''}.`,
    });

    return { ok: true, savedSkills, savedRecipe };
  } catch (err) {
    logger.error(`[trainer.agent] Save skills+recipe failed: ${err.message}`);
    _postProgress(agentId, { type: 'training:error', message: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// URL-first collapse: keep only the final action page's navigation.
//
// Model:
//   nav A → click → click → nav B → click → nav C → click → fill → click
//                    (noise)            (noise)
//
//   Stable URL at C (e.g. /settings):
//     Skill = [navigate C] + [interactions on C]
//
//   Dynamic ID at C (e.g. /playlist/<ID>):
//     Skill = [trigger click "Create Playlist" with expectedResult: url_pattern /playlist/*]
//             + [interactions on C]
//     (the navigate is a RESULT of the click, not a step — verified not hardcoded)
//
//   No navigation (all on one page):
//     Skill = [interactions only] (runtime uses startUrl)
// ---------------------------------------------------------------------------
function _collapseNavigation(events) {
  if (!events || events.length === 0) return events;

  const INTERACTION_TYPES = ['click', 'dblclick', 'fill', 'select', 'check', 'submit',
    'paste', 'keycombo', 'drag', 'rightclick', 'extract'];
  const NAV_TYPES = ['navigate', 'tab-new'];

  // Check if a URL path contains a dynamic ID segment
  // Examples: /playlist/0SfpMOvydhMMG4w5xeZJ1X, /post/123456, /items/abc123def456
  function hasDynamicId(url) {
    try {
      const u = new URL(url);
      const segments = u.pathname.split('/').filter(Boolean);
      for (const seg of segments) {
        // Hex-like (8+ chars), base62 (15+ chars), or pure digits (5+ chars)
        if (/^[0-9a-fA-F]{8,}$/.test(seg)) return true;
        if (/^[A-Za-z0-9_-]{15,}$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg)) return true;
        if (/^\d{5,}$/.test(seg)) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  // Convert a dynamic URL to a pattern (replace ID segments with *)
  // /playlist/0SfpMOvydhMMG4w5xeZJ1X → /playlist/*
  function urlToPattern(url) {
    try {
      const u = new URL(url);
      const segments = u.pathname.split('/');
      const patternSegments = segments.map(seg => {
        if (!seg) return seg;
        if (/^[0-9a-fA-F]{8,}$/.test(seg)) return '*';
        if (/^[A-Za-z0-9_-]{15,}$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg)) return '*';
        if (/^\d{5,}$/.test(seg)) return '*';
        return seg;
      });
      return patternSegments.join('/');
    } catch (_) { return url; }
  }

  // Split events into page segments: each segment = [nav event] + [interactions until next nav]
  // The first segment may not have a nav event (if recording starts on a page)
  const segments = [];
  let currentSeg = { navEvent: null, interactions: [] };

  for (const evt of events) {
    if (NAV_TYPES.includes(evt.type)) {
      // Start a new segment
      if (currentSeg.navEvent || currentSeg.interactions.length > 0) {
        segments.push(currentSeg);
      }
      currentSeg = { navEvent: evt, interactions: [] };
    } else if (evt.type === 'click' && evt.href && /^https?:\/\//i.test(evt.href)) {
      // Nav-click (click with http(s) href) — treat as navigation
      if (currentSeg.navEvent || currentSeg.interactions.length > 0) {
        segments.push(currentSeg);
      }
      currentSeg = { navEvent: { type: 'navigate', url: evt.href, pageTitle: evt.elementText || '', timestamp: evt.timestamp, _fromClick: true }, interactions: [] };
    } else if (INTERACTION_TYPES.includes(evt.type)) {
      currentSeg.interactions.push(evt);
    }
    // Skip hover/focus/scroll — they're noise
  }
  if (currentSeg.navEvent || currentSeg.interactions.length > 0) {
    segments.push(currentSeg);
  }

  // Find the last segment with meaningful interactions
  let lastActionSegIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].interactions.length > 0) {
      lastActionSegIdx = i;
      break;
    }
  }

  // No interactions at all — return as-is (pure navigation)
  if (lastActionSegIdx === -1) return events;

  const lastSeg = segments[lastActionSegIdx];
  const finalUrl = lastSeg.navEvent?.url || null;
  const finalTitle = lastSeg.navEvent?.pageTitle || '';

  // Case 1: No navigation event for the last action segment — interactions only
  if (!finalUrl) {
    logger.info(`[trainer.agent] _collapseNavigation: no nav for last action segment — keeping ${lastSeg.interactions.length} interactions only`);
    return lastSeg.interactions;
  }

  // Case 2: Final URL is stable (no dynamic ID) — navigate + interactions
  if (!hasDynamicId(finalUrl)) {
    const collapsed = [
      {
        type: 'navigate',
        url: finalUrl,
        pageTitle: finalTitle,
        timestamp: lastSeg.navEvent.timestamp,
        _collapsed: true,
      },
      ...lastSeg.interactions,
    ];
    logger.info(`[trainer.agent] _collapseNavigation: stable URL — navigate to ${finalUrl} + ${lastSeg.interactions.length} interactions (dropped ${events.length - collapsed.length} noise events)`);
    return collapsed;
  }

  // Case 3: Final URL has a dynamic ID — find the trigger click in the previous segment
  // The trigger click is the last click before the navigation that led to the dynamic URL
  const pattern = urlToPattern(finalUrl);
  let triggerClick = null;

  if (lastActionSegIdx > 0) {
    const prevSeg = segments[lastActionSegIdx - 1];
    // Find the last click in the previous segment (the one that triggered the navigation)
    for (let i = prevSeg.interactions.length - 1; i >= 0; i--) {
      const evt = prevSeg.interactions[i];
      if (evt.type === 'click' || evt.type === 'dblclick') {
        triggerClick = evt;
        break;
      }
    }
  }

  if (triggerClick) {
    // Mark the trigger click with expectedResult for runtime verification
    const triggerWithExpect = {
      ...triggerClick,
      _expectedResult: { type: 'url_pattern', pattern },
    };
    const collapsed = [
      triggerWithExpect,
      ...lastSeg.interactions,
    ];
    logger.info(`[trainer.agent] _collapseNavigation: dynamic URL ${finalUrl} → keeping trigger click "${triggerClick.elementText || triggerClick.selector}" with expectedResult pattern ${pattern} + ${lastSeg.interactions.length} interactions (dropped ${events.length - collapsed.length} noise events)`);
    return collapsed;
  }

  // Fallback: no trigger click found — use navigate with the pattern (not the raw URL)
  // This is less ideal but better than hardcoding the specific ID
  const collapsed = [
    {
      type: 'navigate',
      url: finalUrl.replace(/\/[0-9a-fA-F]{8,}([/?]|$)/, '/*$1').replace(/\/[A-Za-z0-9_-]{15,}([/?]|$)/, '/*$1').replace(/\/\d{5,}([/?]|$)/, '/*$1'),
      pageTitle: finalTitle,
      timestamp: lastSeg.navEvent.timestamp,
      _collapsed: true,
      _dynamicUrl: true,
    },
    ...lastSeg.interactions,
  ];
  logger.info(`[trainer.agent] _collapseNavigation: dynamic URL with no trigger click — navigate pattern + ${lastSeg.interactions.length} interactions`);
  return collapsed;
}

// ---------------------------------------------------------------------------
// Build waypoint recipe from raw events using LLM
// ---------------------------------------------------------------------------
async function _buildRecipe(session, skillName) {
  const { agentId, hostname, startUrl, rawEvents } = session;

  // ── URL-first collapse ──────────────────────────────────────────────────────
  // Collapse all intermediate navigation (navigate events, nav clicks) into a
  // SINGLE navigate waypoint to the final destination URL before the first real
  // interaction (click/fill/check/etc). This makes the recipe deterministic —
  // next run goes straight to the target page instead of replaying brittle
  // intermediate navigation selectors.
  const collapsedEvents = _collapseNavigation(rawEvents);

  // Format events for LLM
  const eventSummary = collapsedEvents.map((e, i) => {
    switch (e.type) {
      case 'navigate': return `${i + 1}. [NAV] ${e.url} (title: "${e.pageTitle || ''}")`;
      case 'click': return `${i + 1}. [CLICK] "${e.elementText || ''}" selector: ${e.selector}${e.href ? ` href: ${e.href}` : ''}`;
      case 'dblclick': return `${i + 1}. [DBLCLICK] "${e.elementText || ''}" selector: ${e.selector}`;
      case 'rightclick': return `${i + 1}. [RIGHTCLICK] selector: ${e.selector}`;
      case 'check': return `${i + 1}. [CHECK] "${e.label || ''}" selector: ${e.selector} → ${e.checked ? 'checked' : 'unchecked'}`;
      case 'drag': return `${i + 1}. [DRAG] from ${e.fromSelector} (${e.fromX},${e.fromY}) → (${e.toX},${e.toY}) dist: ${e.distance}px`;
      case 'scroll': return `${i + 1}. [SCROLL] dy: ${e.deltaY}px${e.selector ? ` on ${e.selector}` : ''} (now at ${e.scrollY})`;
      case 'fill': return `${i + 1}. [FILL] ${e.selector} value: "${(e.value || '').substring(0, 120)}"`;
      case 'select': return `${i + 1}. [SELECT] ${e.selector} value: "${e.value || ''}"`;
      case 'submit': return `${i + 1}. [SUBMIT] ${e.selector}`;
      case 'paste': return `${i + 1}. [PASTE] ${e.selector} text: "${(e.text || '').substring(0, 80)}"`;
      case 'keycombo': { const c = [e.ctrl?'Ctrl':'',e.shift?'Shift':'',e.alt?'Alt':'',e.key].filter(Boolean).join('+'); return `${i + 1}. [KEYCOMBO] ${c} on ${e.selector}`; }
      case 'focus': return `${i + 1}. [FOCUS] ${e.selector} (Tab navigation)`;
      case 'hover': return `${i + 1}. [HOVER] ${e.selector}`;
      case 'back': return `${i + 1}. [BACK] from: ${e.fromUrl} → ${e.url}`;
      case 'forward': return `${i + 1}. [FORWARD] → ${e.url}`;
      case 'tab-new': return `${i + 1}. [TAB-NEW] url: ${e.url || ''}`;
      case 'extract': return `${i + 1}. [EXTRACT] "${e.extractName}" from ${e.selector} (type: ${e.extractType || 'text'})`;
      default: return `${i + 1}. [${e.type.toUpperCase()}] ${e.selector || e.url || ''}`;
    }
  }).join('\n');

  const prompt = `You are processing raw browser interaction events into a minimal waypoint recipe for browser automation.

AGENT: ${agentId}
START URL: ${startUrl}
SKILL NAME: ${skillName}
${session.trainTask ? `ORIGINAL TASK: ${session.trainTask}` : ''}

RAW EVENTS (in order):
${eventSummary}

Create a MINIMAL waypoint recipe. Rules:
1. URL-FIRST: If a click has an href that is a full http(s) URL and opens a form/composer, replace the click chain (navigate + opening clicks) with a SINGLE navigate waypoint to that href URL. This makes the recipe deterministic — next run skips the brittle click selectors entirely.
2. Merge consecutive clicks that lead to the same page into a single navigate waypoint
3. Remove noise (duplicate navigations, insignificant clicks, hover events, focus events — these are NEVER waypoints)
4. Each waypoint should represent a meaningful navigation step
5. The LAST waypoint is the TARGET — where the user wants the AI to start working
6. Include the primary CSS selector AND alternative selectors for each click waypoint
7. Include URL checkpoints for navigation waypoints
8. EXTRACT waypoints capture data from the page - preserve them for WALT tool returns
9. For fill waypoints that contain task-specific text (email body, post text, etc.), set value to "" (empty) — the runtime will fill from the task. Only keep static values (e.g. a fixed subject line).
10. PARAMETER DETECTION: Analyze each fill/paste waypoint's value. Classify as:
    - TASK-SPECIFIC: The value is something the user would change each time (item name, search query, message body, form field value, post text). Replace with {{param_name}} and add paramRef: "param_name". Add the param to the params array.
    - STATIC: The value is a constant that never changes (a fixed subject line, a default selection, a label). Keep the literal value.
    Name params descriptively (snake_case): item_name, search_query, message_body, field_value.
    Use generic descriptions, not the literal recorded values.

WAYPOINT TYPE CATALOG (use only what the workflow needs):
- navigate: { step, type: "navigate", url, pageTitle?, checkpoint? }
- click: { step, type: "click", selector, altSelectors[], elementText?, href?, expectedResult? }
- dblclick: { step, type: "dblclick", selector, altSelectors[], elementText? }
- rightclick: { step, type: "rightclick", selector, altSelectors[] }
- fill: { step, type: "fill", selector, value, elementText? }
- paste: { step, type: "paste", selector, text }
- keycombo: { step, type: "keycombo", key, ctrl?, shift?, alt?, selector }
- select: { step, type: "select", selector, value }
- check: { step, type: "check", selector, label?, checked? }
- focus: { step, type: "focus", selector, altSelectors[] }
- hover: { step, type: "hover", selector, altSelectors[] }
- drag: { step, type: "drag", fromSelector, fromX, fromY, toX, toY, distance }
- scroll: { step, type: "scroll", deltaY, scrollY?, selector? }
- back: { step, type: "back" }
- forward: { step, type: "forward" }
- tab-new: { step, type: "tab-new", url? }
- submit: { step, type: "submit", selector }
- extract: { step, type: "extract", selector, extractName, extractType, description?, dataAttr?, attrName? }

EXTRACT TYPES (for extract waypoints):
- text: Element textContent
- href: Link URL
- value: Input value
- html: Outer HTML
- src: Image/video source URL
- data: data-* attribute (requires dataAttr field)
- attr: Any attribute by name (requires attrName field)
- json: Parse content as JSON
- table: Extract table as array of objects
- list: Extract list items as array

Map each RAW EVENT to the appropriate waypoint type from the catalog. Output ONLY valid JSON:
{
  "name": "${skillName}",
  "agentId": "${agentId}",
  "startUrl": "${startUrl}",
  "targetUrl": "<final URL>",
  "params": [<array of param specs: { "name": "param_name", "type": "string", "description": "...", "required": true, "example": "..." }>],
  "waypoints": [<array of waypoints, mix types as needed. Fill waypoints with task-specific values use "{{param_name}}" and paramRef: "param_name">],
  "returns": {<if extract waypoints: "extractName": { "type": "string", "description": "..." }>},
  "targetDescription": "<description>",
  "created": "${new Date().toISOString()}"
}`;

  const response = await askWithMessages([
    { role: 'system', content: 'You convert raw browser events into minimal waypoint recipes. Output ONLY valid JSON.' },
    { role: 'user', content: prompt },
  ], { maxTokens: 1500, temperature: 0.2 });

  // Parse response — strip markdown fences if present
  let json = (response || '').trim();
  json = json.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  try {
    const recipe = JSON.parse(json);
    // Ensure required fields
    recipe.name = skillName;
    recipe.agentId = agentId;
    recipe.startUrl = startUrl;
    recipe.created = recipe.created || new Date().toISOString();

    // ── Params validation ──────────────────────────────────────────────────
    // Ensure params array exists and is consistent with paramRef in waypoints
    if (!Array.isArray(recipe.params)) recipe.params = [];
    if (Array.isArray(recipe.waypoints)) {
      // Collect all paramRefs referenced in waypoints
      const referencedParams = new Set();
      for (const wp of recipe.waypoints) {
        if (wp.paramRef) referencedParams.add(wp.paramRef);
      }
      // Add any referenced param that's missing from params array
      for (const ref of referencedParams) {
        if (!recipe.params.find(p => p.name === ref)) {
          recipe.params.push({ name: ref, type: 'string', description: ref.replace(/_/g, ' '), required: true });
        }
      }
      // Remove params not referenced by any waypoint (unless they have a reason to exist)
      recipe.params = recipe.params.filter(p =>
        referencedParams.has(p.name) || !p.required
      );
    }

    // ── URL-first post-processing ──────────────────────────────────────────
    // Convert any click waypoint with a full http(s) href that precedes a form
    // step (fill/submit/press) into a navigate waypoint — deterministic deep-link
    // instead of a brittle selector click.
    if (Array.isArray(recipe.waypoints)) {
      recipe.waypoints = recipe.waypoints.map((w, i) => {
        if (w.type === 'click' && w.href && /^https?:\/\//i.test(w.href)) {
          const _next = recipe.waypoints[i + 1];
          if (_next && /fill|submit|press|check|select/i.test(_next.type)) {
            logger.info(`[trainer.agent] _buildRecipe: URL-first — converting click with href ${w.href} to navigate`);
            return { ...w, type: 'navigate', url: w.href, checkpoint: w.elementText || 'form page' };
          }
        }
        return w;
      });
    }

    return recipe;
  } catch (e) {
    // Fallback: build a simple recipe from raw events
    logger.warn(`[trainer.agent] LLM recipe parse failed, using fallback: ${e.message}`);
    return _buildFallbackRecipe(session, skillName);
  }
}

// ---------------------------------------------------------------------------
// Heuristic param detection (fallback when LLM is unavailable)
// Detects task-specific fill/paste values and converts them to {{param_name}}
// ---------------------------------------------------------------------------
function _deriveParamName(label, selector, existingCount) {
  // Try to extract from aria-label in altSelectors
  if (label) {
    const m = label.match(/aria-label="([^"]+)"/);
    if (m) {
      return m[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 30) || `param_${existingCount + 1}`;
    }
  }
  // Try placeholder
  if (label) {
    const m = label.match(/placeholder="([^"]+)"/);
    if (m) {
      return m[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 30) || `param_${existingCount + 1}`;
    }
  }
  // Try to extract from selector
  if (selector) {
    const m = selector.match(/\[name="([^"]+)"/);
    if (m) return m[1].toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const m2 = selector.match(/#([a-z][a-z0-9_-]+)/i);
    if (m2 && !/^(react|ember|__next|tab)-\d/i.test(m2[1])) return m2[1].toLowerCase().replace(/[^a-z0-9_]/g, '_');
  }
  return `param_${existingCount + 1}`;
}

function _detectParamsFallback(events, session) {
  const params = [];
  const taskText = (session.trainTask || '').toLowerCase();
  const usedNames = new Set();

  for (const evt of events) {
    if (evt.type !== 'fill' && evt.type !== 'paste') continue;
    const value = evt.value || evt.text || '';
    if (!value || value.length < 2) continue;

    // Static heuristics: URLs, emails, numbers-only, very short constants
    if (/^https?:\/\//i.test(value)) continue;
    if (/^[\w.+-]+@[\w-]+\.\w+$/.test(value)) continue;
    if (/^\d+$/.test(value)) continue;
    if (value.length < 3) continue;

    // Treat ALL non-static fill/paste values as task-specific params.
    // The old heuristic required the value to appear in the training task text,
    // but that fails when the user types an example value (e.g. "test ten")
    // that isn't mentioned in the task description ("Create a new playlist").
    // Better to over-parameterize than to hardcode user content.

    // Derive param name
    let paramName = _deriveParamName(
      evt.altSelectors?.find(s => s.includes('aria-label=') || s.includes('placeholder=')),
      evt.selector,
      params.length
    );
    // Ensure uniqueness
    let baseName = paramName;
    let suffix = 1;
    while (usedNames.has(paramName)) {
      paramName = `${baseName}_${suffix++}`;
    }
    usedNames.add(paramName);

    params.push({
      name: paramName,
      type: 'string',
      description: paramName.replace(/_/g, ' '),
      required: true,
      example: value.substring(0, 50),
    });
    evt._paramRef = paramName;
    evt._originalValue = value;
    if (evt.type === 'fill') evt.value = `{{${paramName}}}`;
    else evt.text = `{{${paramName}}}`;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Fallback recipe builder (no LLM needed)
// ---------------------------------------------------------------------------
function _buildFallbackRecipe(session, skillName) {
  const { agentId, startUrl, hostname, rawEvents } = session;

  // Apply URL-first collapse to raw events
  const collapsedEvents = _collapseNavigation(rawEvents);

  // Detect params heuristically (mutates fill/paste events to set {{param}})
  const detectedParams = _detectParamsFallback(collapsedEvents, session);

  // Build waypoints from collapsed events
  const waypoints = [];
  let step = 0;
  const seenUrls = new Set();
  const returns = {};

  for (const evt of collapsedEvents) {
    if (evt.type === 'navigate' && !seenUrls.has(evt.url)) {
      seenUrls.add(evt.url);
      step++;
      waypoints.push({
        step,
        type: 'navigate',
        url: evt.url,
        pageTitle: evt.pageTitle || '',
        checkpoint: `Page loaded: ${evt.pageTitle || evt.url}`,
      });
    } else if (evt.type === 'click' && evt.elementText) {
      step++;
      waypoints.push({
        step,
        type: 'click',
        selector: evt.selector,
        altSelectors: evt.altSelectors || [],
        elementText: evt.elementText,
        href: evt.href || '',
        expectedResult: `Navigate or interact with "${evt.elementText}"`,
      });
    } else if (evt.type === 'dblclick') {
      step++;
      waypoints.push({
        step, type: 'dblclick',
        selector: evt.selector, altSelectors: evt.altSelectors || [],
        elementText: evt.elementText || '',
      });
    } else if (evt.type === 'fill') {
      step++;
      waypoints.push({
        step, type: 'fill',
        selector: evt.selector, altSelectors: evt.altSelectors || [],
        value: evt.value || '',
        paramRef: evt._paramRef || undefined,
      });
    } else if (evt.type === 'paste') {
      step++;
      waypoints.push({
        step, type: 'paste',
        selector: evt.selector, altSelectors: evt.altSelectors || [],
        text: evt.text || '',
        paramRef: evt._paramRef || undefined,
      });
    } else if (evt.type === 'select') {
      step++;
      waypoints.push({
        step, type: 'select',
        selector: evt.selector, value: evt.value || '',
        paramRef: evt._paramRef || undefined,
      });
    } else if (evt.type === 'check') {
      step++;
      waypoints.push({
        step, type: 'check',
        selector: evt.selector, label: evt.label || '', checked: evt.checked,
      });
    } else if (evt.type === 'submit') {
      step++;
      waypoints.push({ step, type: 'submit', selector: evt.selector });
    } else if (evt.type === 'keycombo') {
      step++;
      waypoints.push({
        step, type: 'keycombo',
        key: evt.key || 'Enter',
        ctrl: evt.ctrl || false, shift: evt.shift || false, alt: evt.alt || false,
        selector: evt.selector || '',
      });
    } else if (evt.type === 'extract') {
      step++;
      waypoints.push({
        step, type: 'extract',
        selector: evt.selector, extractName: evt.extractName,
        extractType: evt.extractType || 'text',
        description: `Extract ${evt.extractName} from page`,
      });
      returns[evt.extractName] = {
        type: 'string',
        description: `Extracted ${evt.extractName} from ${evt.selector}`,
      };
    }
  }

  const lastNav = collapsedEvents.filter(e => e.type === 'navigate').pop();

  return {
    name: skillName,
    agentId,
    startUrl,
    targetUrl: lastNav?.url || startUrl,
    params: detectedParams.length > 0 ? detectedParams : undefined,
    waypoints,
    returns: Object.keys(returns).length > 0 ? returns : undefined,
    targetDescription: `Target page: ${lastNav?.pageTitle || lastNav?.url || startUrl}`,
    created: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Auto-split multi-action events into separate action segments
// Uses LLM to detect action boundaries, with heuristic fallback
// ---------------------------------------------------------------------------
async function _autoSplitEvents(session, guidedPlan) {
  const { agentId, rawEvents, trainTask } = session;
  if (!rawEvents || rawEvents.length < 3) {
    return [{ name: 'default', description: trainTask || 'Recorded action', eventStart: 0, eventEnd: rawEvents?.length || 0, params: [] }];
  }

  // Pre-process: replace task-specific values with {{value}} for LLM
  const collapsed = _collapseNavigation(rawEvents);
  const eventsForLLM = collapsed.map(e => ({ ...e }));
  for (const evt of eventsForLLM) {
    if (evt.type === 'fill' || evt.type === 'paste') {
      const val = evt.value || evt.text || '';
      // Mark as parametric unless it's clearly static (URL, email, pure number, very short)
      if (val && val.length > 2 && !/^https?:\/\//i.test(val) && !/^[\w.+-]+@[\w-]+\.\w+$/.test(val) && !/^\d+$/.test(val)) {
        if (evt.type === 'fill') evt.value = '{{value}}';
        else evt.text = '{{value}}';
      }
    }
  }

  // Build event summary for LLM
  const eventSummary = eventsForLLM.map((e, i) => {
    switch (e.type) {
      case 'navigate': return `${i + 1}. [NAV] ${e.url}`;
      case 'click': return `${i + 1}. [CLICK] "${e.elementText || ''}" selector: ${e.selector}${e.href ? ` href: ${e.href}` : ''}`;
      case 'fill': return `${i + 1}. [FILL] ${e.selector} value: "${(e.value || '').substring(0, 80)}"`;
      case 'paste': return `${i + 1}. [PASTE] ${e.selector} text: "${(e.text || '').substring(0, 80)}"`;
      case 'submit': return `${i + 1}. [SUBMIT] ${e.selector}`;
      case 'check': return `${i + 1}. [CHECK] "${e.label || ''}" selector: ${e.selector}`;
      case 'select': return `${i + 1}. [SELECT] ${e.selector} value: "${e.value || ''}"`;
      case 'keycombo': return `${i + 1}. [KEYCOMBO] ${e.key} on ${e.selector}`;
      case 'dblclick': return `${i + 1}. [DBLCLICK] "${e.elementText || ''}" selector: ${e.selector}`;
      default: return `${i + 1}. [${e.type.toUpperCase()}] ${e.selector || e.url || ''}`;
    }
  }).join('\n');

  // Build guided plan context if available (guided training mode)
  let guidedContext = '';
  if (guidedPlan && Array.isArray(guidedPlan) && guidedPlan.length > 0) {
    const planLines = guidedPlan.map((s, i) =>
      `${i + 1}. ${s.description || s.step || `Step ${i + 1}`}${s.expectedType ? ` (expected: ${s.expectedType}${s.expectedText ? ` "${s.expectedText}"` : ''})` : ''}`
    ).join('\n');
    guidedContext = `\nGUIDED PLAN (the user was guided through these steps — use as HINTS for action boundaries and naming):\n${planLines}\n\nThe guided steps are HINTS, not rigid boundaries. Organize the raw events into a strategic path, using the guided steps as semantic context for where one action ends and the next begins.\n`;
  }

  const prompt = `Analyze this sequence of browser interaction events and identify ACTION BOUNDARIES.
An action boundary is where one logical task ends and another begins.

Signals for action boundaries:
- A form submit or "Save"/"Create"/"Done" button click followed by a navigation to a new page section
- A semantic shift from "creating" to "searching" or from "composing" to "sending"
- A significant pause (>3 seconds) followed by a new navigation

MULTI-ACTION DETECTION: If the recording shows meaningful interactions on MULTIPLE different
pages (not just navigation clicks, but fill/submit/create actions on different URLs), split
into separate skills — one per action page. Each skill should represent ONE logical action.
If the actions are too complex, unclear, or the user tried to record too many things at once,
return the rejected option with a helpful message like "This recording contains multiple
actions. Please record one action at a time for best results."

NOTE: {{value}} placeholders in FILL events represent user-provided values that will
become skill parameters. Do NOT treat them as literal strings — they are parametric inputs.

PARAMETER DETECTION: For each action, identify fill/paste values that are TASK-SPECIFIC
(values the user would change each time — names, queries, messages, descriptions, titles).
Map each to a descriptive param_name (snake_case). Static values (URLs, fixed labels,
email addresses, pure numbers) should NOT be params.
IMPORTANT: Even if a fill value does NOT appear in the original task text, if it looks like
user-provided content (a name, title, description, query, message), treat it as a parameter.
Only treat values as static if they are clearly constants (URLs, emails, numbers, fixed labels).
${guidedContext}
${trainTask ? `ORIGINAL TASK: ${trainTask}` : ''}

RAW EVENTS (task-specific values replaced with {{value}}):
${eventSummary}

Output JSON — two options:

OPTION 1 — if you can understand the actions:
{
  "actions": [
    {
      "name": "create.playlist",
      "description": "Create a new playlist with a given name",
      "eventStart": 1,
      "eventEnd": 8,
      "params": [
        { "name": "playlist_name", "type": "string", "required": true, "description": "Name of the playlist to create" }
      ],
      "paramMappings": [
        { "eventIndex": 3, "paramName": "playlist_name", "originalValue": "Christian Test" }
      ]
    }
  ]
}

OPTION 2 — if the events are too chaotic, unclear, or contain multiple unrelated actions:
{ "actions": [], "rejected": true, "reason": "The recorded events don't form a clear, repeatable action. Try recording again with a specific task in mind." }

If there is only ONE action, return a single-element array. Output ONLY valid JSON.`;

  try {
    logger.info('[trainer.agent] _autoSplitEvents: calling LLM for action split...');
    const response = await askWithMessages([
      { role: 'system', content: 'You identify action boundaries in browser interaction sequences. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 1000, temperature: 0.2, responseTimeoutMs: 15000 });

    // Check if cancelled during LLM call
    if (session.cancelRequested) {
      logger.info('[trainer.agent] _autoSplitEvents cancelled by user during LLM call');
      return { rejected: true, reason: 'Cancelled by user' };
    }

    let json = (response || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(json);

    // Check for reject response
    if (parsed.rejected) {
      return { rejected: true, reason: parsed.reason || 'Could not understand the recorded actions' };
    }

    if (parsed.actions && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      // Convert 1-based indices to 0-based
      for (const action of parsed.actions) {
        action.eventStart = Math.max(0, (action.eventStart || 1) - 1);
        action.eventEnd = action.eventEnd || collapsed.length;
      }
      logger.info(`[trainer.agent] _autoSplitEvents: LLM split into ${parsed.actions.length} actions`);
      return parsed.actions;
    }

    // Empty actions array without rejected flag — treat as reject
    if (parsed.actions && parsed.actions.length === 0) {
      return { rejected: true, reason: parsed.reason || 'LLM returned no actions' };
    }
  } catch (e) {
    logger.warn(`[trainer.agent] _autoSplitEvents LLM failed, using heuristic: ${e.message}`);
  }

  // Heuristic fallback: split at submit events or save/create/done clicks
  logger.info('[trainer.agent] _autoSplitEvents: using heuristic fallback');
  return _heuristicSplit(collapsed, trainTask);
}

// Heuristic split: looks for submit events and save/create/done button clicks
function _heuristicSplit(events, trainTask) {
  const BOUNDARY_RE = /\b(save|create|done|submit|send|publish|post|confirm)\b/i;
  const boundaries = [0]; // start of first action

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.type === 'submit') {
      boundaries.push(i + 1); // next action starts after submit
    } else if (evt.type === 'click' && evt.elementText && BOUNDARY_RE.test(evt.elementText)) {
      // Check if followed by a navigation (stronger signal)
      const next = events[i + 1];
      if (next && (next.type === 'navigate' || next.type === 'tab-new')) {
        boundaries.push(i + 1);
      }
    }
  }

  // If only 1 boundary (the start), no split needed
  if (boundaries.length <= 1) {
    return [{ name: 'default', description: trainTask || 'Recorded action', eventStart: 0, eventEnd: events.length, params: [] }];
  }

  // Build action segments
  const actions = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i < boundaries.length - 1 ? boundaries[i + 1] : events.length;
    if (end <= start) continue;
    actions.push({
      name: `action_${actions.length + 1}`,
      description: `Action ${actions.length + 1}`,
      eventStart: start,
      eventEnd: end,
      params: [],
    });
  }

  logger.info(`[trainer.agent] _heuristicSplit: split into ${actions.length} actions`);
  return actions;
}

// ---------------------------------------------------------------------------
// Register trained skill in agent's .md descriptor and user-memory DB
// ---------------------------------------------------------------------------
function _registerSkillInAgent(agentId, skillName, recipe) {
  try {
    const agentFile = agentId.endsWith('.agent') ? `${agentId}.md` : `${agentId}.agent.md`;
    const agentPath = path.join(AGENTS_DIR, agentFile);
    if (!fs.existsSync(agentPath)) return;

    let descriptor = fs.readFileSync(agentPath, 'utf8');
    const entry = `\n  - name: "${skillName}"\n    type: trained_recipe\n    target: "${recipe.targetDescription || ''}"\n    waypoints: ${recipe.waypoints.length}`;

    if (descriptor.includes('trained_skills:')) {
      descriptor = descriptor.replace(/(trained_skills:)/, `$1${entry}`);
    } else {
      descriptor = descriptor.replace(/^(---\s*\n[\s\S]*?\n---)/, `$1\ntrained_skills:${entry}`);
    }

    fs.writeFileSync(agentPath, descriptor, 'utf8');
    logger.info(`[trainer.agent] Registered ${skillName} in ${agentId}.agent.md`);

    // Also register in user-memory DB so parseSkill/external.skill can find it
    const skillPath = path.join(SKILLS_DIR, _skillDirId(agentId), _skillFileName(skillName));
    const memoryUrl = process.env.MCP_USER_MEMORY_URL || process.env.USER_MEMORY_SERVICE_URL || 'http://127.0.0.1:3001';
    const parsedUrl = new URL(memoryUrl);
    const upsertReq = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 3001,
      path: '/skill.upsert',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      if (res.statusCode === 200) {
        logger.info(`[trainer.agent] Registered ${skillName} in user-memory DB`);
      } else {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => { logger.warn(`[trainer.agent] user-memory skill.upsert returned ${res.statusCode}: ${err}`); });
      }
      res.resume();
    });
    upsertReq.on('error', err => { logger.warn(`[trainer.agent] user-memory skill.upsert failed: ${err.message}`); });
    upsertReq.write(JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'skill.upsert',
      payload: {
        name: skillName,
        description: recipe.targetDescription || `Trained skill ${skillName}`,
        execPath: skillPath,
        execType: 'recipe',
        enabled: true,
        sourceDomain: _skillDirId(agentId),
        sourceAction: recipe.targetDescription || '',
      },
    }));
    upsertReq.end();
  } catch (e) {
    logger.error(`[trainer.agent] Failed to register skill: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cancel training — stop WebSocket server, close browser
// ---------------------------------------------------------------------------
function actionCancelTraining(args) {
  let { agentId } = args || {};
  if (agentId) agentId = agentId.toLowerCase();

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };

  session.cancelRequested = true;
  if (session.pollInterval) clearInterval(session.pollInterval);

  // Close HTTP event-push server
  if (session.httpServer) {
    session.httpServer.close(() => {
      logger.info(`[trainer.agent] Event HTTP server closed (port ${session.httpPort})`);
    });
  }

  // Close browser session — only if we own it (not borrowed in 'here' mode)
  if (session.ownsSession !== false) {
    const { browserAct } = require('./browser.act.cjs');
    browserAct({ action: 'close', sessionId: session.sessionId }).catch(() => {});
  }

  activeSessions.delete(agentId);
  _postProgress(agentId, { type: 'training:cancelled', message: 'Training cancelled' });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// List trained skills for an agent
// ---------------------------------------------------------------------------
function actionListSkills(args) {
  let { agentId } = args || {};
  if (agentId) agentId = agentId.toLowerCase();
  if (!agentId) return { ok: false, error: 'agentId is required' };

  const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
  if (!fs.existsSync(skillDir)) return { ok: true, skills: [] };

  const files = fs.readdirSync(skillDir).filter(f => f.endsWith('.skill.json') || f.endsWith('.recipe.json'));
  const skills = files.map(f => {
    try {
      const recipe = JSON.parse(fs.readFileSync(path.join(skillDir, f), 'utf8'));
      const autoGenerated = recipe?.autoGenerated === true;
      const userConfirmed = recipe?.userConfirmed === true;
      return {
        name: recipe.name,
        target: recipe.targetDescription,
        waypoints: recipe.waypoints?.length || 0,
        created: recipe.created,
        autoGenerated,
        userConfirmed,
        origin: userConfirmed ? 'user' : (autoGenerated ? 'auto' : 'user'),
      };
    } catch { return null; }
  }).filter(Boolean);

  return { ok: true, skills };
}

// ---------------------------------------------------------------------------
// Load a specific recipe by skill name (used by browser.agent at runtime)
// ---------------------------------------------------------------------------
function loadRecipe(agentId, skillName) {
  // Try new naming first (skill.json), then legacy .skill.json, then .recipe.json
  const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
  const newPath = path.join(skillDir, _skillFileName(skillName));
  const legacySkillPath = path.join(skillDir, `${skillName}.skill.json`);
  const recipePath = path.join(skillDir, `${skillName}.recipe.json`);
  const filePath = fs.existsSync(newPath) ? newPath
    : (fs.existsSync(legacySkillPath) ? legacySkillPath
      : (fs.existsSync(recipePath) ? recipePath : null));
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Fuzzy skill name matching — normalize dots/spaces/underscores
// ---------------------------------------------------------------------------
function findMatchingRecipe(agentId, taskText, opts = {}) {
  const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
  if (!fs.existsSync(skillDir)) return null;

  const allowAutoGenerated = opts.allowAutoGenerated === true;
  const _isEligibleRecipe = (recipe) => {
    if (!recipe || typeof recipe !== 'object') return false;
    // User-confirmed recipes (saved via saveSkillOffer) are always eligible
    if (recipe.userConfirmed === true) return true;
    if (!allowAutoGenerated && recipe.autoGenerated === true) return false;
    return true;
  };

  const normalized = taskText.toLowerCase().replace(/[\s_]+/g, '.');
  const taskLower = taskText.toLowerCase();
  const files = fs.readdirSync(skillDir).filter(f => f.endsWith('.skill.json') || f.endsWith('.recipe.json'));

  // Pass 1: exact name match in task text (original fuzzy match)
  for (const f of files) {
    const name = f.replace(/\.(skill|recipe)\.json$/, '');
    if (normalized.includes(name)) {
      try {
        const recipe = JSON.parse(fs.readFileSync(path.join(skillDir, f), 'utf8'));
        if (_isEligibleRecipe(recipe)) return recipe;
      }
      catch { continue; }
    }
  }

  // Pass 2: match on targetDescription or targetUrl keywords
  for (const f of files) {
    try {
      const recipe = JSON.parse(fs.readFileSync(path.join(skillDir, f), 'utf8'));
      if (!_isEligibleRecipe(recipe)) continue;
      // Check targetDescription keywords (2+ word overlap)
      if (recipe.targetDescription) {
        const descWords = recipe.targetDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const matchCount = descWords.filter(w => taskLower.includes(w)).length;
        if (matchCount >= 2) return recipe;
      }
      // Check targetUrl path segments
      if (recipe.targetUrl) {
        try {
          const urlPath = new URL(recipe.targetUrl).pathname.toLowerCase().replace(/[/_-]+/g, ' ').trim();
          const pathWords = urlPath.split(/\s+/).filter(w => w.length > 3);
          const pathMatch = pathWords.filter(w => taskLower.includes(w)).length;
          if (pathMatch >= 1) return recipe;
        } catch {}
      }
    } catch { continue; }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auto-recipe: convert a successful playwright.agent transcript into a recipe
// ---------------------------------------------------------------------------
async function saveAutoRecipe(agentId, task, transcript, targetUrl, playbookContext, skillNameOverride) {
  if (!agentId || !task || !Array.isArray(transcript) || transcript.length < 2) return null;

  const _agentIdClean = _skillDirId(agentId);
  const skillDir = path.join(SKILLS_DIR, _agentIdClean);

  // Use the user-provided name (Phase 3 saveSkillOffer) or derive one from the task
  const skillName = skillNameOverride || (() => {
    const _intentName = task.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join('.');
    return `${_agentIdClean}.${_intentName}`;
  })();

  // Check if a recipe already exists for this task (fuzzy match) — skip when
  // the user explicitly named it (they may want to overwrite)
  if (!skillNameOverride) {
    const existing = findMatchingRecipe(_agentIdClean, task, { allowAutoGenerated: true });
    if (existing) {
      logger.info(`[trainer.agent] auto-recipe: recipe "${existing.name}" already exists for task — skipping`);
      return null;
    }
  }

  // Build waypoints from transcript
  const waypoints = [];
  let stepNum = 0;
  for (const entry of transcript) {
    const act = entry.action;
    if (!act || !act.action) continue;
    const a = act.action;

    // Skip non-navigation actions that are creative/task-specific
    if (a === 'return' || a === 'getPageText' || a === 'extractContent' || a === 'pasteAttachment') continue;

    stepNum++;
    if (a === 'navigate' || a === 'goto') {
      waypoints.push({ step: stepNum, type: 'navigate', url: act.url, checkpoint: '' });
    } else if (a === 'click') {
      const sel = act.selector || act.ref || '';
      if (!sel) { stepNum--; continue; }
      waypoints.push({
        step: stepNum, type: 'click', selector: sel,
        altSelectors: act.altSelectors || [],
        elementText: act.elementText || act.text || '',
        href: act.href || '',
      });
    } else if (a === 'fill' || a === 'type') {
      const sel = act.selector || act.ref || '';
      if (!sel) { stepNum--; continue; }
      // Don't store actual typed values — they're task-specific (email address, body text, etc.)
      waypoints.push({
        step: stepNum, type: 'fill', selector: sel,
        altSelectors: act.altSelectors || [],
        value: '',
      });
    } else if (a === 'press' || a === 'press-key') {
      waypoints.push({
        step: stepNum, type: 'keycombo',
        key: act.key || 'Enter',
        ctrl: act.ctrl || false, shift: act.shift || false, alt: act.alt || false,
        selector: act.selector || '',
      });
    } else if (a === 'select') {
      waypoints.push({ step: stepNum, type: 'select', selector: act.selector || '', value: '' });
    } else if (a === 'check' || a === 'uncheck') {
      waypoints.push({ step: stepNum, type: 'check', selector: act.selector || '', label: act.label || '', checked: a === 'check' });
    } else if (a === 'scroll') {
      waypoints.push({ step: stepNum, type: 'scroll', deltaY: act.deltaY || 0 });
    } else if (a === 'snapshot') {
      // Snapshot steps in the transcript are re-plan triggers, not navigation
      stepNum--;
    } else if (a === 'sendEmailWithVerification') {
      // Don't include send — playwright.agent handles this with its guard
      stepNum--;
    } else {
      stepNum--;
    }
  }

  if (waypoints.length < 2) {
    logger.info(`[trainer.agent] auto-recipe: only ${waypoints.length} navigable waypoints from transcript — skipping`);
    return null;
  }

  // ── URL-first optimization ────────────────────────────────────────────────
  // Collapse click chains that open a form/composer into a single navigate to
  // the deep-link URL. If targetUrl (from URL-first discovery) is set and differs
  // from the initial navigate, replace the prefix (navigate + opening clicks
  // that just lead to the form page) with a single navigate to targetUrl.
  // This makes the recipe deterministic — next run skips the click chain entirely.
  let _urlFirstWaypoints = waypoints;
  let _urlFirstStartUrl = transcript[0]?.action?.url || targetUrl || '';
  if (targetUrl && targetUrl !== _urlFirstStartUrl) {
    // Find the first fill/submit/press step — everything before it is just navigation
    // to get to the form. Replace that prefix with a single navigate to targetUrl.
    const _firstFormIdx = waypoints.findIndex(w => /fill|submit|press|check|select/i.test(w.type));
    if (_firstFormIdx > 0) {
      const _prefix = waypoints.slice(0, _firstFormIdx);
      // Only collapse if the prefix is all navigate/click (no fill/submit)
      const _isAllNav = _prefix.every(w => /navigate|click|scroll/i.test(w.type));
      if (_isAllNav) {
        _urlFirstWaypoints = [
          { step: 1, type: 'navigate', url: targetUrl, checkpoint: 'form page' },
          ...waypoints.slice(_firstFormIdx).map((w, i) => ({ ...w, step: i + 2 })),
        ];
        _urlFirstStartUrl = targetUrl;
        logger.info(`[trainer.agent] auto-recipe: URL-first collapse — replaced ${_prefix.length} prefix step(s) with navigate to ${targetUrl}`);
      }
    }
  }
  // Also: if any click step has a full http(s) href and is followed by form steps,
  // convert it to a navigate (deep-link) — avoids brittle selector clicks.
  _urlFirstWaypoints = _urlFirstWaypoints.map((w, i) => {
    if (w.type === 'click' && w.href && /^https?:\/\//i.test(w.href)) {
      const _next = _urlFirstWaypoints[i + 1];
      if (_next && /fill|submit|press|check|select/i.test(_next.type)) {
        logger.info(`[trainer.agent] auto-recipe: URL-first — converting click with href ${w.href} to navigate`);
        return { ...w, type: 'navigate', url: w.href, checkpoint: w.elementText || 'form page' };
      }
    }
    return w;
  });

  const recipe = {
    name: skillName,
    agentId: _agentIdClean,
    startUrl: _urlFirstStartUrl,
    targetUrl: targetUrl || '',
    waypoints: _urlFirstWaypoints,
    targetDescription: task.slice(0, 200),
    created: new Date().toISOString(),
    autoGenerated: true,
    // User-confirmed recipes (via saveSkillOffer) are always eligible for matching,
    // even without the THINKDROP_ALLOW_AUTOGENERATED_RECIPES env var.
    userConfirmed: !!skillNameOverride,
    urlFirst: targetUrl && targetUrl !== _urlFirstStartUrl ? false : true, // true when we collapsed to the deep-link
  };

  // Save recipe file
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
  const recipePath = path.join(skillDir, _skillFileName(skillName));
  fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2), 'utf8');

  // Register in agent descriptor
  _registerSkillInAgent(_agentIdClean, skillName, recipe);

  logger.info(`[trainer.agent] auto-recipe saved: ${recipePath} (${waypoints.length} waypoints)`);
  return recipe;
}

// ---------------------------------------------------------------------------
// Phase 10: Distill keyboard-first script from successful Tier 3 canvas run
// Converts transcript actions into script YAML format for script DB
// ---------------------------------------------------------------------------
async function distillKeyboardScript(agentId, task, transcript, pageType, service) {
  if (!transcript || !Array.isArray(transcript) || transcript.length < 2) return null;
  if (pageType !== 'canvas' && pageType !== 'hybrid') return null;

  const _service = service || (agentId || '').replace(/\.agent$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!_service) return null;

  // Extract keyboard-relevant actions from transcript
  const keyboardActions = [];
  for (const entry of transcript) {
    const act = entry.action || entry;
    const a = act.action;
    if (!a) continue;

    if (a === 'type' || a === 'fill') {
      const text = act.text || act.value || '';
      if (text) keyboardActions.push({ type: 'type', text });
    } else if (a === 'press' || a === 'press-key') {
      keyboardActions.push({ type: 'press', key: act.key || 'Enter' });
    } else if (a === 'click') {
      // Include clicks only if they have semantic locators (not refs)
      const sel = act.selector || '';
      if (sel && !sel.match(/^e\d+$/) && !sel.match(/^button\[ref=/)) {
        keyboardActions.push({ type: 'click', locator: sel });
      }
    }
  }

  if (keyboardActions.length < 2) {
    logger.info(`[trainer.agent] distill: only ${keyboardActions.length} keyboard actions from transcript — skipping`);
    return null;
  }

  // Use LLM to generate a clean script YAML with verify block
  const DISTILL_PROMPT = `You are a browser automation script distiller. Given a list of keyboard actions that successfully completed a task, generate a clean keyboard-first interaction script.

Respond with EXACTLY ONE JSON object (no markdown fences):
{
  "thoughts": "<one sentence>",
  "script": {
    "steps": [
      { "type": "<text>" },
      { "press": "<key>" },
      { "assert_focus": { "check": "<JS expression>", "fix": "click", "fix_locator": "<Playwright locator>", "on_fail": "fallback" } }
    ],
    "verify": [
      { "eval": "<JS expression that returns true/false>" }
    ]
  }
}

Rules:
- Use type/press for keyboard input — these go to whatever has focus
- Include assert_focus only if the original actions suggest focus verification is needed
- Generalize specific text values into template variables: {{title}}, {{message}}, {{items}}
- For list items, use for_each: items with {{item}} template
- Verify should check page content (document.body.innerText.includes(...))
- Keep steps minimal and deterministic
- Service: ${_service}
- Task: ${task}

Raw keyboard actions:
${JSON.stringify(keyboardActions, null, 2)}`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: DISTILL_PROMPT },
      { role: 'user', content: `Distill a keyboard-first script for service=${_service}, task="${task}"` },
    ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 15000 });

    // Parse response
    let parsed = null;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (_) { /* try raw */ }
    if (!parsed) {
      try { parsed = JSON.parse(raw); } catch (_) {}
    }

    if (!parsed || !parsed.script || !Array.isArray(parsed.script.steps)) {
      logger.warn(`[trainer.agent] distill: LLM returned no valid script`);
      return null;
    }

    // Store in script DB
    const { saveInteractionScript } = require('./playwright.agent.cjs');
    const action = _deriveScriptAction(task);
    const triggerKeywords = task.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 8);

    await saveInteractionScript(_service, action, pageType, parsed.script, triggerKeywords);
    logger.info(`[trainer.agent] distill: saved keyboard script ${_service}.${action} (${parsed.script.steps.length} steps)`);
    return { service: _service, action, steps: parsed.script.steps.length };
  } catch (err) {
    logger.warn(`[trainer.agent] distill error (non-fatal): ${err.message}`);
    return null;
  }
}

function _deriveScriptAction(task) {
  return task.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('_') || 'auto_distilled';
}

// ---------------------------------------------------------------------------
// Phase 10: Distill human correction from Tier 4 take-over into script YAML
// Called after user demonstrates correct action via trainer.agent recording
// ---------------------------------------------------------------------------
async function distillHumanCorrection(agentId, task, recordedEvents, pageType, service) {
  if (!recordedEvents || !Array.isArray(recordedEvents) || recordedEvents.length < 2) return null;

  const _service = service || (agentId || '').replace(/\.agent$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!_service) return null;

  // Convert recorded CDP events to keyboard actions
  const keyboardActions = [];
  for (const evt of recordedEvents) {
    if (evt.type === 'click') {
      const sel = evt.selector || '';
      if (sel && !sel.match(/^e\d+$/)) {
        keyboardActions.push({ type: 'click', locator: sel });
      }
    } else if (evt.type === 'fill' || evt.type === 'type') {
      if (evt.value) keyboardActions.push({ type: 'type', text: evt.value });
    } else if (evt.type === 'keycombo' || evt.type === 'press') {
      keyboardActions.push({ type: 'press', key: evt.key || 'Enter' });
    } else if (evt.type === 'navigate') {
      keyboardActions.push({ type: 'navigate', url: evt.url });
    }
  }

  if (keyboardActions.length < 2) {
    logger.info(`[trainer.agent] human correction: only ${keyboardActions.length} actions — skipping script distillation`);
    return null;
  }

  // Use LLM to generate script YAML (same prompt as distillKeyboardScript)
  const DISTILL_PROMPT = `You are a browser automation script distiller. Given a list of human-demonstrated actions that correctly completed a task, generate a clean keyboard-first interaction script.

Respond with EXACTLY ONE JSON object (no markdown fences):
{
  "thoughts": "<one sentence>",
  "script": {
    "steps": [
      { "type": "<text>" },
      { "press": "<key>" },
      { "assert_focus": { "check": "<JS expression>", "fix": "click", "fix_locator": "<Playwright locator>", "on_fail": "fallback" } }
    ],
    "verify": [
      { "eval": "<JS expression that returns true/false>" }
    ]
  }
}

Rules:
- Use type/press for keyboard input — these go to whatever has focus
- Generalize specific text values into template variables: {{title}}, {{message}}, {{items}}
- For list items, use for_each: items with {{item}} template
- Verify should check page content (document.body.innerText.includes(...))
- Keep steps minimal and deterministic
- Service: ${_service}
- Task: ${task}

Human-demonstrated actions:
${JSON.stringify(keyboardActions, null, 2)}`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: DISTILL_PROMPT },
      { role: 'user', content: `Distill a keyboard-first script from human correction for service=${_service}, task="${task}"` },
    ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 15000 });

    let parsed = null;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (_) {}
    if (!parsed) {
      try { parsed = JSON.parse(raw); } catch (_) {}
    }

    if (!parsed || !parsed.script || !Array.isArray(parsed.script.steps)) {
      logger.warn(`[trainer.agent] human correction: LLM returned no valid script`);
      return null;
    }

    const { saveInteractionScript } = require('./playwright.agent.cjs');
    const action = _deriveScriptAction(task);
    const triggerKeywords = task.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 8);

    await saveInteractionScript(_service, action, pageType || 'canvas', parsed.script, triggerKeywords);
    logger.info(`[trainer.agent] human correction: saved script ${_service}.${action} (${parsed.script.steps.length} steps)`);
    return { service: _service, action, steps: parsed.script.steps.length };
  } catch (err) {
    logger.warn(`[trainer.agent] human correction distill error (non-fatal): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Guided plan-first training — LLM generates a step plan, user does each step
// manually while CDP recorder watches and marks each step learned (brain→check),
// then auto-saves a URL-first recipe (per step: destination URL + DOM interactions).
// ---------------------------------------------------------------------------

// Generate a step-by-step plan from the user's task via LLM.
// Returns: { ok, plan: [{ step, description, expectedType, expectedText?, expectedUrl? }] }
async function generateGuidedPlan(task, agentId, startUrl) {
  if (agentId) agentId = agentId.toLowerCase();
  if (!task) return { ok: false, error: 'task is required' };

  const prompt = `You are a browser automation training planner. Given a user's task and the starting URL of a web service, break the task into a sequence of MANUAL steps that the user will perform one at a time while the system watches and learns.

TASK: ${task}
AGENT: ${agentId}
START URL: ${startUrl}

Output ONLY valid JSON (no markdown fences) with this shape:
{
  "plan": [
    {
      "step": 1,
      "description": "<short imperative instruction for the user, e.g. 'Create a new item named <name>'>",
      "expectedType": "navigate|click|fill|submit|select|check",
      "expectedText": "<text the user will click or field label they will fill — used for fuzzy matching recorded events>",
      "expectedUrl": "<URL fragment or path the user will land on after this step, if known — used to match navigate events>"
    }
  ]
}

Rules:
- Each step is ONE high-level user action, phrased as what the user is accomplishing (e.g. "Create the '<name>' <item>", "Add <entry> to the collection", "Add <entry> to the collection"). Do NOT phrase steps as low-level UI clicks like "Click the 'Create' button in the sidebar".
- Use the exact item names, entry names, search terms, and other specifics extracted from the task. If the task says "create a collection off my favorite items" and mentions "<name>", "<entry1>", "<entry2>", "<entry3>", use those exact names in the step descriptions.
- If the task includes [Additional context: ...], extract the specific names, values, and items from it and use them in your step descriptions. For example, if the additional context says "User's preferred collection name is '<name>'" and "User's favorite items for the collection are <entry1>, <entry2>, <entry3>", produce steps: 1) Create the '<name>' collection, 2) Add <entry1> to the collection, 3) Add <entry2> to the collection, 4) Add <entry3> to the collection.
- For a creation task with N items, produce exactly 1 + N steps: step 1 = create the collection/item, steps 2..N+1 = add each item to it.
- For each "add item" step, the expected interaction is: search for the item, then add it to the collection. expectedType should be "click" (for the final "Add" / "Add to collection" button click).
- Do NOT include "navigate to start URL" or "open the site" as a step — the system navigates to the start URL automatically.
- expectedType is the DOM event type the system should watch for to confirm this step: "click" for button clicks, "fill" for text input, "submit" for form submit, "navigate" for page changes, "select" for dropdowns, "check" for checkboxes.
- expectedText is the visible text of the element the user will interact with (button label, field placeholder, link text). Used for fuzzy matching.
- expectedUrl is optional — only set when the step lands on a distinct URL (e.g. /search, /items). Leave empty if the step happens on the same page as the previous step.
- Keep descriptions short and actionable — the user reads them one at a time.
- 1-8 steps max. If the task is genuinely one action, output a single-step plan.`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You are a browser automation training planner. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 2000, temperature: 0.1, responseTimeoutMs: 20000 });

    let json = (raw || '').trim();
    json = json.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(json);
    if (!parsed.plan || !Array.isArray(parsed.plan) || parsed.plan.length === 0) {
      return { ok: false, error: 'LLM returned no plan array' };
    }
    // Normalize: ensure step numbers are sequential
    parsed.plan = parsed.plan.map((p, i) => ({ ...p, step: i + 1 }));
    return { ok: true, plan: parsed.plan };
  } catch (err) {
    logger.warn(`[trainer.agent] generateGuidedPlan failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Start guided training: navigate to start URL, inject recorder, emit first step.
async function actionGuidedTrain(args) {
  let { agentId, task, plan, startUrl: startUrlOverride = null } = args || {};
  if (agentId) agentId = agentId.toLowerCase();

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task) return { ok: false, error: 'task is required' };
  // plan is now optional — guided steps are no longer used. We keep the param
  // for backwards compat but ignore it. Training is unified: record all →
  // LLM organizes on Save.
  if (activeSessions.has(agentId)) return { ok: false, error: 'Training already in progress' };

  const agentFile = agentId.endsWith('.agent') ? `${agentId}.md` : `${agentId}.agent.md`;
  const agentPath = path.join(AGENTS_DIR, agentFile);

  let descriptor = '';
  if (fs.existsSync(agentPath)) {
    descriptor = fs.readFileSync(agentPath, 'utf8');
  } else {
    // HTTP fallback (same as actionTrain)
    try {
      const CMD_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
      const listResult = await new Promise((resolve, reject) => {
        const body = JSON.stringify({});
        const req = http.request(
          { hostname: '127.0.0.1', port: CMD_PORT, path: '/agents.list', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          (res) => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
          }
        );
        req.on('error', reject);
        req.write(body); req.end();
      });
      const agents = listResult?.agents || [];
      const _norm = id => (id || '').replace(/\.agent$/, '').toLowerCase().trim();
      const match = agents.find(a => _norm(a.id) === _norm(agentId) || a.id === agentId);
      if (match?.descriptor) descriptor = match.descriptor;
    } catch (httpErr) {
      logger.warn(`[trainer.agent] guided train HTTP fallback failed: ${httpErr.message}`);
    }
    if (!descriptor) return { ok: false, error: `Agent not found: ${agentId}` };
  }

  const startUrlMatch = descriptor.match(/^start_url:\s*(.+)$/m);
  if (!startUrlMatch) return { ok: false, error: 'Agent missing start_url' };
  const descriptorStartUrl = startUrlMatch[1].trim();
  const effectiveStartUrl = startUrlOverride || descriptorStartUrl;
  const hostname = new URL(descriptorStartUrl).hostname.replace(/^www\./, '');

  // Persistent profile session — reuse the same sessionId that browser.agent
  // uses so auth cookies are preserved.
  const sessionId = `${agentId.replace(/\.agent$/, '')}_agent`;
  const session = {
    agentId, hostname, startUrl: effectiveStartUrl, sessionId,
    rawEvents: [],
    startTime: Date.now(),
    pollInterval: null,
    cancelRequested: false,
    injectedTabs: new Set(),
    ctxBound: false,
    httpServer: null,
    httpPort: null,
    trainMode: 'guided',
    trainTask: task,
    isHereMode: false,
    ownsSession: true,
  };
  activeSessions.set(agentId, session);

  logger.info(`[trainer.agent] Starting training for ${agentId}: task="${task.slice(0, 80)}"`);

  try {
    const { browserAct } = require('./browser.act.cjs');
    _postProgress(agentId, { type: 'training:start', hostname, startUrl: effectiveStartUrl, mode: 'freeform' });

    await _startEventHttpServer(session);
    logger.info(`[trainer.agent] Event HTTP server ready on port ${session.httpPort}`);

    // Navigate to start URL
    await browserAct({ action: 'navigate', url: effectiveStartUrl, sessionId, headed: true, timeoutMs: 30000 });
    await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 }).catch(() => {});
    await _injectRecorderScript(session, 0);
    _startTabWatcher(session);

    return { ok: true, agentId, message: 'Training started. Record interactions and click Save.' };
  } catch (err) {
    logger.error(`[trainer.agent] Train start failed: ${err.message}`);
    activeSessions.delete(agentId);
    return { ok: false, error: err.message };
  }
}

// Derive a dot-separated skill name from the task text. Always ends with .skill.
function _deriveGuidedSkillName(agentId, task) {
  const _agentIdClean = _skillDirId(agentId);
  const _intentName = (task || 'trained')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('.');
  return `${_agentIdClean}.${_intentName || 'trained'}.skill`;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Clear recorded events for an agent — keeps the session alive but resets
// rawEvents so the user can re-record without cancelling and re-training.
// ---------------------------------------------------------------------------
function actionClearEvents(args) {
  let { agentId } = args || {};
  if (agentId) agentId = agentId.toLowerCase();

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };

  session.rawEvents = [];
  session.injectedTabs = session.injectedTabs || new Set();
  // Reset per-tab last indices so polling re-collects from scratch
  if (session._tabLastIndices) session._tabLastIndices.clear();
  logger.info(`[trainer.agent] Cleared raw events for ${agentId}`);
  return { ok: true };
}

module.exports = {
  actionTrain,
  actionSaveTraining,
  actionPreviewSplit,
  actionSaveSkillsAndRecipe,
  actionCancelTraining,
  actionClearEvents,
  actionListSkills,
  loadRecipe,
  findMatchingRecipe,
  saveAutoRecipe,
  distillKeyboardScript,
  distillHumanCorrection,
  // Guided plan-first training (simplified — no step checklist)
  generateGuidedPlan,
  actionGuidedTrain,
  // Exposed for main.js guided-train-finish handler
  _deriveGuidedSkillName,
  _getActiveSession: (agentId) => activeSessions.get((agentId || '').toLowerCase()),
};
