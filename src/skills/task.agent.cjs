'use strict';

/**
 * task.agent.cjs — task-level observe→decide→execute loop (pilot).
 *
 * Instead of executing a pre-written step list with {{token}} placeholders,
 * this loop carries the whole task as a goal, calls registered skills
 * directly each turn, and keeps results inside the LLM context — the same
 * seam-free pattern cli.agent's generic loop uses, promoted to task scope.
 *
 * Scope (pilot): local-class plan tasks only — the stategraph emits a single
 * task.agent step for _planTask dispatches behind THINKDROP_TASK_AGENT=1.
 * Shell actions run in a labeled PTY session (visible in the Terminal pane);
 * skill calls report per-turn progress via _progressCallbackUrl.
 *
 * Contract: done returns stdout = the task's data product (largest observed
 * skill/command output, or the LLM's verbatim result); summary = narration.
 * ask_user returns {ok:false, askUser:true, question, options} which
 * executeCommand surfaces as a pending-question card.
 */

const http = require('http');
const logger = require('../logger.cjs');
const { terminalAgent } = require('./terminal.agent.cjs');
const termStore = require('../terminal/session-store.cjs');

const AGENT_ID = 'task.agent';
const MAX_TURNS = 14;
const OBSERVATION_CHARS = 4000;
const PROMPT_OBS_CHARS = 1200;
const RESULT_CHARS = 20000;

// Skills the loop may call — registered command-service skills only. The
// catalog is rendered into the system prompt; unknown names are rejected.
const CALLABLE_SKILLS = [
  ['doc.read',          'extract text from document files (.pdf/.docx/.xlsx/.pptx/.doc/.rtf/.odt) — ALWAYS for documents, never a shell converter'],
  ['fs.read',           'read a local text/code file, list a directory tree'],
  ['shell.run',         'one local shell command (non-interactive)'],
  ['edit.agent',        'edit/create project files with backup+diff rails'],
  ['file.bridge',       'write content to a file'],
  ['image.analyze',     'describe/OCR an image file'],
  ['media.transcribe',  'transcribe an audio/video file'],
  ['web.crawl',         'fetch readable text from a public URL'],
  ['web.agent',         'web search / research / locate public URLs'],
  ['cli.agent',         'run a configured CLI agent (gh, aws, yt-dlp, …)'],
  ['system.introspect', 'inspect apps/windows/files on this Mac'],
  ['user.agent',        'resolve the user\'s personal data (name/email/phone)'],
];

const LOOP_PROMPT = `You are ThinkDrop's task executor. Complete ONE task by calling
tools — one action per turn. You observe each result and decide the next call;
data stays in this conversation — never route output through placeholders.

Reply with ONLY one JSON object:

  {"action":"skill","skill":"doc.read","args":{"path":"/abs/file.pdf"},"thinking":"why"}
     — call a registered skill. Prefer skills over shell when one fits.
  {"action":"shell","cmd":"pdftotext '/abs/f.pdf' - | head -50","thinking":"why"}
     — run a shell command in the user's VISIBLE terminal (they watch it live).
       Use when no skill fits or a skill just failed.
  {"action":"done","summary":"one-line status","result":"the task's data product"}
     — task complete. summary is narration for humans. result carries the data
       verbatim when it fits (~1500 chars); for bulk output the largest observed
       tool output is captured automatically — just say where it came from.
  {"action":"ask_user","question":"...","options":[]}
     — blocked on something only the user can supply (choice, credential, file).

Rules:
- Documents: use doc.read — it owns pdf/docx/xlsx/pptx extraction. Pandoc CANNOT
  read PDFs; do not reach for it.
- Plain text/code files: fs.read. Binary documents: doc.read. Audio/video:
  media.transcribe.
- Prefer a registered skill over improvising shell; shell is the fallback.
- NEVER repeat an identical failed call — change args or switch tools.
- When the task's answer is already in an observed result, call done NOW —
  do not run redundant verification commands.
- Paths must be absolute. Quote paths that contain spaces or non-ASCII chars.`;

async function _callLLM(systemPrompt, userPrompt, { temperature = 0.1, maxTokens = 500 } = {}) {
  try {
    const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
    return await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature, maxTokens, taskType: 'skill_step', responseTimeoutMs: 60000 }) || null;
  } catch (e) {
    logger.warn(`[task.agent] callLLM failed: ${e.message}`);
    return null;
  }
}

