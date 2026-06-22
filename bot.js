require('./logger').installConsoleFilter();

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');

const { askForToolCall, askForChatReply } = require('./llm');
const SkillTree = require('./skillTree');
const movement = require('./skills/movement');
const survival = require('./skills/survival');
const storage = require('./skills/storage');
const memory = require('./skills/memory');
const toolRegistry = require('./toolRegistry');

const BOT_NAME = process.env.MC_USERNAME || 'marigo';
const HOST = process.env.MC_HOST || 'localhost';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.21';
const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 1500);

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: BOT_NAME,
    version: VERSION
});

bot.loadPlugin(pathfinder);

const skillTree = new SkillTree();
let running = true;
let busy = false;
let chatBusy = false;
let activeFollowUsername = null;
let queuedUserCommand = null;
let autonomousMode = process.env.AUTONOMOUS_ON_START === 'true';
let lastError = null;

bot.once('spawn', async () => {
    console.log(`[BOOT] ${BOT_NAME} spawned. AI body runtime started.`);
    movement.configure(bot);
    loop().catch(error => {
        console.log('[FATAL]', error.message);
        shutdown();
    });
});

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const lower = message.toLowerCase();
    if (!lower.includes(BOT_NAME.toLowerCase()) && !lower.includes('marigo')) return;

    const observation = observe();
    if (lower.includes('status') || lower.includes('durum')) {
        const pos = observation.position;
        bot.chat(`Mode:${autonomousMode ? 'auto' : 'manual'} Level:${skillTree.getLevel(observation).id} xyz:${pos.x},${pos.y},${pos.z} health:${bot.health.toFixed(1)} food:${bot.food} inv:${observation.inventoryText}`);
        return;
    }

    const command = parseUserCommand(username, lower);
    if (command) {
        applyUserCommand(command);
        bot.chat(command.reply);
        return;
    }

    if (chatBusy) {
        bot.chat('Bir saniye, onceki mesaji dusunuyorum.');
        return;
    }

    chatBusy = true;
    try {
        const level = skillTree.getLevel(observation);
        const reply = await askForChatReply({
            username,
            message,
            observation,
            level
        });
        for (const part of splitChat(reply)) {
            bot.chat(part);
            await sleep(350);
        }
    } catch (error) {
        console.log('[CHAT_ERROR]', error.message);
        bot.chat('Duydum ama cevap verirken takildim.');
    } finally {
        chatBusy = false;
    }
});

