/**
 * CommandInterpreter
 * Fast, reliable command interpretation using:
 *  1. Pattern matching (10-50ms) - 90% of commands
 *  2. Embedding similarity (100-300ms) - 10% of commands
 * 
 * Replaces slow, unreliable Ollama LLM calls (500-2000ms)
 */

const logger = require('./logger.cjs');

class CommandInterpreter {
  constructor(options = {}) {
    this.platform = options.platform || (process.platform === 'win32' ? 'windows' : 'mac');
    this.generateEmbeddingFn = options.generateEmbedding;
    this.similarityThreshold = options.similarityThreshold || 0.75;
    this.seedMappings = this.loadCommandMappings();
    
    // Cache for embeddings to avoid recomputation
    this.embeddingCache = new Map();
    
    logger.info(`CommandInterpreter initialized for platform: ${this.platform}`);
  }

  /**
   * Main entry point - tries pattern matching first, then model fallback
   */
  async interpretCommand(naturalLanguage, context = {}) {
    const startTime = Date.now();
    
    // 1️⃣ Try pattern matching first (10-50ms) - handles 90% of commands
    const patternMatch = this.tryPatternMatch(naturalLanguage, context);
    if (patternMatch.success) {
      const elapsed = Date.now() - startTime;
      logger.debug(`✅ Pattern matched in ${elapsed}ms: "${naturalLanguage}" → ${patternMatch.shellCommand}`);
      return patternMatch;
    }
    
    // 2️⃣ Fallback to embedding similarity (100-300ms) - handles 10% of commands
    if (this.generateEmbeddingFn) {
      const modelMatch = await this.fallbackToModel(naturalLanguage, context);
      const elapsed = Date.now() - startTime;
      
      if (modelMatch.success) {
        logger.debug(`✅ Model matched in ${elapsed}ms: "${naturalLanguage}" → ${modelMatch.shellCommand}`);
        return modelMatch;
      }
      
      logger.warn(`❌ No match found in ${elapsed}ms: "${naturalLanguage}" (best score: ${modelMatch.confidence?.toFixed(3)})`);
      return modelMatch;
    }
    
    // 3️⃣ No embedding function provided - return error
    return {
      success: false,
      error: 'Could not interpret command - no pattern match and no embedding model available',
      confidence: 0
    };
  }

