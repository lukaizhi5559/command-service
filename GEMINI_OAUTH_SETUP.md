# Gemini OAuth Integration Setup

The command service now uses **Google Gemini 2.0 Flash** with **OAuth 2.0 authentication** for secure, one-click setup.

## Architecture

```
User Query
    ↓
┌─────────────────────────────────────┐
│  Layer 0: Pattern Matching          │  ← Instant (5-10 exact patterns)
│  ├─ "disk space" → df -h            │
│  ├─ "memory" → top -l 1             │
│  └─ "open slack" → open -a "Slack"  │
└─────────────────────────────────────┘
    ↓ (if no match)
┌─────────────────────────────────────┐
│  Layer 1: Gemini API (OAuth)         │  ← Smart (~200-500ms)
│  ├─ Check rate limit (1500/day)     │
│  ├─ Auto-refresh token if expired   │
│  ├─ Interpret with Gemini 2.0 Flash │
│  └─ Track usage                      │
└─────────────────────────────────────┘
    ↓ (if offline/failed)
┌─────────────────────────────────────┐
│  Layer 2: Local Ollama               │  ← Fallback (offline mode)
│  └─ qwen2:1.5b                       │
└─────────────────────────────────────┘
```

## OAuth Setup (One-Time)

### Prerequisites
✅ Google Cloud Project created (Thinkdrop-Ai)
✅ Gemini API enabled
✅ OAuth credentials downloaded

### How OAuth Works

1. **User clicks "Connect to Gemini"** in ThinkDrop AI
2. **Browser opens** → Google login page
3. **User authorizes** ThinkDrop AI to access Gemini
4. **Token automatically saved** to `~/.thinkdrop/gemini-oauth-token.json`
5. **Auto-refresh** when token expires (no re-login needed)

## Setup Instructions

### 1. Start OAuth Flow

**Via API:**

```bash
curl -X POST http://localhost:3007/gemini.oauth.start \
  -H "Authorization: q6E53kWzIGoxkohxuih3A4xVS06PZn1I" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "gemini.oauth.start",
    "payload": {}
  }'
```

**What happens:**
1. Browser opens automatically
2. You see Google login page
3. Authorize "ThinkDrop AI" to access Gemini
4. Browser shows "✅ Authentication Successful!"
5. Token saved automatically

### 2. Verify Setup

Check Gemini status:

```bash
curl -X POST http://localhost:3007/gemini.status \
  -H "Authorization: q6E53kWzIGoxkohxuih3A4xVS06PZn1I" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "gemini.status",
    "payload": {}
  }'
```

Expected response:
```json
{
  "success": true,
  "gemini": {
    "enabled": true,
    "authenticated": true,
    "model": "gemini-2.0-flash-exp",
    "hasToken": true,
    "tokenExpiry": "2025-11-08T12:00:00.000Z",
    "tokenValid": true
  },
  "usage": {
    "date": "2025-11-07",
    "count": 0,
    "limit": 1500,
    "remaining": 1500,
    "percentage": 0
  }
}
```

### 3. Test Command Interpretation

Try a command:

```bash
# In your ThinkDrop AI app, type:
"how much memory on my computer"
```

Check logs to see which layer handled it:
```bash
tail -f logs/command.log | grep "interpretation"
```

You should see:
```
Command interpreted by Gemini (usage: 1/1500)
```

## Token Management

### Token Storage
- **Location**: `~/.thinkdrop/gemini-oauth-token.json`
- **Format**: Encrypted OAuth 2.0 token
- **Contains**: Access token, refresh token, expiry date

### Auto-Refresh
- Tokens expire after ~1 hour
- Automatically refreshed before expiry
- No user interaction needed
- Uses refresh token (valid for months)

### Revoke Access

To disconnect Gemini:

```bash
curl -X POST http://localhost:3007/gemini.oauth.revoke \
  -H "Authorization: q6E53kWzIGoxkohxuih3A4xVS06PZn1I" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "gemini.oauth.revoke",
    "payload": {}
  }'
```

