require('./logger').installConsoleFilter();

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const { askForAction } = require('./llm');
const SkillTree = require('./skillTree');
const mine = require('./skills/mine');
const craft = require('./skills/craft');
const movement = require('./skills/movement');
const stone = require('./skills/stone');
const tools = require('./skills/tools');
const shelter = require('./skills/shelter');
const survival = require('./skills/survival');
const food = require('./skills/food');
const storage = require('./skills/storage');
const memory = require('./skills/memory');

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
let lastError = null;

bot.once('spawn', async () => {
    console.log(`[BOOT] ${BOT_NAME} spawned. Clean skill tree started.`);
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
        bot.chat(`Level:${skillTree.getLevel(observation).id} xyz:${pos.x},${pos.y},${pos.z} health:${bot.health.toFixed(1)} food:${bot.food} inv:${observation.inventoryText}`);
        return;
    }
    bot.chat('I am here. I am currently learning basic survival and the wood/tool loop with a clean skill tree.');
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
                console.log(`[SURVIVAL_LOOP] action=${JSON.stringify(immediate)} inv=${observation.inventoryText}`);
                await executeAction(immediate);
                lastError = null;
                continue;
            }

            const forced = skillTree.getForcedAction(observation, level);
            const action = forced || await askForAction({
                level,
                observation,
                allowedActions: level.allowedActions
            });
            const safeAction = skillTree.validateAction(action, level) ||
                skillTree.fallbackAction(observation, level);

            console.log(`[LOOP] level=${level.id} action=${JSON.stringify(safeAction)} inv=${observation.inventoryText}`);
            await executeAction(safeAction);
            lastError = null;
        } catch (error) {
            lastError = error.message;
            console.log('[STEP_ERROR]', error.message);
            movement.stop(bot);
        } finally {
            busy = false;
        }
    }
}

async function executeAction(action) {
    if (!action || action.action === 'idle') {
        await sleep(action?.ms || 1000);
        return;
    }

    if (action.action === 'explore') {
        await movement.explore(bot, action);
        return;
    }

    if (action.action === 'mine') {
        await mine.mineBlock(bot, action);
        return;
    }

    if (action.action === 'craft') {
        await craft.craftItem(bot, action.item, action.count || 1);
        return;
    }

    if (action.action === 'place') {
        await craft.placeBlock(bot, action.item);
        return;
    }

    if (action.action === 'move_near') {
        await movement.moveNear(bot, new Vec3(action.x, action.y, action.z), action.range || 2);
        return;
    }

    if (action.action === 'collect_stone') {
        await stone.collectStone(bot, action.count || 16);
        return;
    }

    if (action.action === 'craft_stone_tools') {
        await tools.craftStoneTools(bot);
        return;
    }

    if (action.action === 'build_shelter') {
        await shelter.buildSafeShelter(bot);
        return;
    }

    if (action.action === 'eat_food') {
        await food.eatBestFood(bot);
        return;
    }

    if (action.action === 'find_food') {
        await food.findFood(bot);
        return;
    }

    if (action.action === 'fight_mob') {
        await survival.fightMob(bot, action.entityId);
        return;
    }

    if (action.action === 'escape_pit') {
        await survival.escapePit(bot);
        return;
    }

    if (action.action === 'return_base') {
        await survival.returnBase(bot);
        return;
    }

    if (action.action === 'wait_safe') {
        await survival.waitSafe(bot, action.ms || 1500);
        return;
    }

    if (action.action === 'sleep_bed') {
        await survival.sleepInBed(bot);
        return;
    }

    if (action.action === 'organize_storage') {
        await storage.organizeStorage(bot);
        return;
    }

    throw new Error(`Unknown action: ${action.action}`);
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
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
