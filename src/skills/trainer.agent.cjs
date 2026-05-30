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

const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
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
// Captures clicks, inputs, navigations, and form submissions.
// Results stored in window.__tdTrainEvents for polling.
// ---------------------------------------------------------------------------
const CDP_RECORDER_SCRIPT = `
(function() {
  if (window.__tdRecorderActive) return;
  window.__tdRecorderActive = true;
  window.__tdTrainEvents = window.__tdTrainEvents || [];

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    if (el.getAttribute('aria-label')) return '[aria-label="' + el.getAttribute('aria-label') + '"]';
    var path = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.split(/\\\\s+/).filter(function(c) { return c && !c.startsWith('_'); }).slice(0, 2).join('.');
      if (cls) path += '.' + cls;
    }
    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
      if (siblings.length > 1) {
        var idx = siblings.indexOf(el) + 1;
        path += ':nth-child(' + idx + ')';
      }
    }
    return path;
  }

  function getAltSelectors(el) {
    var alts = [];
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || '').trim().substring(0, 50);
    var href = el.getAttribute('href') || '';
    
    // 1. Combined href + text selector (most specific for links)
    if (href && text && tag === 'a') {
      var shortText = text.substring(0, 20);
      alts.push(tag + '[href*="' + href.split('?')[0].split('/').pop() + '"]:has-text("' + shortText + '")');
    }
    
    // 2. Exact href match (highly deterministic)
    if (href) {
      alts.push(tag + '[href="' + href + '"]');
      // Partial href match (path only, no query params)
      var pathMatch = href.split('?')[0];
      if (pathMatch && pathMatch !== href) {
        alts.push(tag + '[href*="' + pathMatch.split('/').pop() + '"]');
      }
      // Short href match (just filename)
      var filename = href.split('/').pop().split('?')[0];
      if (filename && filename.length > 3) {
        alts.push(tag + '[href*="' + filename + '"]');
      }
    }
    
    // 3. Text-based selector (for buttons/links with text)
    if (text && text.length > 1 && text.length < 60) {
      alts.push(tag + ':has-text("' + text.substring(0, 30) + '")');
      // Exact text match variant
      alts.push(tag + ':text-is("' + text.substring(0, 30) + '")');
    }
    
    // 4. ARIA-based selectors (accessibility)
    var role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : null);
    var ariaLabel = el.getAttribute('aria-label');
    var ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabel) {
      alts.push(tag + '[aria-label="' + ariaLabel + '"]');
      if (role) alts.push('[role="' + role + '"][aria-label="' + ariaLabel + '"]');
    }
    if (ariaLabelledBy) {
      alts.push(tag + '[aria-labelledby="' + ariaLabelledBy + '"]');
    }
    
    // 5. Class-based with text (for styled buttons)
    var classes = el.className && typeof el.className === 'string' ? 
      el.className.split(/\\s+/).filter(function(c) { return c && !c.match(/^_/) && c.length > 2; }).slice(0, 2) : [];
    if (classes.length > 0 && text) {
      alts.push(tag + '.' + classes.join('.') + ':has-text("' + text.substring(0, 20) + '")');
    }
    
    // 6. Legacy format for backwards compatibility
    if (text) alts.push('text=' + text);
    if (role && (ariaLabel || text)) {
      alts.push('role=' + role + '[name="' + (ariaLabel || text).substring(0, 40) + '"]');
    }
    
    return alts;
  }

  // Checkbox/Radio — dedicated handler to capture checked state + label
  document.addEventListener('click', function(e) {
    var el = e.target;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      var label = (el.labels && el.labels[0]) ? el.labels[0].textContent.trim().substring(0, 60) : '';
      window.__tdTrainEvents.push({
        type: 'check', selector: getSelector(el), altSelectors: getAltSelectors(el),
        checked: el.checked, label: label, inputType: el.type,
        elementTag: el.tagName.toLowerCase(),
        url: location.href, timestamp: Date.now()
      });
    }
  }, true);

  // Generic click — skip checkboxes/radios (handled above)
  document.addEventListener('click', function(e) {
    var raw = e.target;
    if (raw.tagName === 'INPUT' && (raw.type === 'checkbox' || raw.type === 'radio')) return;
    var el = raw.closest('a, button, [role="button"], [role="link"], input[type="submit"], [onclick]') || raw;
    var selector = getSelector(el);
    var altSelectors = getAltSelectors(el);
    var text = (el.textContent || '').trim().substring(0, 60);
    var href = el.href || (el.closest('a') || {}).href || '';
    window.__tdTrainEvents.push({
      type: 'click', selector: selector, altSelectors: altSelectors,
      elementText: text, elementTag: el.tagName.toLowerCase(),
      href: href, url: location.href, timestamp: Date.now()
    });
  }, true);

  // Drag-and-drop — pointerdown/pointerup with 30px minimum distance
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

  // Scroll — debounced 500ms, 50px minimum delta
  var _scrollTimer = null;
  var _scrollStart = { x: window.scrollX, y: window.scrollY };
  document.addEventListener('scroll', function() {
    if (!_scrollTimer) {
      _scrollStart = { x: window.scrollX, y: window.scrollY };
    }
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
  }, true);

  document.addEventListener('change', function(e) {
    var el = e.target;
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) === -1) return;
    // Skip checkboxes/radios — already handled by the check listener
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;
    var selector = getSelector(el);
    window.__tdTrainEvents.push({
      type: el.tagName === 'SELECT' ? 'select' : 'fill',
      selector: selector, altSelectors: getAltSelectors(el),
      value: el.value, elementTag: el.tagName.toLowerCase(),
      url: location.href, timestamp: Date.now()
    });
  }, true);

  var lastUrl = location.href;
  setInterval(function() {
    if (location.href !== lastUrl) {
      window.__tdTrainEvents.push({
        type: 'navigate', url: location.href, previousUrl: lastUrl,
        pageTitle: document.title, timestamp: Date.now()
      });
      lastUrl = location.href;
    }
  }, 300);

  document.addEventListener('submit', function(e) {
    window.__tdTrainEvents.push({
      type: 'submit', selector: getSelector(e.target),
      url: location.href, timestamp: Date.now()
    });
  }, true);

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
  const { agentId } = args || {};

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (activeSessions.has(agentId)) return { ok: false, error: 'Training already in progress' };

  const agentFile = agentId.endsWith('.agent') ? `${agentId}.md` : `${agentId}.agent.md`;
  const agentPath = path.join(AGENTS_DIR, agentFile);
  if (!fs.existsSync(agentPath)) return { ok: false, error: `Agent not found: ${agentId}` };

  const descriptor = fs.readFileSync(agentPath, 'utf8');
  const startUrlMatch = descriptor.match(/^start_url:\s*(.+)$/m);
  if (!startUrlMatch) return { ok: false, error: 'Agent missing start_url' };

  const startUrl = startUrlMatch[1].trim();
  const hostname = new URL(startUrl).hostname.replace(/^www\./, '');
  const sessionId = `${agentId}_train`;

  const session = {
    agentId, hostname, startUrl, sessionId,
    rawEvents: [],
    startTime: Date.now(),
    pollInterval: null,
    cancelRequested: false,
  };
  activeSessions.set(agentId, session);

  logger.info(`[trainer.agent] Starting CDP recording for ${agentId} at ${startUrl}`);

  try {
    const { browserAct } = require('./browser.act.cjs');

    _postProgress(agentId, { type: 'training:start', hostname, startUrl });
    await browserAct({ action: 'navigate', url: startUrl, sessionId, headed: true, timeoutMs: 30000 });
    await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 }).catch(() => {});

    // Inject CDP recorder script via addScriptTag (persists in page main world)
    await browserAct({
      action: 'run-code', sessionId, headed: true, timeoutMs: 15000,
      code: `async page => { await page.addScriptTag({ content: ${JSON.stringify(CDP_RECORDER_SCRIPT)} }); return 'injected'; }`,
    });

    // Start polling for events
    _startEventPoller(session);

    // Emit initial step to UI
    _postProgress(agentId, {
      type: 'training:step-recorded',
      stepType: 'url',
      target: `${hostname} \u2192 Landing`,
      url: startUrl,
      pageTitle: hostname,
    });

    return { ok: true, agentId, message: 'Training recording started.' };
  } catch (err) {
    logger.error(`[trainer.agent] Start failed: ${err.message}`);
    activeSessions.delete(agentId);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Poll injected event array every 2s (serialised — no overlapping calls)
// Uses run-code with page.evaluate/page.addScriptTag for persistent state.
// ---------------------------------------------------------------------------
function _startEventPoller(session) {
  const { agentId, sessionId } = session;
  let lastIndex = 0;
  let polling = false; // lock to prevent concurrent poll cycles

  // Single run-code snippet that checks guard + reads events + re-injects if needed.
  // IMPORTANT: We JSON.stringify the result ourselves inside run-code and return a string
  // so that playwright-cli outputs it as a quoted string in ### Result.  Returning a raw
  // object from page.evaluate would let Playwright re-serialise it, but the run-code
  // wrapper only captures the outer return value — and when that value is an object
  // playwright-cli prints its own representation which can be truncated or reformatted.
  // By stringifying once here we get a single predictable escaped-JSON string.
  //
  // To avoid double-escape issues we do the JSON.stringify in the Node run-code context
  // (not inside page.evaluate) so only one serialisation layer exists.
  const POLL_CODE = `async page => {
    const active = await page.evaluate(() => !!window.__tdRecorderActive);
    if (!active) {
      await page.addScriptTag({ content: ${JSON.stringify(CDP_RECORDER_SCRIPT)} });
      return '__REINJECTED__';
    }
    const events = await page.evaluate(() => window.__tdTrainEvents || []);
    return JSON.stringify(events);
  }`;

  session.pollInterval = setInterval(async () => {
    if (session.cancelRequested) { clearInterval(session.pollInterval); return; }
    if (polling) return; // previous cycle still in flight
    polling = true;

    try {
      const { browserAct } = require('./browser.act.cjs');

      const result = await browserAct({
        action: 'run-code', sessionId, headed: true, timeoutMs: 15000,
        code: POLL_CODE,
      });

      logger.info(`[trainer.agent] poll: ok=${result.ok} resultType=${typeof result.result} resultLen=${(result.result||'').length} preview=${JSON.stringify((result.result||'').slice(0,80))}`);
      if (!result.ok || !result.result) { logger.info('[trainer.agent] poll: empty result, skipping'); polling = false; return; }

      const raw = result.result;

      // Sentinel: if we just re-injected, skip this cycle
      if (raw === '__REINJECTED__') {
        logger.info(`[trainer.agent] Re-injected CDP recorder after navigation`);
        polling = false;
        return;
      }

      // The run-code returns JSON.stringify(events) from Node context.
      // playwright-cli wraps it as: ### Result\n"<json-string-escaped>"\n
      // The result extractor strips outer quotes but leaves \" escapes intact.
      // So raw = [{\"type\":\"navigate\",...}] — this is a JSON-string body
      // without the surrounding quotes.  Re-wrapping in quotes and JSON.parse
      // correctly unescapes everything including nested quotes in altSelectors.
      let parsed;
      try {
        // First try direct parse (works if result extractor gave clean JSON)
        parsed = JSON.parse(raw);
      } catch {
        try {
          // Re-wrap as a JSON string value, then parse to get the unescaped string
          const unescaped = JSON.parse('"' + raw + '"');
          parsed = JSON.parse(unescaped);
        } catch (e2) {
          logger.warn(`[trainer.agent] poll JSON parse failed: ${e2.message} rawLen=${raw.length} raw=${JSON.stringify(raw.slice(0, 200))}`);
          polling = false; return;
        }
      }
      // If parsed is still a string (extra encoding layer), parse once more
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) {
          logger.warn(`[trainer.agent] poll double-parse failed: ${e.message}`);
          polling = false; return;
        }
      }

      // parsed should be the events array
      const events = Array.isArray(parsed) ? parsed : [];
      const newEvents = events.slice(lastIndex);
      logger.info(`[trainer.agent] poll: parsed ${events.length} events, ${newEvents.length} new (lastIndex=${lastIndex})`);
      lastIndex = events.length;

      for (const evt of newEvents) {
        // Deduplicate: skip same type+selector within 500ms
        const last = session.rawEvents[session.rawEvents.length - 1];
        if (last && last.type === evt.type && last.selector === evt.selector
            && Math.abs(evt.timestamp - last.timestamp) < 500) continue;

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
  switch (evt.type) {
    case 'navigate':
      return {
        stepType: 'url',
        target: `${evt.pageTitle || new URL(evt.url).pathname} \u2192 Page`,
        url: evt.url,
        pageTitle: evt.pageTitle,
      };
    case 'click':
      return {
        stepType: 'click',
        target: `${evt.elementText || evt.selector} \u2192 Clicked`,
        selector: evt.selector,
        url: evt.url,
      };
    case 'fill':
      return {
        stepType: 'fill',
        target: `${evt.selector} \u2192 "${(evt.value || '').substring(0, 30)}"`,
        selector: evt.selector,
        value: evt.value,
        url: evt.url,
      };
    case 'select':
      return {
        stepType: 'select',
        target: `${evt.selector} \u2192 Selected "${(evt.value || '').substring(0, 30)}"`,
        selector: evt.selector,
        value: evt.value,
        url: evt.url,
      };
    case 'submit':
      return {
        stepType: 'submit',
        target: `Form submitted`,
        selector: evt.selector,
        url: evt.url,
      };
    case 'check':
      return {
        stepType: 'check',
        target: `${evt.label || evt.selector} \u2192 ${evt.checked ? 'checked' : 'unchecked'}`,
        selector: evt.selector,
        url: evt.url,
      };
    case 'drag':
      return {
        stepType: 'drag',
        target: `${evt.fromSelector} \u2192 dragged ${evt.distance}px`,
        selector: evt.fromSelector,
        url: evt.url,
      };
    case 'scroll':
      return {
        stepType: 'scroll',
        target: `Scrolled ${evt.deltaY > 0 ? 'down' : 'up'} ${Math.abs(evt.deltaY)}px`,
        url: evt.url,
      };
    case 'extract':
      return {
        stepType: 'extract',
        target: `Extract "${evt.extractName}" from ${evt.selector}`,
        selector: evt.selector,
        extractName: evt.extractName,
        extractType: evt.extractType,
        url: evt.url,
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

  // Validate dot-name format
  if (!/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/.test(skillName)) {
    return { ok: false, error: 'Skill name must be dot-separated: agent.suffix (e.g. w3schools.editor)' };
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

    // Clean up session
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
      case 'check': return `${i + 1}. [CHECK] "${e.label || ''}" selector: ${e.selector} → ${e.checked ? 'checked' : 'unchecked'}`;
      case 'drag': return `${i + 1}. [DRAG] from ${e.fromSelector} (${e.fromX},${e.fromY}) → (${e.toX},${e.toY}) dist: ${e.distance}px`;
      case 'scroll': return `${i + 1}. [SCROLL] dy: ${e.deltaY}px (now at ${e.scrollY}/${e.pageHeight})`;
      case 'fill': return `${i + 1}. [FILL] ${e.selector} value: "${e.value || ''}"`;
      case 'select': return `${i + 1}. [SELECT] ${e.selector} value: "${e.value || ''}"`;
      case 'submit': return `${i + 1}. [SUBMIT] ${e.selector}`;
      case 'extract': return `${i + 1}. [EXTRACT] "${e.extractName}" from ${e.selector} (type: ${e.extractType || 'text'})`;
      default: return `${i + 1}. [${e.type}] ${e.selector || e.url}`;
    }
  }).join('\n');

  const prompt = `You are processing raw browser interaction events into a minimal waypoint recipe for browser automation.