bot.on('kicked', reason => console.log('[KICKED]', reason));
bot.on('error', error => console.log('[BOT_ERROR]', error.message));
bot.on('death', () => console.log('[DEATH] Bot died; waiting for automatic respawn.'));
bot.on('end', () => {
    running = false;
    console.log('[END] Bot connection closed.');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function loop() {
    while (running) {
        await sleep(LOOP_DELAY_MS);
        if (!bot.entity || busy || bot.health <= 0) continue;

        busy = true;
        try {
            const observation = observe();
            const level = skillTree.getLevel(observation);
            const immediate = survival.chooseImmediateAction(bot, observation, level);
            if (immediate) {
                const safetyCall = toolRegistry.normalizeToolCall(immediate);
                console.log(`[SAFETY] tool=${JSON.stringify(safetyCall)} inv=${observation.inventoryText}`);
                await toolRegistry.executeToolCall(bot, safetyCall);
                lastError = null;
                continue;
            }

            if (queuedUserCommand) {
                const commandCall = queuedUserCommand;
                queuedUserCommand = null;
                console.log(`[USER_COMMAND] tool=${JSON.stringify(commandCall)} inv=${observation.inventoryText}`);
                await toolRegistry.executeToolCall(bot, commandCall);
                lastError = null;
                continue;
            }

            if (activeFollowUsername) {
                const followed = bot.players[activeFollowUsername]?.entity;
                if (followed) {
                    console.log(`[USER_COMMAND] following=${activeFollowUsername}`);
                    await movement.moveNear(bot, followed.position, 2, 6000);
                }
                lastError = null;
                continue;
            }

            if (!autonomousMode) {
                movement.stop(bot);
                lastError = null;
                continue;
            }

            const availableTools = toolRegistry.toolsForLevel(level);
            const aiCall = await askForToolCall({
                level,
                observation,
                tools: availableTools
            });
            const validAiCall = toolRegistry.validateToolCall(
                toolRegistry.normalizeToolCall(aiCall),
                availableTools
            );
            const source = validAiCall ? 'ai' : 'fallback';
            if (aiCall && !validAiCall) {
                console.log(`[AI_REJECTED] level=${level.id} raw=${JSON.stringify(aiCall)}`);
            }
            const toolCall = validAiCall || toolRegistry.fallbackToolCall(skillTree, observation, level);

            console.log(`[AI_LOOP] source=${source} level=${level.id} tool=${JSON.stringify(toolCall)} inv=${observation.inventoryText}`);
            await toolRegistry.executeToolCall(bot, toolCall);
            lastError = null;
        } catch (error) {
            if (isExpectedMovementCancel(error)) {
                lastError = null;
                continue;
            }
            lastError = error.message;
            console.log('[STEP_ERROR]', error.message);
            movement.stop(bot);
        } finally {
            busy = false;
        }
    }
}

function observe() {
    const inventory = countInventory();
    const position = bot.entity?.position;
    const nearbyBlocks = scanUsefulBlocks(32);
    const nearbyMobs = Object.values(bot.entities || {})
        .filter(entity => entity !== bot.entity && entity.position && entity.position.distanceTo(position) <= 24)
        .map(entity => ({
            name: entity.name || entity.displayName || 'unknown',
            distance: Number(entity.position.distanceTo(position).toFixed(1))
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);

    return {
        health: bot.health,
        food: bot.food,
        position: {
            x: Math.floor(position.x),
            y: Math.floor(position.y),
            z: Math.floor(position.z)
        },
        inventory,
        inventoryText: inventoryText(inventory),
        nearbyBlocks,
        nearbyMobs,
        hasUsableChest: storage.hasChestNearby(bot),
        storageReady: !storage.isTemporarilyUnavailable(),
        base: memory.getBase(),
        survivalReady: true,
        lastError
    };
}

function countInventory() {
    const counts = {};
    for (const item of bot.inventory.slots.filter(Boolean)) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    if (bot.heldItem) {
        counts[bot.heldItem.name] = Math.max(counts[bot.heldItem.name] || 0, bot.heldItem.count);
    }
    return counts;
}

function inventoryText(inventory) {
    const text = Object.entries(inventory)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');
    return text || 'empty';
}

function scanUsefulBlocks(maxDistance) {
    const names = [
        'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
        'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
        'stone', 'cobblestone', 'crafting_table', 'chest'
    ];
    const ids = names
        .map(name => bot.registry.blocksByName[name]?.id)
        .filter(Boolean);
    if (ids.length === 0) return [];

    return bot.findBlocks({ matching: ids, maxDistance, count: 128 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .map(block => ({
            name: block.name,
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
            distance: Number(block.position.distanceTo(bot.entity.position).toFixed(1))
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 24);
}

function parseUserCommand(username, lowerMessage) {
    const message = lowerMessage
        .replace(BOT_NAME.toLowerCase(), '')
        .replace('marigo', '')
        .trim();

    if (includesAny(message, [
        'komut',
        'komutlar',
        'commands',
        'help'
    ])) {
        return {
            type: 'help',
            reply: 'Komutlar: beni takip et, dur, odun topla/agac kes, tas topla, yemek bul, otonom basla, otonom dur, durum.'
        };
    }

    if (includesAny(message, [
        'otonom basla',
        'otonom başla',
        'kendi basla',
        'kendi başla',
        'devam et',
        'auto start',
        'start autonomous'
    ])) {
        return {
            type: 'auto_start',
            reply: 'Tamam, otonom plana basliyorum.'
        };
    }

    if (includesAny(message, [
        'otonom dur',
        'otonom kapat',
        'auto stop',
        'stop autonomous'
    ])) {
        return {
            type: 'auto_stop',
            reply: 'Tamam, otonom plani durdurdum. Komut bekliyorum.'
        };
    }

    if (includesAny(message, [
        'takip et',
        'beni takip',
        'follow me',
        'come with me',
        'gel benimle'
    ])) {
        return {
            type: 'follow',
            username,
            reply: 'Tamam, seni takip ediyorum.'
        };
    }

    if (includesAny(message, [
        'takibi birak',
        'takibi bırak',
        'dur',
        'bekle',
        'stop',
        'wait'
    ])) {
        return {
            type: 'stop',
            reply: 'Tamam, duruyorum ve mevcut komutu iptal ediyorum.'
        };
    }

    if (includesAny(message, [
        'agac kes',
        'ağaç kes',
        'odun topla',
        'wood',
        'chop tree',
        'cut tree'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'mine_block',
                args: { target: 'any_log' },
                reason: `Player ${username} requested wood`
            },
            reply: 'Tamam, en yakin agaci kesmeye gidiyorum.'
        };
    }

    if (includesAny(message, [
        'tas topla',
        'taş topla',
        'stone',
        'cobblestone',
        'kaya topla'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'collect_stone',
                args: { count: 16 },
                reason: `Player ${username} requested stone`
            },
            reply: 'Tamam, guvenli merdivenle tas toplamaya basliyorum.'
        };
    }

    if (includesAny(message, [
        'yemek bul',
        'food',
        'find food'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'find_food',
                args: {},
                reason: `Player ${username} requested food`
            },
            reply: 'Tamam, yemek kaynagi ariyorum.'
        };
    }

    return null;
}

function applyUserCommand(command) {
    if (command.type === 'help') return;

    if (command.type === 'auto_start') {
        autonomousMode = true;
        activeFollowUsername = null;
        queuedUserCommand = null;
        return;
    }

    if (command.type === 'auto_stop') {
        autonomousMode = false;
        activeFollowUsername = null;
        queuedUserCommand = null;
        movement.stop(bot);
        return;
    }

    if (command.type === 'follow') {
        autonomousMode = false;
        activeFollowUsername = command.username;
        queuedUserCommand = null;
        return;
    }

    if (command.type === 'stop') {
        autonomousMode = false;
        activeFollowUsername = null;
        queuedUserCommand = null;
        movement.stop(bot);
        return;
    }

    if (command.type === 'tool') {
        autonomousMode = false;
        activeFollowUsername = null;
        queuedUserCommand = command.toolCall;
    }
}

function includesAny(message, needles) {
    return needles.some(needle => message.includes(needle));
}

function isExpectedMovementCancel(error) {
    const message = error?.message || '';
    return message.includes('goal was changed') || message.includes('Goal changed');
}

function shutdown() {
    if (!running) return;
    running = false;
    console.log('[SHUTDOWN] Stopping bot.');
    try {
        bot.quit('Goodbye');
    } catch {
        // Bot was already gone.
    }
}

function splitChat(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return ['Duydum ama su an iyi cevap uretemedim.'];

    const chunks = [];
    let remaining = clean;
    const limit = 220;
    while (remaining.length > limit) {
        let cut = remaining.lastIndexOf(' ', limit);
        if (cut < 80) cut = limit;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks.slice(0, 3);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
