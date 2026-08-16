'use strict';
// ---------------------------------------------------------------------------
// trainer.agent.cjs — Interactive Path Recording + Waypoint Recipe Generator
//
// Architecture:
// 1. Opens browser to agent's start_url (headed mode)
// 2. Injects CDP event listener script to capture user clicks/navigations
// 3. Polls captured events and emits them to the UI as recorded steps
// 4. On "Save": LLM cleans raw events into a minimal waypoint recipe JSON
// 5. Recipe saved to ~/.thinkdrop/skills/<agentId>/<dotName>.recipe.json
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

  // ── Selector helpers ──────────────────────────────────────────────────────

  // Walk up to 4 ancestor levels looking for a stable anchor (id/testid/aria-label)
  // before falling back to tag+class. Produces scoped selectors like
  // '#editor-container > div' instead of bare 'div.cm-line:nth-child(4)'.
  function getSelector(el) {
    if (!el || !el.tagName) return 'body';
    if (el.id) return '#' + el.id;
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    if (el.getAttribute('aria-label')) return '[aria-label="' + el.getAttribute('aria-label') + '"]';
    // Walk up ancestors for a stable anchor
    var ancestor = el.parentElement;
    for (var i = 0; i < 4 && ancestor && ancestor !== document.body; i++, ancestor = ancestor.parentElement) {
      if (ancestor.id) return '#' + ancestor.id + ' ' + el.tagName.toLowerCase();
      if (ancestor.getAttribute('data-testid')) return '[data-testid="' + ancestor.getAttribute('data-testid') + '"] ' + el.tagName.toLowerCase();
      if (ancestor.getAttribute('aria-label')) return '[aria-label="' + ancestor.getAttribute('aria-label') + '"] ' + el.tagName.toLowerCase();
    }
    // Fallback: tag + stable classes + nth-child
    var path = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.split(/\\s+/).filter(function(c) { return c && !c.startsWith('_') && c.length > 1; }).slice(0, 2).join('.');
      if (cls) path += '.' + cls;
    }
    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
      if (siblings.length > 1) path += ':nth-child(' + (siblings.indexOf(el) + 1) + ')';
    }
    return path;
  }

  function getAltSelectors(el) {
    var alts = [];
    if (!el || !el.tagName) return alts;
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || '').trim().substring(0, 50);
    var href = el.getAttribute('href') || '';

    // href-based (most deterministic for links)
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

    // ARIA-based
    var role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : null);
    var ariaLabel = el.getAttribute('aria-label');
    var ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabel) {
      alts.push(tag + '[aria-label="' + ariaLabel + '"]');
      if (role) alts.push('[role="' + role + '"][aria-label="' + ariaLabel + '"]');
    }
    if (ariaLabelledBy) alts.push(tag + '[aria-labelledby="' + ariaLabelledBy + '"]');

    // Class+text
    var classes = el.className && typeof el.className === 'string'
      ? el.className.split(/\\s+/).filter(function(c) { return c && !c.match(/^_/) && c.length > 2; }).slice(0, 2) : [];
    if (classes.length > 0 && text) alts.push(tag + '.' + classes.join('.') + ':has-text("' + text.substring(0, 20) + '")');

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
    var text = (el.textContent || '').trim().substring(0, 60);
    var href = el.href || (el.closest('a') || {}).href || '';
    window.__tdTrainEvents.push({
      type: 'click', selector: selector, altSelectors: getAltSelectors(el),
      elementText: text, elementTag: el.tagName.toLowerCase(),
      href: href, url: location.href, timestamp: Date.now()
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
      elementText: (el.textContent || '').trim().substring(0, 60),
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
      var value = el.value !== undefined ? el.value : (el.innerText || el.textContent || '');
      if (!value) return; // skip empty
      window.__tdTrainEvents.push({
        type: isRange ? 'fill' : (el.tagName === 'SELECT' ? 'select' : 'fill'),
        selector: selector, altSelectors: getAltSelectors(el),
        value: String(value).substring(0, 2000),
        elementTag: el.tagName.toLowerCase(),
        url: location.href, timestamp: Date.now()
      });
    }, 800);
  }, true);

  // ── Native change (SELECT dropdown + blur fallback for inputs) ────────────
  document.addEventListener('change', function(e) {
    var el = e.target;
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) === -1) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;
    var selector = getSelector(el);
    window.__tdTrainEvents.push({
      type: el.tagName === 'SELECT' ? 'select' : 'fill',
      selector: selector, altSelectors: getAltSelectors(el),
      value: el.value, elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now()
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
        window.__tdTrainEvents.push({
          type: 'fill', selector: selector, altSelectors: getAltSelectors(el),
          value: String(value).substring(0, 2000), elementTag: el.tagName.toLowerCase(),
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
  const { agentId, mode = 'fresh', task = null, startUrl: startUrlOverride = null, keepSession = false, browserSessionId = null } = args || {};

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
  const sessionId = isHereMode ? browserSessionId : `${agentId}_train`;
  const effectiveStartUrl = isHereMode ? (startUrlOverride || descriptorStartUrl) : descriptorStartUrl;

  const session = {
    agentId, hostname, startUrl: effectiveStartUrl, sessionId,
    rawEvents: [],
    startTime: Date.now(),
    pollInterval: null,
    cancelRequested: false,
    injectedTabs: new Set(), // tab indices where recorder script has been injected
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
  // Replace the array-push token with a fire-and-forget fetch POST.
  // The object literal + closing ); that follow each push( are valid call args.
  return CDP_RECORDER_SCRIPT
    .split('window.__tdTrainEvents.push(')
    .join(`(function(ev){try{fetch('http://127.0.0.1:${port}/e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev)}).catch(function(){});}catch(e_){}})(`);
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

  // _buildRecorderScript bakes in the fetch endpoint.
  // Also stamp each event with the tab index by patching the fetch token.
  // We inline _tabIndex into every event object passed to the fetch call.
  const baseScript = _buildRecorderScript(httpPort);
  // Patch: insert ev._tabIndex=N before each fetch body JSON.stringify(ev)
  const script = baseScript
    .split('JSON.stringify(ev)')
    .join(`JSON.stringify(Object.assign(ev,{_tabIndex:${tabIndex}}))`);
  const scriptJson = JSON.stringify(script);

  // The run-code vm context only has `page` and `__end__` — no process/global.
  // We just inject a plain script tag; no exposeFunction needed.
  const injectCode = `async page => {
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

  session.rawEvents.push(evt);
  const uiStep = _eventToUIStep(evt);
  logger.info(`[trainer.agent] push event: type=${evt.type} tab=${evt.tabIndex} uiStep=${!!uiStep}`);
  if (uiStep) _postProgress(agentId, { type: 'training:step-recorded', ...uiStep });

  // ── Guided training: match event to current step ──────────────────────
  if (session.guidedPlan && session.guidedCursor !== undefined) {
    _tryMatchGuidedStep(session, evt);
  }
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
  const { agentId, skillName } = args || {};

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!skillName) return { ok: false, error: 'skillName is required' };

  // Validate dot-name format — one or more dot-separated segments
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(skillName)) {
    return { ok: false, error: 'Skill name must be dot-separated (e.g. w3schools.editor or w3schools.tryit.editor)' };
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

    const recipePath = path.join(skillDir, `${skillName}.recipe.json`);
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
// Build waypoint recipe from raw events using LLM
// ---------------------------------------------------------------------------
async function _buildRecipe(session, skillName) {
  const { agentId, hostname, startUrl, rawEvents } = session;

  // Format events for LLM
  const eventSummary = rawEvents.map((e, i) => {
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
3. Remove noise (duplicate navigations, insignificant clicks)
4. Each waypoint should represent a meaningful navigation step
5. The LAST waypoint is the TARGET — where the user wants the AI to start working
6. Include the primary CSS selector AND alternative selectors for each click waypoint
7. Include URL checkpoints for navigation waypoints
8. EXTRACT waypoints capture data from the page - preserve them for WALT tool returns
9. For fill waypoints that contain task-specific text (email body, post text, etc.), set value to "" (empty) — the runtime will fill from the task. Only keep static values (e.g. a fixed subject line).

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
  "waypoints": [<array of waypoints, mix types as needed>],
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
// Fallback recipe builder (no LLM needed)
// ---------------------------------------------------------------------------
function _buildFallbackRecipe(session, skillName) {
  const { agentId, startUrl, hostname, rawEvents } = session;

  // Extract unique navigations and significant clicks
  const waypoints = [];
  let step = 0;
  const seenUrls = new Set();

  const returns = {};

  for (const evt of rawEvents) {
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
    } else if (evt.type === 'extract') {
      step++;
      waypoints.push({
        step,
        type: 'extract',
        selector: evt.selector,
        extractName: evt.extractName,
        extractType: evt.extractType || 'text',
        description: `Extract ${evt.extractName} from page`,
      });
      // Add to returns schema
      returns[evt.extractName] = {
        type: evt.extractType === 'html' ? 'string' : 'string',
        description: `Extracted ${evt.extractName} from ${evt.selector}`,
      };
    }
  }

  const lastNav = rawEvents.filter(e => e.type === 'navigate').pop();

  return {
    name: skillName,
    agentId,
    startUrl,
    targetUrl: lastNav?.url || startUrl,
    waypoints,
    returns: Object.keys(returns).length > 0 ? returns : undefined,
    targetDescription: `Target page: ${lastNav?.pageTitle || lastNav?.url || startUrl}`,
    created: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Register trained skill in agent's .md descriptor
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
  } catch (e) {
    logger.error(`[trainer.agent] Failed to register skill: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cancel training — stop WebSocket server, close browser
// ---------------------------------------------------------------------------
function actionCancelTraining(args) {
  const { agentId } = args || {};

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
  const { agentId } = args || {};
  if (!agentId) return { ok: false, error: 'agentId is required' };

  const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
  if (!fs.existsSync(skillDir)) return { ok: true, skills: [] };

  const files = fs.readdirSync(skillDir).filter(f => f.endsWith('.recipe.json'));
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
  const recipePath = path.join(SKILLS_DIR, _skillDirId(agentId), `${skillName}.recipe.json`);
  if (!fs.existsSync(recipePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(recipePath, 'utf8'));
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
  const files = fs.readdirSync(skillDir).filter(f => f.endsWith('.recipe.json'));

  // Pass 1: exact name match in task text (original fuzzy match)
  for (const f of files) {
    const name = f.replace('.recipe.json', '');
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
  const recipePath = path.join(skillDir, `${skillName}.recipe.json`);
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
      "description": "<short imperative instruction for the user, e.g. 'Create a new playlist named Christian Music'>",
      "expectedType": "navigate|click|fill|submit|select|check",
      "expectedText": "<text the user will click or field label they will fill — used for fuzzy matching recorded events>",
      "expectedUrl": "<URL fragment or path the user will land on after this step, if known — used to match navigate events>"
    }
  ]
}

Rules:
- Each step is ONE meaningful user action (click a button, fill a field, submit a form).
- Do NOT include "navigate to start URL" as a step — the system does that automatically.
- For "create a playlist named X and add artists A, B, C", produce: step 1 = create playlist (fill name + click create), steps 2-4 = search each artist + click "Add to playlist".
- expectedType is the DOM event type the system should watch for to confirm this step: "click" for button clicks, "fill" for text input, "submit" for form submit, "navigate" for page changes, "select" for dropdowns, "check" for checkboxes.
- expectedText is the visible text of the element the user will interact with (button label, field placeholder, link text). Used for fuzzy matching.
- expectedUrl is optional — only set when the step lands on a distinct URL (e.g. /search, /playlists). Leave empty if the step happens on the same page as the previous step.
- Keep descriptions short and actionable — the user reads them one at a time.
- 1-8 steps max. If the task is genuinely one action, output a single-step plan.`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You are a browser automation training planner. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 1200, temperature: 0.1, responseTimeoutMs: 20000 });

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
  const { agentId, task, plan, startUrl: startUrlOverride = null } = args || {};

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task) return { ok: false, error: 'task is required' };
  if (!plan || !Array.isArray(plan) || plan.length === 0) return { ok: false, error: 'plan is required (array of steps)' };
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

  const sessionId = `${agentId}_guided`;
  const session = {
    agentId, hostname, startUrl: effectiveStartUrl, sessionId,
    rawEvents: [],
    startTime: Date.now(),
    pollInterval: null,
    cancelRequested: false,
    injectedTabs: new Set(),
    httpServer: null,
    httpPort: null,
    trainMode: 'guided',
    trainTask: task,
    isHereMode: false,
    ownsSession: true,
    // Guided training fields
    guidedPlan: plan,
    guidedCursor: 0,
    guidedMatchedEvents: [], // per-step: [{ step, events: [evt, ...], destinationUrl }]
    guidedStepStartTime: Date.now(),
  };
  // Initialize matched-events slots
  for (let i = 0; i < plan.length; i++) {
    session.guidedMatchedEvents.push({ step: i + 1, events: [], destinationUrl: null });
  }
  activeSessions.set(agentId, session);

  logger.info(`[trainer.agent] Starting guided training for ${agentId}: ${plan.length} steps, task="${task.slice(0, 80)}"`);

  try {
    const { browserAct } = require('./browser.act.cjs');
    _postProgress(agentId, { type: 'training:start', hostname, startUrl: effectiveStartUrl, mode: 'guided', plan });

    await _startEventHttpServer(session);
    logger.info(`[trainer.agent] Guided event HTTP server ready on port ${session.httpPort}`);

    // Navigate to start URL
    await browserAct({ action: 'navigate', url: effectiveStartUrl, sessionId, headed: true, timeoutMs: 30000 });
    await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 }).catch(() => {});
    await _injectRecorderScript(session, 0);
    _startTabWatcher(session);

    // Emit first guided step to UI (brain icon = not yet learned)
    const firstStep = plan[0];
    _postProgress(agentId, {
      type: 'training:guided-step',
      stepIndex: 0,
      totalSteps: plan.length,
      description: firstStep.description,
      expectedType: firstStep.expectedType,
      expectedText: firstStep.expectedText || null,
      expectedUrl: firstStep.expectedUrl || null,
      brainIcon: true,
    });
    logger.info(`[trainer.agent] Guided step 1/${plan.length}: "${firstStep.description}"`);

    return { ok: true, agentId, message: `Guided training started (${plan.length} steps).` };
  } catch (err) {
    logger.error(`[trainer.agent] Guided train start failed: ${err.message}`);
    activeSessions.delete(agentId);
    return { ok: false, error: err.message };
  }
}

// Try to match an incoming event to the current guided step.
// On match: record event, advance cursor, emit step-learned + next step.
function _tryMatchGuidedStep(session, evt) {
  const cursor = session.guidedCursor;
  const plan = session.guidedPlan;
  if (cursor >= plan.length) return; // all steps done

  const currentStep = plan[cursor];
  const matchedSlot = session.guidedMatchedEvents[cursor];

  // Always record the event into the current step's event list (for recipe building)
  matchedSlot.events.push(evt);

  // Track the latest navigate URL as the step's destination URL
  if (evt.type === 'navigate' && evt.url) {
    matchedSlot.destinationUrl = evt.url;
  }

  // Match logic: does this event satisfy the current step's expectedType + expectedText?
  let matched = false;
  const expectedType = (currentStep.expectedType || '').toLowerCase();
  const expectedText = (currentStep.expectedText || '').toLowerCase();
  const expectedUrl = (currentStep.expectedUrl || '').toLowerCase();

  if (expectedType === evt.type) {
    // Type matches — check text/URL if provided
    if (expectedType === 'navigate') {
      // For navigate steps: match if expectedUrl is empty OR the event URL contains expectedUrl
      if (!expectedUrl || evt.url?.toLowerCase().includes(expectedUrl)) {
        matched = true;
      }
    } else if (expectedType === 'fill' || expectedType === 'submit' || expectedType === 'select' || expectedType === 'check') {
      // For fill/submit/select/check: match on type (text matching is unreliable for inputs)
      matched = true;
    } else if (expectedType === 'click') {
      // For click: fuzzy match on elementText or selector containing expectedText
      const elText = (evt.elementText || '').toLowerCase();
      const sel = (evt.selector || '').toLowerCase();
      if (!expectedText || elText.includes(expectedText) || sel.includes(expectedText.replace(/\s+/g, ''))) {
        matched = true;
      }
    } else {
      // Other types: type match is enough
      matched = true;
    }
  }

  if (!matched) return;

  // Step matched — mark learned, advance cursor
  logger.info(`[trainer.agent] Guided step ${cursor + 1}/${plan.length} matched (type=${evt.type}) — marking learned`);
  _postProgress(session.agentId, {
    type: 'training:step-learned',
    stepIndex: cursor,
    totalSteps: plan.length,
    description: currentStep.description,
    matchedEventType: evt.type,
  });

  session.guidedCursor = cursor + 1;

  // All steps done? Auto-save.
  if (session.guidedCursor >= plan.length) {
    logger.info(`[trainer.agent] All ${plan.length} guided steps learned — auto-saving recipe`);
    _postProgress(session.agentId, {
      type: 'training:guided-complete',
      totalSteps: plan.length,
      message: 'All steps learned! Saving recipe...',
    });
    // Derive skill name from task
    const _skillName = _deriveGuidedSkillName(session.agentId, session.trainTask);
    // Auto-save (async, don't block event processing)
    actionSaveGuidedTraining({ agentId: session.agentId, skillName: _skillName })
      .catch(err => logger.error(`[trainer.agent] Guided auto-save failed: ${err.message}`));
    return;
  }

  // Emit next step to UI
  const nextStep = plan[session.guidedCursor];
  session.guidedStepStartTime = Date.now();
  _postProgress(session.agentId, {
    type: 'training:guided-step',
    stepIndex: session.guidedCursor,
    totalSteps: plan.length,
    description: nextStep.description,
    expectedType: nextStep.expectedType,
    expectedText: nextStep.expectedText || null,
    expectedUrl: nextStep.expectedUrl || null,
    brainIcon: true,
  });
  logger.info(`[trainer.agent] Guided step ${session.guidedCursor + 1}/${plan.length}: "${nextStep.description}"`);
}

// Skip the current guided step (user did it but auto-detection missed).
function actionGuidedSkipStep(args) {
  const { agentId } = args || {};
  const session = activeSessions.get(agentId);
  if (!session || !session.guidedPlan) return { ok: false, error: 'No active guided training session' };
  if (session.guidedCursor >= session.guidedPlan.length) return { ok: false, error: 'All steps already complete' };

  const cursor = session.guidedCursor;
  const currentStep = session.guidedPlan[cursor];
  logger.info(`[trainer.agent] Guided step ${cursor + 1} skipped by user`);

  // Use the last recorded navigate URL as destination if available
  const matchedSlot = session.guidedMatchedEvents[cursor];
  if (!matchedSlot.destinationUrl) {
    const lastNav = session.rawEvents.filter(e => e.type === 'navigate').pop();
    if (lastNav) matchedSlot.destinationUrl = lastNav.url;
  }

  _postProgress(agentId, {
    type: 'training:step-learned',
    stepIndex: cursor,
    totalSteps: session.guidedPlan.length,
    description: currentStep.description,
    matchedEventType: 'skip',
  });

  session.guidedCursor = cursor + 1;

  if (session.guidedCursor >= session.guidedPlan.length) {
    logger.info(`[trainer.agent] All guided steps complete (after skip) — auto-saving recipe`);
    _postProgress(agentId, {
      type: 'training:guided-complete',
      totalSteps: session.guidedPlan.length,
      message: 'All steps learned! Saving recipe...',
    });
    const _skillName = _deriveGuidedSkillName(agentId, session.trainTask);
    actionSaveGuidedTraining({ agentId, skillName: _skillName })
      .catch(err => logger.error(`[trainer.agent] Guided auto-save failed: ${err.message}`));
    return { ok: true, skipped: true, allComplete: true };
  }

  const nextStep = session.guidedPlan[session.guidedCursor];
  _postProgress(agentId, {
    type: 'training:guided-step',
    stepIndex: session.guidedCursor,
    totalSteps: session.guidedPlan.length,
    description: nextStep.description,
    expectedType: nextStep.expectedType,
    expectedText: nextStep.expectedText || null,
    expectedUrl: nextStep.expectedUrl || null,
    brainIcon: true,
  });
  return { ok: true, skipped: true };
}

// Derive a dot-separated skill name from the task text.
function _deriveGuidedSkillName(agentId, task) {
  const _agentIdClean = _skillDirId(agentId);
  const _intentName = (task || 'trained')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('.');
  return `${_agentIdClean}.${_intentName || 'trained'}`;
}

// Save guided training as a URL-first recipe.
// Per step: record ONLY the destination URL (last navigate before the step's key
// interaction) + the DOM interactions on that page. Discard intermediate navigations.
async function actionSaveGuidedTraining(args) {
  const { agentId, skillName } = args || {};
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!skillName) return { ok: false, error: 'skillName is required' };

  // Validate dot-name format
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(skillName)) {
    return { ok: false, error: 'Skill name must be dot-separated (e.g. spotify.create.playlist)' };
  }

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };
  if (!session.guidedPlan) return { ok: false, error: 'Not a guided training session' };

  // Stop polling
  if (session.pollInterval) clearInterval(session.pollInterval);
  session.cancelRequested = true;

  _postProgress(agentId, { type: 'training:saving', message: 'Building URL-first recipe...' });

  try {
    // Build URL-first recipe from guided matched events
    const recipe = _buildGuidedRecipe(session, skillName);

    // Save recipe file
    const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    const recipePath = path.join(skillDir, `${skillName}.recipe.json`);
    fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2), 'utf8');

    // Register in agent descriptor
    _registerSkillInAgent(agentId, skillName, recipe);

    // Clean up session
    if (session.httpServer) {
      session.httpServer.close(() => {
        logger.info(`[trainer.agent] Guided event HTTP server closed (port ${session.httpPort})`);
      });
    }
    if (session.ownsSession !== false) {
      const { browserAct } = require('./browser.act.cjs');
      browserAct({ action: 'close', sessionId: session.sessionId }).catch(() => {});
    }
    activeSessions.delete(agentId);

    logger.info(`[trainer.agent] Guided recipe saved: ${recipePath} (${recipe.waypoints.length} waypoints)`);
    _postProgress(agentId, {
      type: 'training:saved',
      skillName,
      recipePath,
      waypointCount: recipe.waypoints.length,
      message: `Skill "${skillName}" saved with ${recipe.waypoints.length} waypoints.`,
    });

    return { ok: true, skillName, recipePath, recipe };
  } catch (err) {
    logger.error(`[trainer.agent] Guided save failed: ${err.message}`);
    _postProgress(agentId, { type: 'training:error', message: err.message });
    return { ok: false, error: err.message };
  }
}

// Build a URL-first recipe from guided matched events.
// Per step: ONE navigate waypoint (destination URL) + DOM interaction waypoints.
// Intermediate navigations within a step are discarded.
function _buildGuidedRecipe(session, skillName) {
  const { agentId, startUrl, guidedPlan, guidedMatchedEvents, trainTask } = session;
  const waypoints = [];
  let stepNum = 0;

  for (let i = 0; i < guidedPlan.length; i++) {
    const planStep = guidedPlan[i];
    const matched = guidedMatchedEvents[i];
    if (!matched || !matched.events || matched.events.length === 0) {
      logger.warn(`[trainer.agent] Guided recipe: step ${i + 1} has no matched events — skipping`);
      continue;
    }

    // Find the destination URL: the LAST navigate event in this step's events
    // (the URL where the key interaction happened). If no navigate in this step,
    // carry forward the previous step's destination URL.
    const navEvents = matched.events.filter(e => e.type === 'navigate' && e.url && e.url !== 'about:blank');
    const destUrl = navEvents.length > 0 ? navEvents[navEvents.length - 1].url : (waypoints.length > 0 ? null : startUrl);

    if (destUrl) {
      stepNum++;
      waypoints.push({
        step: stepNum,
        type: 'navigate',
        url: destUrl,
        checkpoint: planStep.description,
      });
    }

    // Add DOM interaction waypoints — skip navigate events (already recorded above)
    // and skip the very first navigate if it's just the start URL (URL-first skips it).
    for (const evt of matched.events) {
      if (evt.type === 'navigate') continue; // handled as destination URL above
      if (evt.type === 'click' || evt.type === 'dblclick') {
        stepNum++;
        waypoints.push({
          step: stepNum,
          type: evt.type,
          selector: evt.selector,
          altSelectors: evt.altSelectors || [],
          elementText: evt.elementText || '',
          href: evt.href || '',
        });
      } else if (evt.type === 'fill' || evt.type === 'paste') {
        stepNum++;
        // value="" — runtime fills from task (search query, playlist name are task-specific)
        waypoints.push({
          step: stepNum,
          type: evt.type === 'paste' ? 'paste' : 'fill',
          selector: evt.selector,
          altSelectors: evt.altSelectors || [],
          value: '', // task-specific — runtime fills from task
        });
      } else if (evt.type === 'submit') {
        stepNum++;
        waypoints.push({ step: stepNum, type: 'submit', selector: evt.selector });
      } else if (evt.type === 'keycombo') {
        stepNum++;
        waypoints.push({
          step: stepNum,
          type: 'keycombo',
          key: evt.key || 'Enter',
          ctrl: evt.ctrl || false, shift: evt.shift || false, alt: evt.alt || false,
          selector: evt.selector || '',
        });
      } else if (evt.type === 'select') {
        stepNum++;
        waypoints.push({ step: stepNum, type: 'select', selector: evt.selector, value: '' });
      } else if (evt.type === 'check') {
        stepNum++;
        waypoints.push({
          step: stepNum, type: 'check', selector: evt.selector,
          label: evt.label || '', checked: evt.checked,
        });
      } else if (evt.type === 'hover') {
        stepNum++;
        waypoints.push({
          step: stepNum, type: 'hover', selector: evt.selector,
          altSelectors: evt.altSelectors || [],
        });
      }
      // Skip scroll, focus, tab-new — not meaningful for recipe replay
    }
  }

  // Determine target URL: last navigate waypoint's URL
  const lastNav = waypoints.filter(w => w.type === 'navigate').pop();

  return {
    name: skillName,
    agentId: _skillDirId(agentId),
    startUrl,
    targetUrl: lastNav?.url || startUrl,
    waypoints,
    targetDescription: trainTask ? trainTask.slice(0, 200) : `Guided recipe: ${skillName}`,
    created: new Date().toISOString(),
    userConfirmed: true,
    urlFirst: true,
    guidedTraining: true,
  };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  actionTrain,
  actionSaveTraining,
  actionCancelTraining,
  actionListSkills,
  loadRecipe,
  findMatchingRecipe,
  saveAutoRecipe,
  distillKeyboardScript,
  distillHumanCorrection,
  // Guided plan-first training
  generateGuidedPlan,
  actionGuidedTrain,
  actionGuidedSkipStep,
  actionSaveGuidedTraining,
};
