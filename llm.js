const axios = require('axios');

const USE_LLM = process.env.USE_LLM !== 'false';
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (USE_LLM ? 'ollama' : 'none')).toLowerCase();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.LLM_MODEL || 'hermes3:8b';

const OPENAI_BASE_URL = stripTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4.1-mini';

async function askForToolCall({ level, observation, tools }) {
    if (!USE_LLM || LLM_PROVIDER === 'none') return null;

    const prompt = buildPrompt(level, observation, tools);
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

async function askForChatReply({ username, message, observation, level }) {
    if (!USE_LLM || LLM_PROVIDER === 'none') {
        return 'I can hear you, but my language model is disabled right now.';
    }

    const prompt = buildChatPrompt({ username, message, observation, level });
    try {
        if (LLM_PROVIDER === 'ollama') {
            return sanitizeChatReply(await askOllamaChatReply(prompt));
        }

        if (LLM_PROVIDER === 'openai' || LLM_PROVIDER === 'openai-compatible') {
            return sanitizeChatReply(await askOpenAiCompatibleChatReply(prompt));
        }

        return `I cannot use provider "${LLM_PROVIDER}" for chat yet.`;
    } catch (error) {
        console.log(`[LLM] Could not get a chat reply: ${error.message}`);
        return 'I heard you, but my chat brain stalled for a moment.';
    }
}

async function askOllama(prompt) {
    const response = await axios.post(OLLAMA_URL, {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        think: false,
        format: 'json',
        options: {
            temperature: 0,
            num_predict: 180
        }
    }, {
        timeout: Number(process.env.LLM_TIMEOUT_MS || 30000)
    });

    return parseJson(response.data?.response || response.data?.thinking || '');
}

async function askOllamaChatReply(prompt) {
    const response = await axios.post(OLLAMA_URL, {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        think: false,
        format: {
            type: 'object',
            properties: {
                reply: { type: 'string' }
            },
            required: ['reply']
        },
        options: {
            temperature: 0.1,
            num_predict: Number(process.env.CHAT_MAX_TOKENS || 60)
        }
    }, {
        timeout: Number(process.env.CHAT_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 45000)
    });

    const raw = response.data?.response || response.data?.thinking || '';
    return extractChatReply(raw);
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
        timeout: Number(process.env.LLM_TIMEOUT_MS || 30000),
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    return parseJson(response.data?.choices?.[0]?.message?.content || '');
}

async function askOpenAiCompatibleChatReply(prompt) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for the openai-compatible provider');
    }

    const response = await axios.post(`${OPENAI_BASE_URL}/chat/completions`, {
        model: OPENAI_MODEL,
        messages: [
            {
                role: 'system',
                content: 'You are Marigo, a Minecraft bot. Return only JSON with a reply string.'
            },
            {
                role: 'user',
                content: prompt
            }
        ],
        temperature: 0.3,
        max_tokens: Number(process.env.CHAT_MAX_TOKENS || 90),
        response_format: { type: 'json_object' }
    }, {
        timeout: Number(process.env.CHAT_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 45000),
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    return extractChatReply(response.data?.choices?.[0]?.message?.content || '');
}

function buildPrompt(level, observation, tools) {
    return [
        'You are the AI brain controlling a Minecraft bot body.',
        'The body can only act through the listed tools.',
        'Choose the single best next tool call for the current situation.',
        'Return only JSON. Do not write explanations.',
        `Level: ${level.id}`,
        `Goal: ${level.goal}`,
        `Available tools: ${JSON.stringify(tools.map(toPromptTool))}`,
        `Health: ${observation.health}/20`,
        `Food: ${observation.food}/20`,
        `Position: ${JSON.stringify(observation.position)}`,
        `Inventory: ${observation.inventoryText}`,
        `Nearby blocks: ${JSON.stringify(observation.nearbyBlocks.slice(0, 8))}`,
        `Nearby mobs: ${JSON.stringify(observation.nearbyMobs.slice(0, 8))}`,
        `Base: ${JSON.stringify(observation.base || null)}`,
        `Last error: ${observation.lastError || 'none'}`,
        'Format examples:',
        '{"tool":"mine_block","args":{"target":"oak_log"},"reason":"wood is needed"}',
        '{"tool":"explore","args":{"target":"wood"},"reason":"no tree is visible"}',
        '{"tool":"craft_item","args":{"item":"oak_planks","count":8},"reason":"planks are needed"}',
        '{"tool":"place_block","args":{"item":"crafting_table"},"reason":"crafting table must be placed"}',
        'Tool call JSON:'
    ].join('\n');
}

function buildChatPrompt({ username, message, observation, level }) {
    const language = detectChatLanguage(message);
    const status = [
        `goal=${level?.goal || 'unknown'}`,
        `health=${observation.health}/20`,
        `food=${observation.food}/20`,
        `xyz=${observation.position.x},${observation.position.y},${observation.position.z}`,
        `inventory=${observation.inventoryText}`,
        `base=${observation.base ? `${observation.base.x},${observation.base.y},${observation.base.z}` : 'none'}`,
        `lastError=${observation.lastError || 'none'}`
    ].join('; ');

    return [
        'You are Marigo, an AI-controlled Minecraft survival bot.',
        'Reply as Marigo, not as an assistant explaining a task.',
        `Reply language: ${language}.`,
        'Use only literal facts from the supplied status. Never infer or invent biomes, actions, locations, progress, or completed tasks.',
        'If the player asks what you are doing, answer only with the goal and relevant inventory facts.',
        'Speak naturally with correct grammar and no filler words.',
        'Do not mention internal level identifiers unless the player explicitly asks for technical status.',
        'Do not repeat the player message.',
        'Use one short Minecraft chat sentence, ideally under 20 words. No reasoning, no markdown, no emoji.',
        'Return only JSON with one field named reply.',
        `Player ${username} says: ${message}`,
        `Your current status: ${status}`,
        'Your JSON reply:'
    ].join('\n');
}

function detectChatLanguage(message) {
    const text = String(message || '').toLowerCase();
    if (/[çğıöşü]/i.test(text)) return 'Turkish';
    const turkishWords = [
        'merhaba', 'selam', 'naber', 'nasilsin', 'nasılsın',
        'ne yapiyorsun', 'ne yapıyorsun', 'yapiyorsun', 'yapıyorsun',
        'su an', 'şu an', 'durum', 'beni takip', 'tas topla', 'taş topla',
        'odun', 'ev', 'tarla', 'yemek', 'yardim', 'yardım'
    ];
    return turkishWords.some(word => text.includes(word)) ? 'Turkish' : 'English';
}

function toPromptTool(tool) {
    return {
        name: tool.name,
        description: tool.description,
        args: tool.args
    };
}

function sanitizeChatReply(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 420) || 'I heard you, but I do not have a good answer yet.';
}

function extractChatReply(raw) {
    const text = String(raw || '').trim();
    const parsed = parseJson(text);
    if (parsed && typeof parsed === 'object') {
        return parsed.reply || parsed.message || parsed.answer || parsed.text || '';
    }
    return text;
}

function parseJson(text) {
    const candidates = extractJsonObjects(text);
    for (const candidate of candidates.reverse()) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Try the next candidate.
        }
    }
    return null;
}

function extractJsonObjects(text) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) start = i;
            depth++;
            continue;
        }

        if (char === '}') {
            if (depth === 0) continue;
            depth--;
            if (depth === 0 && start >= 0) {
                objects.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }

    return objects;
}

function stripTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}

module.exports = {
    askForToolCall,
    askForChatReply
};
