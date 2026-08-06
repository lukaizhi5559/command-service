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
 *   discover_search_syntax { domain, task }              → search + crawl official docs to extract a service's search/filter query operators
 *   research_app_behavior { domain, query? }            → targeted web research for app-level operational knowledge (shortcuts, UI modes, quirks)
 */

const http   = require('http');
const logger = require('../logger.cjs');
const { isAuthFlowUrl } = require('../skill-helpers/destination-resolver.cjs');

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

function _classifyDiscoveryCandidate({ url, title, snippet }, serviceDomain) {
  const text = `${url || ''} ${title || ''} ${snippet || ''}`.toLowerCase();
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, '');
    path = parsed.pathname.toLowerCase();
  } catch (_) {
    return { pageClass: 'unknown', onServiceDomain: false };
  }

  const normalizedServiceDomain = String(serviceDomain || '').replace(/^www\./, '').toLowerCase();
  const onServiceDomain = host === normalizedServiceDomain || host.endsWith(`.${normalizedServiceDomain}`);
  if (isAuthFlowUrl(url)) {
    return { pageClass: 'auth', onServiceDomain };
  }
  if (/\b(help|support|documentation|docs|guide|tutorial|community|forum)\b/.test(text)) {
    return { pageClass: 'documentation', onServiceDomain };
  }
  if (/\/(compose|draft|new|create|upload|publish|submit|editor)(?:\b|\/)/.test(path)) {
    return { pageClass: 'app-action', onServiceDomain };
  }
  if (/\/(p|page|post|article|blog|item)\//.test(path)) {
    return { pageClass: onServiceDomain ? 'app-content' : 'public-content', onServiceDomain };
  }
  if (onServiceDomain && (path === '/' || path === '')) {
    return { pageClass: 'app-home', onServiceDomain };
  }
  return { pageClass: 'unknown', onServiceDomain };
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
 * Uses three search strategies and merges results:
 *   A) site-scoped:   site:<domain> <task>          → finds indexed app pages
 *   B) broad:         <domain> <task> how to page URL → finds URLs mentioned in tutorials/guides
 *   C) shortcut:      <serviceName> <taskType> direct URL shortcut → finds shortcut domains (e.g. notion.new)
 * Scores all candidates and returns the best one.
 */
