'use strict';

/**
 * user.agent.cjs — General-purpose user context assembly agent
 *
 * Acts on behalf of the user to fill in context gaps for any task:
 *   - resolve_form:    Fetches name, phone, email, address, etc. for form-filling
 *   - resolve_context: Assembles richer user context (projects, interests, contacts,
 *                      communication style, conversation history) for content generation
 *
 * Data sources (in priority order):
 *   1. user_profile        — O(1) structured key/value (fastest)
 *   2. memory + entities   — semantic search fallback
 *   3. conversation history — time-bounded or entity-scoped only (never blind search)
 *   4. personality traits  — user_interests, user_projects, relationship_style (user facts only)
 *   5. user_constraints    — hard preferences and blocks
 *   6. phrase_preferences  — preferred communication style (messaging tasks only)
 *
 * Args schema:
 * {
 *   action:      string   — 'resolve_form' | 'resolve_context'
 *   fields?:     string[] — for resolve_form: which fields to resolve
 *                           e.g. ['first_name','last_name','email','phone','address']
 *                           or  ['contact:wife:name', 'contact:wife:phone']
 *   contact?:    string   — name of contact to resolve instead of self
 *   topic?:      string   — for resolve_context: free-text description of what's needed
 *   entities?:   string[] — person/thing names to scope conversation search
 *   dateRange?:  { start: string, end: string }  — ISO dates for conversation search
 *   isCommsTask: boolean  — if true, include phrase_preferences
 *   userId?:     string   — defaults to 'local_user'
 * }
 *
 * Returns:
 * {
 *   ok:              boolean
 *   action:          string
 *   resolved:        object  — field→value map (nulls for missing)
 *   summary:         string  — human-readable context block for LLM injection
 *   sources:         string[] — which data sources were actually hit
 *   missingFields:   string[] — fields that could not be resolved (for follow-up)
 *   error?:          string
 * }
 */

const http  = require('http');
const https = require('https');
const logger = require('../logger.cjs');

// ── MCP service endpoints ───────────────────────────────────────────────────
const MEMORY_URL = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
const MEMORY_KEY = process.env.MCP_USER_MEMORY_API_KEY || '';
const CONV_URL   = process.env.MCP_CONVERSATION_URL   || 'http://127.0.0.1:3004';
const CONV_KEY   = process.env.MCP_CONVERSATION_API_KEY || '';

// ── Self profile key definitions ────────────────────────────────────────────
const SELF_KEYS = {
  first_name:  'self:first_name',
  last_name:   'self:last_name',
  name:        'self:name',
  full_name:   'self:name',
  email:       'self:email',
  phone:       'self:phone',
  address:     'self:address',
  work_address:'self:work_address',
  city:        'self:city',
  state:       'self:state',
  zip:         'self:zip',
  postal:      'self:zip',
  company:     'self:company',
  job_title:   'self:job_title',
};

// Personality trait categories that are user facts (not AI character)
const USER_TRAIT_CATEGORIES = new Set(['user_interests', 'user_projects', 'relationship_style']);

// ── Placeholder value guards ─────────────────────────────────────────────────
// Domains LLMs commonly emit as example/placeholder emails — never real addresses.
const _PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'yourdomain.com', 'example.com', 'domain.com', 'test.com',
  'placeholder.com', 'company.com', 'email.com', 'yourcompany.com',
  'acme.com', 'sample.com', 'mail.com', 'user.com', 'yourname.com',
]);

function _isPlaceholderEmail(value) {
  if (!value || typeof value !== 'string') return false;
  const lower = value.toLowerCase().trim();
  if (/^(test|user|email|example|fake|temp|dummy)@/i.test(lower)) return true;
  const domain = lower.split('@')[1];
  return domain ? _PLACEHOLDER_EMAIL_DOMAINS.has(domain) : false;
}

function _isPlaceholderPhone(value) {
  if (!value || typeof value !== 'string') return false;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) return false;
  if (/^(\d)\1{9,}$/.test(digits)) return true; // 1111111111 etc.
  if (digits === '1234567890' || digits === '0987654321') return true;
  if (/^1?555/.test(digits) && digits.length <= 11) return true; // 555-xxxx Hollywood numbers
  return false;
}

// ── Generic HTTP POST helper ─────────────────────────────────────────────────

