'use strict';
/**
 * skill-builder.cjs
 *
 * Definitive skill-building pipeline. Replaces static-registry-first discovery
 * with web-search-driven live discovery every time a new service is requested.
 *
 * Pipeline (5 steps, in strict order):
 *
 *   Step 1 — Prerequisites
 *     Verify node, npm, brew are available on PATH.
 *     If brew is missing (macOS), attempt to install it via shell.
 *     Returns { node, npm, brew } availability map.
 *
 *   Step 2 — Web search for CLI
 *     Queries web-search MCP: "<service> CLI tool npm official site:npmjs.com OR site:github.com"
 *     Also: "<service> CLI brew formula"
 *     Collects top results (title, url, description).
 *
 *   Step 3 — LLM picks best CLI candidate from search results
 *     Asks LLM to identify if any result describes a real CLI binary (not a TS-only SDK).
 *     If a real CLI is found → probe binary after install → if binary on PATH: emit cli config.
 *     If no CLI binary found after probe → fall through to Step 4.
 *
 *   Step 4 — Web search for API
 *     Queries web-search MCP: "<service> REST API documentation curl"
 *     Also: "<service> npm SDK official"
 *     LLM extracts: base URL, auth method, required env vars, example curl command.
 *     Produces api config (npm SDK or native https).
 *
 *   Step 5 — Return config
 *     Returns { type: 'cli'|'api', provider, capability, config }
 *     ready for creatorPlanning to write skill.md + cli.json / api.json.
 *
 * Exports:
 *   buildSkill(serviceName, capability, intent, opts) → { type, provider, capability, config } | null
 *   checkPrereqs()                                    → { node: bool, npm: bool, brew: bool }
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const http          = require('http');
const os            = require('os');
const logger        = require('../logger.cjs');

const WEB_SEARCH_PORT    = process.env.MCP_WEB_SEARCH_PORT || 3002;
const WEB_SEARCH_HOST    = '127.0.0.1';
const WEB_SEARCH_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY || process.env.MCP_API_KEY || '';
const SEARCH_TIMEOUT     = 15000;
const LLM_TIMEOUT        = 20000;

// ── Utility: synchronous shell ────────────────────────────────────────────────
function sh(bin, args, timeoutMs) {
  try {
    const r = spawnSync(bin, args, {
      timeout: timeoutMs || 10000,
      encoding: 'utf8',
      env: { ...process.env },
    });
    return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e.message };
  }
}

function whichBinary(name) {
  const r = sh('which', [name], 4000);
  return r.ok ? r.stdout : null;
}

// ── HTTP POST to MCP web-search service ───────────────────────────────────────
function webSearch(query, maxResults) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      requestId: `skill-builder-${Date.now()}`,
      payload: { query, maxResults: maxResults || 8, provider: 'auto' },
    });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (WEB_SEARCH_API_KEY) headers['Authorization'] = `Bearer ${WEB_SEARCH_API_KEY}`;

    const req = http.request(
      {
        hostname: WEB_SEARCH_HOST,
        port: WEB_SEARCH_PORT,
        path: '/web.search',
        method: 'POST',
        headers,
        timeout: SEARCH_TIMEOUT,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed?.data?.results || parsed?.results || []);
          } catch (_) { resolve([]); }
        });
      },
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

// ── HTTP POST to skill-llm ask endpoint ───────────────────────────────────────
function llmAsk(userPrompt, systemPrompt) {
  const { ask } = require('../skill-llm.cjs');
  return Promise.race([
    ask(userPrompt, { systemPrompt, temperature: 0.1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), LLM_TIMEOUT)),
  ]);
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    const cleaned = (raw || '')
      .trim()
      .replace(/^```json?\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    // Try direct parse first
    if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
      return JSON.parse(cleaned);
    }
    // Extract first {...} object from mixed text
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
    return null;
  } catch (_) {
    return null;
  }
}

// ── Format web search results as a numbered list for LLM ─────────────────────
function formatResults(results) {
  return results.slice(0, 8).map((r, i) =>
    `${i + 1}. ${r.title || '(no title)'}\n   URL: ${r.url || ''}\n   ${(r.description || '').slice(0, 200)}`
  ).join('\n\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 1 — Prerequisite check
// ═════════════════════════════════════════════════════════════════════════════
function checkPrereqs() {
  const node = !!whichBinary('node');
  const npm  = !!whichBinary('npm');
  let brew   = !!whichBinary('brew');

  if (!brew && process.platform === 'darwin') {
    // Check well-known paths first — Electron's PATH often omits /opt/homebrew/bin
    const knownBrewPaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
    const existingBrew = knownBrewPaths.find(p => fs.existsSync(p));
    if (existingBrew) {
      brew = true;
      logger.info(`[SkillBuilder] brew found at ${existingBrew} (not on PATH)`);
    } else {
      logger.info('[SkillBuilder] brew not found — attempting install via /bin/bash');
      try {
        spawnSync('/bin/bash', [
          '-c',
          'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        ], { timeout: 120000, encoding: 'utf8', stdio: 'pipe' });
        brew = !!whichBinary('brew')
          || fs.existsSync('/opt/homebrew/bin/brew')
          || fs.existsSync('/usr/local/bin/brew');
      } catch (_) {}
    }
  }

  logger.info(`[SkillBuilder] Prereqs — node:${node} npm:${npm} brew:${brew}`);
  return { node, npm, brew };
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 2+3 — Web search for CLI + LLM pick + probe
// ═════════════════════════════════════════════════════════════════════════════
async function discoverCLIViaWeb(serviceName, capability, prereqs) {
  const svc = serviceName.toLowerCase().trim();
  logger.info(`[SkillBuilder] Step 2: Web search for CLI — "${svc}"`);

  // Run two searches in parallel
  const [npmResults, brewResults] = await Promise.all([
    webSearch(`${svc} CLI tool npm official binary site:npmjs.com OR site:github.com`, 6),
    prereqs.brew
      ? webSearch(`${svc} brew formula CLI install site:formulae.brew.sh OR site:github.com`, 4)
      : Promise.resolve([]),
  ]);

  const allResults = [...npmResults, ...brewResults];
  if (allResults.length === 0) {
    logger.info(`[SkillBuilder] No CLI web results for "${svc}"`);
    return null;
  }

  logger.info(`[SkillBuilder] CLI web results: ${allResults.length} hits`);

  // LLM picks best CLI candidate
  const system = `You are a CLI tool expert. Given web search results about a service, identify the single best official CLI tool that installs a real executable binary.

CRITICAL rules:
- ONLY pick tools that install a real runnable binary (e.g. "twilio" binary from twilio-cli, "gh" from gh, "stripe" from stripe-cli)
- NEVER pick TypeScript-only SDKs, REST wrappers, or npm packages with no binary (e.g. stripe npm SDK, axios, clicksend)
- Prefer official tools from the service's own GitHub org
- Respond with ONLY valid JSON, no explanation, no markdown

If a real CLI binary exists:
{"found": true, "binaryName": "<binary>", "installCmd": "<npm install -g pkg OR brew install formula>", "installSource": "npm|brew", "npmPackage": "<pkg or null>", "brewFormula": "<formula or null>", "authEnvGuess": ["ENV_VAR1"], "reason": "<one sentence>"}

If no real CLI binary found:
{"found": false}`;

  const user = `Service: ${svc}
Capability: ${capability}

Web search results:
${formatResults(allResults)}

Is there a real CLI binary for "${svc}"? If yes, which npm package or brew formula installs it?`;

  let pick = null;
  try {
    const raw = await llmAsk(user, system);
    pick = parseJson(raw);
  } catch (e) {
    logger.warn(`[SkillBuilder] CLI LLM pick failed: ${e.message}`);
    return null;
  }

  if (!pick?.found || !pick?.binaryName) {
    logger.info(`[SkillBuilder] LLM: no real CLI binary for "${svc}"`);
    return null;
  }

  logger.info(`[SkillBuilder] LLM picked CLI: ${pick.binaryName} via ${pick.installCmd}`);

  // ── Step 3: Probe — verify binary exists (or install + probe) ────────────────
  const binary = pick.binaryName;
  let onPath = whichBinary(binary);

  if (!onPath) {
    logger.info(`[SkillBuilder] Step 3: Probing — installing "${binary}"...`);
    if (pick.installSource === 'brew' && pick.brewFormula && prereqs.brew) {
      sh('brew', ['install', pick.brewFormula], 60000);
    } else if (pick.installSource === 'npm' && pick.npmPackage && prereqs.npm) {
      sh('npm', ['install', '-g', pick.npmPackage], 60000);
    }
    onPath = whichBinary(binary);
  }

  if (!onPath) {
    logger.info(`[SkillBuilder] Step 3: Binary "${binary}" not found after install — rejecting CLI, falling through to API`);
    return null;
  }

  logger.info(`[SkillBuilder] Step 3: Binary "${binary}" confirmed at ${onPath}`);

  // Grab --help for richer context
  let helpText = null;
  try {
    const h = sh(binary, ['--help'], 6000);
    helpText = ((h.stdout || '') + (h.stderr || '')).trim().slice(0, 2000) || null;
  } catch (_) {}

  return {
    type: 'cli',
    provider: svc,
    capability,
    config: {
      tool: binary,
      installCmd: pick.installCmd,
      installSource: pick.installSource,
      npmPackage: pick.npmPackage || null,
      brewFormula: pick.brewFormula || null,
      probeCmd: `${binary} --version`,
      helpCmd: `${binary} --help`,
      helpText,
      authType: 'env',
      authEnv: pick.authEnvGuess || [],
      exampleCmds: [],
      links: [],
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 4 — Web search for API (npm SDK or native HTTPS)
// ═════════════════════════════════════════════════════════════════════════════
async function discoverAPIViaWeb(serviceName, capability) {
  const svc = serviceName.toLowerCase().trim();
  logger.info(`[SkillBuilder] Step 4: Web search for API — "${svc}"`);

  const [sdkResults, restResults] = await Promise.all([
    webSearch(`${svc} official npm SDK Node.js site:npmjs.com OR site:github.com`, 6),
    webSearch(`${svc} REST API documentation curl authentication`, 6),
  ]);

  const allResults = [...sdkResults, ...restResults];
  if (allResults.length === 0) {
    logger.info(`[SkillBuilder] No API web results for "${svc}"`);
    return null;
  }

  logger.info(`[SkillBuilder] API web results: ${allResults.length} hits`);

  const system = `You are an API integration expert. Given web search results about a service, extract the best way to call its API from Node.js.

PRIORITY ORDER:
1. Official npm SDK (most reliable — use require())
2. Native HTTPS (if no SDK or SDK is low quality — use built-in https module)

For npm SDK respond:
{
  "type": "npm",
  "npmPackage": "<exact package name>",
  "authType": "env|oauth|apikey",
  "authEnv": ["ENV_VAR1", "ENV_VAR2"],
  "initSnippet": "<one-line require + init, e.g.: const Client = require('pkg'); const client = new Client({ apiKey: process.env.API_KEY });>",
  "exampleSnippet": "<one example API call as JS code>",
  "baseUrl": null,
  "docsUrl": "<url>",
  "reason": "<one sentence>"
}

For native HTTPS respond:
{
  "type": "https",
  "npmPackage": null,
  "authType": "basic|bearer|apikey",
  "authEnv": ["ENV_VAR1", "ENV_VAR2"],
  "initSnippet": "const https = require('https'); const auth = Buffer.from(process.env.USER + ':' + process.env.KEY).toString('base64');",
  "exampleSnippet": "<minimal https.request example for the main API endpoint>",
  "baseUrl": "<https://api.service.com>",
  "docsUrl": "<url>",
  "reason": "<one sentence>"
}

Respond ONLY with valid JSON, no markdown, no explanation.`;

  const user = `Service: ${svc}
Capability: ${capability}

Web search results:
${formatResults(allResults)}

Extract the best Node.js API integration approach for "${svc}".`;

  let pick = null;
  try {
    const raw = await llmAsk(user, system);
    pick = parseJson(raw);
  } catch (e) {
    logger.warn(`[SkillBuilder] API LLM pick failed: ${e.message}`);
    return null;
  }

  if (!pick) {
    logger.warn(`[SkillBuilder] API: LLM returned no valid config for "${svc}"`);
    return null;
  }

  logger.info(`[SkillBuilder] API config: type=${pick.type} npm=${pick.npmPackage} base=${pick.baseUrl}`);

  // Verify npm package exists if claimed
  if (pick.type === 'npm' && pick.npmPackage) {
    const check = sh('npm', ['info', pick.npmPackage, 'name', '--json'], 10000);
    if (!check.ok || !check.stdout) {
      logger.warn(`[SkillBuilder] npm package "${pick.npmPackage}" not found — falling back to native https`);
      pick.type = 'https';
      pick.npmPackage = null;
    }
  }

  return {
    type: 'api',
    provider: svc,
    capability,
    config: {
      npm: pick.type === 'npm' ? pick.npmPackage : null,
      authType: pick.authType || 'env',
      authEnv: pick.authEnv || [],
      initSnippet: pick.initSnippet || '',
      exampleSnippet: pick.exampleSnippet || '',
      baseUrl: pick.baseUrl || null,
      links: pick.docsUrl ? [{ label: `${svc} API Docs`, url: pick.docsUrl }] : [],
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Well-known providers per capability — baseline for buildSkill fallback + discoverProviders
// ═════════════════════════════════════════════════════════════════════════════
const CAPABILITY_FALLBACKS = {
  sms: [
    {
      name: 'twilio', type: 'api',
      description: 'Twilio SMS API — market leader, easy REST API',
      authEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
      authType: 'basic',
      baseUrl: 'https://api.twilio.com',
      initSnippet: `const https = require('https');\nconst auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');`,
      exampleSnippet: `const body = new URLSearchParams({ To: args.to, From: process.env.TWILIO_PHONE_NUMBER, Body: args.message }).toString();\nawait new Promise((resolve, reject) => {\n  const req = https.request({ hostname: 'api.twilio.com', path: \`/2010-04-01/Accounts/\${process.env.TWILIO_ACCOUNT_SID}/Messages.json\`, method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error', reject); req.write(body); req.end();\n});`,
      links: [{ label: 'Twilio Console', url: 'https://console.twilio.com' }, { label: 'Twilio SMS Docs', url: 'https://www.twilio.com/docs/sms/api' }],
    },
    {
      name: 'clicksend', type: 'api',
      description: 'ClickSend SMS API — HTTP Basic auth, no SDK needed',
      authEnv: ['CLICKSEND_USERNAME', 'CLICKSEND_API_KEY'],
      authType: 'basic',
      baseUrl: 'https://rest.clicksend.com',
      initSnippet: `const https = require('https');\nconst auth = Buffer.from(process.env.CLICKSEND_USERNAME + ':' + process.env.CLICKSEND_API_KEY).toString('base64');`,
      exampleSnippet: `const rawTo = String(args.to).replace(/\\D/g,''); const to = rawTo.length === 10 ? '+1' + rawTo : '+' + rawTo;\nconst payload = JSON.stringify({ messages: [{ to, body: args.message, source: 'thinkdrop' }] });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname: 'rest.clicksend.com', path: '/v3/sms/send', method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', 'Content-Length': buf.length } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error', reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'ClickSend Dashboard', url: 'https://dashboard.clicksend.com' }, { label: 'ClickSend SMS API Docs', url: 'https://developers.clicksend.com/docs/rest/v3/#send-sms' }],
    },
    {
      name: 'messagebird', type: 'api',
      description: 'MessageBird SMS API — global coverage, REST API',
      authEnv: ['MESSAGEBIRD_API_KEY', 'MESSAGEBIRD_ORIGINATOR'],
      authType: 'apikey',
      baseUrl: 'https://rest.messagebird.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ recipients: [args.to], originator: process.env.MESSAGEBIRD_ORIGINATOR, body: args.message });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname: 'rest.messagebird.com', path: '/messages', method: 'POST', headers: { Authorization: 'AccessKey ' + process.env.MESSAGEBIRD_API_KEY, 'Content-Type': 'application/json', 'Content-Length': buf.length } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error', reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'MessageBird Dashboard', url: 'https://dashboard.messagebird.com' }, { label: 'MessageBird SMS Docs', url: 'https://developers.messagebird.com/api/sms-messaging/' }],
    },
    {
      name: 'vonage', type: 'api',
      description: 'Vonage (Nexmo) SMS API — enterprise-grade messaging',
      authEnv: ['VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_FROM_NUMBER'],
      authType: 'apikey',
      baseUrl: 'https://rest.nexmo.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ api_key: process.env.VONAGE_API_KEY, api_secret: process.env.VONAGE_API_SECRET, to: args.to, from: process.env.VONAGE_FROM_NUMBER, text: args.message });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname: 'rest.nexmo.com', path: '/sms/json', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error', reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'Vonage Dashboard', url: 'https://dashboard.nexmo.com' }, { label: 'Vonage SMS Docs', url: 'https://developer.vonage.com/messaging/sms/overview' }],
    },
    {
      name: 'sinch', type: 'api',
      description: 'Sinch SMS API — carrier-grade, global reach',
      authEnv: ['SINCH_SERVICE_PLAN_ID', 'SINCH_API_TOKEN', 'SINCH_FROM_NUMBER'],
      authType: 'bearer',
      baseUrl: 'https://us.sms.api.sinch.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ from: process.env.SINCH_FROM_NUMBER, to: [args.to], body: args.message });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname: 'us.sms.api.sinch.com', path: \`/xms/v1/\${process.env.SINCH_SERVICE_PLAN_ID}/batches\`, method: 'POST', headers: { Authorization: 'Bearer ' + process.env.SINCH_API_TOKEN, 'Content-Type': 'application/json', 'Content-Length': buf.length } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error', reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'Sinch Dashboard', url: 'https://dashboard.sinch.com' }, { label: 'Sinch SMS Docs', url: 'https://developers.sinch.com/docs/sms/api-reference/' }],
    },
  ],
  email: [
    {
      name: 'sendgrid', type: 'api',
      description: 'SendGrid email API — widely used, free tier available',
      authEnv: ['SENDGRID_API_KEY', 'SENDER_EMAIL'],
      authType: 'bearer',
      baseUrl: 'https://api.sendgrid.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ personalizations:[{to:[{email:args.to}]}], from:{email:process.env.SENDER_EMAIL}, subject: args.subject || 'Message', content:[{type:'text/plain',value:args.message}] });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname:'api.sendgrid.com', path:'/v3/mail/send', method:'POST', headers:{ Authorization:'Bearer '+process.env.SENDGRID_API_KEY, 'Content-Type':'application/json', 'Content-Length':buf.length } }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));});\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error',reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'SendGrid Dashboard', url: 'https://app.sendgrid.com' }, { label: 'SendGrid Mail Send Docs', url: 'https://docs.sendgrid.com/api-reference/mail-send/mail-send' }],
    },
    {
      name: 'resend', type: 'api',
      description: 'Resend — modern developer-first email API',
      authEnv: ['RESEND_API_KEY', 'SENDER_EMAIL'],
      authType: 'bearer',
      baseUrl: 'https://api.resend.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ from: process.env.SENDER_EMAIL, to: [args.to], subject: args.subject || 'Message', html: args.message });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname:'api.resend.com', path:'/emails', method:'POST', headers:{ Authorization:'Bearer '+process.env.RESEND_API_KEY, 'Content-Type':'application/json', 'Content-Length':buf.length } }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error',reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'Resend Dashboard', url: 'https://resend.com/overview' }, { label: 'Resend API Docs', url: 'https://resend.com/docs/api-reference/emails/send-email' }],
    },
    {
      name: 'mailgun', type: 'api',
      description: 'Mailgun transactional email API',
      authEnv: ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'SENDER_EMAIL'],
      authType: 'basic',
      baseUrl: 'https://api.mailgun.net',
      initSnippet: `const https = require('https');\nconst auth = Buffer.from('api:' + process.env.MAILGUN_API_KEY).toString('base64');`,
      exampleSnippet: `const body = new URLSearchParams({ from: process.env.SENDER_EMAIL, to: args.to, subject: args.subject || 'Message', text: args.message }).toString();\nawait new Promise((resolve, reject) => {\n  const req = https.request({ hostname:'api.mailgun.net', path:\`/v3/\${process.env.MAILGUN_DOMAIN}/messages\`, method:'POST', headers:{ Authorization:'Basic '+auth, 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error',reject); req.write(body); req.end();\n});`,
      links: [{ label: 'Mailgun Dashboard', url: 'https://app.mailgun.com' }, { label: 'Mailgun Send Docs', url: 'https://documentation.mailgun.com/docs/mailgun/api-reference/openapi-final/tag/Messages/' }],
    },
    {
      name: 'postmark', type: 'api',
      description: 'Postmark — fast transactional email delivery',
      authEnv: ['POSTMARK_SERVER_TOKEN', 'SENDER_EMAIL'],
      authType: 'apikey',
      baseUrl: 'https://api.postmarkapp.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ From: process.env.SENDER_EMAIL, To: args.to, Subject: args.subject || 'Message', TextBody: args.message });\nawait new Promise((resolve, reject) => {\n  const buf = Buffer.from(payload);\n  const req = https.request({ hostname:'api.postmarkapp.com', path:'/email', method:'POST', headers:{ 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN, 'Content-Type':'application/json', 'Content-Length':buf.length } }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});\n  req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });\n  req.on('error',reject); req.write(payload); req.end();\n});`,
      links: [{ label: 'Postmark Account', url: 'https://account.postmarkapp.com' }, { label: 'Postmark Email Docs', url: 'https://postmarkapp.com/developer/api/email-api' }],
    },
  ],
  payment: [
    {
      name: 'stripe', type: 'api',
      description: 'Stripe payments API — most popular dev-friendly payment processor',
      authEnv: ['STRIPE_SECRET_KEY'],
      authType: 'bearer',
      baseUrl: 'https://api.stripe.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const body = new URLSearchParams({ amount: '1000', currency: 'usd', source: 'tok_visa', description: 'ThinkDrop charge' }).toString();\nconst req = https.request({ hostname:'api.stripe.com', path:'/v1/charges', method:'POST', headers:{ Authorization:'Bearer '+secrets.STRIPE_SECRET_KEY, 'Content-Type':'application/x-www-form-urlencoded' } }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});\nreq.on('error',reject); req.write(body); req.end();`,
      links: [{ label: 'Stripe Dashboard', url: 'https://dashboard.stripe.com' }, { label: 'Stripe API Docs', url: 'https://stripe.com/docs/api' }],
    },
    {
      name: 'paypal', type: 'api',
      description: 'PayPal REST API — widely accepted, global reach',
      authEnv: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
      authType: 'oauth2',
      baseUrl: 'https://api-m.paypal.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `// First get access token, then create order\n// See https://developer.paypal.com/docs/api/orders/v2/`,
      links: [{ label: 'PayPal Developer', url: 'https://developer.paypal.com' }, { label: 'PayPal Orders API Docs', url: 'https://developer.paypal.com/docs/api/orders/v2/' }],
    },
    {
      name: 'square', type: 'api',
      description: 'Square payments API — good for POS + online',
      authEnv: ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'],
      authType: 'bearer',
      baseUrl: 'https://connect.squareup.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `const payload = JSON.stringify({ idempotency_key: Date.now().toString(), amount_money: { amount: 100, currency: 'USD' }, source_id: 'cnon:card-nonce-ok' });\nconst req = https.request({ hostname:'connect.squareup.com', path:'/v2/payments', method:'POST', headers:{ Authorization:'Bearer '+secrets.SQUARE_ACCESS_TOKEN, 'Content-Type':'application/json' } }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});\nreq.on('error',reject); req.write(payload); req.end();`,
      links: [{ label: 'Square Developer', url: 'https://developer.squareup.com' }, { label: 'Square Payments Docs', url: 'https://developer.squareup.com/reference/square/payments-api' }],
    },
  ],
  storage: [
    {
      name: 's3', type: 'api',
      description: 'AWS S3 — industry standard object storage',
      authEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET', 'AWS_REGION'],
      authType: 'aws_v4',
      baseUrl: 'https://s3.amazonaws.com',
      initSnippet: `const https = require('https');`,
      exampleSnippet: `// Use AWS SDK v3 (ships compiled JS): const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');\nconst client = new S3Client({ region: secrets.AWS_REGION });\nawait client.send(new PutObjectCommand({ Bucket: secrets.S3_BUCKET, Key: filename, Body: content }));`,
      links: [{ label: 'AWS S3 Console', url: 'https://s3.console.aws.amazon.com' }, { label: 'AWS SDK v3 Docs', url: 'https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/' }],
    },
    {
      name: 'cloudinary', type: 'api',
      description: 'Cloudinary — media asset management + CDN',
      authEnv: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
      authType: 'basic',
      baseUrl: 'https://api.cloudinary.com',
      initSnippet: `const https = require('https');\nconst auth = Buffer.from(secrets.CLOUDINARY_API_KEY + ':' + secrets.CLOUDINARY_API_SECRET).toString('base64');`,
      exampleSnippet: `// Upload via upload API\n// POST https://api.cloudinary.com/v1_1/<cloud>/image/upload`,
      links: [{ label: 'Cloudinary Dashboard', url: 'https://cloudinary.com/console' }, { label: 'Cloudinary Upload Docs', url: 'https://cloudinary.com/documentation/image_upload_api_reference' }],
    },
    {
      name: 'backblaze', type: 'api',
      description: 'Backblaze B2 — affordable S3-compatible storage',
      authEnv: ['B2_APPLICATION_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET_NAME'],
      authType: 'basic',
      baseUrl: 'https://api.backblazeb2.com',
      initSnippet: `const https = require('https');\nconst auth = Buffer.from(secrets.B2_APPLICATION_KEY_ID + ':' + secrets.B2_APPLICATION_KEY).toString('base64');`,
      exampleSnippet: `// Authorize first: GET https://api.backblazeb2.com/b2api/v2/b2_authorize_account\n// Then upload: POST <apiUrl>/b2api/v2/b2_upload_file`,
      links: [{ label: 'Backblaze Console', url: 'https://secure.backblaze.com/b2_buckets.htm' }, { label: 'B2 API Docs', url: 'https://www.backblaze.com/b2/docs/calling.html' }],
    },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// Main entry: buildSkill
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Build a skill for a service via the 5-step web-search-driven pipeline.
 *
 * @param {string} serviceName   e.g. "clicksend", "twilio", "stripe"
 * @param {string} capability    e.g. "sms", "payment", "email"
 * @param {string} [intent]      full user intent string for context
 * @returns {Promise<{ type: 'cli'|'api', provider, capability, config } | null>}
 */
