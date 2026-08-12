require('dotenv').config({ quiet: true });
const axios = require('axios');

const USE_LLM = process.env.USE_LLM !== 'false';
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (USE_LLM ? 'deepseek' : 'none')).toLowerCase();

const OLLAMA_URL = toOllamaChatUrl(process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.LLM_MODEL || 'qwen3.5:9b';

const OPENAI_BASE_URL = stripTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4.1-mini';

const DEEPSEEK_BASE_URL = stripTrailingSlash(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash';

async function askForToolCall({ level, observation, tools }) {
    if (!USE_LLM || LLM_PROVIDER === 'none') return null;

    const prompt = buildPrompt(level, observation, tools);
    try {
        if (LLM_PROVIDER === 'ollama') {
            return await askOllamaToolCall(prompt, tools);
        }

        if (LLM_PROVIDER === 'deepseek') {
            return await askDeepSeekToolCall(prompt, tools);
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

async function askForChatReply({ username, message, observation, level, profession, task, playerMemory, conversation, episodes, character }) {
    if (!USE_LLM || LLM_PROVIDER === 'none') {
        return 'I can hear you, but my language model is disabled right now.';
    }

    const prompt = buildChatPrompt({
        username, message, observation, level, profession, task, playerMemory, conversation, episodes, character
    });
    try {
        if (LLM_PROVIDER === 'ollama') {
            return sanitizeChatReply(await askOllamaChatReply(prompt));
        }

        if (LLM_PROVIDER === 'deepseek') {
            return sanitizeChatReply(await askDeepSeekChatReply(prompt));
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

async function interpretPlayerIntent({ username, message, observation, profession, task, tools }) {
    if (!USE_LLM || LLM_PROVIDER === 'none' || !looksActionable(message)) return null;
    const prompt = buildIntentPrompt({ username, message, observation, profession, task, tools });
    try {
        if (LLM_PROVIDER === 'ollama') {
            return normalizeIntent(await askOllamaJson(prompt, intentSchema(), 360), message, observation, username);
        }
        if (LLM_PROVIDER === 'deepseek') {
            return normalizeIntent(await askDeepSeekJson(prompt, 360), message, observation, username);
        }
        if (LLM_PROVIDER === 'openai' || LLM_PROVIDER === 'openai-compatible') {
            return normalizeIntent(await askOpenAiJson(prompt, 360), message, observation, username);
        }
    } catch (error) {
        console.log(`[LLM] Could not interpret player intent: ${error.message}`);
    }
    return null;
}

async function askForColonyPlan({ snapshot, existing, tools }) {
    if (!USE_LLM || LLM_PROVIDER === 'none') return null;
    const toolDefinitions = (tools || []).map(tool => typeof tool === 'string' ? { name: tool, args: {} } : tool);
    const allowedTools = toolDefinitions.map(tool => tool.name).filter(Boolean);
    const prompt = buildColonyPlanPrompt(snapshot, existing, toolDefinitions);
    try {
        if (LLM_PROVIDER === 'ollama') {
            return await askOllamaJson(prompt, colonyPlanSchema(allowedTools), 420);
        }
        if (LLM_PROVIDER === 'deepseek') {
            return await askDeepSeekJson(prompt, 420);
        }
        if (LLM_PROVIDER === 'openai' || LLM_PROVIDER === 'openai-compatible') {
            return await askOpenAiJson(prompt, 420);
        }
    } catch (error) {
        console.log(`[LLM] Colony planning failed, deterministic planner will continue: ${error.message}`);
    }
    return null;
}

async function askDeepSeekToolCall(prompt, tools) {
    const response = await postDeepSeek({
        messages: [
            {
                role: 'system',
                content: 'You control a Minecraft agent through tools. Select exactly one safe tool.'
            },
            { role: 'user', content: prompt }
        ],
        tools: tools.map(toOllamaTool),
        tool_choice: 'auto',
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 180
    });
    const message = response.data?.choices?.[0]?.message || {};
    const toolCall = message.tool_calls?.[0]?.function;
    if (toolCall?.name) {
        return {
            tool: toolCall.name,
            args: parseArguments(toolCall.arguments),
            reason: 'DeepSeek selected a native tool call'
        };
    }
    return parseJson(message.content || '');
}

async function askDeepSeekChatReply(prompt) {
    const value = await askDeepSeekJson(
        prompt,
        Number(process.env.CHAT_MAX_TOKENS || 220),
        Number(process.env.CHAT_TIMEOUT_MS || 45000)
    );
    return value?.reply || value?.message || value?.answer || '';
}

async function askDeepSeekJson(prompt, maxTokens, timeout) {
    const response = await postDeepSeek({
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
        temperature: 0.15,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
    }, timeout);
    return parseJson(response.data?.choices?.[0]?.message?.content || '');
}

async function postDeepSeek(body, timeout) {
    if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for the deepseek provider');
    const timeoutMs = Number(timeout || process.env.LLM_TIMEOUT_MS || 45000);
    return axios.post(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        model: DEEPSEEK_MODEL,
        ...body
    }, {
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });
}

async function askOllamaToolCall(prompt, tools) {
    const response = await axios.post(OLLAMA_URL, {
        model: OLLAMA_MODEL,
        messages: [
            { role: 'system', content: 'You control a Minecraft agent through tools. Select exactly one safe tool.' },
            { role: 'user', content: prompt }
        ],
        tools: tools.map(toOllamaTool),
        stream: false,
        think: false,
        options: {
            temperature: 0,
            num_predict: 160,
            num_ctx: Number(process.env.OLLAMA_CONTEXT_SIZE || 4096)
        }
    }, {
        timeout: Number(process.env.LLM_TIMEOUT_MS || 30000)
    });

    const toolCall = response.data?.message?.tool_calls?.[0]?.function;
    if (toolCall?.name) {
        return {
            tool: toolCall.name,
            args: parseArguments(toolCall.arguments),
            reason: 'AI selected a native Ollama tool call'
        };
    }
    return parseJson(response.data?.message?.content || '');
}

async function askOllamaChatReply(prompt) {
    const value = await askOllamaJson(prompt, {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply']
    }, Number(process.env.CHAT_MAX_TOKENS || 180), Number(process.env.CHAT_TIMEOUT_MS || 45000));
    return value?.reply || '';
}

async function askOllamaJson(prompt, format, maxTokens, timeout) {
    const response = await axios.post(OLLAMA_URL, {
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        format,
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        options: {
            temperature: 0.1,
            num_predict: maxTokens,
            num_ctx: Number(process.env.OLLAMA_CONTEXT_SIZE || 4096)
        }
    }, {
        timeout: Number(timeout || process.env.LLM_TIMEOUT_MS || 30000)
    });
    return parseJson(response.data?.message?.content || '');
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

async function askOpenAiJson(prompt, maxTokens) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for the openai-compatible provider');
    const response = await axios.post(`${OPENAI_BASE_URL}/chat/completions`, {
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
    }, {
        timeout: Number(process.env.LLM_TIMEOUT_MS || 30000),
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
    });
    return parseJson(response.data?.choices?.[0]?.message?.content || '');
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
        `Nearby blocks: ${JSON.stringify(uniqueNearbyBlocks(observation.nearbyBlocks, 16))}`,
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

function uniqueNearbyBlocks(blocks, limit) {
    const seen = new Set();
    return (blocks || []).filter(block => {
        if (!block?.name || seen.has(block.name)) return false;
        seen.add(block.name);
        return true;
    }).slice(0, limit);
}

function buildChatPrompt({ username, message, observation, level, profession, task, playerMemory, conversation, episodes, character }) {
    const language = detectChatLanguage(message);
    const includeStatus = asksForStatus(message);
    const identity = character || {
        shortName: 'Marigo',
        displayName: 'Marigo',
        speech: { tone: 'warm and practical', verbosity: 'short' },
        values: ['cooperation'],
        traits: {}
    };
    const status = includeStatus ? [
        `goal=${level?.goal || 'unknown'}`,
        `health=${observation.health}/20`,
        `food=${observation.food}/20`,
        `xyz=${observation.position.x},${observation.position.y},${observation.position.z}`,
        `inventory=${observation.inventoryText}`,
        `base=${observation.base ? `${observation.base.x},${observation.base.y},${observation.base.z}` : 'none'}`,
        `lastError=${observation.lastError || 'none'}`,
        `profession=${profession?.id || 'none'}`,
        `activeTask=${task?.goal || 'none'}`
    ].join('; ') : 'withheld because this is a social conversation, not a status request';

    return [
        `You are ${identity.displayName || identity.shortName}, an AI-controlled Minecraft survival citizen.`,
        `Stable character profile: ${JSON.stringify({ shortName: identity.shortName, traits: identity.traits, speech: identity.speech, values: identity.values })}`,
        `Reply as ${identity.shortName}, not as an assistant explaining a task.`,
        'Personality may shape wording and safe preferences, but it never overrides factual state or survival rules.',
        `Reply language: ${language}.`,
        'Use only literal facts for world state. Never invent biomes, actions, locations, progress, or completed tasks.',
        'You may express subjective preferences, curiosity, hopes, and opinions when they follow from the character profile or conversation.',
        'The status is silent background context, not the default topic.',
        'Do not mention the current goal, inventory, coordinates, health, or task unless the player explicitly asks about work, status, progress, or survival needs.',
        'If the player asks what you are doing, answer the question briefly, then continue the social topic if one exists.',
        'For greetings and wellbeing questions, answer warmly and socially; do not turn them into a status report.',
        'Do not mention the current goal when merely greeting the player or answering how you feel.',
        'Treat recent conversation as an ongoing dialogue. Resolve short follow-ups, pronouns, and references from that history.',
        'Respond to the meaning of the player message, not merely with a report about your current task.',
        'When it feels natural, ask one relevant follow-up question or add one personal observation to keep the conversation moving.',
        'Do not ask a question in every reply, and do not repeat a question already answered in recent conversation.',
        'Speak naturally with correct grammar and no filler words.',
        'Do not mention internal level identifiers unless the player explicitly asks for technical status.',
        'Do not repeat the player message.',
        'Use one to three natural sentences, normally under 60 words total. No reasoning labels, markdown, or emoji.',
        'Return only JSON with one field named reply.',
        `Player ${username} says: ${message}`,
        `Known player profile: ${JSON.stringify(playerMemory || {})}`,
        `Recent conversation in chronological order: ${JSON.stringify((conversation || []).slice(-14))}`,
        `Relevant shared memories: ${JSON.stringify((episodes || []).slice(0, 6))}`,
        `Your current status: ${status}`,
        'Your JSON reply:'
    ].join('\n');
}

function asksForStatus(message) {
    const text = foldTurkish(message);
    return /\b(ne yapiyorsun|neyle ugrasiyorsun|durum|status|gorev|task|ilerleme|progress|envanter|inventory|koordinat|coordinate|canin|health|aclik|food|neredesin|where are you)\b/i.test(text);
}

function buildIntentPrompt({ username, message, observation, profession, task, tools }) {
    return [
        'Interpret a Minecraft player request for Marigo.',
        'Return JSON only. Never invent tools outside the supplied list.',
        'Use intent chat when the message is not an actionable request.',
        'Valid intents: chat, follow, come, guard, combat, stop, assign_profession, create_profession, stop_profession, create_goal, create_dynamic_skill.',
        'Use follow for a persistent follow-me request, come for a one-time come-here request, and guard for a persistent guard-me or guard-here request.',
        'Use combat only for an explicit request to duel, attack, or kill a player. Set targetPlayer and combatMode to duel or lethal. Never infer lethal mode without kill, oldur, or to-the-death language.',
        'Use create_profession when the player invents a profession that is not already available.',
        'A custom profession must contain safe repeatable routines using only supplied tools. Never use coordinate movement, player following, creative showcases, or direct combat as profession routines.',
        'Supported routine conditions: always, inventory_below, inventory_at_least, observation_equals.',
        'For create_goal, produce 1-8 ordered tool steps.',
        'Use create_dynamic_skill only when the request needs a reusable sequence that has no existing named skill. It may compose safe supplied tools but may never contain combat with players, following players, coordinate movement, colony operations, shell, files, network, or code.',
        'A dynamic skill has id, displayName, purpose, optional literal parameters, and 1-12 steps. Each step has tool, args, reason, and optional repeat from 1 to 3.',
        'Use exact tool argument names and include every required argument. Do not invent arguments.',
        'For collecting wood use mine_block with target any_log and the requested count.',
        `Player: ${username}`,
        `Message: ${message}`,
        `Current profession: ${profession?.id || 'none'}`,
        `Current task: ${task?.goal || 'none'}`,
        `Health: ${observation.health}; food: ${observation.food}`,
        `Inventory: ${observation.inventoryText}`,
        `Tools: ${JSON.stringify((tools || []).map(toPromptTool))}`,
        'Response JSON:'
    ].join('\n');
}

function buildColonyPlanPrompt(snapshot, existing, toolDefinitions) {
    return [
        'You are the single strategic brain of a Minecraft survival colony.',
        'Create only high-level work orders. Never control movement, combat, hunger, drowning, or block placement ticks.',
        'Local behavior trees enforce safety and validate every physical outcome.',
        'Use only allowed tools. Prefer shortages and unfinished survival infrastructure.',
        'Do not duplicate an existing queued or assigned order.',
        'Return JSON with an orders array. Return an empty array when no strategic work is needed.',
        `Allowed tools and exact argument schemas: ${JSON.stringify(toolDefinitions.map(tool => ({ name: tool.name, description: tool.description, args: tool.args })))}`,
        `Compact colony state: ${JSON.stringify(snapshot)}`,
        `Existing work: ${JSON.stringify((existing || []).map(order => ({ id: order.id, tool: order.tool, args: order.args, status: order.status, dedupeKey: order.dedupeKey })))}`,
        'Each order fields: tool, args, priority 1-100, professions, reason, dedupeKey.',
        'Colony plan JSON:'
    ].join('\n');
}

function colonyPlanSchema(allowedTools) {
    return {
        type: 'object',
        properties: {
            orders: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        tool: allowedTools.length > 0 ? { type: 'string', enum: allowedTools } : { type: 'string' },
                        args: { type: 'object' },
                        priority: { type: 'number' },
                        professions: { type: 'array', items: { type: 'string' } },
                        reason: { type: 'string' },
                        dedupeKey: { type: 'string' }
                    },
                    required: ['tool', 'args', 'priority', 'professions', 'reason', 'dedupeKey']
                }
            }
        },
        required: ['orders']
    };
}

function intentSchema() {
    return {
        type: 'object',
        properties: {
            intent: { type: 'string', enum: ['chat', 'follow', 'come', 'guard', 'combat', 'stop', 'assign_profession', 'create_profession', 'stop_profession', 'create_goal', 'create_dynamic_skill'] },
            profession: { type: 'string' },
            target: { type: 'string', enum: ['player', 'position'] },
            targetPlayer: { type: 'string' },
            combatMode: { type: 'string', enum: ['duel', 'lethal'] },
            professionProfile: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    displayName: { type: 'string' },
                    purpose: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    protectedBlocks: { type: 'array', items: { type: 'string' } },
                    stockTargets: { type: 'object' },
                    routines: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                tool: { type: 'string' },
                                args: { type: 'object' },
                                reason: { type: 'string' },
                                when: { type: 'object' }
                            },
                            required: ['tool', 'args', 'reason']
                        }
                    }
                },
                required: ['id', 'displayName', 'purpose', 'routines']
            },
            dynamicSkillProfile: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    displayName: { type: 'string' },
                    purpose: { type: 'string' },
                    parameters: { type: 'object' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                tool: { type: 'string' },
                                args: { type: 'object' },
                                reason: { type: 'string' },
                                repeat: { type: 'number' }
                            },
                            required: ['tool', 'args']
                        }
                    }
                },
                required: ['id', 'displayName', 'purpose', 'steps']
            },
            goal: { type: 'string' },
            steps: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        tool: { type: 'string' },
                        args: { type: 'object' },
                        reason: { type: 'string' }
                    },
                    required: ['tool']
                }
            }
        },
        required: ['intent']
    };
}

