'use strict';

/**
 * skill: web.agent
 *
 * Web research agent that uses web_search MCP for domain research.
 * Provides domain research, tutorial step extraction, and insight synthesis.
 *
 * Actions:
 *   research_domain      { domain, query }              → searches web for domain-specific guidance
 *   get_tutorial_steps   { query }                       → extracts step-by-step instructions from search results
 *   search_and_navigate  { query, preferDomain? }        → searches web, picks best URL to navigate to directly
 *   discover_task_url   { domain, task }                → dual search (site-scoped + broad) to find the most direct deep-link URL for a task
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
 * Detect parking/squatter content from a search result snippet or title.
 * Works on content signals, not hostname lists — scales to any broker/registrar.
 */
function _isParkingContent(title, snippet, url) {
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  const urlLower = (url || '').toLowerCase();
  // Parking language in title/snippet
  if (/\bdomain\s+(for\s+sale|is\s+for\s+sale|available\s+for\s+sale)\b/.test(text)) return true;
  if (/\bbuy\s+this\s+domain\b/.test(text)) return true;
  if (/\bmake\s+an?\s+offer\b/.test(text)) return true;
  if (/\bparked\s+(by|domain|page)\b/.test(text)) return true;
  if (/\binquire\s+about\s+this\s+domain\b/.test(text)) return true;
  if (/\bthis\s+domain\s+(may\s+be|is)\s+(for\s+sale|available)\b/.test(text)) return true;
  // URL-level parking indicators
  if (/buy.*domain|domain.*sale|domain.*park|domainbroker/i.test(urlLower)) return true;
  return false;
}

/**
 * Score a search result URL for quality.
 * Higher = better. Penalizes parking pages via content signals, rewards preferDomain match.
 */
function _scoreResult(result, preferDomain) {
  let score = 50; // baseline
  try {
    const host = new URL(result.url).hostname.replace(/^www\./, '');
    // Penalize parking/squatter content — content-based, not hostname-list-based
    if (_isParkingContent(result.title, result.snippet, result.url)) return -1;
    // Prefer explicit domain match
    if (preferDomain) {
      const pref = preferDomain.toLowerCase().replace(/^www\./, '');
      if (host === pref || host.endsWith('.' + pref) || pref.endsWith('.' + host)) score += 40;
      else if (host.includes(pref) || pref.includes(host.split('.')[0])) score += 20;
    }
    // Prefer reputable TLDs for dev/doc content
    if (host.endsWith('.org') || host.endsWith('.io') || host.endsWith('.dev')) score += 10;
    // Prefer official-looking subdomains
    if (host.startsWith('docs.') || host.startsWith('developer.') || host.startsWith('help.')) score += 15;
    // Boost if snippet has step-like content
    if (result.snippet && /step|how to|navigate|click|select/i.test(result.snippet)) score += 5;
  } catch (_) { score = 0; }
  return score;
}

/**
 * Search the web and return the best URL to navigate to directly.
 * Used by browser.agent internally and as a plan-level skill.
 */