  /**
   * Pattern matching layer - instant recognition (10-50ms)
   */
  tryPatternMatch(naturalLanguage, context = {}) {
    const lower = naturalLanguage.toLowerCase().trim();
    
    // ══════════════════════════════════════════════════════════════════════════
    // 🚀 PATTERN MATCHING - Instant command recognition
    // ══════════════════════════════════════════════════════════════════════════
    
    // ── OPEN APPS ─────────────────────────────────────────────────────────────
    // Match: "open slack", "launch chrome", "start vscode"
    const openAppMatch = lower.match(/^(open|launch|start)\s+(.+)$/i);
    if (openAppMatch) {
      const app = openAppMatch[2].trim();
      const shellCommand = this.platform === 'mac' 
        ? `open -a "${this.capitalizeApp(app)}"`
        : `start "" "${app}"`;
      
      return {
        success: true,
        shellCommand,
        category: 'app_control',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── OPEN FOLDERS ──────────────────────────────────────────────────────────
    // Match: "open downloads", "open desktop folder", "show my documents"
    if (/^(open|show)\s+(my\s+)?(downloads?|desktop|documents?|home)(\s+folder)?$/i.test(lower)) {
      const folder = lower.match(/(downloads?|desktop|documents?|home)/i)[1];
      const folderMap = {
        'download': '~/Downloads',
        'downloads': '~/Downloads',
        'desktop': '~/Desktop',
        'document': '~/Documents',
        'documents': '~/Documents',
        'home': '~'
      };
      
      const path = folderMap[folder];
      const shellCommand = this.platform === 'mac'
        ? `open ${path}`
        : `explorer "${path.replace('~', '%USERPROFILE%')}"`;
      
      return {
        success: true,
        shellCommand,
        category: 'folder_navigation',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── LIST FILES ────────────────────────────────────────────────────────────
    // Match: "list files in downloads", "show all files in desktop directory"
    const listFilesMatch = lower.match(/^(list|show)\s+(all\s+)?(files?|folders?|items?)\s+in\s+(.+)$/i);
    if (listFilesMatch) {
      const path = listFilesMatch[4].trim();
      const resolvedPath = this.resolvePath(path);
      const shellCommand = this.platform === 'mac'
        ? `ls -la ${resolvedPath}`
        : `dir "${resolvedPath}"`;
      
      return {
        success: true,
        shellCommand,
        category: 'filesystem',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "list files here", "show all files"
    if (/^(list|show)\s+(all\s+)?(files?|folders?|items?)(\s+here)?$/i.test(lower)) {
      const shellCommand = this.platform === 'mac' ? 'ls -la' : 'dir';
      return {
        success: true,
        shellCommand,
        category: 'filesystem',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── SYSTEM INFO ───────────────────────────────────────────────────────────
    // Match: "show my ip", "what's my ip address"
    if (/^(show|what'?s|get)\s+(my\s+)?(ip|ip\s+address)$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'ipconfig getifaddr en0 || ipconfig getifaddr en1'
        : 'ipconfig';
      
      return {
        success: true,
        shellCommand,
        category: 'network',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "check memory usage", "show ram usage"
    if (/^(check|show|what'?s)\s+(my\s+)?(memory|ram)\s+usage$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'vm_stat | head -n 10'
        : 'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value';
      
      return {
        success: true,
        shellCommand,
        category: 'system_info',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "show disk usage", "check disk space"
    if (/^(check|show|what'?s)\s+(my\s+)?(disk|storage)\s+(usage|space)$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'df -h'
        : 'wmic logicaldisk get size,freespace,caption';
      
      return {
        success: true,
        shellCommand,
        category: 'system_info',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── BATTERY ───────────────────────────────────────────────────────────────
    // Match: "check battery", "how much battery", "is my battery low"
    if (/^(check|show|what'?s|how\s+much)\s+(my\s+)?(battery|power)(\s+(level|status|do\s+i\s+have|power))?$/i.test(lower) ||
        /^is\s+my\s+battery\s+low$/i.test(lower) ||
        /^am\s+i\s+plugged\s+in$/i.test(lower) ||
        /^is\s+my\s+laptop\s+charging$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'pmset -g batt'
        : 'WMIC Path Win32_Battery Get EstimatedChargeRemaining,BatteryStatus';
      
      return {
        success: true,
        shellCommand,
        category: 'system_info',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── WIFI ──────────────────────────────────────────────────────────────────
    // Match: "show wifi name", "what wifi am i connected to"
    if (/^(show|what|what'?s)\s+(my\s+)?(wifi|network)\s+(name|am\s+i\s+connected\s+to)$/i.test(lower) ||
        /^what\s+wifi\s+am\s+i\s+connected\s+to$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'networksetup -getairportnetwork en0'
        : 'netsh wlan show interfaces | findstr "SSID"';
      
      return {
        success: true,
        shellCommand,
        category: 'network',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "scan for wifi", "list wifi networks"
    if (/^(scan|list|show)\s+(for\s+)?(available\s+)?wifi\s+networks?$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'networksetup -listpreferredwirelessnetworks en0'
        : 'netsh wlan show networks';
      
      return {
        success: true,
        shellCommand,
        category: 'network',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "turn wifi on/off", "enable/disable wifi"
    const wifiToggleMatch = lower.match(/^(turn|enable|disable)\s+wifi\s+(on|off)?$/i);
    if (wifiToggleMatch) {
      const action = wifiToggleMatch[1].toLowerCase();
      const state = wifiToggleMatch[2]?.toLowerCase();
      const isOn = action === 'enable' || state === 'on';
      
      const shellCommand = this.platform === 'mac'
        ? `networksetup -setairportpower en0 ${isOn ? 'on' : 'off'}`
        : `netsh interface set interface "Wi-Fi" ${isOn ? 'enabled' : 'disabled'}`;
      
      return {
        success: true,
        shellCommand,
        category: 'network',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── BLUETOOTH ─────────────────────────────────────────────────────────────
    // Match: "show bluetooth devices", "list bluetooth devices"
    if (/^(show|list)\s+(connected\s+)?bluetooth\s+devices?$/i.test(lower) ||
        /^what\s+bluetooth\s+devices\s+are\s+connected$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'system_profiler SPBluetoothDataType'
        : 'powershell "Get-PnpDevice -Class Bluetooth"';
      
      return {
        success: true,
        shellCommand,
        category: 'bluetooth',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "turn bluetooth on/off", "enable/disable bluetooth"
    const bluetoothToggleMatch = lower.match(/^(turn|enable|disable)\s+bluetooth\s+(on|off)?$/i);
    if (bluetoothToggleMatch) {
      const action = bluetoothToggleMatch[1].toLowerCase();
      const state = bluetoothToggleMatch[2]?.toLowerCase();
      const isOn = action === 'enable' || state === 'on';
      
      const shellCommand = this.platform === 'mac'
        ? `blueutil -p ${isOn ? '1' : '0'}`
        : `powershell "${isOn ? 'Enable' : 'Disable'}-PnpDevice -Class Bluetooth -Confirm:$false"`;
      
      return {
        success: true,
        shellCommand,
        category: 'bluetooth',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // ── PROCESS MANAGEMENT ────────────────────────────────────────────────────
    // Match: "show running processes", "list all processes"
    if (/^(show|list)\s+(all\s+)?(running\s+)?processes$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'ps aux | head -n 20'
        : 'tasklist';
      
      return {
        success: true,
        shellCommand,
        category: 'processes',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "close this window", "close current window", "close active window"
    if (/^close\s+(this|current|active)\s+window$/i.test(lower)) {
      const shellCommand = this.platform === 'mac'
        ? 'osascript -e "tell application \\"System Events\\" to keystroke \\"w\\" using command down"'
        : 'powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'%{F4}\')"';
      
      return {
        success: true,
        shellCommand,
        category: 'window_control',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "close all chrome windows", "close all safari windows"
    const closeAllWindowsMatch = lower.match(/^close\s+all\s+(\w+)\s+windows$/i);
    if (closeAllWindowsMatch) {
      const app = closeAllWindowsMatch[1].trim();
      const capitalizedApp = this.capitalizeApp(app);
      const shellCommand = this.platform === 'mac'
        ? `osascript -e "tell application \\"${capitalizedApp}\\" to close every window"`
        : `taskkill /IM ${app}.exe /F`;
      
      return {
        success: true,
        shellCommand,
        category: 'window_control',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "kill chrome", "quit slack", "close firefox"
    const killProcessMatch = lower.match(/^(kill|quit|close|stop)\s+(.+)$/i);
    if (killProcessMatch) {
      const app = killProcessMatch[2].trim();
      
      // Don't match if it's "close window" or similar
      if (app.includes('window') || app.includes('tab')) {
        return { success: false, error: 'No pattern match found', confidence: 0 };
      }
      
      const shellCommand = this.platform === 'mac'
        ? `pkill "${this.capitalizeApp(app)}"`
        : `taskkill /IM ${app}.exe /F`;
      
      return {
        success: true,
        shellCommand,
        category: 'app_control',
        confidence: 0.90,
        method: 'pattern'
      };
    }
    
    // ── UTILITIES ─────────────────────────────────────────────────────────────
    // Match: "clear terminal", "clear screen"
    if (/^clear(\s+terminal|\s+screen)?$/i.test(lower)) {
      const shellCommand = this.platform === 'mac' ? 'clear' : 'cls';
      return {
        success: true,
        shellCommand,
        category: 'utilities',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // Match: "show current directory", "print working directory"
    if (/^(show|print)\s+(current\s+)?(directory|working\s+directory|pwd)$/i.test(lower)) {
      const shellCommand = this.platform === 'mac' ? 'pwd' : 'cd';
      return {
        success: true,
        shellCommand,
        category: 'utilities',
        confidence: 0.95,
        method: 'pattern'
      };
    }
    
    // No pattern match found
    return {
      success: false,
      error: 'No pattern match found',
      confidence: 0
    };
  }

  /**
   * Model-based fallback using embedding similarity (100-300ms)
   */
  async fallbackToModel(naturalLanguage, context = {}) {
    const text = naturalLanguage.trim();
    if (!text) {
      return {
        success: false,
        error: 'Empty command',
        confidence: 0
      };
    }

    const nlEmbedding = await this.generateEmbedding(text);

    let bestMatch = null;
    let bestScore = 0;
    let bestCategory = undefined;

    for (const [category, examples] of Object.entries(this.seedMappings)) {
      for (const example of examples) {
        const exampleEmbedding = await this.generateEmbedding(example.nl);
        const similarity = this.cosineSimilarity(nlEmbedding, exampleEmbedding);

        if (similarity > bestScore) {
          bestScore = similarity;
          bestMatch = example;
          bestCategory = category;
        }
      }
    }

    if (bestMatch && bestScore >= this.similarityThreshold) {
      const shellCommand = this.platform === 'mac'
        ? bestMatch.shell.mac
        : bestMatch.shell.windows;

      return {
        success: true,
        shellCommand,
        category: bestCategory,
        confidence: bestScore,
        method: 'embedding'
      };
    }

    return {
      success: false,
      error: 'Could not interpret command',
      confidence: bestScore
    };
  }

  /**
   * Generate embedding with caching
   */
  async generateEmbedding(text) {
    if (this.embeddingCache.has(text)) {
      return this.embeddingCache.get(text);
    }
    
    const embedding = await this.generateEmbeddingFn(text);
    this.embeddingCache.set(text, embedding);
    
    // Limit cache size to 1000 entries
    if (this.embeddingCache.size > 1000) {
      const firstKey = this.embeddingCache.keys().next().value;
      this.embeddingCache.delete(firstKey);
    }
    
    return embedding;
  }

  /**
   * Cosine similarity calculation
   */
  cosineSimilarity(a, b) {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    
    let dot = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Helper: Capitalize app names for macOS
   */
  capitalizeApp(app) {
    const appMap = {
      'slack': 'Slack',
      'chrome': 'Google Chrome',
      'vscode': 'Visual Studio Code',
      'code': 'Visual Studio Code',
      'finder': 'Finder',
      'terminal': 'Terminal',
      'safari': 'Safari',
      'firefox': 'Firefox',
      'spotify': 'Spotify',
      'discord': 'Discord',
      'zoom': 'zoom.us',
      'notion': 'Notion'
    };
    
    return appMap[app.toLowerCase()] || app.split(' ').map(w => 
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  /**
   * Helper: Resolve common path aliases
   */
  resolvePath(path) {
    const pathMap = {
      'downloads': '~/Downloads',
      'desktop': '~/Desktop',
      'documents': '~/Documents',
      'home': '~',
      'current': '.',
      'here': '.'
    };
    
    return pathMap[path.toLowerCase()] || path;
  }

  /**
   * Load seed mappings for embedding-based matching
   */
  loadCommandMappings() {
    const mappings = {
      // ──────────────────────────────────────────────────────────
      // OPEN APPS / FOLDERS
      // ──────────────────────────────────────────────────────────
      open_app: [
        // Slack
        {
          nl: 'open slack',
          shell: { mac: 'open -a "Slack"', windows: 'start "" "slack"' }
        },
        {
          nl: 'launch slack app',
          shell: { mac: 'open -a "Slack"', windows: 'start "" "slack"' }
        },
        {
          nl: 'start slack',
          shell: { mac: 'open -a "Slack"', windows: 'start "" "slack"' }
        },
        // Chrome
        {
          nl: 'open chrome',
          shell: { mac: 'open -a "Google Chrome"', windows: 'start "" "chrome"' }
        },
        {
          nl: 'launch google chrome',
          shell: { mac: 'open -a "Google Chrome"', windows: 'start "" "chrome"' }
        },
        {
          nl: 'start my browser chrome',
          shell: { mac: 'open -a "Google Chrome"', windows: 'start "" "chrome"' }
        },
        // VS Code
        {
          nl: 'open vscode',
          shell: { mac: 'code .', windows: 'code .' }
        },
        {
          nl: 'start visual studio code',
          shell: { mac: 'code .', windows: 'code .' }
        },
        {
          nl: 'open the current folder in vscode',
          shell: { mac: 'code .', windows: 'code .' }
        },
        // Finder / Explorer
        {
          nl: 'open finder',
          shell: { mac: 'open .', windows: 'explorer .' }
        },
        {
          nl: 'open file explorer',
          shell: { mac: 'open .', windows: 'explorer .' }
        },
        {
          nl: 'show current folder in finder',
          shell: { mac: 'open .', windows: 'explorer .' }
        },
        // Terminal / Command Prompt
        {
          nl: 'open a new terminal window',
          shell: { mac: 'open -a "Terminal" "$(pwd)"', windows: 'start "" cmd.exe' }
        },
        {
          nl: 'open command prompt',
          shell: { mac: 'open -a "Terminal" "$(pwd)"', windows: 'start "" cmd.exe' }
        },
        // Downloads folder
        {
          nl: 'open downloads folder',
          shell: { mac: 'open ~/Downloads', windows: 'explorer "%USERPROFILE%\\Downloads"' }
        },
        {
          nl: 'show my downloads',
          shell: { mac: 'open ~/Downloads', windows: 'explorer "%USERPROFILE%\\Downloads"' }
        },
        // Desktop folder
        {
          nl: 'open desktop folder',
          shell: { mac: 'open ~/Desktop', windows: 'explorer "%USERPROFILE%\\Desktop"' }
        },
        {
          nl: 'show my desktop files',
          shell: { mac: 'open ~/Desktop', windows: 'explorer "%USERPROFILE%\\Desktop"' }
        },
        // Documents folder
        {
          nl: 'open documents folder',
          shell: { mac: 'open ~/Documents', windows: 'explorer "%USERPROFILE%\\Documents"' }
        },
        {
          nl: 'show my documents',
          shell: { mac: 'open ~/Documents', windows: 'explorer "%USERPROFILE%\\Documents"' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // CLOSE APPS / WINDOWS
      // ──────────────────────────────────────────────────────────
      close_app: [
        // Slack
        {
          nl: 'close slack',
          shell: { mac: 'pkill "Slack"', windows: 'taskkill /IM slack.exe /F' }
        },
        {
          nl: 'quit slack',
          shell: { mac: 'pkill "Slack"', windows: 'taskkill /IM slack.exe /F' }
        },
        {
          nl: 'kill slack',
          shell: { mac: 'pkill "Slack"', windows: 'taskkill /IM slack.exe /F' }
        },
        // Chrome
        {
          nl: 'close chrome',
          shell: { mac: 'pkill "Google Chrome"', windows: 'taskkill /IM chrome.exe /F' }
        },
        {
          nl: 'quit chrome',
          shell: { mac: 'pkill "Google Chrome"', windows: 'taskkill /IM chrome.exe /F' }
        },
        {
          nl: 'close google chrome',
          shell: { mac: 'pkill "Google Chrome"', windows: 'taskkill /IM chrome.exe /F' }
        },
        {
          nl: 'kill chrome',
          shell: { mac: 'pkill "Google Chrome"', windows: 'taskkill /IM chrome.exe /F' }
        },
        // VS Code
        {
          nl: 'close vscode',
          shell: { mac: 'pkill "Visual Studio Code"', windows: 'taskkill /IM Code.exe /F' }
        },
        {
          nl: 'quit visual studio code',
          shell: { mac: 'pkill "Visual Studio Code"', windows: 'taskkill /IM Code.exe /F' }
        },
        {
          nl: 'kill vscode',
          shell: { mac: 'pkill "Visual Studio Code"', windows: 'taskkill /IM Code.exe /F' }
        },
        // Safari
        {
          nl: 'close safari',
          shell: { mac: 'pkill "Safari"', windows: 'taskkill /IM safari.exe /F' }
        },
        {
          nl: 'quit safari',
          shell: { mac: 'pkill "Safari"', windows: 'taskkill /IM safari.exe /F' }
        },
        // Firefox
        {
          nl: 'close firefox',
          shell: { mac: 'pkill "Firefox"', windows: 'taskkill /IM firefox.exe /F' }
        },
        {
          nl: 'quit firefox',
          shell: { mac: 'pkill "Firefox"', windows: 'taskkill /IM firefox.exe /F' }
        },
        // Spotify
        {
          nl: 'close spotify',
          shell: { mac: 'pkill "Spotify"', windows: 'taskkill /IM Spotify.exe /F' }
        },
        {
          nl: 'quit spotify',
          shell: { mac: 'pkill "Spotify"', windows: 'taskkill /IM Spotify.exe /F' }
        },
        // Discord
        {
          nl: 'close discord',
          shell: { mac: 'pkill "Discord"', windows: 'taskkill /IM Discord.exe /F' }
        },
        {
          nl: 'quit discord',
          shell: { mac: 'pkill "Discord"', windows: 'taskkill /IM Discord.exe /F' }
        },
        // Zoom
        {
          nl: 'close zoom',
          shell: { mac: 'pkill "zoom.us"', windows: 'taskkill /IM Zoom.exe /F' }
        },
        {
          nl: 'quit zoom',
          shell: { mac: 'pkill "zoom.us"', windows: 'taskkill /IM Zoom.exe /F' }
        },
        // Generic window close
        {
          nl: 'close this window',
          shell: { mac: 'osascript -e "tell application \\"System Events\\" to keystroke \\"w\\" using command down"', windows: 'powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'%{F4}\')"' }
        },
        {
          nl: 'close current window',
          shell: { mac: 'osascript -e "tell application \\"System Events\\" to keystroke \\"w\\" using command down"', windows: 'powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'%{F4}\')"' }
        },
        {
          nl: 'close active window',
          shell: { mac: 'osascript -e "tell application \\"System Events\\" to keystroke \\"w\\" using command down"', windows: 'powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'%{F4}\')"' }
        },
        // Close all windows of app
        {
          nl: 'close all chrome windows',
          shell: { mac: 'osascript -e "tell application \\"Google Chrome\\" to close every window"', windows: 'taskkill /IM chrome.exe /F' }
        },
        {
          nl: 'close all safari windows',
          shell: { mac: 'osascript -e "tell application \\"Safari\\" to close every window"', windows: 'taskkill /IM safari.exe /F' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // LIST FILES / DIRECTORIES
      // ──────────────────────────────────────────────────────────
      list_files: [
        {
          nl: 'list files in current directory',
          shell: { mac: 'ls', windows: 'dir' }
        },
        {
          nl: 'show all files here',
          shell: { mac: 'ls', windows: 'dir' }
        },
        {
          nl: 'list everything here including hidden files',
          shell: { mac: 'ls -la', windows: 'dir /a' }
        },
        {
          nl: 'list all files with details',
          shell: { mac: 'ls -la', windows: 'dir' }
        },
        {
          nl: 'show hidden files in this folder',
          shell: { mac: 'ls -la', windows: 'dir /a' }
        },
        {
          nl: 'list files in downloads directory',
          shell: { mac: 'ls -la ~/Downloads', windows: 'dir "%USERPROFILE%\\Downloads"' }
        },
        {
          nl: 'show my desktop directory contents',
          shell: { mac: 'ls -la ~/Desktop', windows: 'dir "%USERPROFILE%\\Desktop"' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // NAVIGATION (cd)
      // ──────────────────────────────────────────────────────────
      navigation: [
        {
          nl: 'go up one folder',
          shell: { mac: 'cd ..', windows: 'cd ..' }
        },
        {
          nl: 'change directory to downloads',
          shell: { mac: 'cd ~/Downloads', windows: 'cd "%USERPROFILE%\\Downloads"' }
        },
        {
          nl: 'cd to desktop',
          shell: { mac: 'cd ~/Desktop', windows: 'cd "%USERPROFILE%\\Desktop"' }
        },
        {
          nl: 'go to my home directory',
          shell: { mac: 'cd ~', windows: 'cd %USERPROFILE%' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // FILE / FOLDER OPERATIONS
      // ──────────────────────────────────────────────────────────
      file_ops: [
        // create folder
        {
          nl: 'create a folder called temp here',
          shell: { mac: 'mkdir temp', windows: 'mkdir temp' }
        },
        {
          nl: 'make a new folder named test',
          shell: { mac: 'mkdir test', windows: 'mkdir test' }
        },
        // remove folder
        {
          nl: 'delete temp folder',
          shell: { mac: 'rm -rf temp', windows: 'rmdir /s /q temp' }
        },
        {
          nl: 'remove test directory',
          shell: { mac: 'rm -rf test', windows: 'rmdir /s /q test' }
        },
        // create file
        {
          nl: 'create an empty file named notes.txt',
          shell: { mac: 'touch notes.txt', windows: 'type nul > notes.txt' }
        },
        {
          nl: 'make a new file called todo.txt',
          shell: { mac: 'touch todo.txt', windows: 'type nul > todo.txt' }
        },
        // delete file
        {
          nl: 'delete notes.txt file',
          shell: { mac: 'rm notes.txt', windows: 'del notes.txt' }
        },
        {
          nl: 'remove todo.txt',
          shell: { mac: 'rm todo.txt', windows: 'del todo.txt' }
        },
        // copy file
        {
          nl: 'copy config.json to backup.json',
          shell: { mac: 'cp config.json backup.json', windows: 'copy config.json backup.json' }
        },
        // move / rename
        {
          nl: 'rename config.json to config.old.json',
          shell: { mac: 'mv config.json config.old.json', windows: 'ren config.json config.old.json' }
        },
        {
          nl: 'move notes.txt to desktop',
          shell: { mac: 'mv notes.txt ~/Desktop', windows: 'move notes.txt "%USERPROFILE%\\Desktop"' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // SYSTEM INFO
      // ──────────────────────────────────────────────────────────
      system_info: [
        {
          nl: 'show my system info',
          shell: { mac: 'system_profiler SPSoftwareDataType', windows: 'systeminfo' }
        },
        {
          nl: 'what is my operating system version',
          shell: { mac: 'sw_vers', windows: 'systeminfo | findstr /B /C:"OS Name" /C:"OS Version"' }
        },
        {
          nl: 'check cpu usage',
          shell: { mac: 'top -l 1 | head -n 10', windows: 'wmic cpu get loadpercentage' }
        },
        {
          nl: 'show memory usage',
          shell: { mac: 'vm_stat | head -n 10', windows: 'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value' }
        },
        {
          nl: 'show disk usage',
          shell: { mac: 'df -h', windows: 'wmic logicaldisk get size,freespace,caption' }
        },
        // Battery
        {
          nl: 'check battery level',
          shell: { mac: 'pmset -g batt', windows: 'WMIC Path Win32_Battery Get EstimatedChargeRemaining' }
        },
        {
          nl: 'show battery status',
          shell: { mac: 'pmset -g batt', windows: 'WMIC Path Win32_Battery Get EstimatedChargeRemaining,BatteryStatus' }
        },
        {
          nl: 'how much battery do i have',
          shell: { mac: 'pmset -g batt', windows: 'WMIC Path Win32_Battery Get EstimatedChargeRemaining' }
        },
        {
          nl: 'is my battery low',
          shell: { mac: 'pmset -g batt', windows: 'WMIC Path Win32_Battery Get EstimatedChargeRemaining' }
        },
        {
          nl: 'how much battery power do i have',
          shell: { mac: 'pmset -g batt', windows: 'WMIC Path Win32_Battery Get EstimatedChargeRemaining' }
        },
        {
          nl: 'am i plugged in',
          shell: { mac: 'pmset -g batt | grep "AC Power"', windows: 'WMIC Path Win32_Battery Get BatteryStatus' }
        },
        {
          nl: 'is my laptop charging',
          shell: { mac: 'pmset -g batt', windows: 'WMIC Path Win32_Battery Get BatteryStatus' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // NETWORK
      // ──────────────────────────────────────────────────────────
      network: [
        {
          nl: 'show my ip address',
          shell: { mac: 'ipconfig getifaddr en0 || ipconfig getifaddr en1', windows: 'ipconfig' }
        },
        {
          nl: 'check network interfaces',
          shell: { mac: 'ifconfig', windows: 'ipconfig /all' }
        },
        {
          nl: 'ping google',
          shell: { mac: 'ping -c 4 google.com', windows: 'ping -n 4 google.com' }
        },
        {
          nl: 'test my internet connection',
          shell: { mac: 'ping -c 4 8.8.8.8', windows: 'ping -n 4 8.8.8.8' }
        },
        {
          nl: 'traceroute to google',
          shell: { mac: 'traceroute google.com', windows: 'tracert google.com' }
        },
        // WiFi
        {
          nl: 'show wifi name',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show interfaces | findstr "SSID"' }
        },
        {
          nl: 'what wifi am i connected to',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show interfaces | findstr "SSID"' }
        },
        {
          nl: 'show my wifi network',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show interfaces | findstr "SSID"' }
        },
        {
          nl: 'what is my wifi network name',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show interfaces | findstr "SSID"' }
        },
        {
          nl: 'show wifi signal strength',
          shell: { mac: 'system_profiler SPAirPortDataType | grep "Signal"', windows: 'netsh wlan show interfaces | findstr "Signal"' }
        },
        {
          nl: 'scan for wifi networks',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show networks' }
        },
        {
          nl: 'list available wifi networks',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show networks' }
        },
        {
          nl: 'show wifi info',
          shell: { mac: 'system_profiler SPAirPortDataType', windows: 'netsh wlan show interfaces' }
        },
        {
          nl: 'turn wifi off',
          shell: { mac: 'networksetup -setairportpower en0 off', windows: 'netsh interface set interface "Wi-Fi" disabled' }
        },
        {
          nl: 'turn wifi on',
          shell: { mac: 'networksetup -setairportpower en0 on', windows: 'netsh interface set interface "Wi-Fi" enabled' }
        },
        {
          nl: 'disable wifi',
          shell: { mac: 'networksetup -setairportpower en0 off', windows: 'netsh interface set interface "Wi-Fi" disabled' }
        },
        {
          nl: 'enable wifi',
          shell: { mac: 'networksetup -setairportpower en0 on', windows: 'netsh interface set interface "Wi-Fi" enabled' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // BLUETOOTH
      // ──────────────────────────────────────────────────────────
      bluetooth: [
        {
          nl: 'show bluetooth devices',
          shell: { mac: 'system_profiler SPBluetoothDataType', windows: 'powershell "Get-PnpDevice -Class Bluetooth"' }
        },
        {
          nl: 'list bluetooth devices',
          shell: { mac: 'system_profiler SPBluetoothDataType', windows: 'powershell "Get-PnpDevice -Class Bluetooth"' }
        },
        {
          nl: 'show connected bluetooth devices',
          shell: { mac: 'system_profiler SPBluetoothDataType | grep -A 10 "Connected:"', windows: 'powershell "Get-PnpDevice -Class Bluetooth | Where-Object {$_.Status -eq \'OK\'}"' }
        },
        {
          nl: 'what bluetooth devices are connected',
          shell: { mac: 'system_profiler SPBluetoothDataType | grep -A 10 "Connected:"', windows: 'powershell "Get-PnpDevice -Class Bluetooth | Where-Object {$_.Status -eq \'OK\'}"' }
        },
        {
          nl: 'turn bluetooth off',
          shell: { mac: 'blueutil -p 0', windows: 'powershell "Disable-PnpDevice -Class Bluetooth -Confirm:$false"' }
        },
        {
          nl: 'turn bluetooth on',
          shell: { mac: 'blueutil -p 1', windows: 'powershell "Enable-PnpDevice -Class Bluetooth -Confirm:$false"' }
        },
        {
          nl: 'disable bluetooth',
          shell: { mac: 'blueutil -p 0', windows: 'powershell "Disable-PnpDevice -Class Bluetooth -Confirm:$false"' }
        },
        {
          nl: 'enable bluetooth',
          shell: { mac: 'blueutil -p 1', windows: 'powershell "Enable-PnpDevice -Class Bluetooth -Confirm:$false"' }
        },
        {
          nl: 'check bluetooth status',
          shell: { mac: 'blueutil -p', windows: 'powershell "Get-PnpDevice -Class Bluetooth | Select-Object Status"' }
        },
        {
          nl: 'is bluetooth on',
          shell: { mac: 'blueutil -p', windows: 'powershell "Get-PnpDevice -Class Bluetooth | Select-Object Status"' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // PROCESS MANAGEMENT
      // ──────────────────────────────────────────────────────────
      processes: [
        {
          nl: 'show running processes',
          shell: { mac: 'ps aux | head -n 20', windows: 'tasklist' }
        },
        {
          nl: 'list all processes',
          shell: { mac: 'ps aux', windows: 'tasklist' }
        },
        {
          nl: 'kill chrome process',
          shell: { mac: 'pkill "Google Chrome"', windows: 'taskkill /IM chrome.exe /F' }
        },
        {
          nl: 'force quit slack',
          shell: { mac: 'pkill "Slack"', windows: 'taskkill /IM slack.exe /F' }
        }
      ],

      // ──────────────────────────────────────────────────────────
      // UTILITIES / MISC
      // ──────────────────────────────────────────────────────────
      utilities: [
        {
          nl: 'clear the terminal',
          shell: { mac: 'clear', windows: 'cls' }
        },
        {
          nl: 'print current directory',
          shell: { mac: 'pwd', windows: 'cd' }
        },
        {
          nl: 'show current date and time',
          shell: { mac: 'date', windows: 'echo %DATE% %TIME%' }
        },
        {
          nl: 'show environment variables',
          shell: { mac: 'env', windows: 'set' }
        },
        {
          nl: 'show shell history',
          shell: { mac: 'history', windows: 'doskey /history' }
        }
      ]
    };

    return mappings;
  }
}

module.exports = CommandInterpreter;
