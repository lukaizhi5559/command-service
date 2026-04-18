/**
 * Command Service MCP Server
 *
 * Actuation-only MCP service. Owns all "can touch the machine" skills:
 *   - command.automate  → skill router (shell.run, browser.act, image.analyze, fs.read, file.watch, file.bridge, screen.capture, external.skill, cli.agent, browser.agent, creator.agent, reviewer.agent)
 *   - health            → service health check
 *
 * Perception, planning, memory, and intent resolution live in other services.
 */

require('dotenv').config();
const http = require('http');
const logger = require('./logger.cjs');
// Shared infrastructure for skills — intelligence + storage
// Any skill can require these directly:
//   const { ask } = require('../skill-llm.cjs');
//   const db = require('../skill-db.cjs');
const skillLlm = require('./skill-helpers/skill-llm.cjs');
const skillDb = require('./skill-helpers/skill-db.cjs');
const { shellRun } = require('./skills/shell.run.cjs');
const { browserAct } = require('./skills/browser.act.cjs');
const { webCrawl } = require('./skills/web.crawl.cjs');
const { imageAnalyze } = require('./skills/image.analyze.cjs');
const { fsRead } = require('./skills/fs.read.cjs');
const { fileWatch } = require('./skills/file.watch.cjs');
const { fileBridge } = require('./skills/file.bridge.cjs');
const { run: externalSkillRun } = require('./skills/external.skill.cjs');
const { run: projectBuilderRun } = require('./skills/project.builder.cjs');
const { projectLaunch } = require('./skills/project.launcher.cjs');
const { projectEdit } = require('./skills/project.editor.cjs');
const { projectStop } = require('./skills/project.stopper.cjs');
const { cliAgent } = require('./skills/cli.agent.cjs');
const { browserAgent } = require('./skills/browser.agent.cjs');
const { playwrightAgent } = require('./skills/playwright.agent.cjs');
const { agentbrowserAct } = require('./skills/agentbrowser.act.cjs');
const { agentbrowserAgent, agentbrowserAgentSkill } = require('./skills/agentbrowser.agent.cjs');
const creatorAgent = require('./skills/creator.agent.cjs');
const reviewerAgent = require('./skills/reviewer.agent.cjs');
const skillCreator = require('./skills/skillCreator.skill.cjs');
const { screenCapture } = require('./skills/screen.capture.cjs');
const { userAgent } = require('./skills/user.agent.cjs');
const skillScheduler = require('./skill-helpers/skill-scheduler.cjs');

class CommandServiceMCPServer {
  constructor() {
    this.serviceName = process.env.SERVICE_NAME || 'command-service';

    logger.info('CommandServiceMCPServer initialized', {
      serviceName: this.serviceName
    });
  }

