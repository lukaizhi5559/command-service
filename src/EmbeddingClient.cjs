/**
 * Embedding Client
 * Calls the Phi4 service to generate embeddings for command interpretation
 */

const logger = require('./logger.cjs');

class EmbeddingClient {
  constructor(phi4ServiceUrl = 'http://localhost:3002') {
    this.phi4ServiceUrl = phi4ServiceUrl;
  }

  /**
   * Generate embedding for text using Phi4 service
   * @param {string} text - Text to generate embedding for
   * @returns {Promise<number[]>} - Embedding vector
   */
  async generateEmbedding(text) {
    try {
      const response = await fetch(`${this.phi4ServiceUrl}/api/embedding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: 'mcp.v1',
          method: 'embedding.generate',
          payload: {
            text,
            options: {
              pooling: 'mean',
              normalize: true
            }
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding service returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      // Extract embedding array from response
      const embedding = result.data?.embedding || result.embedding;
      
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Invalid embedding response format');
      }

      return embedding;
    } catch (error) {
      logger.error('Failed to generate embedding:', error.message);
      throw error;
    }
  }
}

module.exports = EmbeddingClient;