function looksActionable(message) {
    const text = foldTurkish(message);
    return [
        'topla', 'kes', 'yap', 'kur', 'git', 'gel', 'birak', 'gotur', 'koy',
        'takip', 'ol', 'calis', 'meslek', 'farmer', 'miner', 'builder', 'fisher',
        'collect', 'build', 'follow', 'bring', 'store', 'profession', 'guard', 'protect', 'koru', 'nobet', 'dur', 'artik',
        'savas', 'saldir', 'oldur', 'fight', 'attack', 'kill'
    ].some(word => new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`, 'i').test(text));
}

function normalizeIntent(value, message, observation, username = null) {
    if (!value || typeof value !== 'object') return null;
    const result = { ...value };
    const foldedMessage = foldTurkish(message);
    if (result.intent === 'guard') {
        result.target = result.target === 'position' || /burada|burayi|bu nokta|here|this place/.test(foldedMessage)
            ? 'position' : 'player';
    }
    if (result.intent === 'combat') {
        result.combatMode = result.combatMode === 'lethal' || /\b(oldur|kill|olene kadar|to the death)\b/.test(foldedMessage)
            ? 'lethal' : 'duel';
        result.targetPlayer = String(result.targetPlayer || result.username || username || '').slice(0, 16);
        if (!result.targetPlayer) return null;
    }
    if (result.intent === 'assign_profession' && !result.profession) {
        result.profession = result.professionName || result.job || '';
    }
    if (result.intent === 'create_profession') {
        const source = result.professionProfile && typeof result.professionProfile === 'object'
            ? result.professionProfile : result;
        const id = source.id || source.professionName || source.profession || source.job || 'custom_profession';
        result.professionProfile = {
            id,
            displayName: source.displayName || source.name || source.professionName || id,
            purpose: source.purpose || source.description || `Perform the player-defined ${id} profession.`,
            aliases: Array.isArray(source.aliases) ? source.aliases : [],
            protectedBlocks: Array.isArray(source.protectedBlocks) ? source.protectedBlocks : [],
            stockTargets: source.stockTargets && typeof source.stockTargets === 'object' ? source.stockTargets : {},
            routines: (Array.isArray(source.routines) ? source.routines : []).slice(0, 10).map(routine => ({
                tool: routine.tool,
                args: parseArguments(routine.args),
                reason: String(routine.reason || `${id}: ${routine.tool || 'work'}`).slice(0, 180),
                when: routine.when || routine.condition || { type: 'always' }
            }))
        };
    }
    if (result.intent === 'create_dynamic_skill') {
        const source = result.dynamicSkillProfile && typeof result.dynamicSkillProfile === 'object'
            ? result.dynamicSkillProfile : result;
        result.dynamicSkillProfile = {
            id: source.id || source.skillName || 'custom_skill',
            displayName: source.displayName || source.name || source.skillName || 'Custom Skill',
            purpose: source.purpose || source.description || String(message || 'Player-defined skill'),
            parameters: parseArguments(source.parameters),
            steps: (Array.isArray(source.steps) ? source.steps : []).slice(0, 12).map(step => ({
                tool: step.tool,
                args: parseArguments(step.args),
                reason: String(step.reason || '').slice(0, 180),
                repeat: Number(step.repeat || 1)
            }))
        };
    }
    if (Array.isArray(result.steps) && result.steps.length > 0 && result.intent === 'chat') {
        result.intent = 'create_goal';
    }
    if (result.intent === 'create_goal') {
        result.goal = String(result.goal || message || 'player request').slice(0, 120);
        let steps = (result.steps || []).slice(0, 8).map(step => {
            const normalized = { ...step, args: parseArguments(step.args) };
            if (normalized.tool === 'mine_block' && !normalized.args.target && /odun|agac|wood|tree/i.test(foldTurkish(message))) {
                normalized.args.target = 'any_log';
            }
            return normalized;
        });
        const folded = foldedMessage;
        const wantsStorage = /sandik|sandig|chest|depo/.test(folded);
        if (wantsStorage) {
            const storageOnly = /birak|koy|duzenle|store|deposit/.test(folded) &&
                !/topla|kes|collect|gather/.test(folded);
            if (storageOnly) {
                steps = steps.filter(step => ['ensure_base', 'return_base', 'organize_storage'].includes(step.tool));
            }
            steps = steps.filter(step => !(
                (step.tool === 'place_block' && ['sand', 'chest'].includes(step.args?.item)) ||
                (step.tool === 'craft_item' && step.args?.item === 'chest')
            ));
            if (!steps.some(step => step.tool === 'organize_storage')) {
                steps.push({ tool: 'organize_storage', args: {}, reason: 'Store requested resources in base storage' });
            }
        }
        if (!observation?.base && /\bev\b|\beve\b|\bhome\b|\bbase\b/.test(folded) &&
            !steps.some(step => ['build_shelter', 'ensure_base'].includes(step.tool))) {
            const returnIndex = steps.findIndex(step => step.tool === 'return_base');
            const insertAt = returnIndex >= 0 ? returnIndex : steps.length;
            steps.splice(insertAt, 0, { tool: 'ensure_base', args: {}, reason: 'Establish the requested home first' });
        }
        result.steps = steps.flatMap(step => {
            if (step.tool !== 'mine_block' || Number(step.args?.count || 1) <= 1) return [step];
            const repeats = Math.max(1, Math.min(8, Math.ceil(Number(step.args.count) / 4)));
            return Array.from({ length: repeats }, (_, index) => ({
                ...step,
                args: { ...step.args, count: 1 },
                reason: `${step.reason || 'Collect resource'} (${index + 1}/${repeats})`
            }));
        }).slice(0, 12);
    }
    return result;
}

function toOllamaTool(tool) {
    const properties = {};
    const required = [];
    for (const [name, description] of Object.entries(tool.args || {})) {
        const text = String(description);
        properties[name] = {
            type: text.startsWith('number') ? 'number' : text.startsWith('boolean') ? 'boolean' : 'string',
            description: text
        };
        if (text.includes('required')) required.push(name);
    }
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: { type: 'object', properties, required }
        }
    };
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
        .slice(0, 600) || 'I heard you, but I do not have a good answer yet.';
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

function parseArguments(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    return parseJson(value) || {};
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

function toOllamaChatUrl(value) {
    return String(value).replace(/\/api\/(?:generate|chat)\/?$/, '/api/chat');
}

function foldTurkish(value) {
    return String(value || '').toLocaleLowerCase('tr-TR')
        .replace(/[ç]/g, 'c')
        .replace(/[ğ]/g, 'g')
        .replace(/[ıİi]/g, 'i')
        .replace(/[ö]/g, 'o')
        .replace(/[ş]/g, 's')
        .replace(/[ü]/g, 'u');
}

module.exports = {
    askForToolCall,
    askForChatReply,
    interpretPlayerIntent,
    askForColonyPlan,
    buildChatPrompt,
    normalizeIntent
};