function httpPost(baseUrl, apiKey, path, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(baseUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const req = transport.request({
      hostname: parsed.hostname,
      port:     Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      path,
      method:   'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', (e) => {
      logger.warn(`[user.agent] HTTP error (${path}): ${e.message}`);
      resolve(null);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Memory service helpers ───────────────────────────────────────────────────

async function profileGet(key) {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/profile.get', {
    version: 'mcp.v1', service: 'user-memory', action: 'profile.get',
    payload: { key },
  });
  return res?.data?.valueRef || null;
}

async function profileList() {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/profile.list', {
    version: 'mcp.v1', service: 'user-memory', action: 'profile.list',
    payload: {},
  });
  return res?.data?.entries || [];
}

async function memorySearch(query, filters = {}, limit = 8, minSimilarity = 0.3) {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/memory.search', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.search',
    payload: { query, filters, limit, userId: 'local_user', minSimilarity },
  });
  return res?.data?.results || res?.results || res?.data?.memories || res?.memories || [];
}

async function getPersonalityTraits() {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/personality.getTraits', {
    version: 'mcp.v1', service: 'user-memory', action: 'personality.getTraits',
    payload: {},
  });
  const traits = res?.data?.traits;
  // Handle both object format (new API) and array format (legacy)
  if (Array.isArray(traits)) return traits;
  if (traits && typeof traits === 'object') {
    // Convert object {trait_key: {value, source, weight}} to array format expected by callers
    return Object.entries(traits).map(([trait_name, data]) => ({
      trait_name,
      trait_value: data.value,
      source: data.source,
      weight: data.weight,
    }));
  }
  return [];
}

async function listConstraints() {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/constraint.list', {
    version: 'mcp.v1', service: 'user-memory', action: 'constraint.list',
    payload: {},
  });
  return res?.data?.constraints || [];
}

async function searchPhrasePreference(phrase) {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/phrase_preference.search', {
    version: 'mcp.v1', service: 'user-memory', action: 'phrase_preference.search',
    payload: { phrase, threshold: 0.6 },
  });
  return res?.data?.match || null;
}

// ── Conversation service helpers ─────────────────────────────────────────────

async function searchConversation(query, opts = {}) {
  const { entities = [], dateRange = null, limit = 15 } = opts;

  // Use dateRange + entity scope when available — never blind broad search
  if (dateRange?.start) {
    const res = await httpPost(CONV_URL, CONV_KEY, '/message.listByDate', {
      version: 'mcp.v1', service: 'conversation', action: 'message.listByDate',
      payload: {
        startDate:   dateRange.start,
        endDate:     dateRange.end || new Date().toISOString(),
        entityTerms: entities,
        limit:       50,
      },
    });
    const messages = res?.data?.messages || [];
    // If we have additional entities, filter further by text content
    if (entities.length > 0) {
      const terms = entities.map(e => e.toLowerCase());
      return messages.filter(m => {
        const t = (m.content || '').toLowerCase();
        return terms.some(term => t.includes(term));
      }).slice(0, limit);
    }
    return messages.slice(0, limit);
  }

  // Entity-scoped search: use semantic search with entity filter
  if (entities.length > 0) {
    const entityQuery = entities.join(' ');
    const res = await httpPost(CONV_URL, CONV_KEY, '/message.search', {
      version: 'mcp.v1', service: 'conversation', action: 'message.search',
      payload: {
        query:         `${query} ${entityQuery}`.trim(),
        limit,
        minSimilarity: 0.55,
      },
    });
    return res?.data?.messages || [];
  }

  // Topic-only: semantic search with higher similarity threshold
  const res = await httpPost(CONV_URL, CONV_KEY, '/message.search', {
    version: 'mcp.v1', service: 'conversation', action: 'message.search',
    payload: {
      query,
      limit,
      minSimilarity: 0.6,
    },
  });
  return res?.data?.messages || [];
}

// ── resolve_form action ──────────────────────────────────────────────────────
// Fills in form fields (e.g. name, email, phone, address) from user_profile + memory.

