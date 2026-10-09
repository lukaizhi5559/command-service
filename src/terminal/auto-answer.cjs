'use strict';

/**
 * terminal/auto-answer — decides whether a terminal prompt may be answered
 * on the user's behalf, and with what.
 *
 * Policy (from the approved routing/setup design):
 * - The SETUP lane may auto-answer SAFE prompts the plan already settled:
 *   generic [Y/n]/continue confirms → 'y'; arrow-key menus → accept the
 *   highlighted default (Enter). The user chose the setup — answering its
 *   consent-free prompts is executing their decision, not making a new one.
 * - NEVER auto-answer: passwords, passphrases, secrets, API keys, tokens,
 *   auth/verification/2FA/OTP codes, sudo, destructive or irreversible
 *   confirms, legal/consent prompts (license terms, authorize, grant access),
 *   and free-text inputs the plan didn't supply a value for.
 * - When in doubt, DO NOT answer — the prompt stays up for the user. A
 *   missed auto-answer costs seconds; a wrong one costs a credential leak.
 */

// Checked against the prompt line PLUS the trailing screen context — consent
// text often sits a line above the bare '?' prompt.
const NEVER_AUTO_RE = /password|passphrase|secret|api[\s_-]?key|access[\s_-]?key|access[\s_-]?token|bearer|token\s*[:=]|auth(?:entication|orization)?[\s_-]?(?:code|token|key)|verification\s+code|2fa|mfa|otp\b|one[\s-]?time|\[sudo\]|sudo\s+|private[\s_-]?key|ssh[\s_-]?key|fingerprint|credentials?|signing[\s_-]?key|client[\s_-]?secret|are you sure|cannot be undone|irreversible|permanently|delete\s+all|erase|wipe|destroy|format\s|rm\s+-rf|force\s+push|terms\s+of\s+(?:service|use)|license\s+agreement|eula|i\s+(?:agree|accept|consent|acknowledge)|authorize|grant\s+(?:access|permission)|do\s+you\s+trust|trust\s+this|legal/i;

// Generic confirmation — "…? [Y/n]", "Continue? (y/n)", "OK to proceed? yes/no".
const CONFIRM_RE = /\?\s*[\[(]?(?:y(?:es)?\s*[/|]\s*n(?:o)?|n(?:o)?\s*[/|]\s*y(?:es)?)[)\]]?\s*$/i;

// Arrow-key/menu TUIs — inquirer-style "› option" marker or the explicit hint.
const MENU_RE = /use\s+arrow\s+keys|\(arrow keys\)|[›❯→]\s*\S/i;

/**
 * classifyPromptLine — { kind: 'never'|'confirm'|'menu'|'input'|'other' }
 * `line` is the prompt's last visible line; `screen` the trailing context.
 */
function classifyPromptLine(line, screen) {
  const tail = `${line}\n${String(screen || '').split('\n').slice(-6).join('\n')}`;
  if (NEVER_AUTO_RE.test(tail)) return { kind: 'never', line };
  if (CONFIRM_RE.test(line)) return { kind: 'confirm', line };
  if (MENU_RE.test(tail)) return { kind: 'menu', line };
  if (/:\s*$/.test(line) || /\?\s*$/.test(line)) return { kind: 'input', line };
  return { kind: 'other', line };
}

/**
 * answerFor — the string to type for a classified prompt, or null.
 * directives: { confirm?: 'y'|'n'|true|false, select?: 'default'|true,
 *               inputs?: string[] } — set by the lane that owns the session.
 * confirm defaults to 'y' only when directives.enable is truthy — callers
 * must opt in per lane; nothing auto-answers unprompted.
 */
function answerFor(prompt, directives) {
  if (!prompt || prompt.kind === 'never' || !directives || !directives.enable) return null;
  switch (prompt.kind) {
    case 'confirm':
      if (directives.confirm === 'n') return 'n';
      if (directives.confirm === false) return null;
      return 'y';
    case 'menu':
      // Only the highlighted default is ever safe to accept — selecting a
      // specific option needs a directive value we don't guess at.
      return (directives.select === 'default' || directives.select === true) ? '\r' : null;
    case 'input':
      // Free-text input — only a queued directive value may fill it. A
      // consumed value must not be reused for a second prompt.
      if (Array.isArray(directives.inputs) && directives.inputs.length) {
        return directives.inputs.shift();
      }
      return null;
    default:
      return null;
  }
}

module.exports = { classifyPromptLine, answerFor, NEVER_AUTO_RE };