  /**
   * Skill router — dispatches to the appropriate automation skill
   * @param {Object} payload - { skill, args }
   *   skill: 'shell.run' | 'browser.act' | 'image.analyze' | 'fs.read' | 'file.watch' | 'file.bridge' | 'screen.capture' | 'external.skill' | 'cli.agent' | 'browser.agent'
   *   args:  skill-specific arguments (see skills/ implementations)
   */
  async executeAutomation(payload) {
    const { skill, args = {} } = payload || {};

    if (!skill) {
      return {
        success: false,
        error: 'skill is required (shell.run | browser.act | image.analyze | fs.read | file.watch | file.bridge | screen.capture | external.skill | cli.agent | browser.agent)'
      };
    }

    logger.info('Routing automation skill', { skill });

    switch (skill) {
      case 'shell.run':
        return await this._skillShellRun(args);

      case 'browser.act':
        return await this._skillBrowserAct(args);

      case 'web.crawl':
        return await this._skillWebCrawl(args);

      case 'image.analyze':
        return await this._skillImageAnalyze(args);

      case 'fs.read':
        return await this._skillFsRead(args);

      case 'file.watch':
        return await this._skillFileWatch(args);

      case 'file.bridge':
        return await this._skillFileBridge(args);

      case 'external.skill':
        return await this._skillExternal(args, payload);

      case 'screen.capture':
        return await this._skillScreenCapture(args);

      case 'cli.agent':
        return await this._skillCliAgent(args);

      case 'browser.agent':
        return await this._skillBrowserAgent(args);

      case 'playwright.agent':
        return await this._skillPlaywrightAgent(args);

      case 'agentbrowser.act':
        return await this._skillAgentbrowserAct(args);

      case 'agentbrowser.agent':
        return await this._skillAgentbrowserAgent(args);

      case 'creator.agent':
        return await this._skillCreatorAgent(args);

      case 'reviewer.agent':
        return await this._skillReviewerAgent(args);

      case 'skillCreator.skill':
        return await this._skillCreator(args);

      case 'project.builder':
        return await this._skillProjectBuilder(args);

      case 'project.launcher':
        return await this._skillProjectLauncher(args);

      case 'project.editor':
        return await this._skillProjectEditor(args);

      case 'project.stopper':
        return await this._skillProjectStopper(args);

      case 'user.agent':
        return await this._skillUserAgent(args);

      default:
        return {
          success: false,
          error: `Unknown skill: ${skill}`
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Skills — stubs, implementations will live in skills/ and be required here
  // ---------------------------------------------------------------------------

  async _skillShellRun(args) {
    return await shellRun(args);
  }

  async _skillBrowserAct(args) {
    return await browserAct(args);
  }

  async _skillWebCrawl(args) {
    return await webCrawl(args);
  }

  async _skillImageAnalyze(args) {
    return await imageAnalyze(args);
  }

  async _skillFsRead(args) {
    return await fsRead(args);
  }

  async _skillFileWatch(args) {
    return await fileWatch(args);
  }

  async _skillScreenCapture(args) {
    return await screenCapture(args);
  }

  async _skillFileBridge(args) {
    return await fileBridge(args);
  }

  async _skillExternal(args) {
    return await externalSkillRun(args);
  }

  async _skillCliAgent(args) {
    return await cliAgent(args);
  }

  async _skillBrowserAgent(args) {
    return await browserAgent(args);
  }

  async _skillCreatorAgent(args) {
    return await creatorAgent(args);
  }

  async _skillReviewerAgent(args) {
    return await reviewerAgent(args);
  }

  async _skillCreator(args) {
    return await skillCreator(args);
  }

  async _skillProjectBuilder(args) {
    return await projectBuilderRun(args);
  }

  async _skillProjectLauncher(args) {
    return await projectLaunch(args);
  }

  async _skillProjectEditor(args) {
    return await projectEdit(args);
  }

  async _skillProjectStopper(args) {
    return await projectStop(args);
  }

  async _skillUserAgent(args) {
    return await userAgent(args);
  }

  async _skillPlaywrightAgent(args) {
    return await playwrightAgent(args);
  }

  async _skillAgentbrowserAct(args) {
    return await agentbrowserAct(args);
  }

  async _skillAgentbrowserAgent(args) {
    return await agentbrowserAgentSkill(args);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck() {
    return {
      success: true,
      service: this.serviceName,
      status: 'healthy',
      skills: ['shell.run', 'browser.act', 'web.crawl', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'screen.capture', 'external.skill', 'cli.agent', 'browser.agent', 'playwright.agent', 'agentbrowser.act', 'agentbrowser.agent', 'creator.agent', 'reviewer.agent', 'skillCreator.skill', 'project.builder', 'project.launcher', 'project.editor', 'project.stopper']
    };
  }

  // ---------------------------------------------------------------------------
  // stdio transport (MCP protocol)
  // ---------------------------------------------------------------------------

  async start() {
    logger.info('Starting Command Service MCP server (stdio)');

    // ── Warm up creator.agent DB (ensures projects table exists) ────────────
    creatorAgent({ action: 'list_projects' }).catch(() => {});
    reviewerAgent({ action: 'status', projectId: '__warmup__' }).catch(() => {});

    // ── Start skill scheduler daemon ─────────────────────────────────────────
    // Reads installed skills from user-memory MCP, registers node-cron jobs
    // for any skill with a schedule ≠ on_demand. Re-syncs every 5 min.
    skillScheduler.start().catch(err => logger.warn('[Server] Skill scheduler start failed', { error: err.message }));

    // ── Startup skill health scan ─────────────────────────────────────────────
    // Runs once after the scheduler starts — validates all installed skills and
    // writes health records to the skill_health table. Non-blocking and non-fatal.
    try {
      const skillReview = require('./skills/skill.review.cjs');
      skillReview({ action: 'scan_all' }, { logger })
        .then(report => {
          if (report?.summary) logger.info(`[skill.review] ${report.summary}`);
          if (report?.invalidSkills?.length > 0) {
            logger.warn('[skill.review] Invalid skills detected at startup', {
              count: report.invalidSkills.length,
              names: report.invalidSkills.map(s => s.name),
            });
          }
        })
        .catch(err => logger.warn('[skill.review] Startup scan failed (non-fatal)', { error: err.message }));
    } catch (e) {
      logger.warn('[skill.review] Could not load skill.review.cjs (non-fatal)', { error: e.message });
    }

    // ── Minimal HTTP health server ───────────────────────────────────────────
    // Keeps the Node.js event loop alive (no active I/O = process exits) and
    // satisfies the service manager's health check at http://localhost:3007/health
    const PORT = parseInt(process.env.PORT || '3007', 10);
    const healthServer = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health' || req.url === '/service.health') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'healthy',
          service: this.serviceName,
          skills: ['shell.run', 'browser.act', 'web.crawl', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'screen.capture', 'external.skill', 'cli.agent', 'browser.agent', 'playwright.agent', 'agentbrowser.act', 'agentbrowser.agent', 'creator.agent', 'reviewer.agent', 'skillCreator.skill', 'project.builder', 'project.launcher', 'project.editor', 'project.stopper']
        }));
        return;
      }

      // ── GET /debug/resolve-credentials?agentId=gmail.agent ──────────────────
      // Test what resolveCredentials returns including all fallback steps.
      // Usage: open http://localhost:3007/debug/resolve-credentials?agentId=gmail.agent
      if (req.method === 'GET' && req.url?.startsWith('/debug/resolve-credentials')) {
        const agentId = new URL(req.url, 'http://localhost').searchParams.get('agentId') || 'gmail.agent';
        try {
          const { userAgent } = require('./skills/user.agent.cjs');
          const result = await userAgent({ action: 'resolve_credentials', agentId });
          res.writeHead(200);
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ── GET /debug/profile?key=self:email ────────────────────────────────────
      // Directly query a profile KV key to verify storage.
      // Usage: open http://localhost:3007/debug/profile?key=self:email
      if (req.method === 'GET' && req.url?.startsWith('/debug/profile')) {
        const key = new URL(req.url, 'http://localhost').searchParams.get('key') || 'self:email';
        try {
          const http2 = require('http');
          const body = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'profile.get', payload: { key } });
          const memUrl = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
          const memKey = process.env.MCP_USER_MEMORY_API_KEY || '';
          const parsed = new URL(memUrl);
          const reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
          if (memKey) reqHeaders['Authorization'] = `Bearer ${memKey}`;
          const raw = await new Promise((resolve, reject) => {
            const r = http2.request({ hostname: parsed.hostname, port: Number(parsed.port) || 3001, path: '/profile.get', method: 'POST', headers: reqHeaders }, (resp) => {
              let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
            });
            r.on('error', reject); r.write(body); r.end();
          });
          res.writeHead(200);
          res.end(raw);
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ── POST /skill.schedule — register/refresh a skill's cron immediately ──
      // Called by skillCreator after writing a new scheduled skill.
      if (req.method === 'POST' && req.url === '/skill.schedule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName, schedule, execPath, metadata } = JSON.parse(body || '{}');
            await skillScheduler.registerSkill(skillName, schedule, execPath, metadata || {});
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── GET /skill.schedule/list — list active cron jobs ─────────────────────
      if (req.method === 'GET' && req.url === '/skill.schedule/list') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, jobs: skillScheduler.listJobs() }));
        return;
      }