async function resolveForm(args) {
  const { fields = [], contact = null, userId = 'local_user' } = args;
  const resolved = {};
  const sources  = new Set();
  const missing  = [];

  const targetFields = fields.length > 0 ? fields : Object.keys(SELF_KEYS);

  for (const field of targetFields) {
    let value = null;

    // Determine the profile key to look up
    let profileKey;
    if (field.startsWith('contact:')) {
      // Direct contact key, e.g. 'contact:wife:phone'
      profileKey = contact
        ? field.replace(/^contact:[^:]+/, `contact:${contact.toLowerCase().replace(/\s+/g, '_')}`)
        : field;
    } else if (contact) {
      // Lookup for a contact person
      const normalized = contact.toLowerCase().replace(/\s+/g, '_');
      profileKey = `contact:${normalized}:${field}`;
    } else {
      // Self lookup
      profileKey = SELF_KEYS[field] || `self:${field}`;
    }

    // ── 1. user_profile (primary) ───────────────────────────────────────────
    // profile.get now transparently decrypts SAFE: and KEYTAR: refs — any
    // non-null string returned here is already plaintext.
    value = await profileGet(profileKey);
    // Reject placeholder/example values — treat as missing and fall through
    if (value && field === 'email' && _isPlaceholderEmail(value)) {
      logger.warn(`[user.agent] resolveForm: rejecting placeholder email "${value}" for field "${field}" — falling through to memory`);
      value = null;
    } else if (value && field === 'phone' && _isPlaceholderPhone(value)) {
      logger.warn(`[user.agent] resolveForm: rejecting placeholder phone "${value}" — falling through to memory`);
      value = null;
    }
    if (value) {
      sources.add('user_profile');
    }

    // ── 2. memory.search fallback ───────────────────────────────────────────
    if (!value) {
      const query = contact
        ? `${contact} ${field.replace(/_/g, ' ')}`
        : `my ${field.replace(/_/g, ' ')}`;
      const memories = await memorySearch(query, { type: 'personal_profile' }, 5);
      if (memories.length > 0) {
        // Extract the value from the most relevant memory text
        const text = memories[0].text || memories[0].source_text || memories[0].extracted_text || '';
        // Simple field extraction: look for the field keyword followed by a value
        const pattern = new RegExp(`(?:${field.replace(/_/g, '[\\s_]*')})\\s*(?:is|:|—)\\s*([^\\n.,;]{2,80})`, 'i');
        const m = text.match(pattern);
        if (m) {
          value = m[1].trim();
          sources.add('memory');
          // Lazy backfill to user_profile
          try {
            await httpPost(MEMORY_URL, MEMORY_KEY, '/profile.set', {
              version: 'mcp.v1', service: 'user-memory', action: 'profile.set',
              payload: { key: profileKey, valueRef: value },
            });
          } catch (_) {}
        }
      }
    }

    resolved[field] = value;
    if (!value) missing.push(field);
  }

  // ── user_constraints: always pull ──────────────────────────────────────────
  const constraints = await listConstraints();
  if (constraints.length > 0) sources.add('user_constraints');

  // Build a compact summary for LLM injection
  const filledPairs = Object.entries(resolved)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);

  const constraintNotes = constraints
    .filter(c => c.severity === 'hard')
    .map(c => `⚠ ${c.rule}`)
    .slice(0, 5);

  let summary = '';
  if (filledPairs.length > 0) {
    summary += `User context:\n${filledPairs.join('\n')}`;
  }
  if (constraintNotes.length > 0) {
    summary += `\n\nUser constraints:\n${constraintNotes.join('\n')}`;
  }

  return {
    ok: true,
    action: 'resolve_form',
    resolved,
    summary: summary.trim(),
    sources: [...sources],
    missingFields: missing,
    constraints: constraints.map(c => ({ rule: c.rule, severity: c.severity })),
  };
}

// ── resolve_context action ───────────────────────────────────────────────────
// Assembles richer user context for content generation tasks.

