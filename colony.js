require('./logger').installConsoleFilter();
require('./protocol26Shim');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const movement = require('./skills/movement');
const survival = require('./skills/survival');
const sharedStorage = require('./skills/sharedStorage');
const colonyMemory = require('./skills/colonyMemory');
const colonyTasks = require('./skills/colonyTasks');
const toolRegistry = require('./toolRegistry');

const HOST = process.env.MC_HOST || 'localhost';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.21';
const CENTER = colonyTasks.parseCenter(process.env.COLONY_CENTER || '1800,70,0');
const RUNTIME_MS = Number(process.env.COLONY_RUNTIME_MS || 180000);
const LOOP_DELAY_MS = Number(process.env.COLONY_LOOP_DELAY_MS || 1200);
const SEED_RESOURCES = process.env.COLONY_SEED_RESOURCES === 'true';

const AGENTS = [
    {
        name: process.env.COLONY_ALPHA || 'marigo_alpha',
        role: 'builder',
        base: CENTER.offset(-4, 0, 0)
    },
    {
        name: process.env.COLONY_BETA || 'marigo_beta',
        role: 'farmer_miner',
        base: CENTER.offset(4, 0, 0)
    }
];

async function main() {
    colonyTasks.bootstrap(CENTER, AGENTS);
    console.log(`[COLONY] survival MVP starting center=${CENTER.toString()} runtime=${RUNTIME_MS}ms`);

    const bots = await Promise.all(AGENTS.map(createAgentBot));
    try {
        await Promise.all(bots.map(({ bot, agent }) => initializeAgent(bot, agent)));
        await runColonyLoop(bots, Date.now() + RUNTIME_MS);
        printSummary();
    } finally {
        await sleep(1000);
        bots.forEach(({ bot }) => {
            try {
                bot.end();
            } catch {
                // Connection may already be closed.
            }
        });
    }
}

function createAgentBot(agent) {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({
            host: HOST,
            port: PORT,
            username: agent.name,
            version: VERSION
        });

        install26_2MetadataShim(bot);
        bot.loadPlugin(pathfinder);
        bot.once('spawn', async () => {
            try {
                movement.configure(bot);
                install26_2AttackShim(bot);
                await sleep(1500);
                console.log(`[COLONY] ${agent.name} spawned role=${agent.role}`);
                resolve({ bot, agent, lastError: null });
            } catch (error) {
                reject(error);
            }
        });
        bot.on('kicked', reason => console.log(`[COLONY] ${agent.name} kicked ${reason}`));
        bot.on('error', error => console.log(`[COLONY] ${agent.name} error ${error.message}`));
    });
}

async function initializeAgent(bot, agent) {
    await command(bot, `/gamemode survival ${agent.name}`, 500);
    if (SEED_RESOURCES && agent.role === 'builder') await setupTestArea(bot);
    await command(bot, `/tp ${agent.name} ${agent.base.x} ${agent.base.y} ${agent.base.z}`, 700);
    if (SEED_RESOURCES) await seedAgent(bot, agent);
    colonyMemory.setBotBase(agent.name, {
        role: agent.role,
        base: vectorToObject(agent.base),
        status: 'running',
        position: vectorToObject(bot.entity.position.floored())
    });
    bot.chat(`${agent.role} online. Shared storage ve request board hazir.`);
}

async function setupTestArea(bot) {
    await command(
        bot,
        `/fill ${CENTER.x - 10} ${CENTER.y - 1} ${CENTER.z - 10} ${CENTER.x + 10} ${CENTER.y - 1} ${CENTER.z + 10} grass_block`,
        600
    );
    await command(
        bot,
        `/fill ${CENTER.x - 10} ${CENTER.y} ${CENTER.z - 10} ${CENTER.x + 10} ${CENTER.y + 7} ${CENTER.z + 10} air`,
        800
    );
}

async function seedAgent(bot, agent) {
    await command(bot, `/clear ${agent.name}`, 250);
    if (agent.role === 'builder') {
        await command(bot, `/give ${agent.name} chest 1`, 250);
        await command(bot, `/give ${agent.name} cobblestone 4`, 250);
    } else {
        await command(bot, `/give ${agent.name} cobblestone 48`, 250);
        await command(bot, `/give ${agent.name} oak_log 4`, 250);
        await command(bot, `/give ${agent.name} bread 4`, 250);
    }
}

async function runColonyLoop(entries, deadline) {
    let tick = 0;
    while (Date.now() < deadline) {
        tick++;
        for (const entry of entries) {
            await runAgentStep(entry, tick);
        }
        if (isMvpComplete()) {
            console.log('[COLONY] MVP completion criteria reached.');
            return;
        }
        await sleep(LOOP_DELAY_MS);
    }
}

async function runAgentStep(entry, tick) {
    const { bot, agent } = entry;
    if (!bot.entity || bot.health <= 0) return;

    try {
        const observation = observe(bot, entry.lastError);
        const immediate = survival.chooseImmediateAction(bot, observation, { id: 'COLONY_SURVIVAL' });
        const toolCall = immediate
            ? toolRegistry.normalizeToolCall(immediate)
            : await selectColonyTool(bot, agent);

        console.log(`[COLONY_LOOP] tick=${tick} bot=${agent.name} role=${agent.role} tool=${JSON.stringify(toolCall)} inv=${observation.inventoryText}`);
        await toolRegistry.executeToolCall(bot, toolCall);
        entry.lastError = null;
        colonyMemory.setBotBase(agent.name, {
            role: agent.role,
            status: 'running',
            position: vectorToObject(bot.entity.position.floored()),
            inventory: observation.inventory
        });
    } catch (error) {
        entry.lastError = error.message;
        console.log(`[COLONY_STEP_ERROR] bot=${agent.name} ${error.message}`);
        movement.stop(bot);
        colonyMemory.setBotBase(agent.name, {
            role: agent.role,
            status: 'recovering',
            lastError: error.message
        });
        await sleep(800);
    }
}

