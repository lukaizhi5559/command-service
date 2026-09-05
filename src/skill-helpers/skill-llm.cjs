/**
 * skill-llm.cjs — LLM access for command-service skills
 *
 * Connects to ws://localhost:4000/ws/stream using the same protocol as
 * ThinkDropLLMBackend in the stategraph. Any skill in command-service can:
 *
 *   const { ask } = require('../skill-llm.cjs');
 *   const answer = await ask('Pick the best element: ...');
 *
 * Also exposes askWithMessages() for multi-turn system+user prompt patterns.
 */

'use strict';

const logger = require('../logger.cjs');

const WS_URL = process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
const WS_API_KEY = process.env.WEBSOCKET_API_KEY || '';
const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 30000;

// ── Persistent WebSocket connection pool ──────────────────────────────────
// Reuses WebSocket connections across requests to eliminate ~1-2s TCP
// handshake + WS upgrade overhead per call. Each connection handles one
// request at a time; overflow requests create temporary connections that
// are closed after use. Pool size is capped to avoid resource leaks.
const MAX_POOL_SIZE = 2;
let _wsPool = []; // Array of { ws, busy }

function _buildPoolUrl() {
  const url = new URL(WS_URL);
  if (WS_API_KEY) url.searchParams.set('apiKey', WS_API_KEY);
  url.searchParams.set('userId', 'command_service');
  url.searchParams.set('clientId', `skill_pool_${Math.random().toString(36).slice(2, 8)}`);
  return url.toString();
}

/**
 * Acquire a WebSocket connection from the pool, or create a new one.
 * Pooled connections are reused across requests; temporary connections
 * (created when the pool is full and all busy) are closed after use.
 * @returns {Promise<{ws: WebSocket, pooled: boolean}>}
 */
async function _acquireWs() {
  let WebSocket;
  try { WebSocket = require('ws'); } catch {
    throw new Error('[skill-llm] "ws" package not installed in command-service');
  }

  // Find a free, healthy connection in the pool
  for (let i = _wsPool.length - 1; i >= 0; i--) {
    const entry = _wsPool[i];
    if (entry.ws.readyState !== WebSocket.OPEN) {
      // Stale/closed connection — remove from pool
      _wsPool.splice(i, 1);
      continue;
    }
    if (!entry.busy) {
      entry.busy = true;
      // Remove only message listeners from previous requests
      entry.ws.removeAllListeners('message');
      return { ws: entry.ws, pooled: true };
    }
  }

  // No free connection — create a new one
  const ws = new WebSocket(_buildPoolUrl());

  // Connect with timeout
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error('[skill-llm] Connection timeout'));
    }, CONNECT_TIMEOUT_MS);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', (err) => { clearTimeout(t); reject(err); });
  });

  // If pool isn't full, add to pool for reuse; otherwise it's a temporary connection
  const pooled = _wsPool.length < MAX_POOL_SIZE;
  if (pooled) {
    const entry = { ws, busy: true };
    _wsPool.push(entry);
    // Permanent error/close handler — removes from pool on drop
    ws.on('error', (err) => {
      logger.warn(`[skill-llm] Pool connection error: ${err.message}`);
      _wsPool = _wsPool.filter(e => e !== entry);
    });
    ws.on('close', () => {
      _wsPool = _wsPool.filter(e => e !== entry);
    });
  }

  return { ws, pooled };
}

/**
 * Release a WebSocket connection back to the pool, or close it if temporary/errored.
 * @param {WebSocket} ws
 * @param {boolean} errored — if true, destroy the connection
 */
function _releaseWs(ws, errored = false) {
  const entry = _wsPool.find(e => e.ws === ws);
  if (!entry) {
    // Temporary connection (pool was full) — close it
    try { ws.close(); } catch {}
    return;
  }
  if (errored || ws.readyState !== 1) {
    // Broken connection — remove from pool and close
    _wsPool = _wsPool.filter(e => e !== entry);
    try { ws.close(); } catch {}
    return;
  }
  // Healthy — return to pool for reuse
  entry.busy = false;
  // Clean up per-request message listeners
  ws.removeAllListeners('message');
}

// Circuit breaker state
let circuitState = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
  threshold: 5, // Open circuit after 5 failures
  resetTimeoutMs: 60000 // Reset after 1 minute
};

/**
 * Send a single prompt to the LLM, return the full text answer.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.2]
 * @param {string} [opts.taskType='ask']
 * @param {number} [opts.responseTimeoutMs]
 * @param {function} [opts.onToken]  — called with each streamed chunk
 * @returns {Promise<string>}
 */
async function ask(prompt, opts = {}) {
  return askWithMessages([{ role: 'user', content: prompt }], opts);
}

