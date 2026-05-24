/**
 * skill-llm.cjs — LLM access for command-service skills
 *
 * Connects to ws://localhost:4000/ws/stream using the same protocol as
 * VSCodeLLMBackend in the stategraph. Any skill in command-service can:
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

  const MAX_RETRIES = 3;
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

  const url = new URL(WS_URL);
  if (WS_API_KEY) url.searchParams.set('apiKey', WS_API_KEY);
  url.searchParams.set('userId', 'command_service');
  url.searchParams.set('clientId', `skill_${Date.now()}`);

  const ws = new WebSocket(url.toString());

  // Connect
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error('[skill-llm] Connection timeout'));
    }, CONNECT_TIMEOUT_MS);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', (err) => { clearTimeout(t); reject(err); });
  });

  // Build prompt string from messages array if needed
  const promptText = messages.length === 1 && messages[0].role === 'user'
    ? messages[0].content
    : messages.map(m => `${m.role === 'system' ? '<<SYS>>' : '<<USER>>'}${m.content}`).join('\n');

  const requestId = `skill_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  ws.send(JSON.stringify({
    id: requestId,
    type: 'llm_request',
    payload: {
      prompt: promptText,
      provider: 'openai',
      options: {
        temperature: opts.temperature ?? 0.2,
        stream: true,
        taskType: opts.taskType || 'ask',
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
      },
      context: {
        recentContext: [],
        sessionFacts: [],
        sessionEntities: [],
        memories: [],
        webSearchResults: [],
        systemInstructions: opts.systemInstructions || '',
      },
    },
    timestamp: Date.now(),
    metadata: { source: 'command_service_skill' },
  }));

  let accumulated = '';
  let streamStarted = false;
  const responseTimeoutMs = opts.responseTimeoutMs || RESPONSE_TIMEOUT_MS;

  await new Promise((resolve, reject) => {
    let t = setTimeout(() => {
      ws.terminate();
      reject(new Error('[skill-llm] Response timeout'));
    }, responseTimeoutMs);

    const resetTimeout = () => {
      clearTimeout(t);
      t = setTimeout(() => {
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
          const chunk = msg.payload?.chunk || msg.payload?.text || '';
          if (chunk) {
            accumulated += chunk;
            if (opts.onToken) opts.onToken(chunk);
          }
        } else if (msg.type === 'llm_stream_end') {
          clearTimeout(t);
          ws.close();
          resolve();
        } else if (msg.type === 'llm_error') {
          clearTimeout(t);
          ws.close();
          reject(new Error(msg.payload?.message || '[skill-llm] LLM error'));
        } else if (msg.type === 'error') {
          clearTimeout(t);
          ws.close();
          reject(new Error(msg.payload?.message || '[skill-llm] LLM error'));
        }
      } catch (_) {}
    });

    ws.on('error', (err) => { clearTimeout(t); reject(err); });
    ws.on('close', () => {
      clearTimeout(t);
      if (!streamStarted) reject(new Error('[skill-llm] Connection closed before stream started'));
      else resolve();
    });
  });

  const result = accumulated.trim();
  
  // Basic validation - log details for debugging but don't patch with regex
  if (!result || result.length === 0) {
    logger.warn(`[skill-llm] Empty response detected - accumulated: "${accumulated}" (length: ${accumulated.length})`);
    // Log request details for debugging
    logger.warn(`[skill-llm] Request details - messages: ${JSON.stringify(messages)}, opts: ${JSON.stringify(opts)}`);
    return '';
  }
  
  logger.info(`[skill-llm] ask complete (${result.length} chars)`);
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
