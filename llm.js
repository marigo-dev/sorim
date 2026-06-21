const axios = require('axios');

const USE_LLM = process.env.USE_LLM !== 'false';
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (USE_LLM ? 'ollama' : 'none')).toLowerCase();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.LLM_MODEL || 'qwen3:4b';

const OPENAI_BASE_URL = stripTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4.1-mini';

async function askForAction({ level, observation, allowedActions }) {
    if (!USE_LLM || LLM_PROVIDER === 'none') return null;

    const prompt = buildPrompt(level, observation, allowedActions);
    try {
        if (LLM_PROVIDER === 'ollama') {
            return await askOllama(prompt);
        }

        if (LLM_PROVIDER === 'openai' || LLM_PROVIDER === 'openai-compatible') {
            return await askOpenAiCompatible(prompt);
        }

        console.log(`[LLM] Unknown provider "${LLM_PROVIDER}", using fallback.`);
        return null;
    } catch (error) {
        console.log(`[LLM] Could not get a decision, using fallback: ${error.message}`);
        return null;
    }
}

async function askOllama(prompt) {
    const response = await axios.post(OLLAMA_URL, {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
            temperature: 0.1,
            num_predict: 120
        }
    }, {
        timeout: Number(process.env.LLM_TIMEOUT_MS || 12000)
    });

    return parseJson(response.data?.response || '');
}

async function askOpenAiCompatible(prompt) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for the openai-compatible provider');
    }

    const response = await axios.post(`${OPENAI_BASE_URL}/chat/completions`, {
        model: OPENAI_MODEL,
        messages: [
            {
                role: 'system',
                content: 'You select actions for a Minecraft bot. Return only valid JSON.'
            },
            {
                role: 'user',
                content: prompt
            }
        ],
        temperature: 0.1,
        max_tokens: 120
    }, {
        timeout: Number(process.env.LLM_TIMEOUT_MS || 12000),
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    return parseJson(response.data?.choices?.[0]?.message?.content || '');
}

function buildPrompt(level, observation, allowedActions) {
    return [
        'You are the decision selector for a Minecraft bot.',
        'Return only JSON. Do not write explanations.',
        `Level: ${level.id}`,
        `Goal: ${level.goal}`,
        `Allowed actions: ${allowedActions.join(', ')}`,
        `Health: ${observation.health}/20`,
        `Food: ${observation.food}/20`,
        `Position: ${JSON.stringify(observation.position)}`,
        `Inventory: ${observation.inventoryText}`,
        `Nearby blocks: ${JSON.stringify(observation.nearbyBlocks.slice(0, 8))}`,
        'Format examples:',
        '{"action":"mine","target":"oak_log"}',
        '{"action":"explore","target":"wood"}',
        '{"action":"craft","item":"oak_planks","count":8}',
        '{"action":"place","item":"crafting_table"}',
        'Decision JSON:'
    ].join('\n');
}

function parseJson(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

function stripTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}

module.exports = {
    askForAction
};