This will:
1. Revoke the token with Google
2. Delete local token file
3. Require re-authentication for next use

## Usage Monitoring

### Check Usage Status

```bash
curl -X POST http://localhost:3007/usage.status \
  -H "Authorization: q6E53kWzIGoxkohxuih3A4xVS06PZn1I" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "usage.status",
    "payload": {}
  }'
```

### Usage Limits

- **Free Tier**: 1,500 requests/day
- **Warning Threshold**: 66% (990 requests)
- **Reset**: Midnight UTC
- **Automatic Fallback**: Uses Ollama when limit reached

## Privacy & Security

### What Google Sees
- ✅ **Query**: "how much memory on my computer"
- ❌ **NOT command output**: "16GB used, 8GB free"

### What's Stored Locally
- OAuth tokens in `~/.thinkdrop/gemini-oauth-token.json`
- Usage statistics in `~/.thinkdrop/gemini-usage.json`

### Security Features
- Tokens stored locally (not in cloud)
- Auto-refresh (no password re-entry)
- Scoped permissions (only Gemini API access)
- Revocable anytime

## Troubleshooting

### OAuth Flow Fails

**Problem**: Browser doesn't open or shows error

**Solutions**:
1. Check credentials file exists:
   ```bash
   ls mcp-services/command-service/client_secret_*.json
   ```

2. Verify redirect URI in Google Cloud Console:
   - Should be: `http://localhost`
   - Port 3000 must be available

3. Check logs:
   ```bash
   tail -f logs/command.log | grep OAuth
   ```

### Token Expired

**Problem**: Commands fail with "Gemini not authenticated"

**Solution**: Token auto-refreshes, but if it fails:
```bash
# Revoke and re-authenticate
curl ... /gemini.oauth.revoke
curl ... /gemini.oauth.start
```

### Rate Limit Reached

**Problem**: "Gemini daily limit reached"

**Solution**:
- Wait until midnight UTC for reset
- Service automatically falls back to Ollama
- Check usage: `curl ... /usage.status`

### Offline Mode

**Problem**: No internet connection

**Solution**:
- Service automatically detects offline state
- Falls back to local Ollama
- No configuration needed

## API Endpoints

### `gemini.oauth.start`
Start OAuth flow and open browser for authentication

**Request:**
```json
{
  "action": "gemini.oauth.start",
  "payload": {}
}
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully authenticated with Google Gemini",
  "status": {
    "authenticated": true,
    "tokenExpiry": "2025-11-08T12:00:00.000Z"
  }
}
```

### `gemini.oauth.revoke`
Revoke OAuth token and disconnect

**Request:**
```json
{
  "action": "gemini.oauth.revoke",
  "payload": {}
}
```

### `gemini.status`
Get authentication and usage status

**Request:**
```json
{
  "action": "gemini.status",
  "payload": {}
}
```

### `usage.status`
Get current usage statistics

**Request:**
```json
{
  "action": "usage.status",
  "payload": {}
}
```

## Comparison: OAuth vs API Key

| Feature | OAuth (Current) | API Key (Old) |
|---------|----------------|---------------|
| Setup | One-click | Manual copy/paste |
| Security | Scoped, revocable | Full access |
| Expiry | Auto-refresh | Never expires |
| User Experience | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| Implementation | Complex | Simple |

## Files Created

- `~/.thinkdrop/gemini-oauth-token.json` - OAuth tokens
- `~/.thinkdrop/gemini-usage.json` - Usage tracking
- `client_secret_*.json` - OAuth credentials (gitignored)

## Next Steps

1. **Test OAuth flow**: Run `gemini.oauth.start`
2. **Try commands**: "how much memory on my computer"
3. **Monitor usage**: Check `usage.status` endpoint
4. **Integrate UI**: Add "Connect to Gemini" button in app

Enjoy seamless, intelligent command interpretation! 🚀
