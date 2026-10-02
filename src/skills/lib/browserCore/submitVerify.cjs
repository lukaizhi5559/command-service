'use strict';

// ---------------------------------------------------------------------------
// browserCore/submitVerify.cjs — post-submit verification, extracted from
// instruction.runner.cjs (deprecation: shared helpers move to browserCore
// leaves; the runner keeps a thin delegating export until it is gone).
//
// Fix vs. the runner copy: check 1 treated "no dialog candidate matched" as
// proof the compose closed — a false positive on routed composers (LinkedIn
// /sharing/compose) and when a non-compose overlay (audience dropdown)
// matched the selector first. Now ALL candidates are evaluated and a live
// editable surface counts as "compose still open"; absence is inconclusive,
// not success.
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');
const { browserAct } = require('../../browser.act.cjs');

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Returns { ok, reason }. ok=true means a submit signal was confirmed.
async function verifySubmitSuccess(sessionId, verifyText, preClickState) {
  try {
    await _sleep(1500); // wait for submit to take effect

    // 1. Compose surface gone? A compose is still open if ANY dialog-ish
    //    candidate reads as compose OR any editable field is still rendered —
    //    checking candidates one-by-one and not breaking on the first match,
    //    because a non-compose overlay (e.g. LinkedIn audience dropdown) can
    //    be found before the real composer.
    const composeGone = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        // Dialog candidates: ARIA + class-contains (LinkedIn's .share-box-modal
        // has no role=dialog — ARIA-only query false-positives "gone").
        const _dsel = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]';
        const _rendered = (d) => {
          if (!d.isConnected || (d.offsetParent === null && getComputedStyle(d).position !== 'fixed')) return false;
          const r = d.getBoundingClientRect();
          return r.width >= 100 && r.height >= 80;
        };
        let anyCompose = false;
        for (const d of document.querySelectorAll(_dsel)) {
          if (!_rendered(d)) continue;
          const text = (d.innerText || '').toLowerCase();
          const hasSendOrPost = !!d.querySelector('[data-tooltip*="Send" i], [aria-label*="Send" i], [data-tooltip*="Post" i], [aria-label*="Post" i]');
          // Social/email compose dialogs contain compose fields, placeholders, or submit buttons.
          if (/compose|recipient|subject|message body|what do you want to talk about|what's happening|new post|post to anyone|write a message|draft|share your thoughts/.test(text) || hasSendOrPost) {
            anyCompose = true; break;
          }
        }
        // Composer surface: a visible editable field is still mounted. This is
        // the ground truth for routed composers (linkedin.com/sharing/compose)
        // whose containers may not match the dialog selector at all.
        let composerPresent = false;
        for (const el of document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')) {
          if (!_rendered(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 100 && r.height >= 20) { composerPresent = true; break; }
        }
        const gone = !(anyCompose || composerPresent);
        return { gone, reason: gone ? 'no compose surface' : (anyCompose ? 'compose dialog still open' : 'composer field still visible') };
      })()`,
    });
    if (composeGone?.result?.gone) {
      logger.info(`[instruction.runner] Submit verified — compose surface gone`);
      return { ok: true, reason: 'compose_gone' };
    }
    if (composeGone?.result?.reason) {
      logger.info(`[instruction.runner] Submit verify: not gone — ${composeGone.result.reason}`);
    }

    // 2. URL changed away from compose?
    const urlCheck = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const url = window.location.href;
        const wasCompose = /compose|draft|new/.test(${JSON.stringify(preClickState?.url || '')});
        const isCompose = /compose|draft|new/.test(url);
        return { changed: wasCompose && !isCompose, url };
      })()`,
    });
    if (urlCheck?.result?.changed) {
      logger.info(`[instruction.runner] Submit verified — URL changed away from compose`);
      return { ok: true, reason: 'url_change' };
    }

    // 3. Success snackbar/toast?
    const snackbar = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const toast = document.querySelector('[role="status"], [role="alert"], .snackbar, .toast, [data-testid*="toast" i], [data-testid*="snackbar" i]');
        if (!toast) return { found: false };
        const text = (toast.innerText || '').toLowerCase();
        const successPatterns = ['sent', 'sending', 'posted', 'saved', 'submitted', 'done', 'success'];
        const matched = successPatterns.some(p => text.includes(p));
        return { found: matched, text: text.slice(0, 100) };
      })()`,
    });
    if (snackbar?.result?.found) {
      logger.info(`[instruction.runner] Submit verified — snackbar: "${snackbar.result.text}"`);
      return { ok: true, reason: 'snackbar' };
    }

    logger.warn(`[instruction.runner] Submit verification FAILED — compose still open, no URL change, no snackbar`);
    return { ok: false, reason: 'no verification signal' };
  } catch (e) {
    logger.warn(`[instruction.runner] Submit verification error (non-fatal): ${e.message}`);
    return { ok: true, reason: 'verify-error' }; // non-fatal — don't block on verify errors
  }
}

module.exports = { verifySubmitSuccess };
