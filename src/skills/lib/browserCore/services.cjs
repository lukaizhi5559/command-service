'use strict';

// ---------------------------------------------------------------------------
// browserCore/services.cjs — service/agent registry resolution.
// ---------------------------------------------------------------------------

const {
  resolveServiceTarget,
  lookupBrowserService,
  isHostAlias,
  KNOWN_BROWSER_SERVICES,
} = require('../../browser.agent.cjs');

module.exports = { resolveServiceTarget, lookupBrowserService, isHostAlias, KNOWN_BROWSER_SERVICES };
