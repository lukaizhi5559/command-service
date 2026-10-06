'use strict';

/**
 * skill: mcp.agent — external MCP server bridge.
 *
 * Actions:
 *   list_servers {}                                   → configured servers + status
 *   list_tools   { server }                           → tool schema list
 *   call         { server, tool, args? }              → invoke a tool
 *   install      { name, command?, args?, url?, env? }→ write config + handshake
 *                                                       verify + register agent
 *   remove       { name }                             → remove config entry
 *
 * install verifies npm package names before writing (npx -y <pkg> → npm view),
 * handshakes the server to confirm it speaks MCP, captures its tool list into
 * the agent descriptor (type: mcp), and upgrades draft descriptors to active.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const logger = require('../logger.cjs');
const mcp = require('../terminal/mcp-client.cjs');

const AGENTS_DIR = process.env.THINKDROP_AGENTS_DIR || path.join(os.homedir(), '.thinkdrop', 'agents');
const SEED_PATH = path.join(__dirname, '../../../../shared/mcp-registry-seed.json');

function _seed(name) {
  try {
    const j = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    return (j.servers || []).find(s => s.name === name) || null;
  } catch (_) { return null; }
}

function _agentPath(agentId) {
  return path.join(AGENTS_DIR, `${String(agentId).replace(/\.agent$/, '')}.agent.md`);
}

function _writeAgentDescriptor({ name, envKeys, tools, status }) {
  const agentId = `mcp.${name}.agent`;
  const toolLines = (tools || []).map(t => `  - ${t.name}${t.description ? ` — ${String(t.description).slice(0, 80)}` : ''}`);
  const fm = [
    '---',
    `id: ${agentId}`,
    `service: ${name}`,
    'type: mcp',
    `mcp_server: ${name}`,
    `status: ${status}`,
    envKeys?.length ? 'secrets:' : null,
    ...(envKeys || []).map(k => `  - ${k}`),
    '---',
    '',
    `# ${name} (MCP server)`,
    '',
    '## Tools',
    ...(toolLines.length ? toolLines : ['  (tool list unavailable)']),
  ].filter(l => l !== null).join('\n') + '\n';
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(_agentPath(agentId), fm, 'utf8');
  return agentId;
}

function _updateDraftToActive(agentId, tools) {
  const p = _agentPath(agentId);
  try {
    let src = fs.readFileSync(p, 'utf8');
    src = src.replace(/^status:\s*\S+\s*$/m, 'status: active');
    if (tools?.length && !/^## Tools/m.test(src)) {
      src += '\n## Tools\n' + tools.map(t => `  - ${t.name}${t.description ? ` — ${String(t.description).slice(0, 80)}` : ''}`).join('\n') + '\n';
    }
    fs.writeFileSync(p, src, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// Verify an npm package exists before we write `npx -y <pkg>` into config.
function _npmPkgExists(pkg) {
  try {
    const r = spawnSync('npm', ['view', pkg, 'name', '--json'], { timeout: 8000 });
    return r.status === 0;
  } catch (_) {
    return true; // npm unavailable — don't block, handshake will decide
  }
}

async function mcpAgent(args = {}) {
  const action = args.action || 'list_servers';
  try {
    switch (action) {
      case 'list_servers':
        return { ok: true, servers: await mcp.listServers() };

      case 'list_tools': {
        if (!args.server) return { ok: false, error: 'server-required' };
        const tools = await mcp.listTools(args.server);
        return { ok: true, server: args.server, tools };
      }

      case 'call': {
        if (!args.server || !args.tool) return { ok: false, error: 'server-and-tool-required' };
        const r = await mcp.callTool(args.server, args.tool, args.args || {});
        return r;
      }

      case 'install': {
        const name = String(args.name || '').trim();
        if (!name || !/^[a-z0-9_-]+$/i.test(name)) return { ok: false, error: 'bad-server-name' };

        const cfg = mcp.readConfig();
        let def = null;

        if (args.url) {
          def = { url: args.url, env: args.env || {} };
        } else if (args.command) {
          def = { command: args.command, args: args.args || [], env: args.env || {} };
        } else {
          const seed = _seed(name);
          if (!seed) return { ok: false, error: `no-config: ${name} not in registry — provide command+args or url` };
          def = { command: seed.command, args: seed.args || [], env: seed.env || {} };
        }

        // Vet: npx -y <pkg> → confirm the package exists in the registry
        const npxIdx = def.args?.indexOf('-y');
        if (def.command === 'npx' && npxIdx !== -1 && def.args[npxIdx + 1]) {
          const pkg = def.args[npxIdx + 1];
          if (!_npmPkgExists(pkg)) return { ok: false, error: `npm package not found: ${pkg}` };
        }

        cfg[name] = def;
        mcp.writeConfig(cfg);

        // Handshake verify — initialize + tools/list proves it speaks MCP.
        let tools = [];
        try {
          tools = await mcp.listTools(name);
        } catch (err) {
          delete cfg[name];
          mcp.writeConfig(cfg);
          return { ok: false, error: `handshake-failed: ${err.message}` };
        }

        const envKeys = Object.keys(def.env || {});
        const agentId = `mcp.${name}.agent`;
        const draftPath = _agentPath(agentId);
        const draftExists = fs.existsSync(draftPath) && /^status:\s*draft/m.test(fs.readFileSync(draftPath, 'utf8'));
        if (draftExists) {
          _updateDraftToActive(agentId, tools);
        } else {
          _writeAgentDescriptor({ name, envKeys, tools, status: 'active' });
        }

        // Handshake passed — stamp the smoke-test proof so the capability
        // index can rank verified agents above unverified ones.
        try {
          const { stampDescriptor } = require('../../../shared/capability-index.cjs');
          await stampDescriptor(agentId, {
            verified: true,
            verified_at: new Date().toISOString(),
            tools_count: tools.length,
          });
        } catch (_) {}

        logger.info(`[mcp.agent] installed ${name} — ${tools.length} tools`, { agentId });
        return { ok: true, name, agentId, tools: tools.map(t => ({ name: t.name, description: t.description })), envKeys };
      }

      case 'remove': {
        const name = String(args.name || '').trim();
        const cfg = mcp.readConfig();
        if (!cfg[name]) return { ok: false, error: 'not-configured' };
        mcp._kill(name);
        delete cfg[name];
        mcp.writeConfig(cfg);
        try { fs.unlinkSync(_agentPath(`mcp.${name}.agent`)); } catch (_) {}
        return { ok: true };
      }

      default:
        return { ok: false, error: `unknown-action: ${action}` };
    }
  } catch (err) {
    logger.error(`[mcp.agent] ${action} failed`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { mcpAgent };
