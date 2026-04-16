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

async function memorySearch(query, filters = {}, limit = 8) {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/memory.search', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.search',
    payload: { query, filters, limit, userId: 'local_user' },
  });
  return res?.data?.memories || res?.memories || [];
}

async function getPersonalityTraits() {
  const res = await httpPost(MEMORY_URL, MEMORY_KEY, '/personality.getTraits', {
    version: 'mcp.v1', service: 'user-memory', action: 'personality.getTraits',
    payload: {},
  });
  return res?.data?.traits || [];
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
    value = await profileGet(profileKey);
    if (value && !value.startsWith('SAFE:') && !value.startsWith('KEYTAR:')) {
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
        const text = memories[0].source_text || memories[0].extracted_text || '';
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
    const query = entities.length > 0
      ? `${topic} ${entities.join(' ')}`
      : topic;
    const memories = await memorySearch(query, {}, 10);
    if (memories.length > 0) {
      resolved.memories = memories.map(m => m.source_text || m.extracted_text || '').filter(Boolean);
      sources.add('memory');
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
    return {
      ok:    false,
      error: `Unknown action: "${action}". Expected 'resolve_form' or 'resolve_context'.`,
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
