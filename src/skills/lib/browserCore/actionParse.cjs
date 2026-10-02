// actionParse.cjs — strict grammar + prose-tolerant parsing for LLM action
// output. Extracted from instruction.runner.cjs so both the tab-map loop and
// the playwright turn loop share one hardened parser. Leaf module: logger only.

const logger = require('../../../logger.cjs');

// Tempered type-value: the value may contain newlines and embedded quotes
// (email bodies, code) but may NOT contain a second `" into the "` anchor —
// that means the LLM emitted prose/self-correction with a second action phrase
// and greedy capture would swallow reasoning text as the "value" (observed:
// `Type "" into the "Subject" field Wait, I need to reconsider... Type "Good
// night" into the "Subject" field` typed the prose verbatim into Subject).
const _TYPE_VALUE = '((?:(?!" into the ")[\\s\\S])+)';
// Target allows "" — unnamed fillables (LinkedIn Quill composer has no
// text/aria-label) resolve deterministically at execute time. Value stays +
// (an empty value is never a real action).
const _TYPE_RE = new RegExp(`^Type\\s+"${_TYPE_VALUE}"\\s+into\\s+(?:the\\s+)?"([^"]*)"\\s+field\\s*$`, 'i');
const _TYPE_PREFIX_RE = new RegExp(`^Type\\s+"${_TYPE_VALUE}"\\s+into\\s+(?:the\\s+)?"([^"]*)"\\s+field\\b`, 'i');
const _TYPE_BARE_RE = new RegExp(`^Type\\s+"${_TYPE_VALUE}"\\s*$`, 'i');

function _matchActionGrammar(t) {
  if (!t) return null;

  // DONE
  if (/^done$/i.test(t)) return { action: 'done' };

  // Click "button text"
  let m = t.match(/^Click\s+"([^"]+)"\s*$/i);
  if (m) return { action: 'click', target: m[1] };

  // Type "value" into the "field" field  (empty "" target → unnamed fillable)
  m = t.match(_TYPE_RE);
  if (m) return { action: 'type', value: m[1], target: m[2] };

  // Type "value" — bare form: type into the focused/sole fillable
  m = t.match(_TYPE_BARE_RE);
  if (m) return { action: 'type', value: m[1], target: '' };

  // Press Enter / Tab / Escape
  m = t.match(/^Press\s+(Enter|Tab|Escape)\s*$/i);
  if (m) return { action: 'press', key: m[1] };

  // Navigate to URL
  m = t.match(/^Navigate\s+to\s+(https?:\/\/\S+)\s*$/i);
  if (m) return { action: 'navigate', url: m[1] };

  // Wait for stable text
  if (/^Wait\s+for\s+stable\s+text\s*$/i.test(t)) return { action: 'waitForStableText' };

  // Get page text
  if (/^Get\s+page\s+text\s*$/i.test(t)) return { action: 'getPageText' };

  // Scroll down / Scroll up
  m = t.match(/^Scroll\s+(down|up)\s*$/i);
  if (m) return { action: 'scroll', direction: m[1].toLowerCase() };

  // Screenshot
  if (/^Screenshot\s*$/i.test(t)) return { action: 'screenshot' };

  // Run code: <javascript>
  m = t.match(/^Run\s+code:\s*([\s\S]+)$/i);
  if (m) return { action: 'run-code', code: m[1].trim() };

  return null;
}

// Prefix salvage: extract a valid action prefix from a line followed by
// explanatory prose (e.g. `Click "Compose" to open the dialog.`). Only runs
// after strict grammar fails — trailing prose is discarded.
function _matchActionPrefix(line) {
  if (!line) return null;
  const _l = line.replace(/\*\*/g, '').trim();
  let m = _l.match(/^Click\s+"([^"]+)"\s+\S/i);
  if (m) return { action: 'click', target: m[1] };
  m = _l.match(/^Press\s+(Enter|Tab|Escape)\b\s+\S/i);
  if (m) return { action: 'press', key: m[1] };
  m = _l.match(_TYPE_PREFIX_RE);
  if (m) return { action: 'type', value: m[1], target: m[2] };
  m = _l.match(/^Navigate\s+to\s+(https?:\/\/\S+)/i);
  if (m) return { action: 'navigate', url: m[1] };
  m = _l.match(/^Run\s+code:\s*(\S[\s\S]*)$/i);
  if (m) return { action: 'run-code', code: m[1].trim() };
  return null;
}

