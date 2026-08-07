require('./logger').installConsoleFilter();
require('./protocol26Shim');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');

const { askForToolCall, askForChatReply } = require('./llm');
const SkillTree = require('./skillTree');
const movement = require('./skills/movement');
const survival = require('./skills/survival');
const storage = require('./skills/storage');
const shelter = require('./skills/shelter');
const memory = require('./skills/memory');
const homestead = require('./skills/homestead');
const actionControl = require('./skills/actionControl');
const toolRegistry = require('./toolRegistry');

const BOT_NAME = process.env.MC_USERNAME || 'marigo';
const HOST = process.env.MC_HOST || 'localhost';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '26.2';
const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 1500);
const USE_LLM_PLANNER = process.env.USE_LLM_PLANNER === 'true';

memory.initialize(BOT_NAME);

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: BOT_NAME,
    version: VERSION
});

install26_2MetadataShim(bot);
bot.loadPlugin(pathfinder);

const skillTree = new SkillTree();
let running = true;
let busy = false;
let chatBusy = false;
let activeFollowUsername = null;
let queuedUserCommand = null;
let autonomousMode = process.env.AUTONOMOUS_ON_START === 'true';
let cancelRequested = false;
let lastError = null;
let activeToolName = null;
let pendingSafetyCall = null;

