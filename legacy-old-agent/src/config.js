const path = require('path');

module.exports = {
    minecraft: {
        host: process.env.MC_HOST || 'localhost',
        port: Number(process.env.MC_PORT || 25565),
        username: process.env.MC_USERNAME || 'marigo',
        version: process.env.MC_VERSION || '1.21'
    },
    ollama: {
        url: process.env.OLLAMA_URL || 'http://localhost:11434/api/generate',
        model: process.env.OLLAMA_MODEL || 'qwen3:4b',
        timeoutMs: 60000,
        keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        contextSize: Number(process.env.OLLAMA_NUM_CTX || 2048)
    },
    agent: {
        tickDelayMs: 1000,
        maxGoalFailures: 3,
        maxPlanDepth: 12,
        memoryFile: process.env.MEMORY_FILE ||
            path.join(__dirname, '..', 'data', 'world-memory.json')
    }
};
