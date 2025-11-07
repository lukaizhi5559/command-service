/**
 * GeminiOAuthClient
 * 
 * OAuth-based client for Google Gemini API to interpret natural language commands
 * into shell commands. Uses OAuth 2.0 for authentication.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const logger = require('./logger.cjs');

// Dynamic import for ESM-only 'open' package
let openBrowser;
(async () => {
  openBrowser = (await import('open')).default;
})();

class GeminiOAuthClient {
  constructor(config = {}) {
    this.configDir = config.configDir || path.join(process.env.HOME || process.env.USERPROFILE, '.thinkdrop');
    this.tokenFile = path.join(this.configDir, 'gemini-oauth-token.json');
    this.credentialsFile = config.credentialsFile || path.join(__dirname, '..', 'client_secret_133113569188-toktpk62h6ju47k62992aod9ri8o3kov.apps.googleusercontent.com.json');
    this.model = config.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';
    this.enabled = config.enabled !== false;
    
    this.oauth2Client = null;
    this.client = null;
    this.credentials = null;
    this.callbackServer = null; // Track the callback server
    
    // Load OAuth credentials
    this._loadCredentials();
    
    // Load existing token if available
    this._loadToken();
    
    logger.info('GeminiOAuthClient initialized', {
      enabled: this.enabled,
      hasToken: !!this.oauth2Client?.credentials?.access_token,
      model: this.model
    });
  }
  
  /**
   * Load OAuth credentials from file
   * @private
   */
  _loadCredentials() {
    try {
      if (fs.existsSync(this.credentialsFile)) {
        const content = fs.readFileSync(this.credentialsFile, 'utf8');
        const credentials = JSON.parse(content);
        
        // Support both "installed" and "web" application types
        this.credentials = credentials.installed || credentials.web;
        
        if (!this.credentials) {
          throw new Error('Invalid credentials file format');
        }
        
        // Create OAuth2 client
        this.oauth2Client = new OAuth2Client(
          this.credentials.client_id,
          this.credentials.client_secret,
          this.credentials.redirect_uris[0]
        );
        
        logger.info('OAuth credentials loaded', {
          clientId: this.credentials.client_id.substring(0, 20) + '...'
        });
      } else {
        logger.warn('OAuth credentials file not found', {
          path: this.credentialsFile
        });
      }
    } catch (error) {
      logger.error('Failed to load OAuth credentials', { error: error.message });
    }
  }
  
  /**
   * Load saved token from disk
   * @private
   */
  _loadToken() {
    try {
      // Load OAuth tokens
      if (fs.existsSync(this.tokenFile)) {
        const token = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        
        if (this.oauth2Client) {
          this.oauth2Client.setCredentials(token);
          logger.info('OAuth token loaded from disk');
        }
      }
      
      // Load API key and initialize Gemini client
      const apiKeyFile = path.join(this.configDir, 'gemini-api-key.txt');
      if (fs.existsSync(apiKeyFile)) {
        const apiKey = fs.readFileSync(apiKeyFile, 'utf8').trim();
        if (apiKey) {
          this.client = new GoogleGenerativeAI(apiKey);
          logger.info('Gemini API key loaded from disk');
        }
      }
    } catch (error) {
      logger.warn('Failed to load OAuth token or API key', { error: error.message });
    }
  }
  
  /**
   * Save token to disk
   * @private
   */
  _saveToken(token) {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      
      fs.writeFileSync(this.tokenFile, JSON.stringify(token, null, 2), 'utf8');
      logger.info('OAuth token saved to disk');
    } catch (error) {
      logger.error('Failed to save OAuth token', { error: error.message });
    }
  }
  
  /**
   * Check if client is available and authenticated
   * @returns {boolean}
   */
  isAvailable() {
    return this.enabled && 
           !!this.oauth2Client && 
           !!this.oauth2Client.credentials?.access_token;
  }
  
  /**
   * Start OAuth flow
   * Opens browser for user to authenticate
   * @returns {Promise<Object>} - { success, authUrl, error }
   */
  async startOAuthFlow() {
    if (!this.oauth2Client) {
      return {
        success: false,
        error: 'OAuth client not initialized. Check credentials file.'
      };
    }
    
    try {
      // Generate auth URL
      const authUrl = this.oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/generative-language.retriever'],
        prompt: 'consent'
      });
      
      logger.info('Starting OAuth flow', { authUrl });
      
      // Start local server to receive callback
      const { code, error } = await this._startCallbackServer();
      
      if (error) {
        return {
          success: false,
          error
        };
      }
      
      // Exchange code for tokens
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);
      this._saveToken(tokens);
      
      // Create or retrieve API key using OAuth token
      const apiKey = await this._getOrCreateApiKey(tokens);
      
      if (!apiKey) {
        throw new Error('Failed to create Gemini API key');
      }
      
      // Initialize Gemini client with the API key
      this.client = new GoogleGenerativeAI(apiKey);
      
      // Save API key locally as backup
      await this._saveApiKeyToFile(apiKey);
      
      logger.info('OAuth flow completed successfully with API key');
      
      // Return API key and tokens to main app for centralized storage
      return {
        success: true,
        message: 'Successfully authenticated with Google Gemini',
        apiKey: apiKey,
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date,
          scope: tokens.scope
        }
      };
      
    } catch (error) {
      logger.error('OAuth flow failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Start local HTTP server to receive OAuth callback
   * @private
   */
  _startCallbackServer() {
    return new Promise((resolve, reject) => {
      // Close existing server if any
      if (this.callbackServer) {
        try {
          this.callbackServer.close();
          this.callbackServer = null;
        } catch (err) {
          logger.warn('Failed to close existing callback server', { error: err.message });
        }
      }
      
      const server = http.createServer(async (req, res) => {
        const queryParams = url.parse(req.url, true).query;
        
        if (queryParams.code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>✅ Authentication Successful!</h1>
                <p>You can close this window and return to ThinkDrop AI.</p>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body>
            </html>
          `);
          
          this.callbackServer = null;
          server.close();
          resolve({ code: queryParams.code });
        } else if (queryParams.error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>❌ Authentication Failed</h1>
                <p>Error: ${queryParams.error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          
          this.callbackServer = null;
          server.close();
          resolve({ error: queryParams.error });
        }
      });
      
      // Handle server errors
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.error('Port 3000 already in use. Please close the other process or wait a moment.');
          reject(new Error('OAuth callback server port 3000 is already in use. Please try again in a moment.'));
        } else {
          logger.error('Callback server error', { error: err.message });
          reject(err);
        }
      });
      
      this.callbackServer = server;
      
      server.listen(3000, async () => {
        const authUrl = this.oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: [
            'https://www.googleapis.com/auth/cloud-platform', // For creating API keys
            'https://www.googleapis.com/auth/generative-language.retriever' // For Gemini
          ],
          prompt: 'consent'
        });
        
        logger.info('OAuth callback server started on port 3000');
        logger.info('Opening browser for authentication...');
        
        // Open browser (wait for dynamic import if needed)
        if (!openBrowser) {
          openBrowser = (await import('open')).default;
        }
        await openBrowser(authUrl);
      });
    });
  }
  
  /**
   * Get or create API key using OAuth token
   * @private
   */
  async _getOrCreateApiKey(tokens) {
    try {
      // Check if we already have a saved API key locally
      const apiKeyFile = path.join(this.configDir, 'gemini-api-key.txt');
      if (fs.existsSync(apiKeyFile)) {
        const savedKey = fs.readFileSync(apiKeyFile, 'utf8').trim();
        if (savedKey) {
          logger.info('Using existing Gemini API key from local file');
          return savedKey;
        }
      }
      
      // Create API Keys client with OAuth credentials
      const auth = new google.auth.OAuth2();
      auth.setCredentials(tokens);
      
      const apikeys = google.apikeys({ version: 'v2', auth });
      
      // List existing API keys for this project
      const projectId = this.credentials.project_id;
      const parent = `projects/${projectId}/locations/global`;
      
      logger.info('Checking for existing Gemini API keys...');
      
      try {
        const listResponse = await apikeys.projects.locations.keys.list({ parent });
        
        // Look for an existing Gemini API key
        if (listResponse.data.keys && listResponse.data.keys.length > 0) {
          for (const key of listResponse.data.keys) {
            if (key.displayName && key.displayName.includes('ThinkDrop')) {
              logger.info('Found existing ThinkDrop API key');
              // Get the key string
              const keyString = await apikeys.projects.locations.keys.getKeyString({
                name: key.name
              });
              return keyString.data.keyString;
            }
          }
        }
      } catch (listError) {
        logger.warn('Could not list API keys, will create new one', { error: listError.message });
      }
      
      // Create a new API key
      logger.info('Creating new Gemini API key...');
      const createResponse = await apikeys.projects.locations.keys.create({
        parent,
        requestBody: {
          displayName: 'ThinkDrop AI - Gemini',
          restrictions: {
            apiTargets: [{
              service: 'generativelanguage.googleapis.com'
            }]
          }
        }
      });
      
      // The response contains the key directly (not a long-running operation)
      const key = createResponse.data;
      logger.info('API key created', { keyName: key.name });
      
      // Get the key string
      const keyString = await apikeys.projects.locations.keys.getKeyString({
        name: key.name
      });
      
      logger.info('Gemini API key created successfully');
      return keyString.data.keyString;
      
    } catch (error) {
      logger.error('Failed to get/create API key', { error: error.message, stack: error.stack });
      return null;
    }
  }
  
  /**
   * Save API key to file as local backup
   * @private
   */
  async _saveApiKeyToFile(apiKey) {
    try {
      const apiKeyFile = path.join(this.configDir, 'gemini-api-key.txt');
      fs.writeFileSync(apiKeyFile, apiKey, 'utf8');
      logger.info('API key backed up to file');
    } catch (error) {
      logger.error('Failed to save API key to file', { error: error.message });
    }
  }
  
  /**
   * Refresh access token if expired
   * @private
   */
  async _refreshTokenIfNeeded() {
    if (!this.oauth2Client?.credentials) {
      return false;
    }
    
    try {
      // Check if token is expired
      const now = Date.now();
      const expiryDate = this.oauth2Client.credentials.expiry_date;
      
      if (expiryDate && now >= expiryDate - 60000) { // Refresh 1 min before expiry
        logger.info('Access token expired, refreshing...');
        
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);
        this._saveToken(credentials);
        
        // Update Gemini client with new token
        this.client = new GoogleGenerativeAI(credentials.access_token);
        
        logger.info('Access token refreshed');
        return true;
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to refresh token', { error: error.message });
      return false;
    }
  }
  
  /**
   * Interpret natural language command into shell command
   * @param {string} naturalCommand - Natural language command
   * @param {string} os - Operating system (darwin, linux, win32)
   * @param {Object} context - Additional context
   * @returns {Promise<Object>} - { success, command, explanation, error }
   */
  async interpretCommand(naturalCommand, os = 'darwin', context = {}) {
    if (!this.isAvailable()) {
      return {
        success: false,
        error: 'Gemini not authenticated. Please run OAuth flow.'
      };
    }
    
    // Refresh token if needed
    await this._refreshTokenIfNeeded();
    
    try {
      const model = this.client.getGenerativeModel({ model: this.model });
      
      const prompt = this._buildCommandPrompt(naturalCommand, os, context);
      
      logger.debug('Sending command to Gemini', { naturalCommand, os });
      
      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      
      // Parse response
      const parsed = this._parseResponse(text);
      
      if (!parsed.command) {
        logger.warn('Gemini returned no command', { naturalCommand, response: text });
        return {
          success: false,
          error: 'Could not interpret command'
        };
      }
      
      logger.info('Command interpreted by Gemini', {
        naturalCommand,
        shellCommand: parsed.command
      });
      
      return {
        success: true,
        command: parsed.command,
        explanation: parsed.explanation || null
      };
      
    } catch (error) {
      logger.error('Gemini command interpretation failed', {
        error: error.message,
        naturalCommand
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Build prompt for command interpretation
   * @private
   */
  _buildCommandPrompt(naturalCommand, os, context) {
    const osSpecific = {
      darwin: {
        name: 'macOS',
        examples: [
          'Open app: open -a "AppName"',
          'Close app: osascript -e \'quit app "AppName"\'',
          'List apps: ps aux | grep -i ".app/Contents/MacOS" | grep -v grep',
          'Memory: top -l 1 | grep PhysMem',
          'Disk: df -h',
          'Battery: pmset -g batt'
        ]
      },
      linux: {
        name: 'Linux',
        examples: [
          'Open app: xdg-open AppName',
          'Memory: free -h',
          'Disk: df -h',
          'Processes: ps aux'
        ]
      },
      win32: {
        name: 'Windows',
        examples: [
          'Open app: start AppName',
          'Memory: systeminfo | findstr Memory',
          'Disk: wmic logicaldisk get size,freespace,caption'
        ]
      }
    };
    
    const osInfo = osSpecific[os] || osSpecific.darwin;
    
    return `You are a shell command expert for ${osInfo.name}. Convert natural language to shell commands.

CRITICAL RULES:
1. Output ONLY the shell command - NO explanations, NO markdown, NO code blocks
2. If you need to explain, put it on a separate line starting with "EXPLANATION:"
3. Use safe, read-only commands when possible
4. For app names, use exact capitalization (e.g., "Google Chrome", not "chrome")

COMMON PATTERNS FOR ${osInfo.name}:
${osInfo.examples.map(ex => `- ${ex}`).join('\n')}

USER REQUEST:
"${naturalCommand}"

OUTPUT FORMAT:
[shell command here]
EXPLANATION: [optional brief explanation]

COMMAND:`;
  }
  
  /**
   * Parse Gemini response to extract command and explanation
   * @private
   */
  _parseResponse(text) {
    if (!text) return { command: null, explanation: null };
    
    const lines = text.trim().split('\n').filter(line => line.trim());
    
    let command = null;
    let explanation = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip markdown code blocks
      if (trimmed.startsWith('```')) continue;
      
      // Extract explanation
      if (trimmed.startsWith('EXPLANATION:')) {
        explanation = trimmed.replace('EXPLANATION:', '').trim();
        continue;
      }
      
      // Skip common non-command phrases
      if (trimmed.startsWith('Here') || 
          trimmed.startsWith('This') || 
          trimmed.startsWith('The command') ||
          trimmed.startsWith('Note:') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('#')) {
        continue;
      }
      
      // First non-comment, non-explanation line is the command
      if (!command && trimmed.length > 0) {
        command = trimmed;
      }
    }
    
    return { command, explanation };
  }
  
  /**
   * Test connection to Gemini API
   * @returns {Promise<Object>}
   */
  async testConnection() {
    if (!this.isAvailable()) {
      return {
        success: false,
        error: 'Gemini not authenticated'
      };
    }
    
    await this._refreshTokenIfNeeded();
    
    try {
      const model = this.client.getGenerativeModel({ model: this.model });
      const result = await model.generateContent('Say "OK" if you can read this.');
      const text = result.response.text();
      
      logger.info('Gemini connection test passed');
      
      return {
        success: true,
        response: text
      };
    } catch (error) {
      logger.error('Gemini connection test failed', { error: error.message });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get configuration status
   * @returns {Object}
   */
  getStatus() {
    const hasToken = !!this.oauth2Client?.credentials?.access_token;
    const tokenExpiry = this.oauth2Client?.credentials?.expiry_date;
    
    return {
      enabled: this.enabled,
      authenticated: this.isAvailable(),
      model: this.model,
      tokenFile: this.tokenFile,
      hasToken,
      tokenExpiry: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
      tokenValid: hasToken && (!tokenExpiry || Date.now() < tokenExpiry)
    };
  }
  
  /**
   * Revoke OAuth token and clear credentials
   * @returns {Promise<Object>}
   */
  async revokeToken() {
    try {
      if (this.oauth2Client?.credentials?.access_token) {
        await this.oauth2Client.revokeCredentials();
      }
      
      // Clear token file
      if (fs.existsSync(this.tokenFile)) {
        fs.unlinkSync(this.tokenFile);
      }
      
      this.oauth2Client.setCredentials({});
      this.client = null;
      
      logger.info('OAuth token revoked');
      
      return {
        success: true,
        message: 'Token revoked successfully'
      };
    } catch (error) {
      logger.error('Failed to revoke token', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = GeminiOAuthClient;