/**
 * Send a messages array (system + user etc.) to the LLM.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
// Circuit breaker helper
function checkCircuitBreaker() {
  const now = Date.now();
  if (circuitState.isOpen) {
    if (now - circuitState.lastFailure > circuitState.resetTimeoutMs) {
      logger.info('[skill-llm] Circuit breaker reset - attempting recovery');
      circuitState.isOpen = false;
      circuitState.failures = 0;
    } else {
      return false; // Circuit still open
    }
  }
  return true; // Circuit closed
}

function recordFailure() {
  circuitState.failures++;
  circuitState.lastFailure = Date.now();
  if (circuitState.failures >= circuitState.threshold) {
    circuitState.isOpen = true;
    logger.error(`[skill-llm] Circuit breaker opened after ${circuitState.failures} failures`);
  }
}

function recordSuccess() {
  if (circuitState.failures > 0) {
    logger.info(`[skill-llm] Circuit breaker recovery - resetting failure count from ${circuitState.failures}`);
    circuitState.failures = 0;
    circuitState.isOpen = false;
  }
}

async function askWithMessages(messages, opts = {}) {
  // Check circuit breaker first
  if (!checkCircuitBreaker()) {
    logger.warn('[skill-llm] Circuit breaker open - rejecting request');
    throw new Error('[skill-llm] Circuit breaker open - service temporarily unavailable');
  }

  const MAX_RETRIES = 1;
  const RETRY_BASE_MS = 600;
  let lastErr;
  let errorType = 'unknown';
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * (attempt - 1)));
      logger.warn(`[skill-llm] attempt ${attempt}/${MAX_RETRIES} — retrying after ${errorType}`);
    }
    try {
      const result = await _askWithMessagesOnce(messages, opts);
      if (result.length > 0) {
        recordSuccess();
        return result;
      }
      errorType = 'empty_response';
      lastErr = new Error('[skill-llm] Empty response');
      logger.warn(`[skill-llm] attempt ${attempt}/${MAX_RETRIES} returned empty response`);
    } catch (err) {
      lastErr = err;
      // Classify error type for better debugging
      if (err.message.includes('Connection timeout') || err.message.includes('ECONNREFUSED')) {
        errorType = 'connection_error';
      } else if (err.message.includes('Response timeout')) {
        errorType = 'timeout_error';
      } else if (err.message.includes('LLM error')) {
        errorType = 'llm_error';
      } else {
        errorType = 'unknown_error';
      }
      logger.warn(`[skill-llm] attempt ${attempt}/${MAX_RETRIES} ${errorType}: ${err.message}`);
    }
  }
  
  recordFailure();
  logger.error(`[skill-llm] all ${MAX_RETRIES} attempts failed (${errorType}) — last: ${lastErr?.message}`);
  return '';
}

/**
 * Single-attempt implementation — called by askWithMessages retry loop.
 * @private
 */
