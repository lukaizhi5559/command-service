/**
 * Smart Model Selector
 * Automatically selects the best Ollama model based on hardware capabilities
 */

const os = require('os');
const { execSync } = require('child_process');

class ModelSelector {
  constructor() {
    this.modelRequirements = {
      'qwen2.5:7b': {
        minRamGB: 8,
        recommendedRamGB: 12,
        modelSizeGB: 4.7,
        description: 'Best quality, slower inference'
      },
      'qwen2.5:3b': {
        minRamGB: 4,
        recommendedRamGB: 6,
        modelSizeGB: 2.0,
        description: 'Good quality, fast inference'
      },
      'qwen2:1.5b': {
        minRamGB: 2,
        recommendedRamGB: 3,
        modelSizeGB: 1.0,
        description: 'Basic quality, very fast'
      }
    };
  }

  /**
   * Get system hardware information
   */
  getHardwareInfo() {
    const totalMemoryGB = os.totalmem() / (1024 ** 3);
    const freeMemoryGB = os.freemem() / (1024 ** 3);
    const cpuCores = os.cpus().length;
    const platform = os.platform();
    
    // Check for GPU availability
    let hasGPU = false;
    let gpuInfo = 'None detected';
    
    try {
      if (platform === 'darwin') {
        // Check for Apple Silicon (Metal GPU)
        const arch = os.arch();
        if (arch === 'arm64') {
          hasGPU = true;
          gpuInfo = 'Apple Silicon (Metal)';
        }
      } else if (platform === 'linux' || platform === 'win32') {
        // Try to detect NVIDIA GPU
        try {
          const nvidiaCheck = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { 
            encoding: 'utf8',
            timeout: 2000 
          }).trim();
          if (nvidiaCheck) {
            hasGPU = true;
            gpuInfo = nvidiaCheck;
          }
        } catch (e) {
          // No NVIDIA GPU
        }
      }
    } catch (error) {
      // GPU detection failed, continue without GPU
    }

    return {
      totalMemoryGB: Math.round(totalMemoryGB * 10) / 10,
      freeMemoryGB: Math.round(freeMemoryGB * 10) / 10,
      cpuCores,
      platform,
      hasGPU,
      gpuInfo,
      arch: os.arch()
    };
  }

  /**
   * Calculate a performance score for the system
   * Higher score = more capable hardware
   */
  calculatePerformanceScore(hwInfo) {
    let score = 0;
    
    // RAM contribution (40% of score)
    score += (hwInfo.totalMemoryGB / 32) * 40; // 32GB = max score
    
    // CPU cores contribution (30% of score)
    score += (hwInfo.cpuCores / 16) * 30; // 16 cores = max score
    
    // GPU contribution (30% of score)
    if (hwInfo.hasGPU) {
      score += 30;
    }
    
    return Math.min(100, score); // Cap at 100
  }

  /**
   * Select the best model based on hardware capabilities
   */
  selectBestModel(envModel = null) {
    const hwInfo = this.getHardwareInfo();
    const score = this.calculatePerformanceScore(hwInfo);
    
    // Use total RAM for decision making (OS will free memory when needed)
    // But ensure at least 2GB is currently free for safety
    const effectiveRAM = Math.min(hwInfo.totalMemoryGB, hwInfo.freeMemoryGB + 6); // Assume 6GB can be freed
    
    console.log('🔍 [MODEL-SELECTOR] Hardware Detection:');
    console.log(`   💾 Total RAM: ${hwInfo.totalMemoryGB} GB`);
    console.log(`   💾 Free RAM: ${hwInfo.freeMemoryGB} GB`);
    console.log(`   💾 Effective RAM: ${Math.round(effectiveRAM * 10) / 10} GB (for model selection)`);
    console.log(`   🖥️  CPU Cores: ${hwInfo.cpuCores}`);
    console.log(`   🎮 GPU: ${hwInfo.gpuInfo}`);
    console.log(`   📊 Performance Score: ${Math.round(score)}/100`);
    
    // If environment variable specifies a model, validate it against hardware
    if (envModel) {
      const requirements = this.modelRequirements[envModel];
      if (requirements) {
        // Use total RAM for validation (more realistic)
        if (hwInfo.totalMemoryGB >= requirements.minRamGB) {
          console.log(`✅ [MODEL-SELECTOR] Using env model: ${envModel} (${requirements.description})`);
          return {
            model: envModel,
            reason: 'specified in environment',
            hwInfo,
            score
          };
        } else {
          console.warn(`⚠️  [MODEL-SELECTOR] Env model ${envModel} requires ${requirements.minRamGB}GB total RAM, but system only has ${hwInfo.totalMemoryGB}GB`);
          console.log('   Falling back to automatic selection...');
        }
      }
    }
    
    // Automatic selection based on total RAM and performance score
    // Use total RAM since OS will free memory when Ollama needs it
    let selectedModel;
    let reason;
    
    if (hwInfo.totalMemoryGB >= 12 && score >= 70) {
      // High-end system: Use 7B model
      selectedModel = 'qwen2.5:7b';
      reason = 'high-end hardware detected';
    } else if (hwInfo.totalMemoryGB >= 6 && score >= 40) {
      // Mid-range system: Use 3B model
      selectedModel = 'qwen2.5:3b';
      reason = 'mid-range hardware detected';
    } else {
      // Low-end system: Use 1.5B model
      selectedModel = 'qwen2:1.5b';
      reason = 'limited hardware detected';
    }
    
    const requirements = this.modelRequirements[selectedModel];
    console.log(`🎯 [MODEL-SELECTOR] Selected: ${selectedModel}`);
    console.log(`   📝 Reason: ${reason}`);
    console.log(`   ℹ️  ${requirements.description}`);
    console.log(`   💾 Model size: ${requirements.modelSizeGB} GB`);
    
    return {
      model: selectedModel,
      reason,
      hwInfo,
      score,
      requirements
    };
  }

  /**
   * Check if a specific model can run on current hardware
   */
  canRunModel(modelName) {
    const hwInfo = this.getHardwareInfo();
    const requirements = this.modelRequirements[modelName];
    
    if (!requirements) {
      console.warn(`⚠️  Unknown model: ${modelName}`);
      return false;
    }
    
    return hwInfo.freeMemoryGB >= requirements.minRamGB;
  }

  /**
   * Get fallback models in order of preference based on hardware
   */
  getFallbackModels() {
    const hwInfo = this.getHardwareInfo();
    const fallbacks = [];
    
    // Build fallback list based on what can run
    for (const [model, requirements] of Object.entries(this.modelRequirements)) {
      if (hwInfo.freeMemoryGB >= requirements.minRamGB) {
        fallbacks.push(model);
      }
    }
    
    // Sort by model size (largest first)
    fallbacks.sort((a, b) => {
      return this.modelRequirements[b].modelSizeGB - this.modelRequirements[a].modelSizeGB;
    });
    
    return fallbacks;
  }
}

module.exports = new ModelSelector();
