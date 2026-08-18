// ocrOverlayStructure.cjs
// Pure, testable functions for restructuring LiteParser OCR word fragments
// into clean structured rows for overlays (menus, dropdowns, popups, modals, tabs).
//
// No browser dependencies — operates on the textItems array shape returned by
// _liteparseCapture: [{ text, x, y, width, height, confidence }]
//
// Exports: structureOcrOverlayItems, formatOverlayForLLM, pickOverlayAction

'use strict';

// ---------------------------------------------------------------------------
// Noise filters
// ---------------------------------------------------------------------------
const _PUNCT_ONLY_RE = /^[^\w]+$/;
const _ICON_CHARS_RE = /^[®©™»>•‹›←→↑↓✓✕✗✔✘★☆◇◆■□●○]+$/;
const _BUTTON_LABELS = /^(create|save|cancel|done|submit|ok|confirm|delete|remove|close|apply|next|back|edit|add|update|send|post|publish|share|select|choose|done|finish|continue|retry|try again|yes|no|accept|reject|decline)$/i;
const _INPUT_LABELS = /^(search|enter|name|title|description|email|password|username|label|find|what|where|when)$/i;
const _MENU_WORDS = new Set([
  'edit', 'details', 'remove', 'from', 'profile', 'delete', 'make', 'private', 'invite',
  'collaborators', 'exclude', 'your', 'taste', 'move', 'to', 'folder', 'share', 'open',
  'in', 'desktop', 'app', 'create', 'playlist', 'songs', 'episodes', 'blend', 'combine',
  'tastes', 'into', 'a', 'organize', 'playlists', 'cancel', 'update', 'add', 'new',
]);

