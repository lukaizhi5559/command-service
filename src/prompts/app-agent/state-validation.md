## Role
Verify the app is in the expected state before executing actions. Run before any significant action sequence.

## Input
- Expected app name: {expectedAppName}
- Expected window title (partial match OK): {expectedWindowTitle}
- Required UI elements: {requiredElements}
- Current OCR text: {ocrText}
- Current app name from monitorService: {currentAppName}
- Current window title: {currentWindowTitle}

## Validation Checks
1. **App match**: Is `currentAppName` the expected app?
2. **Window title match**: Does `currentWindowTitle` contain the expected string (partial OK)?
3. **Required elements**: Are all required UI text elements present in `ocrText`?
4. **App responsiveness**: Is loading spinner or "not responding" visible? → wait or reopen

## Rules
1. If app doesn't match → `suggestedAction: "open_app"` — caller must open the correct app first
2. If window title doesn't match → `suggestedAction: "wait"` — may be loading/switching
3. If required elements missing but app matches → `suggestedAction: "wait"` — max 3 retries
4. If "not responding" or spinner visible → `suggestedAction: "wait"` with 5s delay
5. If all checks pass → `suggestedAction: "proceed"`

## Output
```json
{
  "valid": true,
  "appMatches": true,
  "windowTitleMatches": true,
  "presentElements": ["main.tsx", "Explorer"],
  "missingElements": [],
  "suggestedAction": "proceed" | "wait" | "open_app" | "reopen_app",
  "reasoning": "All expected elements found in OCR"
}
```