async function resolveContext(args) {
  const {
    topic      = '',
    entities   = [],
    dateRange  = null,
    isCommsTask = false,
    userId     = 'local_user',
  } = args;

  const resolved = {};
  const sources  = new Set();
  let summary    = '';

  // ── 1. user_profile: pull all self: keys ───────────────────────────────────
  const profileEntries = await profileList();
  const selfProfile = {};
  const contactMap  = {};
  for (const entry of profileEntries) {
    const k = entry.key || '';
    const v = entry.valueRef || '';
    // Skip encrypted / sensitive values
    if (v.startsWith('SAFE:') || v.startsWith('KEYTAR:')) continue;
    if (k.startsWith('self:')) {
      selfProfile[k.replace('self:', '')] = v;
    } else if (k.startsWith('contact:')) {
      // contact:wife:phone → { wife: { phone: '...' } }
      const parts = k.split(':'); // ['contact','wife','phone']
      if (parts.length === 3) {
        const [, label, field] = parts;
        if (!contactMap[label]) contactMap[label] = {};
        contactMap[label][field] = v;
      }
    }
  }
  if (Object.keys(selfProfile).length > 0) {
    resolved.self = selfProfile;
    sources.add('user_profile');
  }
  if (Object.keys(contactMap).length > 0) {
    resolved.contacts = contactMap;
    sources.add('user_profile');
  }

  // ── 2. memory.search: search for topic + entities ──────────────────────────
  if (topic) {
    // Build a richer query — include common family/contact keywords to improve recall
    const extraTerms = ['my', 'family', 'contact', 'name', 'phone', 'email', 'address'];
    const topicWords = topic.toLowerCase().split(/\s+/);
    const missingTerms = extraTerms.filter(t => !topicWords.includes(t));
    const enrichedQuery = entities.length > 0
      ? `${topic} ${entities.join(' ')}`
      : `${topic} ${missingTerms.slice(0, 3).join(' ')}`;
    logger.info(`[user.agent] Searching memories for: "${enrichedQuery}" (topic="${topic}", entities=[${entities.join(', ')}])`);
    const memories = await memorySearch(enrichedQuery, {}, 15, 0.2);
    // Filter out screen captures, browser-tab noise, and generic/outdated memories
    const BROWSER_APP_PATTERN = /^(Google Chrome|Microsoft Edge|Safari|Firefox|Opera|Brave):/i;
    const GENERIC_PATTERNS = [
      /^My email address is/i,
      /^My name is/i,
      /^Interests:.*u$/i,  // Truncated interests
      /^The user's interests.*u$/i,  // Truncated interests
      /^I am interested in.*u$/i,  // Truncated interests
    ];
    
    // Filter and deduplicate memories
    const seenTexts = new Set();
    const filteredMemories = memories.filter(m => {
      const text = (m.text || '').trim();
      // Skip if already seen (deduplicate)
      if (seenTexts.has(text)) return false;
      seenTexts.add(text);
      
      // Apply filters
      return m.type !== 'screen_capture' &&
        !BROWSER_APP_PATTERN.test(text) &&
        !GENERIC_PATTERNS.some(pattern => pattern.test(text)) &&
        text.length > 10 &&
        !text.endsWith('u');  // Filter truncated memories
    });
    
    // Sort by relevance (prioritize work-related memories for work topics)
    const isWorkRelated = (text) => {
      const workKeywords = ['work', 'project', 'task', 'meeting', 'email', 'code', 'development', 'bug', 'feature', 'deploy', 'review'];
      return workKeywords.some(keyword => text.toLowerCase().includes(keyword));
    };
    
    const sortedMemories = filteredMemories.sort((a, b) => {
      const aText = (a.text || '').toLowerCase();
      const bText = (b.text || '').toLowerCase();
      const aIsWork = isWorkRelated(aText);
      const bIsWork = isWorkRelated(bText);
      
      // If this is a work-related query, prioritize work memories
      if (topic.toLowerCase().includes('work')) {
        if (aIsWork && !bIsWork) return -1;
        if (!aIsWork && bIsWork) return 1;
      }
      
      // Otherwise, sort by recency (newer first)
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    
    logger.info(`[user.agent] Found ${memories.length} memories, ${filteredMemories.length} after filtering, ${sortedMemories.length} after deduplication`);
    if (sortedMemories.length > 0) {
      resolved.memories = sortedMemories.slice(0, 10).map(m => m.text || '').filter(Boolean);
      sources.add('memory');
      logger.info(`[user.agent] Resolved ${resolved.memories.length} memory texts: ${resolved.memories.map(t => t.slice(0, 60)).join(' | ')}`);
    } else {
      logger.info(`[user.agent] No memories found — will rely on user_profile and conversation history`);
    }
  }

  // ── 3. Conversation history (only when topic or entities present) ──────────
  if (topic || entities.length > 0) {
    const convMessages = await searchConversation(topic, { entities, dateRange, limit: 15 });
    if (convMessages.length > 0) {
      resolved.conversationHistory = convMessages
        .map(m => `[${m.role || 'user'}] ${(m.content || '').slice(0, 300)}`)
        .filter(Boolean);
      sources.add('conversation');
    }
  }

  // ── 4. Personality traits: user facts only ─────────────────────────────────
  const allTraits = await getPersonalityTraits();
  const userTraits = allTraits.filter(t => USER_TRAIT_CATEGORIES.has(t.trait_name));
  if (userTraits.length > 0) {
    resolved.personality = userTraits.reduce((acc, t) => {
      acc[t.trait_name] = t.trait_value;
      return acc;
    }, {});
    sources.add('personality_traits');
  }

  // ── 5. User constraints: always pull ──────────────────────────────────────
  const constraints = await listConstraints();
  if (constraints.length > 0) {
    resolved.constraints = constraints.map(c => ({ rule: c.rule, severity: c.severity }));
    sources.add('user_constraints');
  }

  // ── 6. Phrase preferences: comms tasks only ────────────────────────────────
  if (isCommsTask && topic) {
    const phraseMatch = await searchPhrasePreference(topic);
    if (phraseMatch) {
      resolved.phrasePreference = phraseMatch;
      sources.add('phrase_preferences');
    }
  }

  // ── Build summary block ────────────────────────────────────────────────────
  const parts = [];

  if (resolved.self && Object.keys(resolved.self).length > 0) {
    const selfLines = Object.entries(resolved.self)
      .map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${v}`)
      .join('\n');
    parts.push(`User profile:\n${selfLines}`);
  }

  if (resolved.contacts && Object.keys(resolved.contacts).length > 0) {
    for (const [label, fields] of Object.entries(resolved.contacts)) {
      const contactLines = Object.entries(fields)
        .map(([f, v]) => `  ${f}: ${v}`)
        .join('\n');
      parts.push(`Contact — ${label}:\n${contactLines}`);
    }
  }

  if (Array.isArray(resolved.memories) && resolved.memories.length > 0) {
    parts.push(`Relevant memory:\n${resolved.memories.slice(0, 5).map(m => `  • ${m.slice(0, 200)}`).join('\n')}`);
  }

  if (Array.isArray(resolved.conversationHistory) && resolved.conversationHistory.length > 0) {
    parts.push(`Recent conversation context:\n${resolved.conversationHistory.slice(0, 8).map(l => `  ${l}`).join('\n')}`);
  }

  if (resolved.personality) {
    const pLines = Object.entries(resolved.personality)
      .map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${v}`)
      .join('\n');
    parts.push(`User interests & style:\n${pLines}`);
  }

  if (Array.isArray(resolved.constraints) && resolved.constraints.length > 0) {
    const hardRules = resolved.constraints.filter(c => c.severity === 'hard');
    if (hardRules.length > 0) {
      parts.push(`User constraints:\n${hardRules.slice(0, 5).map(c => `  ⚠ ${c.rule}`).join('\n')}`);
    }
  }

  if (resolved.phrasePreference) {
    const pp = resolved.phrasePreference;
    parts.push(`Communication preference: ${pp.delivery}${pp.service ? ` via ${pp.service}` : ''}`);
  }

  summary = parts.join('\n\n');

  return {
    ok: true,
    action: 'resolve_context',
    resolved,
    summary: summary.trim(),
    sources: [...sources],
    missingFields: [],
  };
}

// ── resolve_credentials action ─────────────────────────────────────────────
// Looks up stored credentials for a service agent (email + password).
// profile.get transparently decrypts SAFE: blobs so callers receive plaintext.
//
// Credential keys follow the gatherCredentialCallback convention in main.js:
//   credential:{agentId}:email
//   credential:{agentId}:password

async function resolveCredentials(args) {
  const { agentId } = args;
  if (!agentId) {
    return { ok: false, error: 'agentId is required for resolve_credentials' };
  }

  const normalized = agentId.toLowerCase().replace(/\.agent$/, '');
  const emailKey    = `credential:${normalized}.agent:email`;
  const passwordKey = `credential:${normalized}.agent:password`;
  // Also try without .agent suffix in case stored without it
  const emailKeyAlt    = `credential:${normalized}:email`;
  const passwordKeyAlt = `credential:${normalized}:password`;
  // username is a common alias stored by some credential-gather flows
  const usernameKey    = `credential:${normalized}.agent:username`;
  const usernameKeyAlt = `credential:${normalized}:username`;
  // Legacy flat keys: stored as 'gmail_email' / 'gmail:username' (no credential: prefix)
  const legacyEmailKey    = `${normalized}_email`;    // e.g. gmail_email
  const legacyUsernameKey = `${normalized}:username`; // e.g. gmail:username (no credential: prefix)
  const legacyPasswordKey = `${normalized}_password`;

  let email    = (await profileGet(emailKey))    || (await profileGet(emailKeyAlt))
               || (await profileGet(usernameKey)) || (await profileGet(usernameKeyAlt))
               || (await profileGet(legacyEmailKey)) || (await profileGet(legacyUsernameKey))
               || (await profileGet('self:email')); // profile KV from storeMemory dual-write
  // Reject placeholder emails from profile — fall through to memory-based fallbacks
  if (email && _isPlaceholderEmail(email)) {
    logger.warn(`[user.agent] resolve_credentials: rejecting placeholder email "${email}" from profile — falling through to memory fallbacks`);
    email = null;
  }
  logger.info(`[user.agent] resolve_credentials step1 (profile KV): ${email || '✗'}`);
  const password = (await profileGet(passwordKey)) || (await profileGet(passwordKeyAlt))
               || (await profileGet(legacyPasswordKey));

  // Fallback A: resolveForm — checks profile KV then structured memory search
  if (!email) {
    try {
      const formResult = await resolveForm({ fields: ['email'] });
      email = formResult?.resolved?.email || null;
      logger.info(`[user.agent] resolve_credentials stepA (resolveForm): ${email || '✗'}`);
    } catch (_) {}
  }

  // Fallback B: raw regex scan over personal_profile memories
  if (!email) {
    try {
      const mems = await memorySearch('email address gmail work personal', { type: 'personal_profile' }, 10);
      const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
      for (const m of mems) {
        const text = m.text || m.source_text || m.extracted_text || '';
        const match = text.match(EMAIL_RE);
        if (match && !_isPlaceholderEmail(match[0])) { email = match[0]; break; }
      }
      logger.info(`[user.agent] resolve_credentials stepB (personal_profile scan): ${email || '✗'}`);
    } catch (_) {}
  }

  // Fallback C: broader memory scan with no type filter
  if (!email) {
    try {
      const mems = await memorySearch('my email is', {}, 10);
      const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
      for (const m of mems) {
        const text = m.text || m.source_text || m.extracted_text || '';
        const match = text.match(EMAIL_RE);
        if (match && !_isPlaceholderEmail(match[0])) { email = match[0]; break; }
      }
      logger.info(`[user.agent] resolve_credentials stepC (broad scan): ${email || '✗'}`);
    } catch (_) {}
  }

  // Migration: if email was found via memory scan (stepB/C) but not in profile KV,
  // write it to the canonical credential key so step1 finds it next time.
  // Note: SAFE: encryption requires Electron safeStorage — plain text here is acceptable
  // since user-memory encrypts at rest and the SAFE: prefix is only used by Electron main.
  if (email) {
    const hasInProfile = (await profileGet(emailKey)) || (await profileGet(emailKeyAlt))
      || (await profileGet(legacyEmailKey)) || (await profileGet(legacyUsernameKey));
    if (!hasInProfile) {
      try {
        await httpPost(MEMORY_URL, MEMORY_KEY, '/profile.set', {
          version: 'mcp.v1', service: 'user-memory', action: 'profile.set',
          payload: { key: emailKey, valueRef: email, sensitive: true },
        });
        logger.info(`[user.agent] resolve_credentials: migrated email to ${emailKey}`);
      } catch (_) {}
    }
  }

  const resolved = {};
  const missing  = [];
  if (email)    { resolved.email    = email;    } else { missing.push('email'); }
  if (password) { resolved.password = password; } else { missing.push('password'); }

  logger.info(`[user.agent] resolve_credentials: agentId=${agentId} email=${email ? '✓' : '✗'} password=${password ? '✓' : '✗'}`);

  return {
    ok:           true,
    action:       'resolve_credentials',
    resolved,
    missing,
    credentialKey: `credential:${normalized}.agent:email`, // key for gatherCredentialCallback to store to
    summary: email ? `Credentials resolved for ${agentId}: email ✓${password ? ', password ✓' : ''}` : `No credentials stored for ${agentId}`,
    sources: (email || password) ? ['user_profile'] : [],
  };
}

// ── Main export ──────────────────────────────────────────────────────────────

async function userAgent(args = {}) {
  const { action = 'resolve_form' } = args;

  try {
    if (action === 'resolve_form') {
      return await resolveForm(args);
    }
    if (action === 'resolve_context') {
      return await resolveContext(args);
    }
    if (action === 'resolve_credentials') {
      return await resolveCredentials(args);
    }
    return {
      ok:    false,
      error: `Unknown action: "${action}". Expected 'resolve_form', 'resolve_context', or 'resolve_credentials'.`,
    };
  } catch (err) {
    logger.error(`[user.agent] Unhandled error (action=${action}):`, err.message);
    return {
      ok:    false,
      action,
      error: err.message,
    };
  }
}

module.exports = { userAgent };
