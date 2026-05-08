'use strict';
// ---------------------------------------------------------------------------
// visualFeedback.js — DOM injection utilities for learn mode visual highlights
//
// Injected into the browser page via playwright-cli run-code action.
// Blue outlines = all extracted elements; Green = active element being executed.
// ---------------------------------------------------------------------------

const INJECT_STYLES_CODE = `async (page) => {
  await page.evaluate(() => {
    const existing = document.getElementById('thinkdrop-learn-styles');
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = 'thinkdrop-learn-styles';
    style.textContent = \`
      .thinkdrop-learn-highlight {
        outline: 3px solid #3b82f6 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 15px rgba(59,130,246,0.5) !important;
        position: relative !important;
        z-index: 999999 !important;
      }
      .thinkdrop-learn-highlight::after {
        content: attr(data-skill-name);
        position: absolute;
        top: -22px;
        left: 0;
        background: #3b82f6;
        color: #fff;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-family: system-ui, sans-serif;
        white-space: nowrap;
        z-index: 9999999;
        pointer-events: none;
      }
      .thinkdrop-learn-active {
        outline: 3px solid #10b981 !important;
        box-shadow: 0 0 20px rgba(16,185,129,0.6) !important;
        background: rgba(16,185,129,0.08) !important;
        z-index: 999999 !important;
        position: relative !important;
      }
    \`;
    document.head.appendChild(style);
    return 'styles_injected';
  });
}`;

/**
 * Returns run-code snippet that highlights all extracted elements (blue outline).
 * Self-contained: injects CSS styles + resolves elements in one run-code call.
 * Uses playwright page.locator() to resolve [ref=eNNN] accessibility refs — these are NOT DOM selectors.
 * @param {Array<{selector: string, skillName: string, label: string}>} elements
 */
function buildHighlightAllCode(elements) {
  const payload = JSON.stringify(elements.map(e => ({
    s: e.selector || e.primary,
    n: e.skillName || e.skill_name || e.label || '',
  })));
  return `async (page) => {
  // Inject/refresh CSS styles first so highlights are always visible
  await page.evaluate(() => {
    const existing = document.getElementById('thinkdrop-learn-styles');
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = 'thinkdrop-learn-styles';
    style.textContent = \`
      .thinkdrop-learn-highlight {
        outline: 3px solid #3b82f6 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 15px rgba(59,130,246,0.5) !important;
        position: relative !important;
        z-index: 999999 !important;
      }
      .thinkdrop-learn-highlight::after {
        content: attr(data-skill-name);
        position: absolute;
        top: -22px;
        left: 0;
        background: #3b82f6;
        color: #fff;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-family: system-ui, sans-serif;
        white-space: nowrap;
        z-index: 9999999;
        pointer-events: none;
      }
      .thinkdrop-learn-active {
        outline: 3px solid #10b981 !important;
        box-shadow: 0 0 20px rgba(16,185,129,0.6) !important;
        background: rgba(16,185,129,0.08) !important;
        z-index: 999999 !important;
        position: relative !important;
      }
    \`;
    document.head.appendChild(style);
    // Clear previous highlights
    document.querySelectorAll('.thinkdrop-learn-highlight').forEach(el => {
      el.classList.remove('thinkdrop-learn-highlight');
      el.removeAttribute('data-skill-name');
    });
  });
  const els = ${payload};
  // Resolve all elements in parallel (100ms each) to stay well under run-code timeout
  const results = await Promise.allSettled(
    els.map(({ s, n }) =>
      page.locator(s).first().elementHandle({ timeout: 100 })
        .then(handle => handle
          ? handle.evaluate((el, label) => {
              el.classList.add('thinkdrop-learn-highlight');
              if (label) el.setAttribute('data-skill-name', label);
            }, n)
          : null
        ).catch(() => null)
    )
  );
  return results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
}`;
}

/**
 * Returns run-code snippet that highlights the active element being executed (green).
 * Uses playwright page.locator() to resolve [ref=eNNN] accessibility refs.
 * @param {string} selector - playwright selector (e.g. [ref=e44])
 * @param {string} [label] - optional human-readable label for tooltip
 */
function buildHighlightActiveCode(selector, label) {
  const safeLabel = label ? String(label).replace(/"/g, '\\"').slice(0, 60) : '';
  return `async (page) => {
  // Clear previous active highlights
  await page.evaluate(() => {
    document.querySelectorAll('.thinkdrop-learn-active').forEach(el => {
      el.classList.remove('thinkdrop-learn-active');
    });
  });
  try {
    const handle = await page.locator(${JSON.stringify(selector)}).first().elementHandle({ timeout: 800 }).catch(() => null);
    if (handle) {
      await handle.evaluate((el, lbl) => {
        el.classList.add('thinkdrop-learn-active');
        if (lbl) el.setAttribute('data-skill-name', lbl);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, ${JSON.stringify(safeLabel)}).catch(() => {});
      return 'highlighted';
    }
  } catch (_) {}
  return 'not_found';
}`;
}

/**
 * Returns run-code snippet that clears all visual feedback.
 */
function buildClearHighlightsCode() {
  return `async (page) => {
  await page.evaluate(() => {
    document.querySelectorAll('.thinkdrop-learn-highlight, .thinkdrop-learn-active').forEach(el => {
      el.classList.remove('thinkdrop-learn-highlight', 'thinkdrop-learn-active');
      el.removeAttribute('data-skill-name');
    });
    const style = document.getElementById('thinkdrop-learn-styles');
    if (style) style.remove();
    return 'cleared';
  });
}`;
}

module.exports = {
  INJECT_STYLES_CODE,
  buildHighlightAllCode,
  buildHighlightActiveCode,
  buildClearHighlightsCode,
};
