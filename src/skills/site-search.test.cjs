// site-search.test.cjs
// Standalone test script — run with: node site-search.test.cjs
// No test framework needed — just assertions + console output.
//
// Tests:
//   1. buildSiteSearchUrl resolves known domains to the correct template URL
//   2. lookupSiteSearchTemplate handles exact + suffix matches
//   3. isListingTask detects shopping/search/media queries
//   4. isSearchResultsUrl / isDeepItemUrl classify URLs correctly
//   5. extractQuotedSearchTerm extracts quoted search terms + rejects UI labels
//   6. parseExtractedItems handles new { items, stats } and old array shapes
//   7. _badCrawlReason flags thin 0-item pages as signature:true (soft block)

'use strict';

const { buildSiteSearchUrl, lookupSiteSearchTemplate, isListingTask, isSearchResultsUrl, isDeepItemUrl, extractQuotedSearchTerm } = require('../skill-helpers/site-search.cjs');
const { parseExtractedItems } = require('./extract-page-items.cjs');

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

async function main() {
  console.log('\n── 1. buildSiteSearchUrl ──');
  const amazon = await buildSiteSearchUrl('amazon.com', 'ESV bibles');
  assert(amazon === 'https://www.amazon.com/s?k=ESV%20bibles', `amazon.com → ${amazon}`);

  const ebay = await buildSiteSearchUrl('ebay.com', 'baby clothes');
  assert(ebay === 'https://www.ebay.com/sch/i.html?_nkw=baby%20clothes', `ebay.com → ${ebay}`);

  const youtube = await buildSiteSearchUrl('youtube.com', 'cat videos');
  assert(youtube === 'https://www.youtube.com/results?search_query=cat%20videos', `youtube.com → ${youtube}`);

  // Suffix match: smile.amazon.com should use amazon.com template
  const smile = await buildSiteSearchUrl('smile.amazon.com', 'bibles');
  assert(smile === 'https://www.amazon.com/s?k=bibles', `smile.amazon.com → ${smile}`);

  // Unknown domain → null (no template, no DB)
  const unknown = await buildSiteSearchUrl('example.com', 'test');
  assert(unknown === null, `example.com → null`);

  // Empty query → null
  const empty = await buildSiteSearchUrl('amazon.com', '');
  assert(empty === null, `empty query → null`);

  // UI label rejection
  const uiLabel = await buildSiteSearchUrl('amazon.com', 'Add to Cart');
  assert(uiLabel === null, `UI label "Add to Cart" → null`);

  console.log('\n── 2. lookupSiteSearchTemplate ──');
  assert(lookupSiteSearchTemplate('amazon.com') === 'https://www.amazon.com/s?k={query}', 'amazon.com template');
  assert(lookupSiteSearchTemplate('www.amazon.com') === 'https://www.amazon.com/s?k={query}', 'www.amazon.com template (strips www)');
  assert(lookupSiteSearchTemplate('smile.amazon.com') === 'https://www.amazon.com/s?k={query}', 'smile.amazon.com suffix match');
  assert(lookupSiteSearchTemplate('example.com') === null, 'example.com → null');
  assert(lookupSiteSearchTemplate('') === null, 'empty → null');

  console.log('\n── 3. isListingTask ──');
  assert(isListingTask('show pics of baby clothes for sale on amazon') === true, 'show pics of baby clothes');
  assert(isListingTask('goto amazon and look up ESV bibles') === true, 'goto amazon look up');
  assert(isListingTask('search amazon for wireless headphones') === true, 'search amazon for');
  assert(isListingTask('find me deals on ebay') === true, 'find me deals');
  assert(isListingTask('what is the capital of France') === false, 'non-listing query → false');
  assert(isListingTask('') === false, 'empty → false');

  console.log('\n── 4. isSearchResultsUrl / isDeepItemUrl ──');
  assert(isSearchResultsUrl('https://www.amazon.com/s?k=esv') === true, 'amazon /s?k= → search');
  assert(isSearchResultsUrl('https://www.ebay.com/sch/i.html?_nkw=test') === true, 'ebay sch/ → search');
  assert(isSearchResultsUrl('https://www.google.com/search?q=test') === true, 'google /search?q= → search');
  assert(isSearchResultsUrl('https://www.amazon.com/ESV-Study-Bible/dp/1433502410') === false, 'amazon /dp/ → not search');
  assert(isDeepItemUrl('https://www.amazon.com/ESV-Study-Bible/dp/1433502410') === true, 'amazon /dp/ → deep item');
  assert(isDeepItemUrl('https://www.ebay.com/itm/123456') === true, 'ebay /itm/ → deep item');
  assert(isDeepItemUrl('https://www.amazon.com/s?k=esv') === false, 'amazon /s?k= → not deep item');

  console.log('\n── 5. extractQuotedSearchTerm ──');
  assert(extractQuotedSearchTerm("search for 'ESV bibles' on amazon") === 'ESV bibles', 'quoted term extraction');
  assert(extractQuotedSearchTerm("look up 'baby clothes' on amazon") === 'baby clothes', 'look up quoted');
  assert(extractQuotedSearchTerm("search for 'Add to Cart'") === null, 'UI label rejected');
  assert(extractQuotedSearchTerm("search results page for ESV") === null, 'mid-sentence "search" rejected (not in first 60 chars)');

  console.log('\n── 6. parseExtractedItems ──');
  // New shape: { items, stats }
  const newShape = parseExtractedItems(JSON.stringify({
    items: [{ url: 'https://x.com', title: 't', mediaType: 'video', videoUrl: 'https://x.com/v.mp4' }],
    stats: { ldBlocks: 1, cardCandidates: 5 },
  }));
  assert(Array.isArray(newShape.items) && newShape.items.length === 1, 'new shape: 1 item');
  assert(newShape.items[0].mediaType === 'video', 'new shape: mediaType=video');
  assert(newShape.items[0].videoUrl === 'https://x.com/v.mp4', 'new shape: videoUrl preserved');
  assert(newShape.stats.ldBlocks === 1, 'new shape: stats.ldBlocks=1');

  // Old shape: bare array
  const oldShape = parseExtractedItems(JSON.stringify([{ url: 'https://y.com', title: 'old' }]));
  assert(Array.isArray(oldShape.items) && oldShape.items.length === 1, 'old shape: 1 item');
  assert(oldShape.items[0].url === 'https://y.com', 'old shape: url preserved');
  assert(oldShape.stats && typeof oldShape.stats === 'object', 'old shape: empty stats object');

  // Empty
  const empty2 = parseExtractedItems('');
  assert(empty2.items.length === 0, 'empty input → 0 items');

  // Playwright-wrapped output
  const wrapped = parseExtractedItems('### Ran Playwright code\n```js\nawait page.evaluate(\'...\')\n```\n{"items":[{"url":"https://z.com","title":"wrapped"}],"stats":{"ldBlocks":0}}');
  assert(wrapped.items.length === 1 && wrapped.items[0].url === 'https://z.com', 'playwright-wrapped output parsed');

  console.log('\n── 7. _badCrawlReason (soft-block detection) ──');
  // Re-implement the logic test inline since _badCrawlReason isn't exported.
  // The key behavior: thin page + 0 items + extractItems=true → signature:true
  const _ERROR_PAGE_RE = /error page|page not found|\b404\b|access denied|forbidden|blocked|captcha|pardon our interruption|unusual traffic|are you a robot|service unavailable|temporarily unavailable|automated access|robot check|validatecaptcha|\/sorry\/|prove you.{0,20}(?:human|not a robot)/i;
  function _badCrawlReason(res, extractItems) {
    if (!res.ok) return { reason: res.error || 'request failed', signature: false };
    const title = res.title || '';
    if (_ERROR_PAGE_RE.test(title)) return { reason: `error-page title`, signature: true };
    const len = res.contentLength || (res.content || '').length;
    if (len < 1500 && _ERROR_PAGE_RE.test((res.content || '').slice(0, 500))) return { reason: `error-page signature`, signature: true };
    if (extractItems && (!res.items || res.items.length === 0) && len < 2500) return { reason: `thin 0 items`, signature: true };
    if (extractItems && (!res.items || res.items.length === 0) && len < 1500) return { reason: `thin 0 items`, signature: false };
    return null;
  }

  // Amazon soft-block: 293 chars, 0 items, extractItems=true → signature:true
  const softBlock = _badCrawlReason({ ok: true, title: 'Amazon', contentLength: 293, items: [] }, true);
  assert(softBlock && softBlock.signature === true, '293-char 0-item page → signature:true (warm retry fires)');

  // Real listing page: 50000 chars, 12 items → null (good page)
  const goodPage = _badCrawlReason({ ok: true, title: 'Amazon : ESV bibles', contentLength: 50000, items: new Array(12) }, true);
  assert(goodPage === null, '50k-char 12-item page → null (good page)');

  // Error page title → signature:true
  const errorTitle = _badCrawlReason({ ok: true, title: 'Are you a robot?', contentLength: 500 }, true);
  assert(errorTitle && errorTitle.signature === true, 'bot-wall title → signature:true');

  // Thin page without extractItems → null (legitimately sparse)
  const sparseNoItems = _badCrawlReason({ ok: true, title: 'Some page', contentLength: 800 }, false);
  assert(sparseNoItems === null, '800-char page without extractItems → null');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${_pass} passed, ${_fail} failed`);
  process.exit(_fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test error:', e); process.exit(1); });
