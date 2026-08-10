'use strict';

/**
 * skill: provider.discovery
 *
 * Provider management agent — handles natural language queries about LLM
 * providers and models, and can add/remove/switch providers at runtime.
 *
 * Actions:
 *   list_models      { provider? }                              → list models for all or one provider
 *   model_info       { provider?, modelId? }                    → speed/intelligence/score info
 *   switch_model     { provider, oldModelId, newModelId, taskType? } → promote a model (both already in catalog)
 *   use_model        { provider, modelId, taskType? }           → discover if missing, then promote as main model
 *   find_providers   { query? }                                 → web search for new free LLM providers
 *   add_provider     { name, baseURL, envKey, ... }             → add a provider + auto-discover
 *   remove_provider  { name }                                   → remove a provider
 *   health_check     { }                                        → catalog health report
 *
 * Uses:
 *   - HTTP to backend (localhost:4000) for catalog operations
 *   - web.agent.cjs searchWeb() for web research
 *   - web.crawl.cjs webCrawl() for crawling API docs
 *   - skill-llm.cjs ask() for LLM classification
 */

const http   = require('http');
const logger = require('../logger.cjs');
const { ask } = require('../skill-helpers/skill-llm.cjs');
const { searchWeb } = require('./web.agent.cjs');
const { webCrawl } = require('./web.crawl.cjs');

const BACKEND_HOST = process.env.THINKDROP_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.THINKDROP_BACKEND_PORT || '4000', 10);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: BACKEND_HOST, port: BACKEND_PORT, path: urlPath, method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.end();
  });
}

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: BACKEND_HOST, port: BACKEND_PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(payload);
    req.end();
  });
}

function httpDelete(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: BACKEND_HOST, port: BACKEND_PORT, path: urlPath, method: 'DELETE',
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.end();
  });
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * list_models — list all models for all providers or a specific one
 */
async function actionListModels(params) {
  const { provider } = params;
  if (provider) {
    const data = await httpGet(`/api/catalog/providers/${encodeURIComponent(provider)}`);
    if (data.error) return { ok: false, error: data.error };
    const models = (data.models || []).filter(m => m.status === 'active');
    return {
      ok: true,
      provider: data.name,
      status: data.status,
      apiType: data.apiType,
      models: models.map(m => ({
        id: m.id, taskType: m.taskType, intelligence: m.intelligence,
        speed: m.speed, category: m.category, status: m.status,
      })),
    };
  }
  // List all providers
  const data = await httpGet('/api/catalog/providers');
  const providers = data.providers || [];
  return {
    ok: true,
    providers: providers.map(p => ({
      name: p.name, status: p.status, activeModels: p.activeModels, totalModels: p.totalModels,
    })),
  };
}

/**
 * model_info — get speed/intelligence/score for a specific model or all rankings
 */
async function actionModelInfo(params) {
  const { provider, modelId } = params;
  const data = await httpGet('/api/catalog/rankings');
  if (data.error) return { ok: false, error: data.error };

  if (provider && modelId) {
    // Find specific model
    for (const tt of ['heavy', 'light']) {
      const chain = data[tt] || [];
      for (const p of chain) {
        if (p.provider === provider) {
          const model = p.models.find(m => m.id === modelId);
          if (model) return { ok: true, provider, modelId, taskType: tt, ...model };
        }
      }
    }
    return { ok: false, error: `Model not found: ${provider}/${modelId}` };
  }

  if (provider) {
    // Return all models for this provider from rankings
    const result = {};
    for (const tt of ['heavy', 'light']) {
      const chain = data[tt] || [];
      const p = chain.find(c => c.provider === provider);
      if (p) result[tt] = p.models;
    }
    return { ok: true, provider, rankings: result };
  }

  // Return top 5 models per task type
  const result = {};
  for (const tt of ['heavy', 'light']) {
    const chain = data[tt] || [];
    result[tt] = chain.slice(0, 3).map(p => ({
      provider: p.provider,
      topModel: p.models[0],
    }));
  }
  return { ok: true, topModels: result };
}

/**
 * switch_model — promote a model that's already in the catalog
 */
async function actionSwitchModel(params) {
  const { provider, newModelId, taskType } = params;
  if (!provider || !newModelId) {
    return { ok: false, error: 'provider and newModelId are required' };
  }
  const result = await httpPost('/api/catalog/promote', {
    provider, modelId: newModelId, taskType: taskType || 'heavy',
  });
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, message: `Switched ${provider} to use ${newModelId} as primary ${taskType || 'heavy'} model`, ...result };
}

/**
 * use_model — multi-step: check catalog → discover if missing → promote
 * Handles "I want to start using [model] for [provider] as my main model"
 */