function _parseAction(raw) {
  if (!raw) return null;
  try {
    const m = String(raw).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (_) {
    return null;
  }
}

function _post(urlStr, payload) {
  try {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname, port: parseInt(u.port, 10),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

const _ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
function _ptyDeltaText(delta, echo) {
  return String(delta || '')
    .replace(_ANSI_RE, '')
    .split('\n')
    .map(l => l.replace(/\r/g, ''))
    .filter(l => l.trim() && !l.includes('__TD_EXIT_') && !(echo && l.includes(echo)))
    .join('\n')
    .trim();
}

// Canonical data-product extraction — mirror of skill-contract.cjs's fallback
// chain, applied to the raw (pre-wire) skill return.
function _dataOf(res) {
  if (!res || typeof res !== 'object') return typeof res === 'string' ? res : '';
  if (typeof res.stdout === 'string' && res.stdout) return res.stdout;
  if (typeof res.result === 'string' && res.result) return res.result;
  if (res.result && typeof res.result === 'object') return JSON.stringify(res.result);
  if (typeof res.text === 'string' && res.text) return res.text;
  if (typeof res.content === 'string' && res.content) return res.content;
  return '';
}

function _buildTurnUser(task, history) {
  const lines = history.length === 0
    ? '(no actions yet — this is turn 1)'
    : history.map(h => {
        const call = h.action === 'skill' ? `${h.skill}(${JSON.stringify(h.args || {}).slice(0, 160)})`
                 : h.action === 'shell' ? `shell: ${h.cmd}`
                 : h.action;
        return `turn ${h.turn}: ${call}\n  → ${String(h.observation || '').slice(0, PROMPT_OBS_CHARS)}`;
      }).join('\n');
  return `TASK: ${task}\n\nHISTORY:\n${lines}\n\nNext action (one JSON object):`;
}

async function taskAgent(args = {}, deps = {}) {
  const { task, cwd, env, timeoutMs, _progressCallbackUrl, _stepIndex } = args;
  const runSkill = typeof deps.runSkill === 'function' ? deps.runSkill : null;
  if (!task || typeof task !== 'string') {
    return { ok: false, agentId: AGENT_ID, error: 'task.agent requires args.task (string)' };
  }
  if (!runSkill) {
    return { ok: false, agentId: AGENT_ID, error: 'task.agent requires deps.runSkill (skill dispatcher)' };
  }

  // Prior plan-task outputs — text context, not a token channel.
  const prior = Array.isArray(args.priorResults) && args.priorResults.length
    ? `\n\nPRIOR TASK RESULTS (context):\n${args.priorResults
        .map(p => `[task ${p.taskNum}] ${String(p.result || '').slice(0, 3000)}`).join('\n')}`
    : '';
  const fullTask = task + prior;

  const catalog = CALLABLE_SKILLS.map(([n, d]) => `  ${n} — ${d}`).join('\n');
  const systemPrompt = `${LOOP_PROMPT}\n\nAVAILABLE SKILLS:\n${catalog}\n\nCurrent date/time: ${new Date().toISOString()} (${process.env.TZ || 'local'})`;

  const history = [];
  const transcript = [];
  const failedSigs = new Map();
  let _bestOutput = '';
  const _track = (t) => { if (typeof t === 'string' && t.length > _bestOutput.length) _bestOutput = t; };

  // Visible PTY session for shell actions — same pattern as cli.agent's loop:
  // labeled session, managedBy:'agent', every command streams to the pane.
  let _ptySessionId = null;
  let _ptyDead = false;
  const _ensurePty = async () => {
    if (_ptySessionId) return _ptySessionId;
    if (_ptyDead) throw new Error('pty-unavailable');
    const label = `task: ${String(task).slice(0, 48)}`;
    const r = await terminalAgent({ action: 'open', label, managedBy: 'agent' });
    if (!r?.ok || !r.sessionId) { _ptyDead = true; throw new Error(r?.error || 'pty-open-failed'); }
    _ptySessionId = r.sessionId;
    return _ptySessionId;
  };

  const _emit = (turn, currentAction, thinking) => {
    if (_progressCallbackUrl) {
      _post(_progressCallbackUrl, {
        type: 'agent:turn_live', agentId: AGENT_ID, turn, maxTurns: MAX_TURNS,
        stepIndex: _stepIndex ?? 0, currentAction, thinking: thinking || null,
      });
    }
  };

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      _emit(turn, 'thinking', null);

      const raw = await _callLLM(systemPrompt, _buildTurnUser(fullTask, history));
      const action = _parseAction(raw);
      if (!action || !action.action) {
        history.push({ turn, action: 'llm', observation: `unparseable LLM reply: ${String(raw || 'null').slice(0, 300)} — reply with ONE JSON action` });
        continue;
      }
      _emit(turn, `${action.action}${action.skill ? ':' + action.skill : ''}`, action.thinking);

      let observation = '';

      if (action.action === 'done') {
        transcript.push({ turn, action, outcome: { ok: true } });
        return {
          ok: true, agentId: AGENT_ID, task,
          stdout: action.result || _bestOutput || action.summary || '',
          summary: action.summary || '',
          agentTurns: turn, transcript,
        };
      }

      if (action.action === 'ask_user') {
        transcript.push({ turn, action, outcome: { ok: false, askUser: true } });
        return {
          ok: false, agentId: AGENT_ID, task, askUser: true,
          question: action.question || 'The task needs your input.',
          options: Array.isArray(action.options) ? action.options : [],
          agentTurns: turn, transcript,
        };
      }

      // Loop guard — identical failed call signature twice → force a change.
      const sig = `${action.action}:${action.skill || ''}:${JSON.stringify(action.args || action.cmd || '')}`;

      if (action.action === 'skill') {
        const skill = String(action.skill || '');
        if (skill === AGENT_ID) {
          observation = 'task.agent cannot call itself';
        } else if (!CALLABLE_SKILLS.some(([n]) => n === skill)) {
          observation = `unknown skill "${skill}" — use one of: ${CALLABLE_SKILLS.map(([n]) => n).join(', ')}`;
        } else {
          try {
            const res = await runSkill(skill, action.args || {});
            const data = _dataOf(res);
            if (res && (res.ok === true || res.success === true || res.ok === undefined)) {
              _track(data);
              observation = `${skill} ok:\n${String(data || res.summary || '(no output)').slice(0, OBSERVATION_CHARS)}`;
            } else {
              observation = `${skill} failed: ${res?.error || res?.summary || 'unknown error'}${data ? `\npartial output: ${data.slice(0, 500)}` : ''}`;
            }
          } catch (e) {
            observation = `${skill} threw: ${e.message}`;
          }
        }
      } else if (action.action === 'shell') {
        const cmd = String(action.cmd || '').trim();
        if (!cmd) {
          observation = 'shell: cmd is required';
        } else {
          // Visible PTY first — the command streams into the Terminal pane.
          let ran = false;
          try {
            const sid = await _ensurePty();
            const r = await terminalAgent({
              action: 'exec', sessionId: sid, cmd,
              timeoutMs: action.timeoutMs || timeoutMs || 60000,
              keepSession: true, cwd: cwd || undefined, env: env || undefined,
              _progressCallbackUrl,
            });
            if (r && r.ok !== undefined) {
              ran = true;
              const out = _ptyDeltaText(r.delta, cmd) || (r.screen || '');
              if (r.ok && r.exitCode === 0) _track(out);
              observation = `exitCode=${r.exitCode}\n${String(out).slice(0, OBSERVATION_CHARS)}`;
            }
          } catch (_) { /* fall through to shell.run */ }
          if (!ran) {
            try {
              const res = await runSkill('shell.run', { cmd: 'bash', argv: ['-c', cmd], cwd, env, timeoutMs: action.timeoutMs || timeoutMs || 60000 });
              const out = [res?.stdout, res?.stderr].filter(Boolean).join('\n');
              if (res && (res.exitCode === 0 || res.ok)) _track(res?.stdout || out);
              observation = `exitCode=${res?.exitCode ?? (res?.ok ? 0 : 1)}\n${String(out || res?.error || '').slice(0, OBSERVATION_CHARS)}`;
            } catch (e) {
              observation = `shell error: ${e.message}`;
            }
          }
        }
      } else {
        observation = `unknown action "${action.action}" — use skill | shell | done | ask_user`;
      }

      const failed = /failed|error|unknown|unparseable/i.test(observation.slice(0, 60));
      if (failed) {
        const n = (failedSigs.get(sig) || 0) + 1;
        failedSigs.set(sig, n);
        if (n >= 2) observation += `\n[LOOP GUARD] This exact call failed ${n} times — change the approach or ask_user.`;
      }

      history.push({ turn, ...action, observation: String(observation).slice(0, PROMPT_OBS_CHARS) });
      transcript.push({ turn, action, observation: String(observation).slice(0, 500), outcome: { ok: !failed } });
    }
  } finally {
    if (_ptySessionId) {
      try { termStore.close(_ptySessionId); } catch (_) {}
    }
  }

  return {
    ok: false, agentId: AGENT_ID, task,
    error: `task.agent reached MAX_TURNS (${MAX_TURNS}) without completing`,
    stdout: _bestOutput || undefined,
    agentTurns: MAX_TURNS, transcript,
  };
}

module.exports = { taskAgent, LOOP_PROMPT, CALLABLE_SKILLS };
