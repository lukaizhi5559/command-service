// extract-page-items.fixture.test.cjs
// Fixture-based regression test — run with: node extract-page-items.fixture.test.cjs
//
// Tests the generated extraction script against a realistic Amazon-style SERP
// HTML fixture using jsdom. Verifies:
//   1. Script extracts product cards with title, imageUrl, url, price.
//   2. Script completes in under 2s (well within the 15s eval timeout).
//   3. Script handles heavy DOM without timing out.
//   4. Script returns partial results on error (resilience).
//   5. Script rejects data: placeholder images.
//
// NOTE: The fixture uses generic SERP markup patterns (data-component-type,
// data-asin, h2, a[href], img with data-a-dynamic-image) — NOT site-specific
// selectors in the extraction script itself. The script's broad card-candidate
// selector matches these generically.

'use strict';

const { buildExtractItemsScript, parseExtractedItems } = require('./extract-page-items.cjs');
const { JSDOM } = require('jsdom');

let _pass = 0;
let _fail = 0;

function assert(condition, msg) {
  if (condition) {
    _pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    _fail++;
    console.error(`  ❌ ${msg}`);
  }
}

// ── Build a realistic Amazon-style SERP fixture ──────────────────────────────
// Uses generic patterns: [data-component-type="s-search-result"], [data-asin],
// h2 > a[href*="/dp/"], img with data-a-dynamic-image, .a-price.
// 24 product cards to match a typical Amazon SERP.
function buildAmazonSerPFixture(numProducts = 24) {
  const cards = [];
  for (let i = 0; i < numProducts; i++) {
    const asin = `B0${String(i).padStart(6, '0')}CD`;
    const title = `Baby Product ${i + 1} - Cute Outfit`;
    const price = `$${(19.99 + i * 2).toFixed(2)}`;
    cards.push(`
      <div data-component-type="s-search-result" data-asin="${asin}" class="s-result-item">
        <div class="s-card-container">
          <div class="a-section">
            <span class="a-price">
              <span class="a-offscreen">${price}</span>
              <span class="a-price-whole">${price}</span>
            </span>
          </div>
          <div class="s-product-image-container">
            <a class="s-no-outline-click" href="/dp/${asin}/ref=sr_1_${i + 1}">
              <img class="s-image"
                   src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
                   data-a-dynamic-image='{"https://m.media-amazon.com/images/I/${asin}.jpg":[300,400],"https://m.media-amazon.com/images/I/${asin}_large.jpg":[600,800]}'
                   alt="${title}" />
            </a>
          </div>
          <div class="a-section a-spacing-none">
            <h2 class="a-size-base-plus a-text-normal">
              <a class="a-link-normal" href="/dp/${asin}/ref=sr_1_${i + 1}">
                <span>${title}</span>
              </a>
            </h2>
          </div>
          <div class="a-row">
            <span class="a-price"><span class="a-offscreen">${price}</span></span>
          </div>
        </div>
      </div>`);
  }
  return `<!DOCTYPE html>
<html>
<head>
  <title>Amazon.com : baby clothes</title>
  <meta property="og:title" content="Amazon.com : baby clothes" />
</head>
<body>
  <div id="search">
    <div class="s-main-slot s-result-list">
      ${cards.join('\n')}
    </div>
  </div>
</body>
</html>`;
}

// Run the extraction script in a jsdom window context.
function runExtraction(html) {
  const dom = new JSDOM(html, { url: 'https://www.amazon.com/s?k=baby%20clothes' });
  const window = dom.window;
  const document = window.document;

  // The script is an IIFE that returns a JSON string. Evaluate it in the
  // jsdom window context by wrapping it in a function call.
  const script = buildExtractItemsScript();
  // Use vm-like evaluation: create a function that runs in the window scope.
  // jsdom provides a real DOM, so we can run the script directly.
  const fn = new Function('document', 'window', 'URL', `return (${script});`);
  const jsonStr = fn(document, window, window.URL);
  return parseExtractedItems(jsonStr);
}

async function main() {
  console.log('\n── 1. Fixture: Amazon-style SERP with 24 products ──');
  const html = buildAmazonSerPFixture(24);
  const start = Date.now();
  let result;
  try {
    result = runExtraction(html);
  } catch (e) {
    assert(false, `extraction threw: ${e.message}`);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Results: ${_pass} passed, ${_fail} failed`);
    process.exit(1);
  }
  const elapsed = Date.now() - start;

  assert(result.items.length > 0, `extracted ${result.items.length} items (expected > 0)`);
  assert(elapsed < 2000, `completed in ${elapsed}ms (expected < 2000ms)`);
  assert(result.stats.cardCandidates > 0, `stats.cardCandidates=${result.stats.cardCandidates} > 0`);

  console.log('\n── 2. Item fields are populated ──');
  if (result.items.length > 0) {
    const item = result.items[0];
    assert(!!item.title, `item has title: "${item.title}"`);
    assert(!!item.imageUrl, `item has imageUrl: "${item.imageUrl}"`);
    assert(!!item.url, `item has url: "${item.url}"`);
    assert(!!item.price, `item has price: "${item.price}"`);
    assert(!!item.hostname, `item has hostname: "${item.hostname}"`);
    assert(!item.imageUrl.startsWith('data:'), `imageUrl is NOT a data: placeholder`);
    assert(item.imageUrl.includes('m.media-amazon.com'), `imageUrl resolved from data-a-dynamic-image`);
    assert(item.url.includes('/dp/') || item.url.includes('amazon.com'), `url is a product link`);
  }

  console.log('\n── 3. All 24 products extracted (no timeout) ──');
  assert(result.items.length >= 20, `extracted >= 20 of 24 products (got ${result.items.length})`);

  console.log('\n── 4. Resilience: partial results on malformed DOM ──');
  const badHtml = '<html><body><div data-asin="B0TEST"><a href="/dp/B0TEST/">link</a></div> broken';
  let badResult;
  try {
    badResult = runExtraction(badHtml);
    assert(true, 'did not throw on malformed HTML');
  } catch (e) {
    assert(false, `threw on malformed HTML: ${e.message}`);
    badResult = { items: [], stats: {} };
  }
  assert(Array.isArray(badResult.items), 'returns items array even on bad input');

  console.log('\n── 5. Empty page returns 0 items gracefully ──');
  const emptyHtml = '<html><body></body></html>';
  const emptyResult = runExtraction(emptyHtml);
  assert(emptyResult.items.length === 0, `empty page → 0 items (got ${emptyResult.items.length})`);
  assert(emptyResult.stats.cardCandidates === 0, `empty page → 0 cardCandidates`);

  console.log('\n── 6. Heavy DOM (100 products) completes fast ──');
  const heavyHtml = buildAmazonSerPFixture(100);
  const heavyStart = Date.now();
  const heavyResult = runExtraction(heavyHtml);
  const heavyElapsed = Date.now() - heavyStart;
  assert(heavyResult.items.length >= 24, `heavy DOM extracted ${heavyResult.items.length} items (capped at 24)`);
  assert(heavyElapsed < 3000, `heavy DOM completed in ${heavyElapsed}ms (expected < 3000ms)`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${_pass} passed, ${_fail} failed`);
  process.exit(_fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test error:', e); process.exit(1); });