async function actionUseModel(params) {
  const { provider, modelId, taskType } = params;
  if (!provider || !modelId) {
    return { ok: false, error: 'provider and modelId are required' };
  }

  // Step 1: Check if the model already exists in the catalog
  const providerData = await httpGet(`/api/catalog/providers/${encodeURIComponent(provider)}`);
  if (providerData.error) {
    return { ok: false, error: providerData.error };
  }

  const existingModel = (providerData.models || []).find(m => m.id === modelId && m.status === 'active');

  if (existingModel) {
    // Model already in catalog — just promote
    const promoteResult = await httpPost('/api/catalog/promote', {
      provider, modelId, taskType: taskType || 'heavy',
    });
    if (promoteResult.error) return { ok: false, error: promoteResult.error };
    return {
      ok: true,
      action: 'promote',
      message: `Model ${provider}/${modelId} is now your primary ${taskType || 'heavy'} model.`,
      model: existingModel,
    };
  }

  // Step 2: Model not in catalog — trigger discovery to find it
  logger.info(`[provider.discovery] Model ${modelId} not in catalog for ${provider} — triggering discovery`);
  const discoverResult = await httpPost(`/api/catalog/discover/${encodeURIComponent(provider)}`, {});

  // Step 3: Check again after discovery
  const updatedProvider = await httpGet(`/api/catalog/providers/${encodeURIComponent(provider)}`);
  const discoveredModel = (updatedProvider.models || []).find(m => m.id === modelId && m.status === 'active');

  if (discoveredModel) {
    // Found it — promote
    const promoteResult = await httpPost('/api/catalog/promote', {
      provider, modelId, taskType: taskType || 'heavy',
    });
    if (promoteResult.error) return { ok: false, error: promoteResult.error };
    return {
      ok: true,
      action: 'discover_and_promote',
      message: `Discovered and promoted ${provider}/${modelId} as your primary ${taskType || 'heavy'} model.`,
      model: discoveredModel,
    };
  }

  // Step 4: Model not found even after discovery
  const availableModels = (updatedProvider.models || [])
    .filter(m => m.status === 'active')
    .map(m => ({ id: m.id, taskType: m.taskType, intelligence: m.intelligence, speed: m.speed }));

  return {
    ok: false,
    action: 'not_found',
    error: `Model "${modelId}" was not found on provider "${provider}" after discovery.`,
    availableModels,
    suggestion: availableModels.length > 0
      ? `Here are the available models on ${provider}. Would you like to use one of these instead?`
      : `Provider "${provider}" has no active models. Check if the API key is set correctly.`,
  };
}

/**
 * find_providers — web search for new free LLM providers
 * Uses web.agent.cjs searchWeb + web.crawl.cjs to research providers
 */