async function actionSearchAndNavigate({ query, preferDomain, maxResults = 5 }) {
  if (!query) return { ok: false, error: 'query is required' };

  logger.info(`[web.agent] search_and_navigate: "${query.slice(0, 80)}" preferDomain=${preferDomain || 'none'}`);

  const searchResult = await searchWeb(query, maxResults);
  if (!searchResult.ok) return searchResult;

  const results = searchResult.results || [];
  if (results.length === 0) return { ok: false, error: 'No search results returned' };

  // Score all results, filter negatives
  const scored = results
    .map(r => ({ ...r, _score: _scoreResult(r, preferDomain) }))
    .filter(r => r._score >= 0)
    .sort((a, b) => b._score - a._score);

  if (scored.length === 0) {
    return { ok: false, error: 'All search results were parking/squatter pages' };
  }

  const best = scored[0];
  logger.info(`[web.agent] search_and_navigate: best=${best.url} score=${best._score}`);

  return {
    ok: true,
    bestUrl: best.url,
    title: best.title,
    snippet: best.snippet,
    score: best._score,
    allResults: scored.map(r => ({ url: r.url, title: r.title, score: r._score })),
  };
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

  // Synthesize insights from search results, filtering parking/squatter content
  const insights = searchResult.results
    .filter(r => !_isParkingContent(r.title, r.snippet, r.url))
    .map(r => ({
      title: r.title,
      snippet: r.snippet,
      url: r.url,
      source: new URL(r.url).hostname
    }));

  // Extract common patterns and steps
  const stepPatterns = _extractStepPatterns(insights);

  // Pick best URL from results (highest scoring non-parking result)
  const preferDomain = domain || null;
  const scored = (searchResult.results || [])
    .map(r => ({ ...r, _score: _scoreResult(r, preferDomain) }))
    .filter(r => r._score >= 0)
    .sort((a, b) => b._score - a._score);
  const bestUrl = scored.length > 0 ? scored[0].url : null;

  // Synthesize a plain-text insights string for injection into agent context
  const insightsText = insights
    .slice(0, 3)
    .map(i => `- ${i.title}: ${i.snippet}`)
    .join('\n');

  // Confidence: based on result quality and step extraction
  const confidence = insights.length >= 3 && stepPatterns.length >= 3 ? 0.8
    : insights.length >= 2 ? 0.5
    : insights.length >= 1 ? 0.3
    : 0;

  return {
    ok: true,
    query: searchQuery,
    insights,
    insightsText,
    stepPatterns,
    bestUrl,
    confidence,
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

/**
 * Discover the most direct deep-link URL for a task on a given service domain.
 * Uses two search strategies and merges results:
 *   A) site-scoped:   site:<domain> <task>          → finds indexed app pages
 *   B) broad:         <domain> <task> how to page URL → finds URLs mentioned in tutorials/guides
 * Scores all candidates and returns the best one.
 */
async function actionDiscoverTaskUrl({ domain, task, maxResults = 5, candidateUrl }) {
  if (!domain) return { ok: false, error: 'domain is required' };
  if (!task)   return { ok: false, error: 'task is required' };

  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  logger.info(`[web.agent] discover_task_url: domain=${cleanDomain} task="${task.slice(0, 80)}" candidateUrl=${candidateUrl || 'none'}`);

  // Extract task keywords for scoring
  const taskKeywords = (task.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'how', 'use', 'page', 'url', 'site'].includes(w))
  );

  const allCandidates = [];

  // Seed with a previously verified URL if provided; it will compete with discovered candidates
  if (candidateUrl && candidateUrl.includes(cleanDomain)) {
    allCandidates.push({ url: candidateUrl, title: 'Previously verified URL', snippet: '', source: 'verified-cache' });
  }

  // ── Strategy A: site-scoped search ──────────────────────────────────────
  const queryA = `site:${cleanDomain} ${task.slice(0, 100)}`;
  logger.info(`[web.agent] discover_task_url: strategy A (site-scoped): "${queryA.slice(0, 80)}"`);
  const resultA = await searchWeb(queryA, maxResults).catch(() => ({ ok: false }));
  if (resultA.ok && resultA.results) {
    for (const r of resultA.results) {
      if (!_isParkingContent(r.title, r.snippet, r.url)) {
        allCandidates.push({ url: r.url, title: r.title, snippet: r.snippet, source: 'site-scoped' });
      }
    }
  }

  // ── Strategy B: broad search + snippet URL extraction ───────────────────
  const queryB = `${cleanDomain} ${task.slice(0, 80)} how to page URL`;
  logger.info(`[web.agent] discover_task_url: strategy B (broad): "${queryB.slice(0, 80)}"`);
  const resultB = await searchWeb(queryB, maxResults).catch(() => ({ ok: false }));
  if (resultB.ok && resultB.results) {
    for (const r of resultB.results) {
      if (!_isParkingContent(r.title, r.snippet, r.url)) {
        // The result URL itself might be on the service domain
        allCandidates.push({ url: r.url, title: r.title, snippet: r.snippet, source: 'broad-result' });
        // Also extract URLs mentioned in snippets (tutorials often say "go to exampleapp.com/create")
        // Include #, ?, =, &, % and other common URL chars so deep links like mail.google.com/mail/u/0/#inbox?compose=new are captured.
        const snippetUrls = (r.snippet || '').match(new RegExp(
          cleanDomain.replace(/\./g, '\\.') + '\\/[a-z0-9\/_#?=&.~%+-]+', 'gi'
        ));
        if (snippetUrls) {
          for (const su of snippetUrls) {
            const fullUrl = su.startsWith('http') ? su : `https://${su}`;
            allCandidates.push({ url: fullUrl, title: r.title, snippet: r.snippet, source: 'broad-snippet' });
          }
        }
      }
    }
  }

  if (allCandidates.length === 0) {
    logger.info('[web.agent] discover_task_url: no candidates found from either strategy');
    return { ok: false, error: 'No deep-link candidates found' };
  }

  // ── Score all candidates ────────────────────────────────────────────────
  const domainBase = cleanDomain.split('.')[0]; // e.g. 'exampleapp' from 'exampleapp.com'
  const scored = allCandidates.map(c => {
    let score = 10; // baseline
    try {
      const parsed = new URL(c.url);
      const host = parsed.hostname.replace(/^www\./, '');
      const path = parsed.pathname.toLowerCase();

      // +50: URL path contains task keywords
      for (const kw of taskKeywords) {
        if (path.includes(kw)) score += 50 / taskKeywords.length;
      }

      // +30: Same domain as the service
      if (host === cleanDomain || host.endsWith('.' + cleanDomain)) score += 30;
      else if (host.includes(domainBase)) score += 15;

      // +20: On the service domain (not a blog/reddit)
      if (host === cleanDomain || host.endsWith('.' + cleanDomain)) score += 20;

      // +25: Previously verified URL from cache
      if (c.source === 'verified-cache') score += 25;

      // +10: Snippet mentions "how to" + task keywords
      const snippetLower = (c.snippet || '').toLowerCase();
      if (/how to/.test(snippetLower)) {
        for (const kw of taskKeywords) {
          if (snippetLower.includes(kw)) { score += 10 / taskKeywords.length; break; }
        }
      }

      // Penalize root paths (just the homepage)
      if (path === '/' || path === '') score -= 20;

      // Penalize very long paths (likely article/blog pages, not app pages)
      if (path.split('/').length > 5) score -= 10;

    } catch (_) { score = 0; }
    return { ...c, _score: Math.round(score) };
  }).filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score);

  // Deduplicate by URL (keep highest score)
  const seen = new Set();
  const deduped = scored.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  if (deduped.length === 0 || deduped[0]._score < 30) {
    logger.info(`[web.agent] discover_task_url: best candidate scored ${deduped[0]?._score || 0} — below threshold, no override`);
    return { ok: false, error: 'No candidate scored above threshold', bestScore: deduped[0]?._score || 0 };
  }

  const best = deduped[0];
  const confidence = Math.min(1, best._score / 100);
  logger.info(`[web.agent] discover_task_url: best=${best.url} score=${best._score} confidence=${confidence.toFixed(2)} source=${best.source}`);

  return {
    ok: true,
    taskUrl: best.url,
    confidence,
    score: best._score,
    allCandidates: deduped.slice(0, 5).map(c => ({ url: c.url, score: c._score, source: c.source })),
  };
}

// Main export handler
module.exports = async function webAgent(args) {
  const { action, ...params } = args || {};
  
  switch (action) {
    case 'research_domain':
      return await actionResearchDomain(params);
    case 'get_tutorial_steps':
      return await actionGetTutorialSteps(params);
    case 'search_and_navigate':
      return await actionSearchAndNavigate(params);
    case 'discover_task_url':
      return await actionDiscoverTaskUrl(params);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
};

module.exports.actionResearchDomain    = actionResearchDomain;
module.exports.actionGetTutorialSteps  = actionGetTutorialSteps;
module.exports.actionSearchAndNavigate = actionSearchAndNavigate;
module.exports.actionDiscoverTaskUrl  = actionDiscoverTaskUrl;