async function actionDiscoverTaskUrl({ domain, task, maxResults = 5, candidateUrl }) {
  if (!domain) return { ok: false, error: 'domain is required' };
  if (!task)   return { ok: false, error: 'task is required' };

  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const domainBase = cleanDomain.split('.')[0]; // e.g. 'notion' from 'app.notion.com'
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
        // Extract URLs matching the full cleanDomain/path pattern
        const snippetUrls = (r.snippet || '').match(new RegExp(
          cleanDomain.replace(/\./g, '\\.') + '\\/[a-z0-9\/_#?=&.~%+-]+', 'gi'
        ));
        // Also extract shortcut-domain URLs (e.g. notion.new, notion.so) —
        // serviceName.<tld> patterns that may not match cleanDomain
        const shortcutSnippetUrls = (r.snippet || '').match(new RegExp(
          domainBase.replace(/\./g, '\\.') + '\\.[a-z]{2,}(?:\\/[a-z0-9\/_#?=&.~%+-]*)?', 'gi'
        ));
        if (snippetUrls) {
          for (const su of snippetUrls) {
            const fullUrl = su.startsWith('http') ? su : `https://${su}`;
            allCandidates.push({ url: fullUrl, title: r.title, snippet: r.snippet, source: 'broad-snippet' });
          }
        }
        if (shortcutSnippetUrls) {
          for (const su of shortcutSnippetUrls) {
            const fullUrl = su.startsWith('http') ? su : `https://${su}`;
            // Avoid duplicates already added via snippetUrls
            if (!allCandidates.some(c => c.url === fullUrl)) {
              allCandidates.push({ url: fullUrl, title: r.title, snippet: r.snippet, source: 'broad-snippet-shortcut' });
            }
          }
        }
      }
    }
  }

  // ── Strategy C: shortcut/direct URL search ─────────────────────────────
  // Search for "<serviceName> <taskType> direct URL shortcut" to find shortcut
  // domains like notion.new, docs.google.com/forms, etc.
  const serviceName = cleanDomain.split('.')[0]; // 'notion' from 'app.notion.com'
  const taskType = /create|new|compose|write|draft/i.test(task) ? 'create new page' : task.split(' ').slice(0, 3).join(' ');
  const queryC = `${serviceName} ${taskType} direct URL shortcut`;
  logger.info(`[web.agent] discover_task_url: strategy C (shortcut): "${queryC.slice(0, 80)}"`);
  const resultC = await searchWeb(queryC, maxResults).catch(() => ({ ok: false }));
  if (resultC.ok && resultC.results) {
    for (const r of resultC.results) {
      if (!_isParkingContent(r.title, r.snippet, r.url)) {
        allCandidates.push({ url: r.url, title: r.title, snippet: r.snippet, source: 'shortcut-result' });
        // Extract shortcut URLs from snippets — patterns like notion.new, notion.so, etc.
        const shortcutUrls = (r.snippet || '').match(new RegExp(
          serviceName.replace(/\./g, '\\\.') + '\\.[a-z]{2,}(?:\\/[a-z0-9\/_#?=&.~%+-]*)?', 'gi'
        ));
        if (shortcutUrls) {
          for (const su of shortcutUrls) {
            const fullUrl = su.startsWith('http') ? su : `https://${su}`;
            allCandidates.push({ url: fullUrl, title: r.title, snippet: r.snippet, source: 'shortcut-snippet' });
          }
        }
      }
    }
  }

  // ── Strategy D: search URL syntax discovery ────────────────────────────
  // For search/filter tasks, search for "<service> search URL syntax" or
  // "<service> filter URL parameters" to find documentation about the service's
  // search URL format. Extract URL patterns from the results.
  const _isSearchTask = /\b(search|find|look\s*up|filter|unread|from:|subject:|label:|starred|is:unread|check.*for|show.*from|list.*from)\b/i.test(task);
  if (_isSearchTask) {
    const queryD = `${serviceName} search URL syntax filter parameters`;
    logger.info(`[web.agent] discover_task_url: strategy D (search syntax): "${queryD.slice(0, 80)}"`);
    const resultD = await searchWeb(queryD, maxResults).catch(() => ({ ok: false }));
    if (resultD.ok && resultD.results) {
      for (const r of resultD.results) {
        if (!_isParkingContent(r.title, r.snippet, r.url)) {
          // Extract search URL patterns from snippets — look for URLs with search/query params
          const searchPatternUrls = (r.snippet || '').match(new RegExp(
            cleanDomain.replace(/\./g, '\\.') + '\\/[a-z0-9\/_]*[#?]?(?:search|q|filter|query)=[a-z0-9\/_#?=&.~%+-]*', 'gi'
          ));
          if (searchPatternUrls) {
            for (const su of searchPatternUrls) {
              const fullUrl = su.startsWith('http') ? su : `https://${su}`;
              if (!allCandidates.some(c => c.url === fullUrl)) {
                allCandidates.push({ url: fullUrl, title: r.title, snippet: r.snippet, source: 'search-syntax' });
              }
            }
          }
          // Also check if the result URL itself is a search URL
          try {
            const rHost = new URL(r.url).hostname.replace(/^www\./, '');
            if ((rHost === cleanDomain || rHost.endsWith('.' + cleanDomain)) &&
                /[#?](search|q|filter|query)=/i.test(r.url)) {
              if (!allCandidates.some(c => c.url === r.url)) {
                allCandidates.push({ url: r.url, title: r.title, snippet: r.snippet, source: 'search-syntax-result' });
              }
            }
          } catch (_) {}
        }
      }
    }
  }

  if (allCandidates.length === 0) {
    logger.info('[web.agent] discover_task_url: no candidates found from any strategy');
    return { ok: false, error: 'No deep-link candidates found' };
  }

  // ── Score all candidates ────────────────────────────────────────────────
  const _isComposeTask = /\b(compose|send|write|draft|create|new email|new message|email to|reply|forward)\b/i.test(task);
  const scored = allCandidates.map(c => {
    let score = 10; // baseline
    try {
      const fullUrl = c.url.toLowerCase();

      // Reject PII redaction/placeholder tokens outright — search-index artifacts
      if (/\bpii_|%5bpii|\[redacted\]|\[placeholder\]/i.test(c.url)) {
        return { ...c, _score: 0 };
      }

      // Reject auth-flow URLs outright (login, magic-link, oauth, authorize,
      // callback, signup, verify, logout, …). These are identity-flow pages,
      // never valid task deep-links — promoting them sends the agent to an auth
      // error/landing page instead of the app surface (e.g. claude.ai/magic-link).
      if (isAuthFlowUrl(c.url)) {
        return { ...c, _score: 0 };
      }

      // Heavy penalty for prefilled-message query params on non-compose tasks
      // (stale subject/recipient/body from search index, never valid for read/search)
      if (!_isComposeTask && /[?&](su|to|body|subject|bcc|cc)=/i.test(c.url) && /[?&](view=cm|tf=cm|tf=1)/i.test(c.url)) {
        score -= 60;
      }

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
      // +15: Hostname starts with service name base but different TLD (likely shortcut domain)
      else if (host.split('.')[0] === domainBase) score += 15;

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

      // Penalize help/support/community pages — these are never app deep links
      const titleLower = (c.title || '').toLowerCase();
      if (/\/(support|help|helpcenter|topic|community|forum|answers|thread)\b/i.test(fullUrl) ||
          /\b(support|help)\b/i.test(host) ||
          /how to|tutorial|guide|help center|support/i.test(titleLower)) {
        score -= 40;
      }

      // Boost app-like URLs with deep-link markers (#, ?, compose, draft, new, create)
      if (/[#?]/.test(fullUrl) && host === cleanDomain) score += 15;
      if (/\b(compose|draft|new|create|inbox|mail|message)\b/i.test(path) && host === cleanDomain) score += 20;

      // Boost search URLs for search tasks — #search/, ?q=, ?filter=, /search?q=
      if (_isSearchTask && host === cleanDomain) {
        if (/#search\//i.test(fullUrl)) score += 40;
        if (/[?&](q|query|filter|search)=/i.test(fullUrl)) score += 30;
        if (/\/search\b/i.test(path)) score += 25;
      }

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

  const candidates = deduped.slice(0, 5).map(c => ({
    url: c.url,
    title: c.title,
    snippet: c.snippet,
    score: c._score,
    source: c.source,
    trust: 'search',
    ..._classifyDiscoveryCandidate(c, cleanDomain),
  }));
  const best = candidates[0];
  const confidence = Math.min(1, best.score / 100);
  logger.info(`[web.agent] discover_task_url: candidate=${best.url} score=${best.score} confidence=${confidence.toFixed(2)} source=${best.source} class=${best.pageClass}`);

  return {
    ok: true,
    taskUrl: best.url,
    confidence,
    score: best.score,
    trust: 'search',
    candidate: best,
    allCandidates: candidates,
    taskKeywords,
  };
}

/**
 * Discover a service's search/filter query operators (e.g. Gmail's "is:unread",
 * "has:attachment") by searching for and crawling its official help documentation,
 * then using an LLM to extract a concise operator → meaning list. Mirrors
 * actionDiscoverTaskUrl's search+crawl pattern but targets query syntax instead
 * of deep-link URLs.
 *
 * @param {string} domain - service hostname, e.g. "mail.google.com"
 * @param {string} task   - the user's task text, used only for logging/context
 * @returns {Promise<{ok, service, operators: string[], sourceUrl}>}
 */
async function actionDiscoverSearchSyntax({ domain, task }) {
  if (!domain) return { ok: false, error: 'domain is required' };

  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const serviceName = cleanDomain.split('.')[0];
  logger.info(`[web.agent] discover_search_syntax: domain=${cleanDomain} task="${(task || '').slice(0, 80)}"`);

  const query = `${serviceName} advanced search operators syntax`;
  const searchResult = await searchWeb(query, 5).catch(() => ({ ok: false }));
  if (!searchResult.ok || !Array.isArray(searchResult.results) || searchResult.results.length === 0) {
    logger.info('[web.agent] discover_search_syntax: no search results found');
    return { ok: false, error: 'No search results found' };
  }

  // Prefer official help/support docs for the service (most reliable operator listings)
  const officialDoc = searchResult.results.find(r => {
    try {
      const h = new URL(r.url).hostname.replace(/^www\./, '');
      return h.includes(serviceName) || h.includes(cleanDomain.split('.').slice(-2).join('.'));
    } catch (_) { return false; }
  }) || searchResult.results[0];

  logger.info(`[web.agent] discover_search_syntax: crawling ${officialDoc.url}`);
  const { webCrawl } = require('./web.crawl.cjs');
  const crawlResult = await webCrawl({ url: officialDoc.url, maxChars: 4000, timeoutMs: 20000 }).catch(() => ({ ok: false }));
  if (!crawlResult.ok || !crawlResult.content) {
    logger.info('[web.agent] discover_search_syntax: crawl failed or returned no content');
    return { ok: false, error: 'Crawl failed to extract documentation content' };
  }

  const { ask } = require('../skill-helpers/skill-llm.cjs');
  const extractPrompt = `The following is text crawled from a help page about "${serviceName}" search/query syntax.

Extract a concise list of search operators and what each one filters or means. Only include operators clearly documented in this text — do not invent any. Respond with ONLY a JSON array of strings, each formatted as "operator — meaning" (e.g. "is:unread — shows only unread messages"). If no operators are found, respond with [].

TEXT:
${crawlResult.content.slice(0, 3500)}`;

  let operators = [];
  try {
    const raw = await ask(extractPrompt, { maxTokens: 500, temperature: 0 });
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        operators = parsed.filter(o => typeof o === 'string' && o.trim().length > 0).slice(0, 12);
      }
    }
  } catch (err) {
    logger.warn(`[web.agent] discover_search_syntax: LLM extraction failed: ${err.message}`);
  }

  if (operators.length === 0) {
    logger.info('[web.agent] discover_search_syntax: no operators extracted');
    return { ok: false, error: 'No operators extracted from documentation' };
  }

  logger.info(`[web.agent] discover_search_syntax: extracted ${operators.length} operator(s) for ${serviceName} from ${officialDoc.url}`);
  return { ok: true, service: serviceName, operators, sourceUrl: officialDoc.url };
}

/**
 * Discover setup requirements for a CLI tool or service.
 * Searches for official installation/authentication documentation and extracts
 * structured setupInfo fields (installCmd, authCmd, setupUrl, credentials, instructions).
 *
 * @param {string} service   - service name (e.g. "gcalcli", "github")
 * @param {string} [cliTool] - CLI tool name (e.g. "gcalcli", "gh")
 * @param {number} [maxResults=5]
 * @returns {Promise<{ok, setupInfo, sources}>}
 */
async function actionDiscoverSetup({ service, cliTool, maxResults = 5 }) {
  if (!service && !cliTool) {
    return { ok: false, error: 'service or cliTool is required' };
  }

  const tool = cliTool || service;
  const searchQuery = `${tool} CLI install authenticate setup guide official documentation`;
  logger.info(`[web.agent] discover_setup: searching for "${searchQuery.slice(0, 80)}"`);

  const searchResult = await searchWeb(searchQuery, maxResults);
  if (!searchResult.ok) {
    return { ok: false, error: searchResult.error || 'web search failed', setupInfo: null };
  }

  const results = searchResult.results || [];
  if (results.length === 0) {
    return { ok: false, error: 'No search results found', setupInfo: null };
  }

  // Score results — prefer official documentation domains
  const preferDomain = `${service}.com`;
  const scored = results
    .map(r => ({ ...r, _score: _scoreResult(r, preferDomain) }))
    .filter(r => r._score >= 0)
    .sort((a, b) => b._score - a._score);

  // Extract setup hints from snippets
  const setupInfo = {};
  const sources = [];

  // Look for install commands in snippets
  const allSnippets = scored.map(r => r.snippet || '').join(' ');
  const allText = `${scored.map(r => `${r.title} ${r.snippet}`).join(' ')} `.toLowerCase();

  // Install command patterns
  const installPatterns = [
    { regex: /(?:brew install|pip install|npm install -g|pipx install)\s+[\w-]+/gi, field: 'installCmd' },
    { regex: /(?:apt-get install|apt install|snap install)\s+[\w-]+/gi, field: 'installCmd' },
  ];
  for (const { regex, field } of installPatterns) {
    const m = allSnippets.match(regex);
    if (m && m[0] && !setupInfo[field]) {
      setupInfo[field] = m[0].trim();
      break;
    }
  }

  // Auth/login command patterns
  const authPatterns = [
    { regex: new RegExp(`${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:login|auth|authenticate)`, 'gi'), field: 'authCmd' },
    { regex: /(?:gh auth|gcloud auth|aws configure|docker login)\s+/gi, field: 'authCmd' },
  ];
  for (const { regex, field } of authPatterns) {
    const m = allSnippets.match(regex);
    if (m && m[0] && !setupInfo[field]) {
      setupInfo[field] = m[0].trim();
      break;
    }
  }

  // Credentials patterns
  const credMatches = [];
  if (/api[_ ]?key/i.test(allText)) credMatches.push('api_key');
  if (/oauth/i.test(allText)) credMatches.push('oauth');
  if (/access[_ ]?token/i.test(allText)) credMatches.push('access_token');
  if (/client[_ ]?secret/i.test(allText)) credMatches.push('client_secret');
  if (credMatches.length > 0) setupInfo.credentials = credMatches;

  // Best official URL for setup
  const bestResult = scored[0];
  if (bestResult?.url) {
    setupInfo.setupUrl = bestResult.url;
  }

  // Instructions: synthesize from top snippets
  const topSnippets = scored.slice(0, 3).map(r => r.snippet).filter(Boolean);
  if (topSnippets.length > 0) {
    setupInfo.instructions = topSnippets.join(' ').slice(0, 500);
  }

  // Collect source URLs
  for (const r of scored.slice(0, 5)) {
    sources.push({ url: r.url, title: r.title, score: r._score });
  }

  logger.info(`[web.agent] discover_setup: extracted ${Object.keys(setupInfo).length} fields from ${scored.length} results`);

  return {
    ok: true,
    setupInfo: Object.keys(setupInfo).length > 0 ? setupInfo : null,
    sources,
    bestUrl: bestResult?.url || null,
  };
}

// ── research_app_behavior ───────────────────────────────────────────────────
// Targeted web research for app-level operational knowledge: shortcuts, UI modes,
// element semantics, quirks. Unlike research_domain (generic nav hints), this runs
// multiple query templates designed to surface app behaviors and classifies the
// results into structured knowledge entries matching the appKnowledge.cjs schema.

// Classify a snippet/title into a knowledge entry type
// Order matters: more specific types are checked before generic "shortcut"
function _classifyBehaviorType(text) {
  const t = String(text || '').toLowerCase();
  if (/(recover|undo|fix|restore|revert)/i.test(t)) return 'recovery_move';
  if (/(verify|confirm|check|signal|indicator|status)/i.test(t)) return 'verification_signal';
  if (/(compact|hidden|not visible|toggle|hide|show|sidebar|toolbar|menu bar|view mode)/i.test(t)) return 'ui_mode';
  if (/(rename|commit|save|persist|enter|blur|focus|input|field|submit|apply)/i.test(t)) return 'element_semantics';
  if (/(quirk|bug|workaround|gotcha|caveat|pitfall|unexpected)/i.test(t)) return 'quirk';
  if (/(ctrl|cmd|⌘|shortcut|keyboard|hotkey|key binding|keystroke)/i.test(t)) return 'shortcut';
  return 'quirk'; // default — still useful operational knowledge
}

// Extract a shortcut combo from text (e.g. "Ctrl+Shift+F", "Cmd+B")
function _extractShortcut(text) {
  const m = String(text || '').match(/(?:Ctrl|Control|Cmd|Command|⌘|Alt|Option|Shift|Win|Meta)\s*\+\s*(?:Ctrl|Control|Cmd|Command|⌘|Alt|Option|Shift|Win|Meta\s*\+\s*)?[A-Z0-9]/i);
  return m ? m[0].replace(/\s+/g, '').replace(/^Ctrl$/i, 'Ctrl').replace(/^Cmd$/i, 'Cmd') : null;
}

// Extract a CSS-selector-like reference from text (e.g. "input.docs-title-input")
function _extractSelector(text) {
  const m = String(text || '').match(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9_-]+)+(?:\[[^\]]+\])?/i);
  return m ? m[0] : null;
}

/**
 * Research app-level behaviors (shortcuts, UI modes, element semantics, quirks)
 * for a given domain/app. Runs targeted query templates and synthesizes structured
 * knowledge entries suitable for caching in appKnowledge.cjs.
 *
 * @param {string} domain   - app hostname or service name (e.g. "docs.google.com" or "google docs")
 * @param {string} [query]  - optional task-specific query (e.g. "rename document")
 * @param {number} [maxResults=4] - results per query template
 * @returns {Promise<{ok, entries, confidence, sourceCount, query}>}
 */
async function actionResearchAppBehavior({ domain, query, maxResults = 4 }) {
  if (!domain) return { ok: false, error: 'domain is required' };

  // Normalize domain to a readable app name for queries
  const appName = String(domain)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.[a-z]{2,}.*$/i, '')
    .replace(/[._-]+/g, ' ')
    .trim() || domain;
  const hostForId = String(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || domain;
  const taskVerb = query ? ` ${query}` : '';

  // Targeted query templates designed to surface app behaviors.
  // The command-system queries are generic — they work for any app:
  //   - "slash commands" surfaces Notion/Slack/Discord/Google Docs slash commands
  //   - "command palette" surfaces Linear (C key), VS Code (Cmd+Shift+P), Figma (/)
  //   - Apps with no command system (Spotify, Amazon) return nothing — also useful
  const queries = [
    `${appName} keyboard shortcuts cheat sheet`,
    `${appName} compact mode toggle hidden UI toolbar`,
    `${appName} slash commands blocks insert create`,
    `${appName} command palette quick actions`,
    `${appName}${taskVerb} how to`,
    `${appName} tips tricks quirks hidden features`,
  ].filter(Boolean);

  logger.info(`[web.agent] research_app_behavior: ${queries.length} queries for "${appName}" (task="${query || 'none'}")`);

  // ── Phase 1: Search — run all queries in parallel ──
  const searchResults = [];
  let totalSources = 0;
  const searchPromises = queries.map(q =>
    searchWeb(q, maxResults).catch(err => {
      logger.warn(`[web.agent] research_app_behavior: query "${q.slice(0, 50)}" failed: ${err.message}`);
      return null;
    })
  );
  const searchResponses = await Promise.all(searchPromises);
  for (const res of searchResponses) {
    if (!res?.ok || !Array.isArray(res.results)) continue;
    totalSources += res.results.length;
    for (const r of res.results) {
      if (_isParkingContent(r.title, r.snippet, r.url)) continue;
      searchResults.push(r);
    }
  }

  if (searchResults.length === 0) {
    logger.info(`[web.agent] research_app_behavior: no search results for "${appName}"`);
    return { ok: true, query: queries.join(' | '), entries: [], confidence: 0, sourceCount: 0 };
  }

  // ── Phase 2: Crawl best pages + LLM-synthesize actionable knowledge ──
  // Pick the best 1-2 pages to crawl. Prefer official help/support docs for the
  // service (most reliable), then fall back to high-quality third-party results.
  const serviceHost = hostForId.split('.').slice(-2).join('.');
  const crawlCandidates = [];
  const seenUrls = new Set();
  // First: official docs (hostname contains the service domain)
  for (const r of searchResults) {
    try {
      const h = new URL(r.url).hostname.replace(/^www\./, '');
      if ((h.includes(serviceHost) || h.includes(appName.toLowerCase().replace(/\s+/g, ''))) && !seenUrls.has(r.url)) {
        crawlCandidates.push(r);
        seenUrls.add(r.url);
      }
    } catch (_) {}
  }
  // Then: other results (cheat sheets, tutorials) — but only if they look substantive
  for (const r of searchResults) {
    if (crawlCandidates.length >= 2) break;
    if (seenUrls.has(r.url)) continue;
    const text = `${r.title || ''} ${r.snippet || ''}`;
    if (text.length > 50 && /shortcut|keyboard|how to|guide|tutorial|tip|slash|command|block|insert/i.test(text)) {
      crawlCandidates.push(r);
      seenUrls.add(r.url);
    }
  }

  logger.info(`[web.agent] research_app_behavior: ${crawlCandidates.length} crawl candidates for "${appName}"`);

  // Crawl each candidate in parallel — each crawl uses its own browser session
  // (_crawl_<hash>), so they're fully independent and can run concurrently.
  let { webCrawl } = require('./web.crawl.cjs');
  const crawledContents = [];
  const crawlPromises = crawlCandidates.slice(0, 3).map(c =>
    webCrawl({ url: c.url, maxChars: 6000, timeoutMs: 15000 })
      .then(result => ({ ok: true, ...result, _url: c.url, _title: c.title }))
      .catch(err => {
        logger.warn(`[web.agent] research_app_behavior: crawl failed for ${c.url}: ${err.message}`);
        return { ok: false, _url: c.url };
      })
  );
  const crawlResults = await Promise.all(crawlPromises);
  for (const result of crawlResults) {
    if (result.ok && result.content && result.content.length > 100) {
      crawledContents.push({ url: result._url, content: result.content, title: result._title });
      logger.info(`[web.agent] research_app_behavior: crawled ${result._url} (${result.content.length} chars)`);
    }
  }

  // ── Phase 3: LLM synthesis ──
  let entries = [];
  if (crawledContents.length > 0) {
    try {
      const { ask } = require('../skill-helpers/skill-llm.cjs');
      const combinedContent = crawledContents
        .map(c => `--- ${c.title} (${c.url}) ---\n${c.content.slice(0, 3000)}`)
        .join('\n\n')
        .slice(0, 10000);

      const extractPrompt = `The following is text crawled from help/documentation pages about "${appName}".

Extract operational knowledge that would help an automation agent interact with this app. Focus on:
1. Keyboard shortcuts (extract the exact key combo, e.g. "Ctrl+Shift+F" or "Cmd+Shift+F")
2. Slash commands / block creation (does the app use "/" prefix? "#" prefix? Cmd+K? What commands are available — /todo, /heading, /bullet, /code, etc.? How does the user insert/create blocks?)
3. UI modes / toggles (compact mode, sidebar collapse, hidden toolbars, fullscreen, etc. — what hides UI elements and how to reveal them)
4. Element semantics (how to rename, commit, save — does it need Enter? blur? click? where is the title input? what placeholder does it use?)
5. Workflow patterns (step-by-step: how to create a page, how to set a title, how to add a block, how to insert a todo list — include the selector or key sequence for each step)
6. Element disambiguation (if multiple contenteditable/textbox elements exist, which is the title vs body? what placeholder/aria-label/tag distinguishes them?)
7. Quirks / gotchas / workarounds (things that commonly trip up automation)
8. Hidden element behaviors (what causes elements to be hidden, how to reveal them)

Return ONLY a JSON array of objects, each with:
- "type": one of "shortcut", "slash_command", "command_system", "ui_mode", "element_semantics", "workflow", "quirk", "recovery_move"
- "summary": one-sentence actionable description (include the key combo, selector, or command prefix if known)
- "details": object with optional fields:
  - "shortcut" (e.g. "Ctrl+Shift+F")
  - "prefix" (e.g. "/" or "#" — the command prefix if any)
  - "commands" (array of known commands, e.g. ["/todo", "/heading", "/bullet"])
  - "selector" (e.g. "input.docs-title-input", "h1[contenteditable]")
  - "steps" (array of step strings for workflow entries, e.g. ["Click H1 placeholder", "Type title", "Press Enter"])
  - "titleElement" (e.g. "h1[placeholder='New page']" — how to identify the title input)
  - "bodyElement" (e.g. "div[role='group']" — how to identify the body editor)
  - "sourceUrl"

Return [] if no operational knowledge is found. Do NOT include generic descriptions like "learn more about X" — only include entries that tell the agent HOW to do something specific.

TEXT:
${combinedContent}`;

      const raw = await ask(extractPrompt, { maxTokens: 1200, temperature: 0, responseTimeoutMs: 30000 });
      const jsonMatch = raw && raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          const seenIds = new Set();
          for (const item of parsed) {
            if (!item || typeof item.summary !== 'string' || item.summary.length < 10) continue;
            const type = ['shortcut', 'slash_command', 'command_system', 'ui_mode', 'element_semantics', 'workflow', 'quirk', 'recovery_move'].includes(item.type) ? item.type : 'quirk';
            const summary = item.summary.trim().replace(/\s+/g, ' ').slice(0, 220);
            const id = `${hostForId.replace(/^www\./, '').split('.')[0]}.${type}.${(summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30))}`;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const details = item.details && typeof item.details === 'object' ? item.details : {};
            // Ensure sourceUrl is set from the crawl if not provided by the LLM
            if (!details.sourceUrl && crawledContents.length > 0) details.sourceUrl = crawledContents[0].url;
            entries.push({
              id,
              type,
              summary,
              details,
              source: 'web_research_llm',
              confidence: 0.7, // LLM-synthesized from authoritative docs — higher than snippet-only
            });
          }
          logger.info(`[web.agent] research_app_behavior: LLM extracted ${entries.length} actionable entries for "${appName}"`);
        }
      }
    } catch (llmErr) {
      logger.warn(`[web.agent] research_app_behavior: LLM synthesis failed: ${llmErr.message} — falling back to snippet-based entries`);
    }
  }

  // ── Phase 4: Snippet-based extraction — ALWAYS run as supplement to LLM ──
  // Previously this only ran as a fallback when LLM synthesis produced nothing.
  // But LLM synthesis can succeed yet MISS important entries (e.g. produce a
  // `shortcut` entry but miss the `ui_mode` entry for compact mode). Running
  // snippet extraction always and merging with LLM entries (dedup by type+summary
  // prefix, LLM entries take precedence with 0.7 > 0.5) ensures snippet-discovered
  // knowledge like "Ctrl+Shift+F to toggle compact mode" is never lost.
  {
    const _snippetEntries = [];
    const _seenSnippetIds = new Set();
    for (const r of searchResults.slice(0, 8)) {
      const text = `${r.title || ''} ${r.snippet || ''}`.trim();
      if (text.length < 15) continue;
      const type = _classifyBehaviorType(text);
      const shortcut = _extractShortcut(text);
      const selector = _extractSelector(text);
      let summary = (r.snippet || r.title || '').trim().replace(/\s+/g, ' ');
      if (summary.length > 220) summary = summary.slice(0, 219) + '\u2026';
      if (!summary) continue;
      if (shortcut && !summary.toLowerCase().includes(shortcut.toLowerCase())) {
        summary = `${summary} (Shortcut: ${shortcut})`;
      }
      const id = `${hostForId.replace(/^www\./, '').split('.')[0]}.${type}.${(summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30))}`;
      if (_seenSnippetIds.has(id)) continue;
      _seenSnippetIds.add(id);
      _snippetEntries.push({
        id,
        type,
        summary,
        details: {
          ...(shortcut ? { shortcut } : {}),
          ...(selector ? { selector } : {}),
          sourceUrl: r.url,
        },
        source: 'web_research_snippet',
        confidence: 0.5,
      });
    }
    // Merge: only add snippet entries whose type+summary prefix isn't already covered by LLM
    let _addedFromSnippet = 0;
    for (const _snip of _snippetEntries) {
      const _covered = entries.some(e => e.type === _snip.type
        && e.summary.toLowerCase().slice(0, 40) === _snip.summary.toLowerCase().slice(0, 40));
      if (!_covered) { entries.push(_snip); _addedFromSnippet++; }
    }
    logger.info(`[web.agent] research_app_behavior: ${_snippetEntries.length} snippet entries extracted, ${_addedFromSnippet} added (LLM had ${entries.length - _addedFromSnippet}), ${entries.length} total for "${appName}"`);
  }

  // Deduplicate by summary similarity (keep highest-confidence)
  const deduped = [];
  for (const e of entries) {
    const similar = deduped.find(d => d.type === e.type && d.summary.toLowerCase().slice(0, 60) === e.summary.toLowerCase().slice(0, 60));
    if (similar) {
      if ((e.confidence || 0) > (similar.confidence || 0)) {
        Object.assign(similar, e);
      }
    } else {
      deduped.push(e);
    }
  }

  // Cap entries to keep context lean
  const finalEntries = deduped.slice(0, 12);

  // Confidence: based on entry count and source diversity
  const confidence = finalEntries.length >= 5 ? 0.7 : finalEntries.length >= 3 ? 0.5 : finalEntries.length >= 1 ? 0.3 : 0;

  logger.info(`[web.agent] research_app_behavior: ${finalEntries.length} entries (confidence=${confidence.toFixed(2)}, sources=${totalSources}, crawled=${crawledContents.length}) for "${appName}"`);

  return {
    ok: true,
    query: queries.join(' | '),
    entries: finalEntries,
    confidence,
    sourceCount: totalSources,
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
    case 'discover_search_syntax':
      return await actionDiscoverSearchSyntax(params);
    case 'discover_setup':
      return await actionDiscoverSetup(params);
    case 'research_app_behavior':
      return await actionResearchAppBehavior(params);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
};

module.exports.actionResearchDomain    = actionResearchDomain;
module.exports.actionGetTutorialSteps  = actionGetTutorialSteps;
module.exports.actionSearchAndNavigate = actionSearchAndNavigate;
module.exports.actionDiscoverTaskUrl  = actionDiscoverTaskUrl;
module.exports.actionDiscoverSearchSyntax = actionDiscoverSearchSyntax;
module.exports.actionDiscoverSetup    = actionDiscoverSetup;
module.exports.actionResearchAppBehavior = actionResearchAppBehavior;
module.exports._classifyDiscoveryCandidate = _classifyDiscoveryCandidate;
module.exports.searchWeb = searchWeb;