// ---------------------------------------------------------------------------
// structureOcrOverlayItems — cluster word fragments into structured rows
// ---------------------------------------------------------------------------
// Input:  items[] = [{ text, x, y, width, height, confidence }]
// Output: rows[]  = [{ id, type, text, description, x, y, width, height }]
//
// Types: heading | row-item-link | row-item-description | input-field | button | divider
//
function structureOcrOverlayItems(items, opts = {}) {
  if (!items || items.length === 0) return [];

  // ── Step 1: Filter noise ────────────────────────────────────────────────
  // Note: low-confidence items are NOT filtered here — they're needed for spatial
  // structure (clustering + horizontal gap detection). A filtered-out item can
  // create a false large gap between its neighbors, causing over-splitting.
  // Low-confidence items are skipped in step 3 (text joining) instead.
  const filtered = [];
  for (const item of items) {
    const text = (item.text || '').trim();
    // Drop empty, but keep single-letter words (like "a") — they're real words
    // that join with others in a row. Only drop single-char if it's not a letter.
    if (text.length === 0) continue;
    if (text.length === 1 && !/[a-z]/i.test(text)) continue;
    if (_PUNCT_ONLY_RE.test(text)) continue;
    if (_ICON_CHARS_RE.test(text)) continue;
    // Drop very low-confidence short items (likely OCR misreads of icons)
    if (text.length <= 3 && (item.confidence || 1.0) < 0.6) continue;
    filtered.push({ ...item, text });
  }
  if (filtered.length === 0) return [];

  // ── Step 1b: Filter the left icon column ────────────────────────────────
  // Overlay menus have icons in a left column and text to the right. OCR
  // sometimes misreads an icon as text (e.g. "Q", "M1", "3"). Detect the icon
  // column by finding the leftmost x-cluster, then drop short non-word items
  // that sit in that column and have a word to their right.
  filtered.sort((a, b) => (a.x || 0) - (b.x || 0));
  let iconColumnCutoff = Infinity;
  for (let i = 0; i < filtered.length; i++) {
    if (i + 1 < filtered.length) {
      const curr = filtered[i];
      const next = filtered[i + 1];
      const gap = (next.x || 0) - ((curr.x || 0) + (curr.width || 0));
      if (gap > 20) {
        iconColumnCutoff = (curr.x || 0) + (curr.width || 0) + 10;
        break;
      }
    }
  }
  const iconFiltered = [];
  for (const item of filtered) {
    const text = item.text || '';
    const right = (item.x || 0) + (item.width || 0);
    const isInIconColumn = (item.x || 0) < iconColumnCutoff && right < iconColumnCutoff;
    const hasTextToRight = filtered.some(other =>
      other !== item &&
      (other.x || 0) > right &&
      Math.abs((other.y || 0) - (item.y || 0)) < 40
    );
    if (isInIconColumn && hasTextToRight && text.length <= 3 && !_MENU_WORDS.has(text.toLowerCase())) {
      // Likely an icon misread (e.g. "Q", "M1", "®")
      continue;
    }
    iconFiltered.push(item);
  }

  // ── Step 2: Cluster into rows by vertical overlap ───────────────────────
  // Sort by y ascending
  iconFiltered.sort((a, b) => (a.y || 0) - (b.y || 0));

  const rows = [];
  let currentRow = [iconFiltered[0]];
  let currentRowY = iconFiltered[0].y || 0;
  let currentRowH = iconFiltered[0].height || 0;

  for (let i = 1; i < iconFiltered.length; i++) {
    const item = iconFiltered[i];
    const itemY = item.y || 0;
    const itemH = item.height || 0;
    // Start a new row if vertical gap exceeds 60% of the taller item's height
    const threshold = Math.max(currentRowH, itemH) * 0.6;
    if (Math.abs(itemY - currentRowY) > threshold) {
      rows.push(currentRow);
      currentRow = [item];
      currentRowY = itemY;
      currentRowH = itemH;
    } else {
      currentRow.push(item);
      // Update row tracking to the tallest item
      if (itemH > currentRowH) {
        currentRowH = itemH;
      }
    }
  }
  rows.push(currentRow); // don't forget the last row

  // ── Step 2b: Split rows with large horizontal gaps ──────────────────────
  // Items on the same y may be separate UI elements (e.g. "Cancel" and "Create"
  // buttons side by side). If the horizontal gap between consecutive items
  // (sorted by x) exceeds 2x the item height, split into separate rows.
  // Within a single label like "Create a playlist", word gaps are small (~5px),
  // so this won't over-split.
  const splitRows = [];
  for (const rowItems of rows) {
    if (rowItems.length <= 1) {
      splitRows.push(rowItems);
      continue;
    }
    // Sort by x within the row
    const sorted = [...rowItems].sort((a, b) => (a.x || 0) - (b.x || 0));
    const subRows = [[sorted[0]]];
    for (let j = 1; j < sorted.length; j++) {
      const prev = sorted[j - 1];
      const curr = sorted[j];
      const prevRight = (prev.x || 0) + (prev.width || 0);
      const currLeft = curr.x || 0;
      const hGap = currLeft - prevRight;
      const refHeight = Math.max(prev.height || 0, curr.height || 0);
      // Split if horizontal gap > 2x the item height (clearly separate elements)
      if (hGap > refHeight * 2) {
        subRows.push([curr]);
      } else {
        subRows[subRows.length - 1].push(curr);
      }
    }
    for (const sub of subRows) {
      splitRows.push(sub);
    }
  }

  // ── Step 3: Within each row, sort by x and join text ────────────────────
  // Skip low-confidence items when joining text (they were kept for spatial
  // structure in steps 2-2b, but their text is unreliable for the final output).
  // Also apply word segmentation for merged words (e.g. "Editdetails" → "Edit details").
  const _ACTION_PREFIXES = ['Edit', 'Remove', 'Delete', 'Make', 'Move', 'Share', 'Invite',
    'Exclude', 'Open', 'Create', 'Add', 'Update', 'Send', 'Post', 'Publish', 'Select',
    'Choose', 'Save', 'Cancel', 'Close', 'Apply', 'Submit'];
  function segmentMergedWords(text) {
    if (!text || text.length < 5 || /\s/.test(text)) return text;
    for (const prefix of _ACTION_PREFIXES) {
      if (text.toLowerCase().startsWith(prefix.toLowerCase()) && text.length > prefix.length) {
        const rest = text.slice(prefix.length);
        // Only segment if the rest starts with a capital letter or is a known word
        if (/^[A-Z]/.test(rest) || _MENU_WORDS.has(rest.toLowerCase())) {
          return prefix + ' ' + rest;
        }
      }
    }
    return text;
  }
  const rowObjs = splitRows.map(rowItems => {
    rowItems.sort((a, b) => (a.x || 0) - (b.x || 0));
    const textParts = rowItems.filter(i => (i.confidence || 1.0) >= 0.5).map(i => i.text);
    let text = textParts.join(' ').replace(/\s+/g, ' ').trim();
    // Apply word segmentation to each part (in case a single OCR item merged two words)
    text = textParts.map(segmentMergedWords).join(' ').replace(/\s+/g, ' ').trim();
    const x = Math.min(...rowItems.map(i => i.x || 0));
    const y = Math.min(...rowItems.map(i => i.y || 0));
    const right = Math.max(...rowItems.map(i => (i.x || 0) + (i.width || 0)));
    const bottom = Math.max(...rowItems.map(i => (i.y || 0) + (i.height || 0)));
    const height = bottom - y;
    // Use the MEDIAN height of individual items for font size estimation.
    // Max is too sensitive to one tall word (e.g. "playlist" h=12 in a
    // description row where most words are h=9). Median is more stable.
    const itemHeights = rowItems.map(i => i.height || 0).filter(h => h > 0).sort((a, b) => a - b);
    const medianItemHeight = itemHeights.length > 0
      ? itemHeights[Math.floor(itemHeights.length / 2)]
      : (height || 10);
    return {
      text,
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(right - x),
      height: Math.round(height),
      _medianItemHeight: Math.round(medianItemHeight),
      _itemCount: rowItems.length,
    };
  });

  // ── Step 4: Compute median font height across all rows for heading detection ───
  const fontHeights = rowObjs.map(r => r._medianItemHeight).filter(h => h > 0).sort((a, b) => a - b);
  const medianHeight = fontHeights.length > 0 ? fontHeights[Math.floor(fontHeights.length / 2)] : 10;

  // ── Step 5: Classify each row (first pass — no description detection yet) ──
  const classified = rowObjs.map((row, idx) => {
    const text = row.text;
    const textLower = text.toLowerCase();
    const textLen = text.length;
    const h = row._medianItemHeight;
    const isLargeFont = h > medianHeight * 1.4;

    // Divider: very short text or only symbols
    if (textLen <= 2 && _PUNCT_ONLY_RE.test(text)) {
      return { ...row, type: 'divider' };
    }

    // Heading: first row(s), large font, short text
    if (idx === 0 && isLargeFont && textLen < 50) {
      return { ...row, type: 'heading' };
    }
    // Also heading if large font and very short (title-like)
    if (isLargeFont && textLen < 40 && textLen > 2) {
      return { ...row, type: 'heading' };
    }

    // Button: only classify as button if this is a horizontal button group
    // (multiple short words on the same y, e.g. "Cancel Create") OR if there
    // are input-fields in the overlay (modal context). A single short word in
    // a vertical menu list (e.g. "Delete") should stay row-item-link.
    // Check is deferred to step 5c after all rows are classified.


    // Input field: looks like a placeholder/label
    if (textLen > 3 && textLen < 60 && /[?]/.test(text)) {
      return { ...row, type: 'input-field' };
    }
    if (textLen > 2 && textLen < 50 && row._itemCount <= 3) {
      const words = textLower.split(/\s+/);
      if (words.some(w => _INPUT_LABELS.test(w))) {
        return { ...row, type: 'input-field' };
      }
    }

    // Default: row-item-link (description detection in second pass below)
    return { ...row, type: 'row-item-link' };
  });

  // ── Step 5b: Second pass — detect descriptions by y-gap to previous LINK ──
  // In menus/dropdowns, a description row appears directly below its parent link
  // with a SMALL vertical gap (~22px in the Spotify fixtures), while separate menu
  // items have a LARGER gap (~36-47px). This is more reliable than font-size
  // comparison because OCR height detection is imprecise.
  //
  // A row-item-link becomes a row-item-description if:
  //   - The y-gap to the previous row-item-link is < 2.5x the previous row's font height
  //   - The previous row is a row-item-link (NOT a heading) with meaningful text (> 2 chars)
  //   - The current row has longer text than the previous (> 10 chars)
  const _REAL_SINGLE_CHARS = new Set(['a', 'i', 'o']);
  for (let i = 1; i < classified.length; i++) {
    const row = classified[i];
    if (row.type !== 'row-item-link') continue;
    // Find the previous non-heading, non-divider, non-noise row
    let prevIdx = i - 1;
    while (prevIdx >= 0) {
      const pt = classified[prevIdx].type;
      const ptLen = classified[prevIdx].text.length;
      const isNoise = ptLen <= 2 && !_REAL_SINGLE_CHARS.has(classified[prevIdx].text.toLowerCase());
      if (pt === 'heading' || pt === 'divider' || isNoise) {
        prevIdx--;
      } else {
        break;
      }
    }
    if (prevIdx < 0) continue;
    const prev = classified[prevIdx];
    if (prev.type !== 'row-item-link') continue;
    // y-gap between the tops of the two rows
    const yGap = row.y - prev.y;
    const gapThreshold = prev._medianItemHeight * 2.5;
    if (yGap < gapThreshold && row.text.length > 10 && row.text.length < 100) {
      classified[i].type = 'row-item-description';
    }
  }

  // ── Step 5c: Classify buttons based on full overlay context ─────────────
  // A row is a button ONLY if:
  //   (a) The overlay has input-fields (modal context) — buttons in a modal
  //       dialog like "Cancel" / "Create" next to a text input, OR
  //   (b) The row contains 2+ known button labels on the same y (horizontal
  //       button group, e.g. "Cancel Create" split into two items)
  // A single short word in a vertical menu list (e.g. "Delete" in a context
  // menu) stays row-item-link — it's a menu item, not a modal button.
  const _hasInputs = classified.some(r => r.type === 'input-field');
  for (let i = 0; i < classified.length; i++) {
    const row = classified[i];
    if (row.type !== 'row-item-link') continue;
    const textLen = row.text.length;
    const textLower = row.text.toLowerCase();
    // Case (a): modal context with inputs — short button-like label
    if (_hasInputs && textLen >= 2 && textLen <= 30 && _BUTTON_LABELS.test(textLower)) {
      classified[i].type = 'button';
      continue;
    }
    // Case (b): horizontal button group — multiple button labels on same y
    // (detected as multiple items at similar y after splitting)
    // Check if this row and the next row are both short button labels at similar y
    if (i + 1 < classified.length) {
      const next = classified[i + 1];
      if (next.type === 'row-item-link' &&
          Math.abs(next.y - row.y) < 10 &&
          textLen >= 2 && textLen <= 20 && _BUTTON_LABELS.test(textLower) &&
          next.text.length >= 2 && next.text.length <= 20 && _BUTTON_LABELS.test(next.text.toLowerCase())) {
        classified[i].type = 'button';
        classified[i + 1].type = 'button';
      }
    }
  }

  // ── Step 6: Pair descriptions with parent links ─────────────────────────
  // Also filter out noise rows (single-char OCR misreads that aren't real words)
  const final = [];
  for (let i = 0; i < classified.length; i++) {
    const row = classified[i];
    // Skip noise: single-char rows that aren't real words (OCR icon misreads like "d", "id")
    if (row.text.length <= 2 && !_REAL_SINGLE_CHARS.has(row.text.toLowerCase()) && row.type !== 'heading') {
      continue;
    }
    if (row.type === 'row-item-description' && final.length > 0) {
      const last = final[final.length - 1];
      // Only pair description with a link that has meaningful text (length > 2)
      if (last.type === 'row-item-link' && !last.description && last.text.length > 2) {
        last.description = row.text;
        continue; // skip standalone description row
      }
    }
    if (row.type === 'divider') {
      continue; // skip dividers
    }
    final.push({ ...row, description: row.description || null });
  }

  // ── Step 7: Assign sequential IDs and clean up internal fields ──────────
  let id = 1;
  return final.map(row => {
    const { _medianItemHeight, _itemCount, ...clean } = row;
    return { id: id++, ...clean };
  });
}

