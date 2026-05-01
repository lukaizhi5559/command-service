'use strict';

/**
 * skill: web.agent
 *
 * Web research agent that uses web_search MCP for domain research.
 * Provides domain research, tutorial step extraction, and insight synthesis.
 *
 * Actions:
 *   research_domain  { domain, query }      → searches web for domain-specific guidance
 *   get_tutorial_steps { query }            → extracts step-by-step instructions from search results
 */

const http   = require('http');
const logger = require('../logger.cjs');

// Web Search MCP configuration from environment
const WEB_SEARCH_API_URL = process.env.MCP_WEB_SEARCH_API_URL;
const WEB_SEARCH_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY;

/**
 * Search the web using configured MCP web_search service.
 * Mirrors the agentWebSearch pattern in browser.agent.cjs for correct envelope format.
 */
async function searchWeb(query, maxResults = 5) {
  if (!WEB_SEARCH_API_URL) {
    logger.warn('[web.agent] Web search not configured - MCP_WEB_SEARCH_API_URL missing');
    return { ok: false, skipped: true, error: 'Web search not configured' };
  }

  let wsHostname, wsPort;
  try {
    const _u = new URL(WEB_SEARCH_API_URL);
    wsHostname = _u.hostname;
    wsPort = parseInt(_u.port) || 3002;
  } catch (_) {
    logger.warn('[web.agent] MCP_WEB_SEARCH_API_URL is not a valid URL — web search skipped');
    return { ok: false, skipped: true, error: 'Web search URL is invalid' };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'web-search',
      requestId: `ws_${Date.now()}`,
      action: 'search',
      payload: { query, maxResults },
    });
    const req = http.request({
      hostname: wsHostname,
      port: wsPort,
      path: '/web.search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${WEB_SEARCH_API_KEY || ''}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.data?.results || parsed?.results || [];
          logger.info(`[web.agent] searchWeb: ${results.length} results for "${query.slice(0, 60)}"`);
          resolve({ ok: true, results });
        } catch (e) {
          logger.error(`[web.agent] searchWeb parse error: ${e.message}`);
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => {
      logger.error(`[web.agent] searchWeb request error: ${e.message}`);
      resolve({ ok: false, error: e.message });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      logger.warn(`[web.agent] searchWeb timed out for "${query.slice(0, 60)}"`);
      resolve({ ok: false, error: 'web search timed out' });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Research a domain for specific task guidance
 */
async function actionResearchDomain({ domain, query, maxResults = 5 }) {
  if (!domain && !query) {
    return { ok: false, error: 'domain or query is required' };
  }

  const searchQuery = query || `How to use ${domain} complete guide tutorial`;
  logger.info(`[web.agent] Researching: ${searchQuery}`);

  const searchResult = await searchWeb(searchQuery, maxResults);
  
  if (!searchResult.ok) {
    return searchResult;
  }

  // Synthesize insights from search results
  const insights = searchResult.results.map(r => ({
    title: r.title,
    snippet: r.snippet,
    url: r.url,
    source: new URL(r.url).hostname
  }));

  // Extract common patterns and steps
  const stepPatterns = _extractStepPatterns(insights);

  return {
    ok: true,
    query: searchQuery,
    insights,
    stepPatterns,
    sourceCount: insights.length
  };
}

/**
 * Extract tutorial steps from search results focused on "how to" queries
 */
async function actionGetTutorialSteps({ query, maxResults = 3 }) {
  if (!query) {
    return { ok: false, error: 'query is required' };
  }

  // Enhance query for step-by-step results
  const enhancedQuery = `how to ${query} step by step tutorial guide`;
  logger.info(`[web.agent] Getting tutorial steps: ${enhancedQuery}`);

  const searchResult = await searchWeb(enhancedQuery, maxResults);
  
  if (!searchResult.ok) {
    return searchResult;
  }

  // Extract structured steps from snippets
  const tutorials = searchResult.results.map(r => ({
    title: r.title,
    url: r.url,
    steps: _extractStepsFromText(r.snippet),
    rawSnippet: r.snippet
  }));

  // Merge and deduplicate steps across sources
  const mergedSteps = _mergeTutorialSteps(tutorials);

  return {
    ok: true,
    query: enhancedQuery,
    tutorials,
    mergedSteps,
    confidence: _calculateStepConfidence(mergedSteps, tutorials.length)
  };
}

/**
 * Extract step patterns from search insights
 */
function _extractStepPatterns(insights) {
  const patterns = [];
  const actionVerbs = ['click', 'select', 'enter', 'type', 'choose', 'fill', 'press', 'submit', 'login', 'sign'];
  
  for (const insight of insights) {
    const text = `${insight.title} ${insight.snippet}`.toLowerCase();
    
    for (const verb of actionVerbs) {
      const regex = new RegExp(`\\b${verb}\\s+(?:the\\s+)?([^.,;]+)`, 'gi');
      const matches = text.matchAll(regex);
      
      for (const match of matches) {
        if (match[1] && match[1].length > 3) {
          patterns.push({
            action: verb,
            target: match[1].trim(),
            source: insight.source
          });
        }
      }
    }
  }

  // Deduplicate by action+target
  const seen = new Set();
  return patterns.filter(p => {
    const key = `${p.action}:${p.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20); // Limit to top 20 patterns
}

/**
 * Extract numbered steps from text
 */
function _extractStepsFromText(text) {
  const steps = [];
  
  // Match numbered steps (1. Step one, 2. Step two, etc.)
  const numberedRegex = /(?:\d+\.?\s+|\(?\d+\)?\s+)([^.\n]+)/g;
  let match;
  while ((match = numberedRegex.exec(text)) !== null) {
    steps.push(match[1].trim());
  }

  // Match bullet points
  const bulletRegex = /(?:^|\n)[\s]*[-•*][\s]+([^\n]+)/g;
  while ((match = bulletRegex.exec(text)) !== null) {
    steps.push(match[1].trim());
  }

  // Match "Step X: ..." or "Step X - ..."
  const stepRegex = /step\s+\d+[:\-\s]+([^\n]+)/gi;
  while ((match = stepRegex.exec(text)) !== null) {
    steps.push(match[1].trim());
  }

  // If no structured steps found, extract sentences with action verbs
  if (steps.length === 0) {
    const actionRegex = /(?:click|select|enter|type|choose|fill|press|submit)\s+[^.]+/gi;
    while ((match = actionRegex.exec(text)) !== null) {
      steps.push(match[0].trim());
    }
  }

  return [...new Set(steps)].slice(0, 10); // Deduplicate and limit
}

/**
 * Merge steps from multiple tutorials, removing duplicates
 */
function _mergeTutorialSteps(tutorials) {
  const allSteps = [];
  const seenPhrases = new Set();

  for (const tutorial of tutorials) {
    for (const step of tutorial.steps) {
      // Normalize for comparison
      const normalized = step.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Check for similarity with existing steps
      let isDuplicate = false;
      for (const seen of seenPhrases) {
        if (_calculateSimilarity(normalized, seen) > 0.7) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && step.length > 10) {
        seenPhrases.add(normalized);
        allSteps.push({
          text: step,
          source: tutorial.url,
          confidence: 'medium'
        });
      }
    }
  }

  return allSteps.slice(0, 15); // Top 15 unique steps
}

/**
 * Calculate string similarity (simple Jaccard)
 */
function _calculateSimilarity(a, b) {
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/**
 * Calculate confidence score for merged steps
 */
function _calculateStepConfidence(mergedSteps, sourceCount) {
  if (mergedSteps.length === 0) return 0;
  if (sourceCount >= 3 && mergedSteps.length >= 5) return 0.9;
  if (sourceCount >= 2 && mergedSteps.length >= 3) return 0.7;
  if (mergedSteps.length >= 3) return 0.5;
  return 0.3;
}

// Main export handler
module.exports = async function webAgent(args) {
  const { action, ...params } = args || {};
  
  switch (action) {
    case 'research_domain':
      return await actionResearchDomain(params);
    case 'get_tutorial_steps':
      return await actionGetTutorialSteps(params);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
};