      // ── POST /skill.fire — immediately fire a scheduled skill ("Run now") ────
      if (req.method === 'POST' && req.url === '/skill.fire') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName, forced } = JSON.parse(body || '{}');
            if (!skillName) {
              res.writeHead(400);
              res.end(JSON.stringify({ ok: false, error: 'skillName required' }));
              return;
            }
            const result = await skillScheduler.runSkillNow(skillName, forced === true);
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /skill.schedule/sync — force immediate re-sync from user-memory ──
      if (req.method === 'POST' && req.url === '/skill.schedule/sync') {
        skillScheduler.sync().catch(() => {});
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── POST /skill.unschedule — remove a skill's cron job (called on skill delete) ─
      if (req.method === 'POST' && req.url === '/skill.unschedule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { skillName } = JSON.parse(body || '{}');
            if (skillName) skillScheduler.unregisterSkill(skillName);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── POST /skill.schedule/toggle — pause or resume a skill's cron job ─────
      if (req.method === 'POST' && req.url === '/skill.schedule/toggle') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { skillName, action } = JSON.parse(body || '{}');
            if (skillName && (action === 'pause' || action === 'resume')) {
              skillScheduler.toggleSkill(skillName, action);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── POST /reminder.register — register a one-shot reminder ────────────────
      if (req.method === 'POST' && req.url === '/reminder.register') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { id, delayMs, label, triggerIntent, triggerPrompt, pendingSteps } = JSON.parse(body || '{}');
            const result = skillScheduler.registerReminder({ id, delayMs, label, triggerIntent, triggerPrompt, pendingSteps });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── GET /reminder.list — list pending reminders ────────────────────────────
      if (req.method === 'GET' && req.url === '/reminder.list') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, reminders: skillScheduler.listReminders() }));
        return;
      }

      // ── POST /reminder.cancel — cancel a pending reminder ──────────────────────
      if (req.method === 'POST' && req.url === '/reminder.cancel') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { id } = JSON.parse(body || '{}');
            const cancelled = skillScheduler.cancelReminder(id);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, cancelled }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── POST /skill.oauth-status — check OAuth token presence for a skill ──────
      // Lightweight pre-flight check used by executeCommand.js before dispatching
      // an external.skill step. Returns connected/expired state per provider without
      // performing any token exchange or modification.
      if (req.method === 'POST' && req.url === '/skill.oauth-status') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName = '', providers = [] } = JSON.parse(body || '{}');
            let keytar = null;
            try { keytar = require('keytar'); } catch (_) {}
            const statuses = await Promise.all(providers.map(async (provider) => {
              if (!keytar) return { provider, connected: false, expired: false };
              try {
                // Mirror buildSkillContext key lookup order
                let raw = await keytar.getPassword('thinkdrop', `oauth:${provider}:${skillName}`);
                if (!raw) raw = await keytar.getPassword('thinkdrop', `oauth:${provider}`);
                if (!raw) return { provider, connected: false, expired: false };
                let tok;
                try { tok = JSON.parse(raw); } catch (_) { return { provider, connected: true, expired: false }; }
                // Blobs with only client creds (no access/refresh token) are not yet connected
                const hasToken = !!(tok.access_token || tok.refresh_token);
                if (!hasToken) return { provider, connected: false, expired: false };
                const expired = !!(tok.expires_at && Date.now() >= Number(tok.expires_at));
                return { provider, connected: true, expired };
              } catch (_) { return { provider, connected: false, expired: false }; }
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, statuses }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/command.automate') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { payload } = JSON.parse(body);
            const result = await this.executeAutomation(payload);
            // Wrap in MCP envelope: envelope success=true always (HTTP 200).
            // The skill's own success/failure is inside data — the StateGraph
            // reads result.data and handles skill-level failures (needsManualStep, etc.)
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, data: result }));
          } catch (err) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, data: { success: false, error: err.message } }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    healthServer.listen(PORT, () => {
      logger.info(`Health endpoint listening on http://localhost:${PORT}/health`);
    });

    const shutdown = (signal) => {
      logger.info(`${signal} received — shutting down`);
      healthServer.close(() => process.exit(0));
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('Command Service ready');
  }
}

