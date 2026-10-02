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

// Press target: modifier chords + named keys + single chars. The tail is
// constrained to a single char or a known key name so `Press the button`
// can't parse — executor normalizes ctrl→Control, cmd→Meta, etc.
const _PRESS_KEY = '((?:(?:ctrl|control|cmd|command|meta|shift|alt|option)\\s*\\+\\s*)*(?:[a-z0-9]|enter|return|tab|escape|esc|space|backspace|delete|del|insert|ins|home|end|pageup|pagedown|pgup|pgdn|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|f\\d{1,2}))';
const _PRESS_RE = new RegExp(`^Press\\s+${_PRESS_KEY}\\s*$`, 'i');
const _PRESS_PREFIX_RE = new RegExp(`^Press\\s+${_PRESS_KEY}\\b\\s+\\S`, 'i');

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

  // Press <key> — Enter/Tab/Escape, arrows, chords (Ctrl+A, Cmd+Shift+K…)
  m = t.match(_PRESS_RE);
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
  // The grammar placeholder is literal "<javascript>" — LLMs echo it as a
  // wrapper tag around real code ("Run code: <javascript>\n…code…\n</javascript>").
  // Unwrap the tags; a bare placeholder with no body is unparseable (reprompt).
  m = t.match(/^Run\s+code:\s*([\s\S]+)$/i);
  if (m) {
    const _code = _unwrapCodePlaceholder(m[1]);
    return _code ? { action: 'run-code', code: _code } : null;
  }

  return null;
}

// Strip literal <javascript>/<js>/<code>/<script> wrapper tags (and closing
// tags / code fences) a model echoed around real code. Returns '' when the
// captured "code" was only the placeholder — caller treats as unparseable.
function _unwrapCodePlaceholder(code) {
  let c = String(code || '').trim();
  c = c.replace(/^<(?:javascript|js|code|script)>\s*/i, '');
  c = c.replace(/\s*<\/(?:javascript|js|code|script)>\s*$/i, '');
  c = c.replace(/^\s*```(?:javascript|js)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
  c = c.trim();
  // Reject anything still starting with a tag-ish token (never real JS).
  if (!c || /^<[a-z/!]/i.test(c)) return '';
  return c;
}

// Prefix salvage: extract a valid action prefix from a line followed by
// explanatory prose (e.g. `Click "Compose" to open the dialog.`). Only runs
// after strict grammar fails — trailing prose is discarded.
function _matchActionPrefix(line) {
  if (!line) return null;
  const _l = line.replace(/\*\*/g, '').trim();
  let m = _l.match(/^Click\s+"([^"]+)"\s+\S/i);
  if (m) return { action: 'click', target: m[1] };
  m = _l.match(_PRESS_PREFIX_RE);
  if (m) return { action: 'press', key: m[1] };
  m = _l.match(_TYPE_PREFIX_RE);
  if (m) return { action: 'type', value: m[1], target: m[2] };
  m = _l.match(/^Navigate\s+to\s+(https?:\/\/\S+)/i);
  if (m) return { action: 'navigate', url: m[1] };
  m = _l.match(/^Run\s+code:\s*(\S[\s\S]*)$/i);
  if (m) {
    const _code = _unwrapCodePlaceholder(m[1]);
    return _code ? { action: 'run-code', code: _code } : null;
  }
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
  // Verb lines iterate BOTTOM-UP: CoT-style responses state a candidate action,
  // reason, then emit the corrected final action last — the last line is the
  // answer (observed: `Click "Post to Anyone"... Wait... Click "Po t" button`
  // salvaged the rejected first line and clicked the audience selector).
  for (let i = _lines.length - 1; i >= 0; i--) {
    const l = _lines[i];
    // NOTE: `Run\s+code` must NOT keep the literal `:` in the alternation —
    // `\b` after a non-word `:` never matches before a space, which made
    // Run-code actions unreachable (observed: "Could not parse LLM action").
    if (/^(Click|Type|Press|Navigate|Wait|Get|Scroll|Screenshot|Run\s+code|Done)\b/i.test(l)) {
      // Run code: the code body can span following lines (e.g. wrapped in
      // <javascript>…</javascript>) — a line-only candidate captures just the
      // placeholder. Push the rest of the reply so the grammar can unwrap it.
      if (/^Run\s+code\b/i.test(l) && i < _lines.length - 1) _candidates.push(_lines.slice(i).join('\n'));
      _candidates.push(l);
    }
  }
  // Embedded-action suffixes: `Type "...` / `Click "...` / `Press X` appearing
  // mid-line. Push rightmost-first, lines bottom-up — in "Wait, I need to
  // reconsider ... Type X" the final embedded action is the corrected intent.
  for (let li = _lines.length - 1; li >= 0; li--) {
    const l = _lines[li];
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
