# Vision Service Examples

This folder contains working examples of Nut.js automation using the Vision Spatial Service.

## Prerequisites

1. **Environment Setup:**
   ```bash
   # Copy .env.example to .env and add your API key
   cp ../.env.example ../.env
   
   # Add your OpenAI API key
   OPENAI_API_KEY=sk-your-key-here
   ```

2. **macOS Permissions:**
   - System Settings → Privacy & Security → Accessibility → Enable Terminal/Node
   - System Settings → Privacy & Security → Screen Recording → Enable Terminal/Node

## Examples

### 1. Gmail Compose (Hybrid Approach)

**File:** `gmail-compose-vision.js`

Demonstrates the recommended hybrid approach:
- Try keyboard shortcut first (fast)
- Fall back to fixed coordinates
- Use vision AI as final fallback

**Run:**
```bash
node gmail-compose-vision.js
```

**What it does:**
1. Opens Chrome
2. Navigates to Gmail
3. Clicks Compose button (using hybrid approach)
4. Fills in email fields using vision
5. Leaves draft ready to send

**Expected output:**
```
🚀 Starting Gmail Compose automation with Vision AI...
🌐 Opening Gmail...
⏳ Waiting for Gmail to load...
📧 Attempting to open Gmail Compose...
1️⃣ Trying keyboard shortcut (C)...
✅ Keyboard shortcut worked!
✍️ Filling email fields...
📧 Filling To field...
📝 Filling Subject field...
💬 Filling email body...
✅ Email filled successfully!
✅ Automation complete!
```

### 2. YouTube Search (Vision-First)

**File:** `youtube-search-vision.js`

Demonstrates vision-first approach for dynamic UIs:
- Uses vision AI to find search box
- No hard-coded coordinates
- Works on any YouTube layout

**Run:**
```bash
node youtube-search-vision.js
```

**What it does:**
1. Opens Chrome
2. Navigates to YouTube
3. Finds search box using vision AI
4. Types search query
5. Submits search

**Expected output:**
```
🚀 Starting YouTube search automation with Vision AI...
🌐 Opening YouTube...
⏳ Waiting for YouTube to load...
🔍 Searching for: "AI tutorials 2024"
👁️ Using vision AI to find search box...
📸 [VISION] Screenshot saved: .temp/screenshots/screen-xxx.png
✅ [VISION] Found 15 UI elements
✅ Search box clicked!
⌨️ Typing search query...
✅ Search submitted!
✅ Automation complete!
```

## How Vision Service Works

```
1. Capture Screenshot
   ↓
2. Send to OpenAI GPT-4o
   ↓
3. Receive UI Element Map
   [
     { label: "Compose", role: "button", bbox: {x: 70, y: 175, w: 100, h: 40} },
     { label: "Search", role: "input", bbox: {x: 300, y: 50, w: 400, h: 35} },
     ...
   ]
   ↓
4. Find Element by Label
   ↓
5. Click Center of Bounding Box
```

## Customizing Examples

### Change Email Recipient

Edit `gmail-compose-vision.js`:
```javascript
await fillEmailWithVision(
  'your-email@example.com',  // Change this
  'Your Subject',
  'Your message body'
);
```

### Change Search Query

Edit `youtube-search-vision.js`:
```javascript
await searchYouTube('your search query');  // Change this
```

### Add More Steps

```javascript
// After compose is open, you can:
await findAndClick('Attach files', 'button');
await findAndClick('Send', 'button');
await findAndClick('Close', 'button');
```

## Troubleshooting

### "Could not find element"

**Solution 1:** Check if page is fully loaded
```javascript
await sleep(5000);  // Increase wait time
```

**Solution 2:** Try alternative labels
```javascript
// Try multiple variations
let success = await findAndClick('Compose', 'button');
if (!success) {
  success = await findAndClick('New message', 'button');
}
```

**Solution 3:** Use `getUIMap()` to see all elements
```javascript
const map = await getUIMap();
console.log('Available elements:', map);
```

### "API key not found"

Make sure `.env` file has:
```bash
OPENAI_API_KEY=sk-your-actual-key
```

### "Permission denied"

Enable accessibility and screen recording permissions:
```bash
# macOS
System Settings → Privacy & Security → Accessibility
System Settings → Privacy & Security → Screen Recording
```

## Performance Tips

1. **Use Hybrid Approach** - Try fast methods first
2. **Cache Results** - Vision service caches for 30s
3. **Batch Operations** - Get UI map once, find multiple elements
4. **Increase Delays** - Give pages time to load

## Cost Considerations

- **Vision API call:** ~$0.01 per screenshot
- **Hybrid approach:** Minimizes API calls
- **Caching:** Reduces repeated calls

**Example costs:**
- Gmail compose (hybrid): $0.00 (keyboard shortcut works)
- YouTube search (vision): $0.01 (one API call)
- Complex workflow: $0.03-0.05 (3-5 API calls)

## Creating Your Own Examples

Template:
```javascript
const { keyboard, Key, mouse } = require('@nut-tree-fork/nut-js');
const { findAndClick, getUIMap } = require('../src/services/visionSpatialService');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  try {
    // 1. Navigate to your app
    // ... navigation code ...
    
    // 2. Use vision to interact
    await findAndClick('Button Label', 'button');
    
    // 3. Continue automation
    await keyboard.type('text');
    
    console.log('✅ Done!');
  } catch (error) {
    console.error('❌ Failed:', error.message);
  }
})();
```

## Next Steps

1. Run the examples to see vision service in action
2. Modify examples for your use cases
3. Create new automation scripts
4. Check `../VISION_SPATIAL_SERVICE.md` for full API reference

## Support

- API Reference: `../VISION_SPATIAL_SERVICE.md`
- Integration Guide: `../VISION_INTEGRATION_GUIDE.md`
- Complete Summary: `../VISION_SERVICE_COMPLETE.md`