/**
 * @param {string} serviceName
 * @param {string} capability
 * @param {string} [intent]
 * @param {Function} [emitFn]  optional (type, payload) => void — pushed to ResultsWindow
 */
async function buildSkill(serviceName, capability, intent, emitFn) {
  const svc = (serviceName || '').toLowerCase().trim();
  const cap = (capability || svc).toLowerCase().trim();
  const emit = typeof emitFn === 'function' ? emitFn : () => {};

  if (!svc) return null;

  logger.info(`[SkillBuilder] Starting skill build for "${svc}" (capability: "${cap}")`);

  // ── Step 1: Prerequisites ──────────────────────────────────────────────────
  emit('planning', { message: `Checking prerequisites (node, npm, brew)…` });
  const prereqs = checkPrereqs();
  logger.info(`[SkillBuilder] Prereqs — node:${prereqs.node} npm:${prereqs.npm} brew:${prereqs.brew}`);
  if (!prereqs.node || !prereqs.npm) {
    emit('planning', { message: '⚠️ node.js or npm not found — cannot build skill.' });
    logger.error('[SkillBuilder] node or npm not available — cannot build skill');
    return null;
  }
  if (!prereqs.brew) {
    emit('planning', { message: '⚠️ Homebrew not found — CLI installs via brew will be skipped.' });
  }

  // ── Steps 2+3: Try CLI first ───────────────────────────────────────────────
  emit('planning', { message: `Searching for a "${svc}" CLI tool…` });
  const cliResult = await discoverCLIViaWeb(svc, cap, prereqs);
  if (cliResult) {
    emit('planning', { message: `Found CLI tool for "${svc}": ${cliResult.config.tool}` });
    logger.info(`[SkillBuilder] CLI skill found for "${svc}" — binary: ${cliResult.config.tool}`);
    return cliResult;
  }

  // ── Step 4: Fall back to API ───────────────────────────────────────────────
  emit('planning', { message: `No CLI found for "${svc}" — searching REST API docs…` });
  logger.info(`[SkillBuilder] No CLI found for "${svc}" — trying API discovery`);
  const apiResult = await discoverAPIViaWeb(svc, cap);
  if (apiResult) {
    emit('planning', { message: `Found API config for "${svc}" (${apiResult.config.npm || 'native https'})` });
    logger.info(`[SkillBuilder] API skill found for "${svc}" — npm: ${apiResult.config.npm || 'native https'}`);
    return apiResult;
  }

  // ── Last resort: use CAPABILITY_FALLBACKS entry for this provider ─────────
  const capFallbacks = CAPABILITY_FALLBACKS[cap] || [];
  const fbEntry = capFallbacks.find(fb => fb.name === svc);
  if (fbEntry) {
    emit('planning', { message: `Using built-in config for "${svc}" — ready to collect credentials.` });
    logger.info(`[SkillBuilder] Using CAPABILITY_FALLBACKS entry for "${svc}" as last resort`);
    return {
      type: 'api',
      provider: svc,
      capability: cap,
      config: {
        npm: fbEntry.npm || null,
        authType: fbEntry.authType || 'env',
        authEnv: fbEntry.authEnv || [],
        baseUrl: fbEntry.baseUrl || null,
        initSnippet: fbEntry.initSnippet || '',
        exampleSnippet: fbEntry.exampleSnippet || '',
        links: fbEntry.links || [],
      },
    };
  }

  emit('planning', { message: `Could not find API config for "${svc}" — falling back to code generation.` });
  logger.warn(`[SkillBuilder] Could not find any CLI or API approach for "${svc}"`);
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// discoverProviders — find ALL options for a capability via web search
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Web-search for all available CLI tools and API/SDK providers for a capability.
 * Returns a ranked list for the user to choose from.
 * Called by gatherContext BEFORE asking any credential questions.
 *
 * @param {string} capability   e.g. "sms", "email", "payment"
 * @param {string} [intent]     full user message for context
 * @returns {Promise<Array<{ name: string, type: 'cli'|'api', description: string }>>}
 */

async function discoverProviders(capability, intent) {
  const cap = (capability || '').toLowerCase().trim();
  if (!cap) return [];

  logger.info(`[SkillBuilder] discoverProviders for capability "${cap}"`);

  // Run 3 searches in parallel: alternatives list, npm SDKs, and API comparisons
  const [altResults, npmResults, apiResults] = await Promise.all([
    webSearch(`${cap} API service alternatives comparison 2024 2025 best providers list`, 6),
    webSearch(`${cap} npm package SDK Node.js send messages 2024`, 6),
    webSearch(`best ${cap} messaging service REST API developer 2024`, 6),
  ]);

  const allResults = [...altResults, ...npmResults, ...apiResults];
  logger.info(`[SkillBuilder] discoverProviders: ${allResults.length} web results for "${cap}"`);

  // Get the hardcoded fallback list for this capability
  const fallbacks = CAPABILITY_FALLBACKS[cap] || [];

  let webDiscovered = [];
  if (allResults.length > 0) {
    const system = `You are an API service expert. Given web search results about "${cap}" services, identify ALL distinct service providers mentioned.

Return ONLY a valid JSON array — no explanation, no markdown fences:
[
  { "name": "<provider name, lowercase, e.g. twilio>", "type": "api", "description": "<one sentence max>", "authEnv": ["ENV_VAR_NAME"] },
  ...
]

CRITICAL rules:
- You MUST return at least 3-5 providers if they exist in the results
- Include every distinct provider mentioned — do not pick just the most popular one
- type is almost always "api" for web services (use "cli" only if there is a real installable binary)
- authEnv: use standard env var names like TWILIO_ACCOUNT_SID, CLICKSEND_API_KEY etc
- Exclude: tutorials, demo services, localhost tools, deprecated services
- Return [] only if truly no real providers are mentioned`;

    const user = `Find ALL ${cap} service providers mentioned in these search results.
User intent: "${intent || cap}"

Search results:
${formatResults(allResults)}

List every ${cap} provider you can find (aim for 3-6 options):`;

    try {
      const raw = await llmAsk(user, system);
      // Handle both array and object-wrapped responses
      let parsed = null;
      try {
        const cleaned = (raw || '').trim().replace(/^```json?\n?/i, '').replace(/\n?```\s*$/, '').trim();
        // Try array first
        if (cleaned.startsWith('[')) {
          parsed = JSON.parse(cleaned);
        } else {
          // Try extracting array from object
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) parsed = JSON.parse(arrMatch[0]);
        }
      } catch (_) {}

      if (Array.isArray(parsed)) {
        webDiscovered = parsed.filter(p => p.name && typeof p.name === 'string');
        logger.info(`[SkillBuilder] LLM extracted providers: ${webDiscovered.map(p => p.name).join(', ')}`);
      }
    } catch (e) {
      logger.warn(`[SkillBuilder] discoverProviders LLM failed: ${e.message}`);
    }
  }

  // Merge: web-discovered first, then fill in from fallbacks for any not already in the list
  const seen = new Set(webDiscovered.map(p => p.name.toLowerCase()));
  const merged = [...webDiscovered];
  for (const fb of fallbacks) {
    if (!seen.has(fb.name)) {
      merged.push(fb);
      seen.add(fb.name);
    }
  }

  // Cap at 6 providers
  const final = merged.slice(0, 6);
  logger.info(`[SkillBuilder] discoverProviders final list: ${final.map(p => p.name).join(', ')}`);
  return final;
}

module.exports = { buildSkill, checkPrereqs, discoverProviders };
