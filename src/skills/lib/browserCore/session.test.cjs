'use strict';
/**
 * session.test.cjs — regression tests for deriveSessionId prefix pass-through.
 *
 * Bug fixed: deriveSessionId('ext:default') minted 'ext:default_agent' — a
 * session that can't exist, so dom.act/url.first bound-page checks reported
 * "no live tab for session 'ext:default_agent'".
 *
 * Run: node mcp-services/command-service/src/skills/lib/browserCore/session.test.cjs
 */

const { deriveSessionId, qualifyOpenTab } = require('./session.cjs');

let passed = 0, failed = 0;
function it(label, fn) {
  try { fn(); passed++; console.log(`  ✅ ${label}`); }
  catch (e) { failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'expected'} '${b}' got '${a}'`); }

console.log('\nsession.cjs — deriveSessionId prefix pass-through\n');

it('agent ids derive to <base>_agent (unchanged)', () => {
  eq(deriveSessionId('amazon.agent'), 'amazon_agent');
  eq(deriveSessionId('ebay_agent'), 'ebay_agent');
  eq(deriveSessionId('gmail'), 'gmail_agent');
  eq(deriveSessionId('my site.agent'), 'my_site_agent');
});

it('ext: session ids pass through unchanged', () => {
  eq(deriveSessionId('ext:default'), 'ext:default');
  eq(deriveSessionId('ext:youtube_agent'), 'ext:youtube_agent');
  eq(deriveSessionId('ext:google_agent'), 'ext:google_agent');
});

it('open:/bg: session ids pass through unchanged', () => {
  eq(deriveSessionId('open:my_tab'), 'open:my_tab');
  eq(deriveSessionId('bg:worker'), 'bg:worker');
});

it('qualifyOpenTab still leaves prefixed ids alone', () => {
  eq(qualifyOpenTab('ext:default', 'in the open tab'), 'ext:default');
  eq(qualifyOpenTab('ebay_agent', 'in the open tab'), 'open:ebay_agent');
});

it('default/falsy agent id unchanged', () => {
  eq(deriveSessionId(''), 'default_agent');
  eq(deriveSessionId(null), 'default_agent');
  eq(deriveSessionId('default.agent'), 'default_agent');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
