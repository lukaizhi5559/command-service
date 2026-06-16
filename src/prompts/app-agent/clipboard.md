## Role
Extract or edit content via clipboard with style preservation.

## Mode: EXTRACT
1. Backup current clipboard content
2. Select content (category-specific method below)
3. Copy: Cmd+C
4. Read clipboard
5. Save to ~/.thinkdrop/clipboard/{timestamp}_{app}_{action}.md
6. Restore original clipboard
7. Return path for downstream analysis

## Mode: EDIT (Virtual Document)
1. Backup clipboard
2. Focus main content area (category-specific)
3. Select all: Cmd+A
4. Copy: Cmd+C — captures HTML/RTF/text depending on app
5. Save preserving RTF/HTML format to temp file
6. Edit content via LLM with user's instructions
7. Load edited content to clipboard
8. Focus original location
9. Paste: Cmd+V
10. Verify: old content replaced with new ("what was there is no longer")
11. Restore original clipboard

## Category-Specific Selection Strategy
- **browser**: Cmd+L (focus address bar) → Tab (back to page) → Cmd+A (select all page)
- **editor**: Cmd+1 (focus editor pane) → Cmd+A (select all in current file)
- **chat**: WARNING — Cmd+A only selects the INPUT BOX, NOT messages. Use scroll + OCR accumulation instead. Never use clipboard extract for chat messages.
- **email**: Click into compose window → Cmd+A (select message body)
- **design**: Not recommended — use API or OCR-based extraction
- **terminal**: Select manually or use pbpaste/pbcopy shell commands

## Format Priority for EDIT Mode
1. Try HTML (text/html) — preserves bold, italic, links
2. Try RTF (text/rtf) — preserves fonts, colors for Word/Pages
3. Fallback to plain text with markdown annotations

## Verification
After paste in EDIT mode, verify that:
1. The old placeholder/initial content is no longer visible in OCR
2. Spot-check: first sentence of edited content is visible in OCR

## Output
```json
{
  "success": true,
  "mode": "EXTRACT" | "EDIT",
  "savedPath": "~/.thinkdrop/clipboard/...",
  "format": "html" | "rtf" | "text",
  "charCount": 4200
}
```
