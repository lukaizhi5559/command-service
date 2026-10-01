'use strict';

// ---------------------------------------------------------------------------
// browserCore/auth.cjs — auth-wall detection + credential resolution.
// ---------------------------------------------------------------------------

const { detectAuthViaLLM, AUTH_CHECK_PROMPT } = require('../../../skill-helpers/auth-check.cjs');
const { _isSigninWall, resolveCredential, clearAuthCaches } = require('../../browser.agent.cjs');

module.exports = {
  detectAuthViaLLM,
  AUTH_CHECK_PROMPT,
  isSigninWall: _isSigninWall,
  resolveCredential,
  clearAuthCaches,
};