// ---------------------------------------------------------------------------
// Ensure playwright-cli is installed (brew install playwright-cli)
// Runs async at startup — does not block the server from starting.
// ---------------------------------------------------------------------------
function ensurePlaywrightCli() {
  const { execFile } = require('child_process');
  const fs = require('fs');

  const CLI_CANDIDATES = [
    '/opt/homebrew/bin/playwright-cli',
    '/usr/local/bin/playwright-cli',
  ];

  const found = CLI_CANDIDATES.some(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (found) {
    logger.info('[startup] playwright-cli already installed ✓');
    return;
  }

  logger.info('[startup] playwright-cli not found — installing via brew...');
  execFile('brew', ['install', 'playwright-cli'], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      logger.warn('[startup] brew install playwright-cli failed — browser.act will degrade gracefully', { error: err.message });
    } else {
      logger.info('[startup] playwright-cli installed ✓');
    }
  });
}

/**
 * Seed OAuth client credentials from environment variables into the keychain.
 * Runs once on startup so skills can find client_id/client_secret without
 * requiring the user to complete a full OAuth connect flow first.
 * Never overwrites an existing value (preserves live access/refresh tokens).
 */
async function seedOAuthCredentials() {
  let keytar;
  try { keytar = require('keytar'); } catch (_) {
    logger.warn('[startup] keytar unavailable — skipping OAuth credential seeding');
    return;
  }

  const PROVIDERS = [
    'google', 'github', 'microsoft', 'facebook', 'twitter',
    'linkedin', 'slack', 'notion', 'spotify', 'dropbox',
    'discord', 'zoom', 'atlassian', 'salesforce', 'hubspot',
  ];

  for (const provider of PROVIDERS) {
    const prefix = provider.toUpperCase();
    const envClientId     = process.env[`${prefix}_CLIENT_ID`];
    const envClientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!envClientId && !envClientSecret) continue;

    const keychainKey = `oauth:${provider}`;
    let blob = {};
    try {
      const raw = await keytar.getPassword('thinkdrop', keychainKey);
      if (raw) blob = JSON.parse(raw);
    } catch (_) { /* start fresh */ }

    let changed = false;
    if (envClientId && !blob.client_id) {
      blob.client_id = envClientId;
      changed = true;
    }
    if (envClientSecret && !blob.client_secret) {
      blob.client_secret = envClientSecret;
      changed = true;
    }

    if (changed) {
      try {
        await keytar.setPassword('thinkdrop', keychainKey, JSON.stringify(blob));
        logger.info(`[startup] Seeded keychain oauth:${provider} from .env`);
      } catch (err) {
        logger.warn(`[startup] Failed to seed keychain oauth:${provider}`, { error: err.message });
      }
    }
  }
}

// Start server if run directly
if (require.main === module) {
  ensurePlaywrightCli();
  seedOAuthCredentials().catch(err => logger.warn('[startup] seedOAuthCredentials failed', { error: err.message }));
  const server = new CommandServiceMCPServer();
  server.start().catch((error) => {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  });
}

module.exports = CommandServiceMCPServer;