// ---------------------------------------------------------------------------
// formatOverlayForLLM — compact string for LLM prompt
// ---------------------------------------------------------------------------
function formatOverlayForLLM(rows) {
  if (!rows || rows.length === 0) return 'Overlay items: (empty)';
  const lines = ['Overlay items:'];
  for (const row of rows) {
    let line = `[${row.id}] ${row.type}: "${row.text}"`;
    if (row.description) {
      line += ` — "${row.description}"`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// pickOverlayAction — ask LLM to pick an item or fill fields + click button
// ---------------------------------------------------------------------------
// Returns: { ok, action: 'pick'|'fill_and_click', selection?: {id, text, x, y, width, height},
//            fills?: [{id, value}], click?: {id, text}, reason?: string }
//
// askWithMessages is injected for testability — same signature as skill-llm.cjs
async function pickOverlayAction(rows, goal, askWithMessages) {
  if (!rows || rows.length === 0) {
    return { ok: false, error: 'no rows provided' };
  }
  if (!askWithMessages) {
    return { ok: false, error: 'askWithMessages is required' };
  }

  const hasInputs = rows.some(r => r.type === 'input-field');
  const hasButtons = rows.some(r => r.type === 'button');
  const isModal = hasInputs && hasButtons;

  const overlayStr = formatOverlayForLLM(rows);

  let prompt;
  if (isModal) {
    prompt = `You are interacting with a dialog/modal. Given the user's goal and the items below, determine what to type in the input field(s) and which button to click.

GOAL: ${goal}

${overlayStr}

Respond with ONLY a JSON object (no markdown fences):
{"actions": [{"type": "fill", "id": <number>, "value": "<text to type>"}, {"type": "click", "id": <number>}], "reason": "<one sentence>"}`;
  } else {
    prompt = `You are selecting an item from an overlay (menu, dropdown, popup, tab bar). Given the user's goal and the items below, pick the ONE item that best matches what the user wants to do.

GOAL: ${goal}

${overlayStr}

Respond with ONLY a JSON object (no markdown fences):
{"id": <number>, "reason": "<one sentence>"}`;
  }

  let raw;
  try {
    raw = await askWithMessages([
      { role: 'system', content: 'You are a browser automation overlay selector. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 300, temperature: 0, responseTimeoutMs: 15000 });
  } catch (e) {
    return { ok: false, error: `LLM call failed: ${e.message}` };
  }

  // Parse JSON from response
  let parsed;
  try {
    let json = (raw || '').trim();
    json = json.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    const match = json.match(/\{[\s\S]*\}/);
    if (match) json = match[0];
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `LLM response parse failed: ${e.message}`, raw };
  }

  if (isModal) {
    // Validate actions array
    if (!parsed.actions || !Array.isArray(parsed.actions)) {
      return { ok: false, error: 'LLM did not return actions array', raw };
    }
    const fills = parsed.actions.filter(a => a.type === 'fill').map(a => {
      const row = rows.find(r => r.id === a.id);
      return { id: a.id, value: a.value, text: row?.text || '', x: row?.x, y: row?.y };
    });
    const click = parsed.actions.find(a => a.type === 'click');
    const clickRow = click ? rows.find(r => r.id === click.id) : null;
    return {
      ok: true,
      action: 'fill_and_click',
      fills,
      click: clickRow ? { id: clickRow.id, text: clickRow.text, x: clickRow.x, y: clickRow.y, width: clickRow.width, height: clickRow.height } : null,
      reason: parsed.reason || '',
    };
  } else {
    // Validate pick
    if (parsed.id === undefined || parsed.id === null) {
      return { ok: false, error: 'LLM did not return an id', raw };
    }
    const row = rows.find(r => r.id === parsed.id);
    if (!row) {
      return { ok: false, error: `LLM picked id ${parsed.id} which does not exist`, raw };
    }
    return {
      ok: true,
      action: 'pick',
      selection: { id: row.id, text: row.text, x: row.x, y: row.y, width: row.width, height: row.height, description: row.description },
      reason: parsed.reason || '',
    };
  }
}

module.exports = { structureOcrOverlayItems, formatOverlayForLLM, pickOverlayAction };