async function actionFindProviders(params) {
  const { query } = params;
  const searchQuery = query || 'free openai compatible LLM API providers 2025 free tier';

  logger.info(`[provider.discovery] Searching web for new providers: "${searchQuery}"`);

  // Step 1: Web search
  const searchResult = await searchWeb(searchQuery, 10);
  if (!searchResult.ok || !searchResult.results || searchResult.results.length === 0) {
    return { ok: false, error: 'Web search returned no results', candidates: [] };
  }

  // Step 2: Get current providers to exclude them
  const currentProviders = await httpGet('/api/catalog/providers');
  const existingNames = new Set((currentProviders.providers || []).map(p => p.name.toLowerCase()));

  // Step 3: Use LLM to classify search results into provider candidates
  const searchResultsText = searchResult.results.slice(0, 10).map((r, i) => 
    `[${i}] title: ${r.title || ''}\n    url: ${r.url || r.link || ''}\n    snippet: ${(r.snippet || r.description || '').slice(0, 200)}`
  ).join('\n');

  const classifyPrompt = `You are an LLM provider catalog analyst. I searched for "${searchQuery}" and got these results:

${searchResultsText}

Current providers already in the catalog: ${Array.from(existingNames).join(', ')}

From these search results, identify any NEW LLM providers that:
1. Are NOT already in the current providers list
2. Offer a free tier or freemium API
3. Are OpenAI-compatible (use /v1/chat/completions format) or have their own SDK

For each candidate, extract:
- name: short identifier (e.g., "together-ai", "fireworks", "hyperbolic")
- baseURL: the API base URL (e.g., "https://api.together.xyz/v1")
- envKey: the expected env var name (e.g., "TOGETHER_API_KEY")
- catalogEndpoint: the /models endpoint if discoverable
- apiType: "openai-compatible" | "anthropic" | "google" | "mistral"
- tier: "free" | "freemium" | "paid"
- description: one-line description of what they offer

Respond in JSON only:
{"candidates": [{"name": "...", "baseURL": "...", "envKey": "...", "catalogEndpoint": "...", "apiType": "openai-compatible", "tier": "free", "description": "..."}]}

If no new providers found, return {"candidates": []}`;

  let candidates = [];
  try {
    const llmResponse = await ask(classifyPrompt, { maxTokens: 2000, temperature: 0.3 });
    const cleaned = llmResponse.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    candidates = parsed.candidates || [];
  } catch (e) {
    logger.warn(`[provider.discovery] LLM classification failed: ${e.message}`);
    // Fall back to raw search results
    return {
      ok: true,
      candidates: [],
      searchResults: searchResult.results.slice(0, 5).map(r => ({ title: r.title, url: r.url || r.link })),
      note: 'LLM classification failed — showing raw search results for manual review.',
    };
  }

  // Step 4: Filter out existing providers
  const newCandidates = candidates.filter(c => !existingNames.has(c.name.toLowerCase()));

  // Step 5: Optionally crawl the top candidate's API docs to verify
  if (newCandidates.length > 0 && newCandidates[0].baseURL) {
    try {
      const crawlResult = await webCrawl({
        url: newCandidates[0].baseURL.replace('/v1', '/docs') || newCandidates[0].baseURL,
        maxChars: 3000, timeoutMs: 15000,
      });
      if (crawlResult.ok && crawlResult.content) {
        newCandidates[0].docsPreview = crawlResult.content.slice(0, 500);
        newCandidates[0].docsVerified = true;
      }
    } catch (e) {
      // Crawl failure is non-fatal
    }
  }

  return {
    ok: true,
    candidates: newCandidates,
    note: newCandidates.length > 0
      ? `Found ${newCandidates.length} potential new providers. Use add_provider to add them.`
      : 'No new providers found in search results.',
  };
}

/**
 * add_provider — add a provider to the backend catalog + auto-discover
 */
async function actionAddProvider(params) {
  const { name, baseURL, envKey, catalogEndpoint, apiType, tier, autoDiscover } = params;
  if (!name || !baseURL || !envKey) {
    return { ok: false, error: 'name, baseURL, and envKey are required' };
  }

  const result = await httpPost('/api/catalog/providers', {
    name, baseURL, envKey,
    catalogEndpoint,
    apiType: apiType || 'openai-compatible',
    tier: tier || 'free',
    autoDiscover: autoDiscover !== false, // default true
  });

  if (result.error) return { ok: false, error: result.error };

  return {
    ok: true,
    message: `Provider ${name} added successfully.${result.discovery ? ` Discovered ${result.discovery.totalModels} models.` : ''}`,
    ...result,
  };
}

/**
 * remove_provider — remove a provider from the catalog
 */
async function actionRemoveProvider(params) {
  const { name } = params;
  if (!name) return { ok: false, error: 'name is required' };

  const result = await httpDelete(`/api/catalog/providers/${encodeURIComponent(name)}`);
  if (result.error) return { ok: false, error: result.error };

  return { ok: true, message: `Provider ${name} removed.`, ...result };
}

/**
 * health_check — return catalog health report
 */
async function actionHealthCheck() {
  const data = await httpGet('/api/catalog/health');
  return { ok: true, ...data };
}

// ── Main export ───────────────────────────────────────────────────────────────

module.exports = async function providerDiscoveryAgent(args) {
  const { action, ...params } = args || {};

  switch (action) {
    case 'list_models':
      return await actionListModels(params);
    case 'model_info':
      return await actionModelInfo(params);
    case 'switch_model':
      return await actionSwitchModel(params);
    case 'use_model':
      return await actionUseModel(params);
    case 'find_providers':
      return await actionFindProviders(params);
    case 'add_provider':
      return await actionAddProvider(params);
    case 'remove_provider':
      return await actionRemoveProvider(params);
    case 'health_check':
      return await actionHealthCheck();
    default:
      return { ok: false, error: `Unknown action: ${action}. Valid: list_models, model_info, switch_model, use_model, find_providers, add_provider, remove_provider, health_check` };
  }
};

// Export individual actions for testing
module.exports.actionListModels     = actionListModels;
module.exports.actionModelInfo      = actionModelInfo;
module.exports.actionSwitchModel    = actionSwitchModel;
module.exports.actionUseModel       = actionUseModel;
module.exports.actionFindProviders  = actionFindProviders;
module.exports.actionAddProvider    = actionAddProvider;
module.exports.actionRemoveProvider = actionRemoveProvider;
module.exports.actionHealthCheck    = actionHealthCheck;