// Positions inside a line where a quoted action verb begins — used to recover
// the corrected action from single-line self-correction prose like:
//   Type "" into the "Subject" field Wait, reconsider... Type "Good night" into the "Subject" field
const _EMBEDDED_VERB_RE = /\b(?:Type|Click|Press|Run\s+code)\s*/gi;

function _parseAction(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();

  // 1. Strict grammar on the full text.
  const _direct = _matchActionGrammar(t);
  if (_direct) return _sanitize(_direct);

  // 2. Prose extraction — chatty LLMs prepend reasoning or repeat the action.
  //    Build ALL candidate action lines (Action: line + every verb line) plus
  //    embedded-action suffixes (handles one-line self-corrections where the
  //    last action is the intended one). Strict-parse each — first wins.
  const _lines = t.split('\n').map(l => l.replace(/\*\*/g, '').trim()).filter(Boolean);
  const _candidates = [];
  for (const l of _lines) {
    const _am = l.match(/^Action:\s*(.*)$/i);
    if (_am && _am[1]) _candidates.push(_am[1].trim());
  }
  for (const l of _lines) {
    // NOTE: `Run\s+code` must NOT keep the literal `:` in the alternation —
    // `\b` after a non-word `:` never matches before a space, which made
    // Run-code actions unreachable (observed: "Could not parse LLM action").
    if (/^(Click|Type|Press|Navigate|Wait|Get|Scroll|Screenshot|Run\s+code|Done)\b/i.test(l)) _candidates.push(l);
  }
  // Embedded-action suffixes: `Type "...` / `Click "...` / `Press X` appearing
  // mid-line. Push rightmost-first — in "Wait, I need to reconsider ... Type X"
  // the final embedded action is the corrected intent.
  for (const l of _lines) {
    const positions = [];
    _EMBEDDED_VERB_RE.lastIndex = 0;
    let em;
    while ((em = _EMBEDDED_VERB_RE.exec(l)) !== null) {
      if (em.index > 0) positions.push(em.index);
      if (em.index === l.lastIndex) break;
    }
    for (let i = positions.length - 1; i >= 0; i--) _candidates.push(l.slice(positions[i]));
  }
  for (const c of _candidates) {
    const p = _sanitize(_matchActionGrammar(c));
    if (p) {
      logger.info(`[instruction.runner] _parseAction: extracted action line "${c.slice(0, 80)}" from prose`);
      return p;
    }
    const pp = _sanitize(_matchActionPrefix(c));
    if (pp) {
      logger.info(`[instruction.runner] _parseAction: salvaged action prefix from "${c.slice(0, 80)}"`);
      return pp;
    }
  }

  // 3. Multi-line Type fallback — values spanning newlines (email bodies) fail
  //    line-splitting above; the anchored greedy-ish match handles them. Runs
  //    AFTER candidates so prose can't be captured as a value.
  const _mlType = t.match(_TYPE_RE);
  if (_mlType) return _sanitize({ action: 'type', value: _mlType[1], target: _mlType[2] });

  logger.info(`[instruction.runner] _parseAction: no parseable action in "${t.slice(0, 80)}"`);
  return null;
}

// Reject values that still contain a nested action anchor — prose contamination.
function _sanitize(parsed) {
  if (!parsed) return null;
  if (parsed.action === 'type' && typeof parsed.value === 'string' && /" into the "/i.test(parsed.value)) {
    logger.warn(`[instruction.runner] _parseAction: rejecting garbled type value "${parsed.value.slice(0, 60)}"`);
    return null;
  }
  return parsed;
}

module.exports = { _parseAction, _matchActionGrammar, _matchActionPrefix };
