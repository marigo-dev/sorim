const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b';
const USE_LLM = process.env.USE_LLM !== 'false';

async function askForAction({ level, observation, allowedActions }) {
    if (!USE_LLM) return null;

    const prompt = buildPrompt(level, observation, allowedActions);
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: OLLAMA_MODEL,
            prompt,
            stream: false,
            options: {
                temperature: 0.1,
                num_predict: 120
            }
        }, {
            timeout: 12000
        });

        return parseJson(response.data?.response || '');
    } catch (error) {
        console.log(`[LLM] karar alinamadi, fallback kullanilacak: ${error.message}`);
        return null;
    }
}

function buildPrompt(level, observation, allowedActions) {
    return [
        'Sen Minecraft botu icin karar secicisin.',
        'Sadece JSON dondur. Aciklama yazma.',
        `Seviye: ${level.id}`,
        `Hedef: ${level.goal}`,
        `Izinli actionlar: ${allowedActions.join(', ')}`,
        `Can: ${observation.health}/20`,
        `Aclik: ${observation.food}/20`,
        `Konum: ${JSON.stringify(observation.position)}`,
        `Envanter: ${observation.inventoryText}`,
        `Yakin bloklar: ${JSON.stringify(observation.nearbyBlocks.slice(0, 8))}`,
        'Format ornekleri:',
        '{"action":"mine","target":"oak_log"}',
        '{"action":"explore","target":"wood"}',
        '{"action":"craft","item":"oak_planks","count":8}',
        '{"action":"place","item":"crafting_table"}',
        'Karar JSON:'
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

module.exports = {
    askForAction
};
