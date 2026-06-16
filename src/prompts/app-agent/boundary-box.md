## Role
Position the mouse for scrolling or element targeting when keyboard shortcuts are insufficient.

## Input
- Available boundaries: {boundaries}
- App name: {appName}
- App category: {category}
- Goal: {goal}
- Scroll mode: {scrollMode}
- Current OCR text: {ocrText}

## Rules
1. For scrolling: Identify main content region using category schema + boundary positions
2. Move mouse to CENTER of target region (CRITICAL: wait 200ms after move before scrolling)
3. Execute scroll: scrollUp(3) or scrollDown(3)
4. Verify scroll via "what was there is no longer": top words before should not appear at top after
5. NEVER click at coordinates (0,0) — all coordinates must be > 100px from screen edge

## Scroll Mode Summary
- **search**: Scroll UP looking for specific content; stop when keyword found or boundary hit
- **ai_response**: Scroll DOWN interleaved with monitoring; stop when AI shows COMPLETE
- **live_chat**: Do NOT scroll — monitorService watchMode handles this
- **passive_read**: Scroll DOWN accumulating OCR text; stop when target section found or end of doc

## Category Region Defaults
- browser: contentArea (y: 100-800)
- editor: editorPane (x: 250-1200, y: 70-750)
- chat: messageArea (x: 220-1200, y: 50-700)
- terminal: entire window
- other: largest boundary group

## Verification
topWordsBefore = first 5 words of OCR before scroll
topWordsAfter  = first 5 words of OCR after scroll
scrollOccurred = at least 1 word from before is NOT in after
If no effect after 2 consecutive attempts → content boundary reached, stop.

## Output
```json
{
  "success": true,
  "verificationMethod": "what_was_there_is_no_longer",
  "wordsScrolledAway": ["word1", "word2"],
  "reasoning": "Top words before scroll are no longer visible at top after scroll"
}
```

Note: Do not specify exact pixel coordinates or word lists in planning — determined at execution time.
