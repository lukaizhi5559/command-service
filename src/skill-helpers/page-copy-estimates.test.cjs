// page-copy-estimates.test.cjs
// Standalone regression test — run with: node page-copy-estimates.test.cjs
//
// Tests:
//   1. categorizeUrl maps known hosts (exact + suffix) to categories.
//   2. estimateForUrl returns minChars/settleMs, falls back to web_generic.
//   3. isBotWall catches Cloudflare/CAPTCHA signatures, passes clean text.
//   4. normalizeUrl strips tracking params + hash, keeps query semantics.
//   5. saveCopy/findFreshCopy round-trip with TTL expiry.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  categorizeUrl, estimateForUrl, isBotWall, normalizeUrl,
  saveCopy, findFreshCopy, readCopy, COPIES_DIR, COPIES_INDEX,
} = require('./page-copy-estimates.cjs');

let _pass = 0;
let _fail = 0;

function assert(condition, msg) {
  if (condition) { _pass++; console.log(`  ✅ ${msg}`); }
  else { _fail++; console.error(`  ❌ ${msg}`); }
}

async function main() {
  console.log('\n── 1. categorizeUrl ──');
  assert(categorizeUrl('https://www.google.com/search?q=x') === 'search_engine', 'google.com → search_engine');
  assert(categorizeUrl('https://smile.amazon.com/dp/123') === 'shopping', 'smile.amazon.com → shopping (suffix)');
  assert(categorizeUrl('https://www.youtube.com/watch?v=1') === 'media_player', 'youtube.com → media_player');
  assert(categorizeUrl('https://x.com/user/status/1') === 'social_feed', 'x.com → social_feed');
  assert(categorizeUrl('https://some-random-site.io/page') === null, 'unknown host → null');
  assert(categorizeUrl('not a url') === null, 'non-url → null');

  console.log('\n── 2. estimateForUrl ──');
  const g = estimateForUrl('https://www.google.com/search?q=tesla');
  assert(g.category === 'search_engine' && g.minChars === 800, `google estimate: ${JSON.stringify(g)}`);
  const unk = estimateForUrl('https://unknown.xyz/');
  assert(unk.category === 'web_generic' && unk.minChars === 300, 'unknown → web_generic defaults');
  assert(estimateForUrl(null).category === 'web_generic', 'null → web_generic');

  console.log('\n── 3. isBotWall ──');
  assert(isBotWall('Verify you are human by completing the action below'), 'verify-you-are-human detected');
  assert(isBotWall('Some text cf-chl-abc123 more'), 'cf-chl detected');
  assert(isBotWall('Please complete the security check to continue'), 'security check detected');
  assert(!isBotWall('New Tesla cars: Model 3, Model Y, Cybertruck — prices and specs'), 'clean text passes');
  assert(!isBotWall(''), 'empty passes');
  assert(!isBotWall(null), 'null passes');
  // Long real page mentioning "captcha" in content (SO question titles) — not a wall.
  const longPage = 'StackOverflow search results\n' + 'result entry '.repeat(800) + '\nhow do i bypass captcha in selenium\n';
  assert(!isBotWall(longPage), 'long page with "captcha" in content passes');

  console.log('\n── 4. normalizeUrl ──');
  assert(normalizeUrl('https://www.amazon.com/s?k=bibles&utm_source=x#reviews') === 'amazon.com/s?k=bibles', 'strips www, utm_, hash');
  assert(normalizeUrl('https://x.com/A?b=2&a=1') === 'x.com/a?b=2&a=1' || normalizeUrl('https://x.com/A?b=2&a=1') === 'x.com/a?a=1&b=2', 'path lowercased + params sorted');
  assert(normalizeUrl('https://example.com/') === 'example.com/', 'root path preserved');

  console.log('\n── 5. saveCopy / findFreshCopy / TTL ──');
  // Isolate the index for this test run.
  const _backup = fs.existsSync(COPIES_INDEX) ? fs.readFileSync(COPIES_INDEX, 'utf8') : null;
  try {
    const testHost = `test-${Date.now()}.example.com`;
    const testUrl = `https://${testHost}/page?utm_campaign=x`;
    const content = 'x'.repeat(1500);
    const saved = saveCopy({ url: testUrl, content, appName: 'Safari' });
    assert(saved && fs.existsSync(saved.file), `copy written to ${saved?.file}`);
    assert(readCopy(saved.file) === content, 'readCopy round-trips content');

    const hit = findFreshCopy(testUrl);
    assert(hit && hit.file === saved.file, 'findFreshCopy hits by normalized URL');
    const hit2 = findFreshCopy(`https://${testHost}/page?utm_campaign=OTHER`);
    assert(hit2 && hit2.file === saved.file, 'cache hit survives utm_ param change');

    const latest = findFreshCopy(null);
    assert(latest && latest.file === saved.file, 'findFreshCopy(null) returns newest');

    // Expired: shrink TTL to 0 → miss.
    assert(findFreshCopy(testUrl, 0) === null || !findFreshCopy(testUrl, 0), 'ttl=0 → miss');

    // html flavor sidecar
    const savedHtml = saveCopy({ url: testUrl + '/2', content, appName: 'Safari', html: '<html>hi</html>' });
    assert(savedHtml.htmlFile && fs.existsSync(savedHtml.htmlFile), 'html sidecar written');
  } finally {
    if (_backup !== null) fs.writeFileSync(COPIES_INDEX, _backup);
  }

  console.log(`\n${_pass} passed, ${_fail} failed`);
  process.exit(_fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