async function _askWithMessagesOnce(messages, opts = {}) {
  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch {
    throw new Error('[skill-llm] "ws" package not installed in command-service');
  }

  // Acquire a connection from the pool (reuses persistent connections)
  const { ws, pooled } = await _acquireWs();
  let _errored = false;

  // Extract system message and build user prompt.
  // The backend reads context.systemInstructions for the system message and
  // passes it as a proper { role: 'system' } message to the LLM provider.
  // Embedding <<SYS>> tags in the prompt does NOT work — most providers
  // (GPT, Claude, Gemini, GLM) don't understand Llama-2 chat tags.
  let systemInstructions = '';
  let promptText = '';
  if (messages.length === 1 && messages[0].role === 'user') {
    promptText = messages[0].content;
  } else {
    systemInstructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    promptText = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  }

  const requestId = `skill_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  ws.send(JSON.stringify({
    id: requestId,
    type: 'llm_request',
    payload: {
      prompt: promptText,
      provider: 'auto',
      options: {
        temperature: opts.temperature ?? 0.2,
        stream: true,
        taskType: opts.taskType || 'skill_step',
        // Backend reads options.maxTokens (camelCase), NOT max_tokens (snake_case)
        ...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
        // Structured output: pass responseFormat (camelCase) through to the
        // backend router, which forwards it to OpenAI-compatible providers as
        // OpenAI `response_format`. Providers that don't support it gracefully
        // degrade (backend retries without it on 400).
        ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
      },
      context: {
        recentContext: [],
        sessionFacts: [],
        sessionEntities: [],
        memories: [],
        webSearchResults: [],
        systemInstructions: systemInstructions || opts.systemInstructions || '',
      },
    },
    timestamp: Date.now(),
    metadata: { source: 'command_service_skill' },
  }));

  let accumulated = '';
  let streamStarted = false;
  let lastProvider = '';
  const responseTimeoutMs = opts.responseTimeoutMs || RESPONSE_TIMEOUT_MS;

  try {
    await new Promise((resolve, reject) => {
      let t = setTimeout(() => {
        _errored = true;
        ws.terminate();
        reject(new Error('[skill-llm] Response timeout'));
      }, responseTimeoutMs);

      const resetTimeout = () => {
        clearTimeout(t);
        t = setTimeout(() => {
          _errored = true;
          ws.terminate();
          reject(new Error('[skill-llm] Response timeout'));
        }, responseTimeoutMs);
      };

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'llm_stream_start') {
            streamStarted = true;
            clearTimeout(t);
          } else if (msg.type === 'llm_stream_fallback') {
            resetTimeout();
          } else if (msg.type === 'llm_stream_chunk') {
            // Reset the response timeout on each chunk so a slow-but-progressing
            // stream doesn't get killed. Without this, llm_stream_start clears the
            // timeout and chunks never reset it — a stalled stream hangs forever
            // (observed: 63-second calls burning 70% of the turn-loop budget).
            resetTimeout();
            const provider = msg.payload?.provider || msg.payload?.chunk?.provider || '';
            if (provider) lastProvider = provider;
            const chunk = msg.payload?.chunk || msg.payload?.text || '';
            if (chunk) {
              accumulated += chunk;
              if (opts.onToken) opts.onToken(chunk);
            }
          } else if (msg.type === 'llm_stream_end') {
            clearTimeout(t);
            // Don't close pooled connections — release them back to the pool
            resolve();
          } else if (msg.type === 'llm_error') {
            clearTimeout(t);
            _errored = true;
            reject(new Error(msg.payload?.message || '[skill-llm] LLM error'));
          } else if (msg.type === 'error') {
            clearTimeout(t);
            _errored = true;
            reject(new Error(msg.payload?.message || '[skill-llm] LLM error'));
          }
        } catch (_) {}
      });

      ws.on('error', (err) => {
        clearTimeout(t);
        _errored = true;
        reject(err);
      });
      ws.on('close', () => {
        clearTimeout(t);
        if (!streamStarted) {
          _errored = true;
          reject(new Error('[skill-llm] Connection closed before stream started'));
        } else {
          resolve();
        }
      });
    });
  } finally {
    // Release the connection back to the pool (or close if temporary/errored)
    _releaseWs(ws, _errored);
  }

  const result = accumulated.trim();
  
  // Basic validation - log details for debugging but don't patch with regex
  if (!result || result.length === 0) {
    logger.warn(`[skill-llm] Empty response detected - accumulated: "${accumulated}" (length: ${accumulated.length})`);
    // Log request details for debugging
    logger.warn(`[skill-llm] Request details - messages: ${JSON.stringify(messages)}, opts: ${JSON.stringify(opts)}`);
    return '';
  }
  
  logger.info(`[skill-llm] ask complete (${result.length} chars, provider=${lastProvider || 'unknown'})`);
  return result;
}

/**
 * Quick availability check — opens a WS connection and closes it.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return false; }
  return new Promise((resolve) => {
    try {
      const url = new URL(WS_URL);
      if (WS_API_KEY) url.searchParams.set('apiKey', WS_API_KEY);
      url.searchParams.set('userId', 'health');
      url.searchParams.set('clientId', `health_${Date.now()}`);
      const ws = new WebSocket(url.toString());
      const t = setTimeout(() => { 
        clearTimeout(t);
        ws.terminate();
        logger.warn('[skill-llm] Health check failed - connection timeout');
        resolve(false); 
      }, 3000);
      ws.on('open', () => { 
        clearTimeout(t); 
        ws.close(); 
        logger.debug('[skill-llm] Health check passed');
        resolve(true); 
      });
      ws.on('error', (err) => { 
        clearTimeout(t); 
        logger.warn(`[skill-llm] Health check failed - ${err.message}`);
        resolve(false); 
      });
    } catch (err) {
      logger.warn(`[skill-llm] Health check error - ${err.message}`);
      resolve(false);
    }
  });
}

/**
 * Get detailed health status including circuit breaker state
 * @returns {Promise<{available: boolean, circuitOpen: boolean, failures: number, lastFailure: number, serviceUrl: string}>}
 */
async function getHealthStatus() {
  const available = await isAvailable();
  return {
    available,
    circuitOpen: circuitState.isOpen,
    failures: circuitState.failures,
    lastFailure: circuitState.lastFailure,
    serviceUrl: WS_URL
  };
}

module.exports = { ask, askWithMessages, isAvailable, getHealthStatus };
