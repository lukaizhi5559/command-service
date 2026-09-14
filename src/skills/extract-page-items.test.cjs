// extract-page-items.test.cjs
// Standalone regression test — run with: node extract-page-items.test.cjs
//
// Tests:
//   1. Generated extraction script parses as valid JS.
//   2. Generated script contains generic resilience/speed patterns
//      (try/catch partial results, textContent over innerText, loop caps,
//      data-a-dynamic-image lazy-image handling, data: URL rejection).
//   3. parseExtractedItems handles new { items, stats } shape, old array shape,
//      and empty/invalid input.
//   4. parseExtractedItems preserves product mediaType and video fields.

'use strict';

const { buildExtractItemsScript, parseExtractedItems } = require('./extract-page-items.cjs');

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
  console.log('\n── 1. Generated script is syntactically valid JS ──');
  const script = buildExtractItemsScript();
  assert(script.length > 1000, `script length ${script.length} > 1000`);
  try {
    // The script is an arrow expression; wrap to parse as a statement.
    new Function(`return (${script})`);
    assert(true, 'generated script parses as valid JS');
  } catch (e) {
    assert(false, `generated script parse error: ${e.message}`);
  }

  console.log('\n── 2. Generic resilience/speed patterns are present ──');
  assert(script.includes('aDynamicImage'), 'handles data-a-dynamic-image (generic lazy-image attr)');
  assert(script.includes('data-asin'), 'includes data-asin in broad card-candidate selector');
  assert(script.includes('MAX_CARD_LOOPS'), 'has loop cap for speed');
  assert(script.includes('MAX_ANCHORS'), 'has per-card anchor cap');
  assert(script.includes('MAX_IMGS'), 'has per-card image cap');
  assert(script.includes('textContent'), 'uses textContent over innerText (avoids reflow)');
  assert(script.includes('stats.error'), 'returns partial results + error on failure');

  console.log('\n── 3. parseExtractedItems shapes ──');
  const newShape = parseExtractedItems(JSON.stringify({
    items: [
      { url: 'https://amazon.com/dp/123', title: 'T', imageUrl: 'https://img.png', mediaType: 'product', price: '$12.99' },
      { url: 'https://youtube.com/watch?v=abc', title: 'V', imageUrl: 'https://thumb.jpg', mediaType: 'video', videoUrl: 'https://vid.mp4', duration: '5:30' },
    ],
    stats: { ldBlocks: 1, cardCandidates: 8, filtered: 0 },
  }));
  assert(newShape.items.length === 2, 'new shape: 2 items');
  assert(newShape.items[0].mediaType === 'product', 'product mediaType preserved');
  assert(newShape.items[1].mediaType === 'video', 'video mediaType preserved');
  assert(newShape.items[1].duration === '5:30', 'video duration preserved');
  assert(newShape.stats.cardCandidates === 8, 'stats.cardCandidates preserved');

  const oldShape = parseExtractedItems(JSON.stringify([{ url: 'https://x.com', title: 'old' }]));
  assert(oldShape.items.length === 1 && oldShape.items[0].url === 'https://x.com', 'old bare-array shape');
  assert(oldShape.stats && typeof oldShape.stats === 'object', 'old shape gets empty stats');

  assert(parseExtractedItems('').items.length === 0, 'empty string → 0 items');
  assert(parseExtractedItems('not json').items.length === 0, 'invalid JSON → 0 items');

  console.log('\n── 4. data: placeholder rejection ──');
  // The in-page script uses resolveImg which rejects data: URLs via the
  // startsData() helper and prefers real URLs from data-a-dynamic-image.
  assert(script.includes('startsData'), 'has startsData() helper for data: rejection');
  assert(script.includes("if (u && startsData(u)) u = '';"), 'rejects data: URLs after resolution');
  assert(script.includes('!startsData(k)'), 'skips data: keys in aDynamicImage map');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${_pass} passed, ${_fail} failed`);
  process.exit(_fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test error:', e); process.exit(1); });
