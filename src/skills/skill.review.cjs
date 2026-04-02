'use strict';
/**
 * skill.review — ThinkDrop skill health review agent
 *
 * Scans installed skills for structural validity and auto-repairs
 * exec_type/exec_path frontmatter mismatches.
 *
 * Actions:
 *   scan_all      — validate all installed skills, write skill_health records
 *   validate_one  — validate a single skill by name
 *   repair_one    — deterministically repair exec_type/exec_path mismatch + re-register
 *
 * Called at command-service startup (scan_all) and on-demand.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEMORY_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const MEMORY_KEY  = process.env.MCP_USER_MEMORY_API_KEY || '';

// ── MCP HTTP helper ───────────────────────────────────────────────────────────

function mcpPost(action, payload, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action,
      payload,
    });
    const req = http.request({
      hostname: MEMORY_HOST,
      port    : MEMORY_PORT,
      path    : `/${action}`,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${MEMORY_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Frontmatter helpers ───────────────────────────────────────────────────────

function parseFrontmatterField(md, field) {
  const m = md.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Validate structural consistency of a skill contract.
 * Returns { ok: bool, errors: string[] }
 */
function validateSkillContract(contractMd, execPath) {
  const errors = [];

  if (!contractMd) {
    errors.push('contract_md is empty');
    return { ok: false, errors };
  }

  const execType = parseFrontmatterField(contractMd, 'exec_type');
  const fmExecPath = parseFrontmatterField(contractMd, 'exec_path');

  if (!execType) errors.push('Missing exec_type in frontmatter');
  if (!fmExecPath) errors.push('Missing exec_path in frontmatter');

  // Cross-field consistency
  const resolvedPath = execPath || (fmExecPath
    ? fmExecPath.replace(/^~/, os.homedir())
    : '');

  if (execType === 'node' && resolvedPath.endsWith('.md')) {
    errors.push(`exec_type 'node' but exec_path points to .md file — should be exec_type: shell`);
  }
  if ((resolvedPath.endsWith('.cjs') || resolvedPath.endsWith('.js')) && execType !== 'node') {
    errors.push(`exec_path is a JS file but exec_type is '${execType}' — should be exec_type: node`);
  }

  // exec_path file existence check
  if (resolvedPath && !fs.existsSync(resolvedPath)) {
    errors.push(`exec_path file does not exist on disk: ${resolvedPath}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Deterministically repair exec_type/exec_path mismatch in a skill.md file.
 * Only repairs the frontmatter — does NOT modify the skill logic.
 * Returns { repaired: bool, newExecType, newExecPath, error? }
 */
function repairFrontmatter(contractMd, skillName) {
  const fmExecPath = parseFrontmatterField(contractMd, 'exec_path');
  const fmExecType = parseFrontmatterField(contractMd, 'exec_type');

  if (!fmExecPath || !fmExecType) {
    return { repaired: false, error: 'Cannot repair — missing exec_type or exec_path in frontmatter' };
  }

  // Determine correct type by file extension (authoritative)
  const resolvedPath = fmExecPath.replace(/^~/, os.homedir());
  let correctType;
  if (resolvedPath.endsWith('.md')) {
    correctType = 'shell';
  } else if (resolvedPath.endsWith('.cjs') || resolvedPath.endsWith('.js')) {
    correctType = 'node';
  } else {
    return { repaired: false, error: `Cannot infer exec_type from exec_path extension: ${fmExecPath}` };
  }

  if (fmExecType === correctType) {
    return { repaired: false, error: 'No mismatch — exec_type already matches exec_path extension' };
  }

  const repairedMd = contractMd
    .replace(/^exec_type:\s*\S+/m, `exec_type: ${correctType}`);

  return { repaired: true, repairedMd, newExecType: correctType, oldExecType: fmExecType };
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function scanAll(logger) {
  const listRes = await mcpPost('skill.list', {});
  const skills  = listRes?.data?.results || [];

  if (skills.length === 0) {
    return { ok: true, summary: 'No installed skills to scan', scanned: 0, healthy: 0, invalid: 0 };
  }

  let healthy = 0, invalid = 0, missing = 0;
  const invalidSkills = [];

  for (const sk of skills) {
    const detailRes = await mcpPost('skill.get', { name: sk.name });
    const skill = detailRes?.data;
    if (!skill) { missing++; continue; }

    // ── Disk-sync: disk is the source of truth for .md contract skills ────────
    // If the on-disk skill.md differs from the DB's contract_md, sync DB from disk.
    // This covers manual edits and template updates that haven't been re-registered.
    // repair_one already keeps both in sync — this catches any remaining drift.
    const _diskExecPath = (skill.execPath || '').replace(/^~/, os.homedir());
    if (_diskExecPath.endsWith('.md') && fs.existsSync(_diskExecPath)) {
      try {
        const _diskMd = fs.readFileSync(_diskExecPath, 'utf8');
        if (_diskMd.trim() !== (skill.contractMd || '').trim()) {
          if (logger) logger.info(`[skill.review] Disk content differs from DB for "${sk.name}" — syncing DB from disk`);
          await mcpPost('skill.install', { contractMd: _diskMd });
          skill.contractMd = _diskMd; // use fresh content for validation below
        }
      } catch (_diskErr) {
        if (logger) logger.warn(`[skill.review] Disk read failed for "${sk.name}" (non-fatal): ${_diskErr.message}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const { ok, errors } = validateSkillContract(skill.contractMd, skill.execPath);

    if (ok) {
      healthy++;
      await mcpPost('skill.health.upsert', {
        skillName: sk.name,
        status: 'ok',
        errors: null,
        autoRepaired: false,
      });
    } else {
      invalid++;
      invalidSkills.push({ name: sk.name, errors });
      await mcpPost('skill.health.upsert', {
        skillName: sk.name,
        status: 'invalid',
        errors: errors.join('; '),
        autoRepaired: false,
      });
      if (logger) logger.warn(`[skill.review] Invalid skill: ${sk.name}`, { errors });
    }
  }

  const summary = `Scanned ${skills.length} skill(s): ${healthy} healthy, ${invalid} invalid, ${missing} missing contract`;
  if (logger) logger.info(`[skill.review] scan_all complete — ${summary}`);
  return { ok: true, summary, scanned: skills.length, healthy, invalid, missing, invalidSkills };
}

async function validateOne(skillName, logger) {
  const detailRes = await mcpPost('skill.get', { name: skillName });
  const skill = detailRes?.data;
  if (!skill) {
    return { ok: false, error: `Skill '${skillName}' not found` };
  }

  const { ok, errors } = validateSkillContract(skill.contractMd, skill.execPath);
  await mcpPost('skill.health.upsert', {
    skillName,
    status: ok ? 'ok' : 'invalid',
    errors: ok ? null : errors.join('; '),
    autoRepaired: false,
  });

  return { ok, skillName, errors: ok ? [] : errors };
}

async function repairOne(skillName, logger) {
  const detailRes = await mcpPost('skill.get', { name: skillName });
  const skill = detailRes?.data;
  if (!skill) {
    return { ok: false, error: `Skill '${skillName}' not found` };
  }

  // Only auto-repair .md contract skills (exec_type:node + .md exec_path)
  const execPath = skill.execPath || '';
  if (!execPath.endsWith('.md')) {
    return { ok: false, error: `repair_one only supports .md contract skills. execPath=${execPath}` };
  }

  const { repaired, repairedMd, newExecType, oldExecType, error } = repairFrontmatter(skill.contractMd, skillName);
  if (!repaired) {
    return { ok: false, error: error || 'Could not determine repair strategy' };
  }

  // Write repaired contract back to the skill.md file
  const skillMdPath = execPath.replace(/^~/, os.homedir());
  try {
    fs.writeFileSync(skillMdPath, repairedMd, 'utf8');
  } catch (e) {
    return { ok: false, error: `Failed to write repaired skill.md: ${e.message}` };
  }

  // Re-register with the corrected contract
  const installRes = await mcpPost('skill.install', { contractMd: repairedMd });
  if (installRes?.status !== 'ok') {
    return {
      ok: false,
      error: `File repaired but re-registration failed: ${installRes?.error?.message || JSON.stringify(installRes)}`
    };
  }

  // Update health to 'repaired'
  await mcpPost('skill.health.upsert', {
    skillName,
    status: 'repaired',
    errors: null,
    autoRepaired: true,
  });

  if (logger) logger.info(`[skill.review] Auto-repaired skill: ${skillName} (exec_type: ${oldExecType} → ${newExecType})`);
  return {
    ok: true,
    skillName,
    oldExecType,
    newExecType,
    message: `exec_type corrected from '${oldExecType}' to '${newExecType}' and re-registered`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

module.exports = async function run(args, context) {
  const logger  = context?.logger || null;
  const action  = args?.action || 'scan_all';
  const name    = args?.skillName || args?.name || null;

  switch (action) {
    case 'scan_all':
      return await scanAll(logger);

    case 'validate_one':
      if (!name) return { ok: false, error: 'validate_one requires skillName' };
      return await validateOne(name, logger);

    case 'repair_one':
      if (!name) return { ok: false, error: 'repair_one requires skillName' };
      return await repairOne(name, logger);

    default:
      return { ok: false, error: `Unknown action '${action}'. Valid: scan_all, validate_one, repair_one` };
  }
};