AGENT: ${agentId}
START URL: ${startUrl}
SKILL NAME: ${skillName}

RAW EVENTS (in order):
${eventSummary}

Create a MINIMAL waypoint recipe. Rules:
1. Merge consecutive clicks that lead to the same page into a single navigate waypoint
2. Remove noise (duplicate navigations, insignificant clicks)
3. Each waypoint should represent a meaningful navigation step
4. The LAST waypoint is the TARGET — where the user wants the AI to start working
5. Include the primary CSS selector AND alternative selectors for each click waypoint
6. Include URL checkpoints for navigation waypoints
7. EXTRACT waypoints capture data from the page - preserve them for WALT tool returns

WAYPOINT TYPE CATALOG (use only what the workflow needs):
- navigate: { step, type: "navigate", url, pageTitle?, checkpoint? }
- click: { step, type: "click", selector, altSelectors[], elementText?, href?, expectedResult? }
- fill: { step, type: "fill", selector, value, elementText? }
- select: { step, type: "select", selector, value }
- check: { step, type: "check", selector, label?, checked? }
- drag: { step, type: "drag", fromSelector, fromX, fromY, toX, toY, distance }
- scroll: { step, type: "scroll", deltaY, scrollY?, pageHeight? }
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
// Cancel training — stop polling, close browser
// ---------------------------------------------------------------------------
function actionCancelTraining(args) {
  const { agentId } = args || {};

  const session = activeSessions.get(agentId);
  if (!session) return { ok: false, error: 'No active training session' };

  session.cancelRequested = true;
  if (session.pollInterval) clearInterval(session.pollInterval);

  // Close browser session
  const { browserAct } = require('./browser.act.cjs');
  browserAct({ action: 'close', sessionId: session.sessionId }).catch(() => {});

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
      return { name: recipe.name, target: recipe.targetDescription, waypoints: recipe.waypoints?.length || 0, created: recipe.created };
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
function findMatchingRecipe(agentId, taskText) {
  const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
  if (!fs.existsSync(skillDir)) return null;

  const normalized = taskText.toLowerCase().replace(/[\s_]+/g, '.');
  const taskLower = taskText.toLowerCase();
  const files = fs.readdirSync(skillDir).filter(f => f.endsWith('.recipe.json'));

  // Pass 1: exact name match in task text (original fuzzy match)
  for (const f of files) {
    const name = f.replace('.recipe.json', '');
    if (normalized.includes(name)) {
      try { return JSON.parse(fs.readFileSync(path.join(skillDir, f), 'utf8')); }
      catch { continue; }
    }
  }

  // Pass 2: match on targetDescription or targetUrl keywords
  for (const f of files) {
    try {
      const recipe = JSON.parse(fs.readFileSync(path.join(skillDir, f), 'utf8'));
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
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  actionTrain,
  actionSaveTraining,
  actionCancelTraining,
  actionListSkills,
  loadRecipe,
  findMatchingRecipe,
};