async function selectColonyTool(bot, agent) {
    const bootstrap = selectBootstrapTool(bot, agent);
    if (bootstrap) return bootstrap;

    if (agent.role === 'builder') {
        try {
            await colonyTasks.ensureSharedStorageReady(bot, CENTER);
        } catch (error) {
            console.log(`[COLONY] shared storage check failed: ${error.message}`);
            const retry = selectBootstrapTool(bot, agent);
            if (retry) return retry;
            throw error;
        }
    }

    return colonyTasks.selectTask(bot, agent);
}

function selectBootstrapTool(bot, agent) {
    const inventory = colonyTasks.countInventory(bot);
    const sharedPosition = sharedStorage.getSharedStoragePosition();
    const chestNearby = sharedPosition && findBlockAtOrNear(bot, 'chest', sharedPosition, 3);
    if (chestNearby) return null;

    if (agent.role !== 'builder') {
        if ((inventory.cobblestone || 0) >= 16) {
            return {
                tool: 'wait_safe',
                args: { ms: 1500 },
                reason: 'farmer_miner: wait with first cobblestone until shared storage exists'
            };
        }
        return {
            tool: 'collect_stone',
            args: { count: 16 },
            reason: 'farmer_miner: gather first colony blocks while builder prepares storage'
        };
    }

    if ((inventory.chest || 0) > 0) {
        return {
            tool: 'ensure_shared_storage',
            args: vectorToObject(CENTER),
            reason: 'builder: place first shared storage chest'
        };
    }

    if (totalPlanks(inventory) >= 8) {
        return {
            tool: 'craft_item',
            args: { item: 'chest', count: 1 },
            reason: 'builder: craft shared storage chest'
        };
    }

    const logName = Object.keys(inventory).find(name => name.endsWith('_log') && inventory[name] > 0);
    if (logName) {
        return {
            tool: 'craft_item',
            args: { item: logName.replace(/_log$/, '_planks'), count: 8 },
            reason: 'builder: make planks for shared storage chest'
        };
    }

    return {
        tool: 'mine_block',
        args: { target: 'any_log' },
        reason: 'builder: collect wood for shared storage chest'
    };
}

function isMvpComplete() {
    const memory = colonyMemory.load();
    const shared = memory.sharedStorage?.inventory || {};
    const marker = memory.projects.find(project =>
        project.id === 'survival_marker' &&
        ['partial', 'complete'].includes(project.status)
    );
    return (shared.cobblestone || 0) >= 16 && Boolean(marker);
}

function observe(bot, lastError) {
    const inventory = colonyTasks.countInventory(bot);
    const position = bot.entity.position;
    const nearbyMobs = Object.values(bot.entities || {})
        .filter(entity => entity !== bot.entity && entity.position && entity.position.distanceTo(position) <= 24)
        .map(entity => ({
            id: entity.id,
            name: entity.name || entity.displayName || 'unknown',
            distance: Number(entity.position.distanceTo(position).toFixed(1))
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);

    return {
        health: bot.health,
        food: bot.food,
        position: vectorToObject(position.floored()),
        inventory,
        inventoryText: inventoryText(inventory),
        nearbyBlocks: [],
        nearbyMobs,
        hasUsableChest: false,
        storageReady: true,
        base: colonyMemory.load().bots[bot.username]?.base || null,
        survivalReady: true,
        lastError
    };
}

function findBlockAtOrNear(bot, name, position, radius) {
    const center = new Vec3(position.x, position.y, position.z);
    const direct = bot.blockAt(center);
    if (direct?.name === name) return direct;
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlocks({ matching: id, maxDistance: radius, count: 16 })
        .map(blockPosition => bot.blockAt(blockPosition))
        .filter(Boolean)
        .filter(block => block.position.distanceTo(center) <= radius)[0] || null;
}

function totalPlanks(inventory) {
    return Object.entries(inventory)
        .filter(([name]) => name.endsWith('_planks'))
        .reduce((sum, [, count]) => sum + count, 0);
}

async function command(bot, text, waitMs = 350) {
    bot.chat(text);
    await sleep(waitMs);
}

function install26_2AttackShim(bot) {
    if (VERSION !== '26.2' && process.env.ENABLE_EXPERIMENTAL_26_2 !== 'true') return;
    if (bot._marigo26_2AttackShimInstalled || typeof bot.attack !== 'function') return;
    bot._marigo26_2AttackShimInstalled = true;
    const originalAttack = bot.attack.bind(bot);

    bot.attack = function attack26_2(target, swing = true) {
        if (!target?.id || !bot._client) return originalAttack(target, swing);
        if (swing) bot.swingArm();
        bot._client.write('attack', { entityId: target.id });
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
        return originalEmit(eventName, packet, ...args);
    };
    client._marigo26_2MetadataShimInstalled = true;
}

function printSummary() {
    const memory = colonyMemory.load();
    console.log(`[COLONY_SUMMARY] shared=${JSON.stringify(memory.sharedStorage?.inventory || {})}`);
    console.log(`[COLONY_SUMMARY] requests=${JSON.stringify(memory.requests)}`);
    console.log(`[COLONY_SUMMARY] projects=${JSON.stringify(memory.projects)}`);
}

function inventoryText(inventory) {
    return Object.entries(inventory)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ') || 'empty';
}

function vectorToObject(vector) {
    return { x: Math.floor(vector.x), y: Math.floor(vector.y), z: Math.floor(vector.z) };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
    console.log('[COLONY_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