bot.once('spawn', async () => {
    console.log(`[BOOT] ${BOT_NAME} spawned. AI body runtime started.`);
    movement.configure(bot);
    install26_2AttackShim(bot);
    await sleep(3000);
    loop().catch(error => {
        console.log('[FATAL]', error.message);
        shutdown();
    });
});

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const lower = message.toLowerCase();
    if (!lower.includes(BOT_NAME.toLowerCase()) && !lower.includes('marigo')) return;
    if (looksLikeAdminCommand(lower)) return;

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
bot.on('death', () => {
    console.log('[DEATH] Bot died; cancelling the active action before respawn.');
    pendingSafetyCall = null;
    memory.clearSurfaceExit();
    haltCurrentAction('death');
});
bot.on('end', () => {
    running = false;
    console.log('[END] Bot connection closed.');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const safetyWatchdog = setInterval(() => {
    if (!running || !autonomousMode || !busy || cancelRequested || !bot.entity || bot.health <= 0) return;
    if (activeToolName === 'fight_mob') return;
    const threat = survival.nearestHostile(bot, 12);
    if (!threat) return;

    console.log(
        `[SAFETY_INTERRUPT] cancelling=${activeToolName || 'unknown'} ` +
        `threat=${threat.name} distance=${threat.distance.toFixed(1)}`
    );
    pendingSafetyCall = {
        tool: 'fight_mob',
        args: { entityId: threat.id },
        reason: `Reactive threat interrupt: ${threat.name}`
    };
    haltCurrentAction(`hostile ${threat.name}`);
}, 300);
safetyWatchdog.unref();

async function loop() {
    while (running) {
        await sleep(LOOP_DELAY_MS);
        if (!bot.entity || busy || bot.health <= 0) continue;

        busy = true;
        try {
            await shelter.ensureBaseEgress(bot);
            const observation = observe();
            const level = skillTree.getLevel(observation);
            if (pendingSafetyCall) {
                const safetyCall = pendingSafetyCall;
                pendingSafetyCall = null;
                console.log(`[SAFETY_PENDING] tool=${JSON.stringify(safetyCall)} inv=${observation.inventoryText}`);
                await executeTool(safetyCall);
                lastError = null;
                continue;
            }

            if (queuedUserCommand) {
                const commandCall = queuedUserCommand;
                queuedUserCommand = null;
                console.log(`[USER_COMMAND] tool=${JSON.stringify(commandCall)} inv=${observation.inventoryText}`);
                await executeTool(commandCall);
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

            const immediate = survival.chooseImmediateAction(bot, observation, level);
            if (immediate) {
                const safetyCall = toolRegistry.normalizeToolCall(immediate);
                console.log(`[SAFETY] tool=${JSON.stringify(safetyCall)} inv=${observation.inventoryText}`);
                await executeTool(safetyCall);
                lastError = null;
                continue;
            }

            const availableTools = toolRegistry.toolsForLevel(level);
            let source = 'fallback';
            let toolCall = null;

            if (USE_LLM_PLANNER) {
                const aiCall = await askForToolCall({
                    level,
                    observation,
                    tools: availableTools
                });
                const validAiCall = toolRegistry.validateToolCall(
                    toolRegistry.normalizeToolCall(aiCall),
                    availableTools
                );
                source = validAiCall ? 'ai' : 'fallback';
                if (aiCall && !validAiCall) {
                    console.log(`[AI_REJECTED] level=${level.id} raw=${JSON.stringify(aiCall)}`);
                }
                toolCall = validAiCall;
            }

            toolCall = toolCall || toolRegistry.fallbackToolCall(skillTree, observation, level);

            console.log(`[AI_LOOP] source=${source} level=${level.id} tool=${JSON.stringify(toolCall)} inv=${observation.inventoryText}`);
            await executeTool(toolCall);
            lastError = null;
        } catch (error) {
            if (cancelRequested) {
                cancelRequested = false;
                lastError = null;
                movement.stop(bot);
                continue;
            }
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
        hasPlacedCraftingTable: memory.hasPlacedBlock('crafting_table'),
        hasPlacedFurnace: memory.hasPlacedBlock('furnace'),
        hasBed: homestead.hasBed(bot),
        farmReady: homestead.hasFarm(bot),
        hasMatureCrop: homestead.hasMatureCrop(bot),
        storageReady: !storage.isTemporarilyUnavailable(),
        base: memory.getBase(),
        survivalReady: true,
        lastError
    };
}

function install26_2AttackShim(bot) {
    if (VERSION !== '26.2' && process.env.ENABLE_EXPERIMENTAL_26_2 !== 'true') return;
    if (bot._marigo26_2AttackShimInstalled || typeof bot.attack !== 'function') return;
    bot._marigo26_2AttackShimInstalled = true;
    const originalAttack = bot.attack.bind(bot);

    bot.attack = function attack26_2(target, swing = true) {
        if (!target?.id || !bot._client) return originalAttack(target, swing);
        bot._client.write('attack', { entityId: target.id });
        if (swing) bot.swingArm();
    };
}

function install26_2MetadataShim(bot) {
    if (VERSION !== '26.2' && process.env.ENABLE_EXPERIMENTAL_26_2 !== 'true') return;
    const client = bot._client;
    if (!client || client._marigo26_2MetadataShimInstalled) return;

    const originalEmit = client.emit.bind(client);
    client.emit = function emitWithMetadataFallback(eventName, packet, ...args) {
        if (eventName === 'entity_metadata' && packet && !Array.isArray(packet.metadata)) {
            packet.metadata = [];
        }
        if (
            eventName === 'world_particles' &&
            (!packet?.particle || typeof packet.particle.type !== 'number')
        ) {
            // Particle ids are cosmetic. Ignore unknown 26.2 payloads instead of
            // letting Mineflayer's older registry interrupt combat and movement.
            return false;
        }
        if (
            (eventName === 'set_slot' && !isUsableNotchItem(packet?.item)) ||
            (eventName === 'set_player_inventory' && !isUsableNotchItem(packet?.contents)) ||
            (eventName === 'window_items' && (
                !Array.isArray(packet?.items) ||
                packet.items.some(item => !isUsableNotchItem(item))
            ))
        ) {
            return false;
        }
        return originalEmit(eventName, packet, ...args);
    };
    client._marigo26_2MetadataShimInstalled = true;
}

function isUsableNotchItem(item) {
    return Boolean(item) && (
        typeof item.present === 'boolean' ||
        typeof item.itemId === 'number' ||
        typeof item.itemCount === 'number'
    );
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
        'stone', 'cobblestone', 'coal_ore', 'iron_ore', 'deepslate_iron_ore',
        'crafting_table', 'furnace', 'chest', 'torch'
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
            reply: 'Komutlar: beni takip et, dur, odun topla/agac kes, tas topla, yemek bul, build showcase, build <isim>, otonom basla, otonom dur, durum.'
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
        'build showcase',
        'showcase build',
        'hepsini yap',
        'tum buildleri yap',
        'tüm buildleri yap'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'build_showcase',
                args: {},
                reason: `Player ${username} requested creative build showcase`
            },
            reply: 'Tamam, creative showcase alanini kuruyorum.'
        };
    }

    const buildMatch = message.match(/\b(?:build|inşa|insa|yap)\s+([a-z0-9_-]+)/i);
    if (buildMatch) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'build_blueprint',
                args: { name: buildMatch[1] },
                reason: `Player ${username} requested blueprint ${buildMatch[1]}`
            },
            reply: `${buildMatch[1]} blueprintini creative modda kuruyorum.`
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

function looksLikeAdminCommand(lowerMessage) {
    const stripped = lowerMessage.replace(BOT_NAME.toLowerCase(), '').replace('marigo', '').trim();
    const firstWord = stripped.split(/\s+/)[0];
    return [
        'op',
        'deop',
        'tp',
        'teleport',
        'clear',
        'give',
        'fill',
        'setblock',
        'difficulty',
        'gamerule',
        'time',
        'weather',
        'kill',
        'effect',
        'gamemode',
        'summon'
    ].includes(firstWord) ||
        ['gave', 'removed', 'teleported', 'changed', 'set', 'made', 'killed', 'applied']
            .includes(firstWord);
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
        haltCurrentAction();
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
        haltCurrentAction();
        return;
    }

    if (command.type === 'tool') {
        autonomousMode = false;
        activeFollowUsername = null;
        queuedUserCommand = command.toolCall;
    }
}

function includesAny(message, needles) {
    return needles.some(needle => {
        if (!needle.includes(' ') && /^[a-z0-9_]+$/i.test(needle)) {
            return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}([^a-z0-9_]|$)`, 'i')
                .test(message);
        }
        return message.includes(needle);
    });
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExpectedMovementCancel(error) {
    const message = error?.message || '';
    return message.includes('goal was changed') ||
        message.includes('Goal changed') ||
        message.includes('digging aborted') ||
        message.includes('Digging aborted');
}

function haltCurrentAction(reason = 'manual stop') {
    actionControl.cancel(bot, reason);
    cancelRequested = true;
    movement.stop(bot);
    try {
        bot.stopDigging();
    } catch {
        // The bot may not be digging right now.
    }
}

async function executeTool(call) {
    activeToolName = call?.tool || null;
    try {
        await toolRegistry.executeToolCall(bot, call);
    } finally {
        activeToolName = null;
    }
}

function shutdown() {
    if (!running) return;
    running = false;
    console.log('[SHUTDOWN] Stopping bot.');
    try {
        memory.flush();
    } catch (error) {
        console.log('[MEMORY] shutdown save failed:', error.message);
    }
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
