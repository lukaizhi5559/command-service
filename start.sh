#!/bin/bash

# Command Service Startup Script
# Starts the Command MCP service with health checks

set -e

echo "🚀 Starting Command Service..."

# Check if Ollama is running
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "❌ Ollama is not running!"
  echo "   Please start Ollama first:"
  echo "   $ ollama serve"
  exit 1
fi

# Check if llama3.2:latest model is available
if ! ollama list | grep -q "llama3.2:latest"; then
  echo "⚠️  llama3.2:latest model not found"
  echo "   Pulling model (this may take a few minutes)..."
  ollama pull llama3.2:latest
fi

# Check if .env exists
if [ ! -f .env ]; then
  echo "📝 Creating .env from .env.example..."
  cp .env.example .env
fi

# Start the service
echo "✅ Starting HTTP server on port 3007..."
npm start
